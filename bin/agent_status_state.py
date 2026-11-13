"""Canonical, event-driven status model shared by Python clients.

Silence is not completion: active sessions persist until a terminal event or reset.
Version 2 TTL settings are intentionally ignored on migration.
"""
from __future__ import annotations

import math
import time
from typing import Any

AGENTS = ("codex", "claude")
PRIORITY = {"idle": 0, "working": 1, "approval": 2, "error": 3}
VALID_STATES = set(PRIORITY)
ALERT_KINDS = {"completion", "permission", "decision", "error"}
MAX_ALERTS = 256


def label(value: Any, limit: int = 120) -> str:
    return "".join(char for char in str(value or "") if char.isprintable())[:limit]


def alert_kind(record: dict) -> str:
    if record.get("state") == "approval":
        return "decision" if record.get("attention") == "decision" else "permission"
    if record.get("state") == "error":
        return "error"
    if record.get("state") == "idle" and record.get("event") == "Stop":
        return "completion"
    return ""


def string_list(value: Any, limit: int) -> list[str]:
    return [item for item in value if isinstance(item, str)][-limit:] if isinstance(value, list) else []


def transition_session(previous: dict, state: str, message: str, event: str,
                       turn_id: str, observed: float, project: str = "",
                       action_id: str = "", attention: str = "") -> dict | None:
    previous_turn = previous.get("turn_id", "")
    retired = string_list(previous.get("retired_turns"), 32)
    if observed < previous.get("updated_at", 0) or (turn_id and turn_id in retired):
        return None
    if event == "PreModelRequest" and (not turn_id or turn_id == previous_turn):
        return None  # Model retries must not clear attention or reopen a stopped turn.
    if (turn_id and previous_turn and turn_id != previous_turn
            and event not in {"UserPromptSubmit", "PreModelRequest"}):
        return None
    if event == "UserPromptSubmit" and turn_id and turn_id == previous_turn:
        return None  # Replayed prompts must not reopen a blocked or stopped turn.
    if event == "SessionStart" and previous.get("state") in {"working", "approval", "error"}:
        return None
    if (event and event not in {"UserPromptSubmit", "PreModelRequest", "SessionStart", "SessionEnd"}
            and previous.get("state") == "idle"
            and previous.get("event") in {"Stop", "Interrupt", "SessionEnd", "Reset"}
            and ((turn_id and turn_id == previous_turn)
                 or (previous.get("event") == "SessionEnd" and event != "Reset"))):
        return None
    if previous.get("state") == "approval":
        if event == "PreToolUse":
            return None
        if (event in {"PostToolUse", "PostToolUseFailure"} and previous.get("action_id")
                and action_id != previous["action_id"]):
            return None
        if state == "approval" and event in {"PermissionRequest", "Notification"}:
            attention = previous.get("attention", attention)
            action_id = action_id or previous.get("action_id", "")
    if (state == "approval" and not action_id and event == "PermissionRequest"
            and previous.get("event") == "PreToolUse"):
        action_id = previous.get("action_id", "")
    if previous_turn and ((turn_id and turn_id != previous_turn) or event == "SessionStart"):
        retired = (retired + [previous_turn])[-32:]
    result = {
        "state": state, "message": message, "event": event, "updated_at": observed,
        "turn_id": turn_id or (previous_turn if event != "SessionStart" else ""),
        "project": label(project or previous.get("project"), 80),
        "action_id": label(action_id, 256),
        "attention": "decision" if state == "approval" and attention == "decision" else "",
        "retired_turns": retired,
        "seen_alerts": string_list(previous.get("seen_alerts"), 64),
    }

    if event not in {"Reset", "SessionEnd", "Interrupt"} and "context" in previous:
        result["context"] = previous["context"]
    return result


def usage_snapshot(value: Any) -> dict:
    """Accept only numeric usage metadata; never carry source payloads forward."""
    if not isinstance(value, dict):
        return {}
    result = {}
    for kind in ("context", "quota"):
        item = value.get(kind)
        if not isinstance(item, dict):
            continue
        updated = item.get("updated_at")
        if type(updated) not in (int, float) or not 0 < updated < 8640000000000 or not math.isfinite(updated):
            continue
        if kind == "context":
            used = item.get("used_percent")
            if type(used) in (int, float) and 0 <= used <= 100 and math.isfinite(used):
                result[kind] = {"used_percent": used, "updated_at": updated}
        else:
            windows = []
            for window in item.get("windows", [])[:2] if isinstance(item.get("windows"), list) else []:
                if not isinstance(window, dict):
                    continue
                used, minutes, resets = (window.get(key) for key in ("used_percent", "window_minutes", "resets_at"))
                if (type(used) not in (int, float) or not 0 <= used <= 100 or not math.isfinite(used)
                        or type(minutes) is not int or not 0 < minutes <= 525600
                        or type(resets) not in (int, float) or not updated < resets < 8640000000000 or not math.isfinite(resets)):
                    continue
                windows.append({"used_percent": used, "window_minutes": minutes, "resets_at": resets})
            result[kind] = {"updated_at": updated, "windows": windows}
    return result


def merge_usage(state: dict, agent: str, session_id: str, value: Any) -> None:
    record = state["sessions"][agent].get(session_id)
    if record is None or record.get("event") in {"SessionEnd", "Reset", "Interrupt"}:
        return
    snapshot = usage_snapshot(value)
    context = snapshot.get("context")
    if context and context["updated_at"] >= record.get("context", {}).get("updated_at", 0):
        record["context"] = context
    quota = snapshot.get("quota")
    if quota and quota["updated_at"] >= state.get("usage", {}).get(agent, {}).get("updated_at", 0):
        state.setdefault("usage", {})[agent] = quota


def normalize_alerts(value: Any) -> dict | None:
    if (not isinstance(value, dict) or not isinstance(value.get("generation"), str)
            or not label(value["generation"], 64)):
        return None
    sequence = value.get("sequence")
    if type(sequence) is not int or not 0 <= sequence < 2**53:
        return None
    events = []
    items = value.get("events")
    for item in items[-MAX_ALERTS:] if isinstance(items, list) else []:
        if (not isinstance(item, dict) or item.get("agent") not in AGENTS
                or not isinstance(item.get("kind"), str) or item["kind"] not in ALERT_KINDS
                or type(item.get("sequence")) is not int
                or not 0 < item["sequence"] <= sequence
                or not isinstance(item.get("session"), str)):
            continue
        events.append({
            "sequence": item["sequence"], "agent": item["agent"], "kind": item["kind"],
            "session": item["session"], "project": label(item.get("project"), 80),
            "updated_at": timestamp(item.get("updated_at"), 0),
        })
    return {"generation": label(value["generation"], 64), "sequence": sequence,
            "events": sorted({item["sequence"]: item for item in events}.values(), key=lambda item: item["sequence"])}


def timestamp(value: Any, fallback: float) -> float:
    try:
        result = float(value)
        return result if math.isfinite(result) and result >= 0 else fallback
    except (TypeError, ValueError, OverflowError):
        return fallback


def empty_state() -> dict[str, Any]:
    return normalize_state({})


def aggregate_agent(agent: str, sessions: dict, current: float) -> dict[str, Any]:
    active = [(sid, item) for sid, item in sessions.items() if item["state"] != "idle"]
    result = {"state": "idle", "message": "", "updated_at": current, "active_sessions": len(active)}
    if active:
        sid, item = max(active, key=lambda entry: (PRIORITY[entry[1]["state"]], entry[1]["updated_at"], entry[0]))
        result.update(item, session=sid)
    return result


def normalize_state(state: Any) -> dict[str, Any]:
    current = time.time()
    if not isinstance(state, dict):
        state = {}
    raw_sessions = state.get("sessions")
    raw_agents = state.get("agents")
    sessions = {}
    for agent in AGENTS:
        items = raw_sessions.get(agent, {}) if isinstance(raw_sessions, dict) else {}
        # Migrate old summary-only state once; session records are authoritative.
        if raw_sessions is None and isinstance(raw_agents, dict):
            item = raw_agents.get(agent)
            if isinstance(item, dict) and isinstance(item.get("state"), str) and item["state"] in VALID_STATES - {"idle"}:
                items = {f"{agent}:legacy": item}
        cleaned = {}
        for sid, item in (items.items() if isinstance(items, dict) else []):
            if not isinstance(item, dict) or not isinstance(item.get("state"), str):
                continue
            if item["state"] not in VALID_STATES:
                continue
            if item["state"] == "idle" and current - timestamp(item.get("updated_at"), current) > 86400:
                continue
            cleaned[str(sid)] = {
                "state": item["state"],
                "message": str(item.get("message") or "")[:500],
                "event": str(item.get("event") or ""),
                "turn_id": str(item.get("turn_id") or ""),
                "updated_at": timestamp(item.get("updated_at"), current),
            }
            context = usage_snapshot({"context": item.get("context")}).get("context")
            if context:
                cleaned[str(sid)]["context"] = context
            for key, limit in (("project", 80), ("action_id", 256), ("attention", 16)):
                if key in item:
                    cleaned[str(sid)][key] = label(item[key], limit)
            for key, limit in (("retired_turns", 32), ("seen_alerts", 64)):
                if key in item:
                    cleaned[str(sid)][key] = string_list(item[key], limit)
        sessions[agent] = cleaned
    result = {
        "version": 3,
        "updated_at": timestamp(state.get("updated_at"), current),
        "sessions": sessions,
        "agents": {agent: aggregate_agent(agent, sessions[agent], current) for agent in AGENTS},
    }
    raw_usage = state.get("usage")
    if isinstance(raw_usage, dict):
        usage = {agent: usage_snapshot({"quota": raw_usage.get(agent)}).get("quota") for agent in AGENTS}
        result["usage"] = {agent: item for agent, item in usage.items() if item is not None}
    alerts = normalize_alerts(state.get("alerts"))
    if alerts is not None:
        result["alerts"] = alerts
    return result


def combined_state(state: dict) -> str:
    agents = state.get("agents")
    if not isinstance(agents, dict):
        return "idle"
    states = [item.get("state") for item in agents.values() if isinstance(item, dict)]
    return max((s for s in states if isinstance(s, str) and s in PRIORITY), key=PRIORITY.get, default="idle")
