from __future__ import annotations

import importlib.machinery
import importlib.util
import io
import json
import os
import socket
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "bin"))


def load_module(name, path):
    loader = importlib.machinery.SourceFileLoader(name, str(path))
    spec = importlib.util.spec_from_loader(name, loader)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


agent_status = load_module("agent_status", ROOT / "bin/agent-status")
hook = load_module("status_hook", ROOT / "bin/agent-status-hook")
desktop = load_module("desktop_status", ROOT / "desktop/agent_status_desktop.py")
wrapper = load_module("exec_status", ROOT / "bin/codex-status-exec")


class AgentStatusTests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp_dir.cleanup)
        self.state_file = Path(self.temp_dir.name) / "state.json"
        self.patch_path = patch.object(agent_status, "state_path", lambda: self.state_file)
        self.patch_path.start()
        self.addCleanup(self.patch_path.stop)

    def test_invalid_json_is_reported_without_data_loss(self):
        self.state_file.write_text('{broken')
        with self.assertRaises(ValueError):
            agent_status.apply_update("codex", "working")
        self.assertEqual(self.state_file.read_text(), '{broken')
        agent_status.apply_update("all", "idle")
        backups = list(self.state_file.parent.glob("state.corrupt-*.json"))
        self.assertEqual(len(backups), 1)
        self.assertEqual(backups[0].read_text(), '{broken')
        self.assertEqual(agent_status.load_state()["agents"]["codex"]["state"], "idle")

    def test_identity_migration_preserves_canonical_turn_and_alert_history(self):
        legacy_id = "claude:/synthetic/session.jsonl"
        canonical_id = "claude:transcript:canonical"
        agent_status.apply_update("claude", "approval", session_id=legacy_id,
                                  event="PermissionRequest", turn_id="old", action_id="a")
        agent_status.apply_update("claude", "working", session_id=canonical_id,
                                  event="UserPromptSubmit", turn_id="new")
        state = agent_status.apply_update("claude", "idle", session_id=canonical_id,
                                         event="Stop", turn_id="old", legacy_session_id=legacy_id)
        self.assertNotIn(legacy_id, state["sessions"]["claude"])
        record = state["sessions"]["claude"][canonical_id]
        self.assertEqual(record["state"], "working")
        self.assertEqual(record["turn_id"], "new")
        self.assertIn("old", record["retired_turns"])
        self.assertEqual(state["alerts"]["sequence"], 1)
        self.assertEqual(state["alerts"]["events"][0]["session"], canonical_id)
        state = agent_status.apply_update("claude", "idle", session_id=canonical_id, event="Stop", turn_id="new")
        self.assertEqual(state["agents"]["claude"]["state"], "idle")
        self.assertEqual(state["alerts"]["sequence"], 2)

    def test_malformed_records_are_normalized(self):
        for malformed in (None, [], "invalid"):
            state = agent_status.normalize_state({"agents": malformed, "sessions": {"codex": malformed}})
            self.assertEqual(state["agents"]["codex"]["state"], "idle")
        state = agent_status.normalize_state({"updated_at": float('nan'), "sessions": {"codex": {
            "a": {"state": [], "updated_at": "invalid"},
            "b": {"state": "working", "updated_at": float('inf')},
        }}})
        json.dumps(state, allow_nan=False)
        self.assertEqual(state["agents"]["codex"]["active_sessions"], 1)

    def test_active_states_never_expire_even_with_old_ttl(self):
        for name in ("working", "approval", "error"):
            with self.subTest(state=name):
                state = {"version": 2, "ttl_seconds": 1, "sessions": {
                    "codex": {"s": {"state": name, "updated_at": time.time() - 86400 * 30}},
                }}
                visible = agent_status.normalize_state(state)
                self.assertEqual(visible["agents"]["codex"]["state"], name)
                self.assertEqual(desktop.display_state(state)["agents"]["codex"], visible["agents"]["codex"])
                self.assertNotIn("ttl_seconds", visible)
                self.assertEqual(visible["version"], 3)

    def test_summary_only_migration(self):
        state = agent_status.normalize_state({"agents": {"codex": {"state": "working"}}})
        self.assertEqual(state["agents"]["codex"]["state"], "working")
        state["sessions"]["codex"].clear()
        self.assertEqual(agent_status.normalize_state(state)["agents"]["codex"]["state"], "idle")

    def test_session_updates_do_not_clear_other_sessions(self):
        agent_status.apply_update("codex", "approval", session_id="s1", event="PermissionRequest")
        agent_status.apply_update("codex", "working", session_id="s2", event="PreToolUse")
        self.assertEqual(agent_status.load_state()["agents"]["codex"]["state"], "approval")
        agent_status.apply_update("codex", "idle", session_id="s1", event="Stop")
        state = agent_status.load_state()
        self.assertEqual(state["agents"]["codex"]["state"], "working")
        self.assertIn("s2", state["sessions"]["codex"])

    def test_approval_resume_and_error_recovery(self):
        for name in ("working", "approval", "working", "error", "working", "idle"):
            result = agent_status.apply_update("claude", name, session_id="s")
            self.assertEqual(result["agents"]["claude"]["state"], name)
            self.assertEqual(agent_status.load_state()["agents"]["claude"]["state"], name)

    def test_priority_across_agents(self):
        agent_status.apply_update("codex", "working", session_id="s1")
        agent_status.apply_update("claude", "approval", session_id="s2")
        self.assertEqual(desktop.combined_state(agent_status.load_state()), "approval")
        agent_status.apply_update("codex", "error", session_id="s3")
        self.assertEqual(desktop.combined_state(agent_status.load_state()), "error")

    def test_concurrent_updates_are_serialized(self):
        errors = []
        def update(index):
            try:
                agent_status.apply_update("claude", "working", session_id=f"claude:{index}")
            except Exception as exc:
                errors.append(exc)
        threads = [threading.Thread(target=update, args=(index,)) for index in range(24)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()
        self.assertEqual(errors, [])
        self.assertEqual(len(agent_status.load_state()["sessions"]["claude"]), 24)

    @unittest.skipUnless(os.name == "posix", "POSIX lock crash integration")
    def test_process_concurrency_and_lock_recovery_after_kill(self):
        cache = Path(self.temp_dir.name) / "cache"
        env = {**os.environ, "XDG_CACHE_HOME": str(cache)}
        command = [sys.executable, str(ROOT / "bin/agent-status"), "update", "codex", "working", "--session"]
        processes = [subprocess.Popen(command + [str(index)], env=env) for index in range(12)]
        for proc in processes:
            self.assertEqual(proc.wait(timeout=10), 0)
        path = cache / "agent-status-indicator/state.json"
        self.assertEqual(len(json.loads(path.read_text())["sessions"]["codex"]), 12)
        holder = subprocess.Popen([sys.executable, "-u", "-c", "import fcntl,sys,time; f=open(sys.argv[1],'a'); fcntl.flock(f,fcntl.LOCK_EX); print('locked',flush=True); time.sleep(30)", str(path.with_suffix('.lock'))], stdout=subprocess.PIPE, text=True)
        self.addCleanup(lambda: holder.poll() is None and holder.kill())
        self.assertEqual(holder.stdout.readline().strip(), "locked")
        holder.kill()
        holder.wait(timeout=3)
        holder.stdout.close()
        self.assertEqual(subprocess.run(command + ["after-crash"], env=env, timeout=5).returncode, 0)
        self.assertEqual(len(json.loads(path.read_text())["sessions"]["codex"]), 13)

    def test_late_previous_turn_and_stopped_turn_cannot_overwrite(self):
        ts = time.time()
        agent_status.apply_update("codex", "working", session_id="s", event="UserPromptSubmit", turn_id="t1", observed_at=ts)
        agent_status.apply_update("codex", "working", session_id="s", event="UserPromptSubmit", turn_id="t2", observed_at=ts + 1)
        agent_status.apply_update("codex", "idle", session_id="s", event="Stop", turn_id="t1", observed_at=ts + 2)
        self.assertEqual(agent_status.load_state()["agents"]["codex"]["state"], "working")
        agent_status.apply_update("codex", "idle", session_id="s", event="Stop", turn_id="t2", observed_at=ts + 3)
        agent_status.apply_update("codex", "working", session_id="s", event="PostToolUse", turn_id="t2", observed_at=ts + 4)
        self.assertEqual(agent_status.load_state()["agents"]["codex"]["state"], "idle")
        agent_status.apply_update("codex", "working", session_id="s", event="UserPromptSubmit", turn_id="t3", observed_at=ts + 5)
        agent_status.apply_update("codex", "error", session_id="s", observed_at=ts)
        self.assertEqual(agent_status.load_state()["agents"]["codex"]["state"], "working")

    def test_agent_reset_does_not_clear_other_agent(self):
        agent_status.apply_update("codex", "working", session_id="c1")
        agent_status.apply_update("claude", "working", session_id="c2")
        agent_status.apply_update("codex", "idle")
        state = agent_status.load_state()
        self.assertEqual(state["sessions"]["codex"], {})
        self.assertEqual(state["agents"]["claude"]["state"], "working")

    def test_retired_prompt_cannot_reopen_newer_turn(self):
        for turn in ("first", "second", "first"):
            agent_status.apply_update("codex", "working", session_id="s", event="UserPromptSubmit", turn_id=turn)
        record = agent_status.load_state()["sessions"]["codex"]["s"]
        self.assertEqual(record["turn_id"], "second")
        agent_status.apply_update("codex", "approval", session_id="s", event="PermissionRequest", turn_id="second")
        agent_status.apply_update("codex", "working", session_id="s", event="UserPromptSubmit", turn_id="second")
        self.assertEqual(agent_status.load_state()["agents"]["codex"]["state"], "approval")

    def test_blocked_action_requires_matching_resolution(self):
        agent_status.apply_update("claude", "approval", session_id="s", event="PermissionRequest", action_id="a")
        for event, action in (("PreToolUse", "a"), ("PostToolUse", "b"), ("PostToolUse", "")):
            result = agent_status.apply_update("claude", "working", session_id="s", event=event, action_id=action)
            self.assertEqual(result["agents"]["claude"]["state"], "approval")
        result = agent_status.apply_update("claude", "working", session_id="s", event="PostToolUse", action_id="a")
        self.assertEqual(result["agents"]["claude"]["state"], "working")

    def test_alert_history_survives_next_prompt_and_deduplicates(self):
        for event, name in (("SessionStart", "idle"), ("UserPromptSubmit", "working"),
                            ("PermissionRequest", "approval"), ("PermissionRequest", "approval"),
                            ("PostToolUse", "working"), ("PermissionRequest", "approval"),
                            ("Stop", "idle"), ("Stop", "idle")):
            state = agent_status.apply_update("codex", name, session_id="s", event=event, turn_id="one", project="demo", action_id="a")
        self.assertEqual([item["kind"] for item in state["alerts"]["events"]], ["permission", "completion"])
        state = agent_status.apply_update("codex", "working", session_id="s", event="UserPromptSubmit", turn_id="two")
        self.assertEqual(len(state["alerts"]["events"]), 2)
        self.assertEqual(state["sessions"]["codex"]["s"]["project"], "demo")
        self.assertEqual(state["version"], 3)

    def test_history_is_bounded_without_dropping_sessions(self):
        for index in range(270):
            state = agent_status.apply_update("claude", "error", session_id=f"s{index}", event="Error")
        self.assertEqual(len(state["alerts"]["events"]), 256)
        self.assertEqual(state["alerts"]["sequence"], 270)
        self.assertEqual(len(state["sessions"]["claude"]), 270)

    def test_permission_without_action_id_uses_preceding_tool_identity(self):
        for action in ("a", "b"):
            agent_status.apply_update("claude", "working", session_id="s", event="PreToolUse", action_id=action)
            state = agent_status.apply_update("claude", "approval", session_id="s", event="PermissionRequest")
            self.assertEqual(state["sessions"]["claude"]["s"]["action_id"], action)
            agent_status.apply_update("claude", "working", session_id="s", event="PostToolUse", action_id=action)
        state = agent_status.apply_update("claude", "approval", session_id="s", event="PermissionRequest", action_id="a")
        self.assertEqual(state["agents"]["claude"]["state"], "working", 'resolved action cannot block again')
        self.assertEqual([item["kind"] for item in state["alerts"]["events"]], ["permission", "permission"])

    def test_unidentified_permissions_can_alert_again_after_resolution(self):
        for _ in range(2):
            agent_status.apply_update("codex", "approval", session_id="s", event="PermissionRequest", turn_id="turn")
            state = agent_status.apply_update("codex", "working", session_id="s", event="PostToolUse", turn_id="turn")
        self.assertEqual(len(state["alerts"]["events"]), 2)

    def test_session_reset_rejects_late_same_turn_events(self):
        agent_status.apply_update("codex", "working", session_id="s", event="UserPromptSubmit", turn_id="old")
        agent_status.apply_update("codex", "idle", session_id="s")
        for event in ("PreToolUse", "PostToolUse", "PermissionRequest", "Stop"):
            state = agent_status.apply_update("codex", "working", session_id="s", event=event, turn_id="old")
            self.assertEqual(state["sessions"]["codex"]["s"]["event"], "Reset")
        self.assertEqual(state["alerts"]["events"], [])
        state = agent_status.apply_update("codex", "working", session_id="s", event="UserPromptSubmit", turn_id="new")
        self.assertEqual(state["agents"]["codex"]["state"], "working")

    def test_ten_mixed_sessions_and_manual_reset_do_not_invent_completion(self):
        for index in range(10):
            agent = "claude" if index % 2 else "codex"
            state = agent_status.apply_update(agent, "working", session_id=str(index), event="UserPromptSubmit", project="same")
        self.assertEqual(sum(len(items) for items in state["sessions"].values()), 10)
        state = agent_status.apply_update("codex", "idle", session_id="0")
        self.assertEqual(state["alerts"]["events"], [])
        self.assertEqual(state["agents"]["claude"]["active_sessions"], 5)

    def test_update_all_idle_clears_every_session(self):
        agent_status.apply_update("all", "working", session_id="shared")
        agent_status.apply_update("all", "idle")
        for sessions in agent_status.load_state()["sessions"].values():
            self.assertEqual(sessions, {})

    def test_silent_socket_client_is_bounded(self):
        server, client = socket.socketpair()
        with client:
            started = time.monotonic()
            thread = threading.Thread(target=agent_status.handle_client, args=(server,))
            thread.start()
            thread.join(timeout=2)
            self.assertFalse(thread.is_alive())
            self.assertLess(time.monotonic() - started, 2)
            self.assertFalse(json.loads(client.recv(4096))["ok"])

    def test_bad_socket_payload_does_not_break_next_update(self):
        for payload in (b'[]\n', b'{"action":"bad"}\n', b'x' * 70000 + b'\n'):
            server, client = socket.socketpair()
            with client:
                thread = threading.Thread(target=agent_status.handle_client, args=(server,))
                thread.start()
                client.sendall(payload)
                self.assertFalse(json.loads(client.recv(4096))["ok"])
                thread.join(timeout=3)
        agent_status.apply_update("codex", "working")
        self.assertEqual(agent_status.load_state()["agents"]["codex"]["state"], "working")


class CodexDiagnosticsTests(unittest.TestCase):
    def response(self, trust="trusted", enabled=True, events=("userPromptSubmit", "stop")):
        return {"result": {"data": [{"errors": [], "hooks": [
            {"eventName": event, "trustStatus": trust, "enabled": enabled,
             "command": "/path/agent-status-hook --agent codex", "sourcePath": "/path/hooks.json"}
            for event in events
        ]}]}}

    def test_configured_but_untrusted_hooks_are_not_ready(self):
        for trust in ("untrusted", "modified"):
            result = agent_status.codex_hook_report(self.response(trust=trust), ["UserPromptSubmit", "Stop"])
            self.assertEqual(result["status"], "needs_trust")

    def test_disabled_missing_and_unsupported_hooks_are_distinguished(self):
        self.assertEqual(agent_status.codex_hook_report(self.response(enabled=False), [])["status"], "disabled")
        self.assertEqual(agent_status.codex_hook_report(self.response(events=()), [])["status"], "not_registered")
        self.assertEqual(agent_status.codex_hook_report(self.response(events=("preToolUse",)), [])["status"], "missing_lifecycle_events")
        result = agent_status.codex_hook_report(self.response(), ["UserPromptSubmit", "Stop", "SessionEnd", "Interrupt"])
        self.assertEqual(result["status"], "ready")
        self.assertEqual(result["configured_events_not_registered"], ["SessionEnd", "Interrupt"])

    def test_rpc_and_configuration_errors_are_not_ready(self):
        self.assertEqual(agent_status.codex_hook_report({"error": "unsupported method"}, [])["status"], "unavailable")
        response = self.response()
        response["result"]["data"][0]["errors"] = [{"message": "bad configuration"}]
        self.assertEqual(agent_status.codex_hook_report(response, [])["status"], "configuration_error")

    def test_unrelated_trusted_hook_does_not_count_as_integration(self):
        response = self.response()
        for hook_info in response["result"]["data"][0]["hooks"]:
            hook_info["command"] = "some-other-hook"
        self.assertEqual(agent_status.codex_hook_report(response, [])["status"], "not_registered")


class HookTests(unittest.TestCase):
    def test_large_payload_parser_retains_only_supported_metadata(self):
        payload = {"session_id": "s", "cwd": "/synthetic/demo", "tool_name": "Write",
                   "tool_input": {"content": "x" * 200000}, "last_assistant_message": "x" * 200000,
                   "params": {"threadId": "thread", "turn_id": "turn", "body": "x" * 200000}}
        with patch.object(sys, "stdin", io.StringIO(json.dumps(payload))):
            parsed = hook.parse_stdin()
        self.assertEqual(parsed["session_id"], "s")
        self.assertEqual(parsed["params"], {"threadId": "thread", "turn_id": "turn"})
        self.assertNotIn("tool_input", parsed)
        self.assertNotIn("last_assistant_message", parsed)

    def test_large_payloads_do_not_drop_lifecycle_events(self):
        with tempfile.TemporaryDirectory() as directory:
            env = {**os.environ, "XDG_CACHE_HOME": directory}
            path = Path(directory) / "agent-status-indicator/state.json"
            body = "x" * 200000
            for agent in ("claude", "codex"):
                for event, extra, expected in (
                    ("UserPromptSubmit", {"prompt": body}, "working"),
                    ("PreToolUse", {"tool_name": "Write", "tool_use_id": "a", "tool_input": {"content": body}}, "working"),
                    ("PermissionRequest", {"tool_name": "Write", "tool_input": {"content": body}}, "approval"),
                    ("PostToolUse", {"tool_use_id": "a", "tool_response": body}, "working"),
                    ("Stop", {"last_assistant_message": body}, "idle"),
                ):
                    payload = {"session_id": "large", "turn_id": "turn", **extra}
                    result = subprocess.run([sys.executable, str(ROOT / "bin/agent-status-hook"),
                                             "--agent", agent, "--event", event], input=json.dumps(payload),
                                            env=env, capture_output=True, text=True, timeout=5)
                    self.assertEqual(result.returncode, 0, result.stderr)
                    self.assertEqual(json.loads(path.read_text())["agents"][agent]["state"], expected)
                    self.assertNotIn("x" * 256, path.read_text())
                state = json.loads(path.read_text())
                self.assertEqual([item["kind"] for item in state["alerts"]["events"] if item["agent"] == agent],
                                 ["permission", "completion"])

    def test_upgrade_migrates_transcript_fallback_without_merging_other_sessions(self):
        for agent in ("claude", "codex"):
            for with_environment_id in (False, True):
                with self.subTest(agent=agent, environment_id=with_environment_id), tempfile.TemporaryDirectory() as directory:
                    env = {**os.environ, "XDG_CACHE_HOME": directory}
                    for key in ("CODEX_SESSION_ID", "CODEX_THREAD_ID", "CLAUDE_SESSION_ID", "CLAUDE_CONVERSATION_ID"):
                        env.pop(key, None)
                    if with_environment_id:
                        env["CODEX_SESSION_ID" if agent == "codex" else "CLAUDE_SESSION_ID"] = "runtime"
                    legacy_id = f"{agent}:/synthetic/project/one.jsonl"
                    other_id = f"{agent}:/synthetic/project/two.jsonl"
                    records = {legacy_id: {"state": "working", "updated_at": time.time()}}
                    if with_environment_id:
                        records[other_id] = {"state": "approval", "updated_at": time.time()}
                    path = Path(directory) / "agent-status-indicator/state.json"
                    path.parent.mkdir()
                    path.write_text(json.dumps({"version": 3, "sessions": {agent: records}}))
                    payload = {"transcript_path": "/synthetic/project/one.jsonl", "cwd": "/synthetic/project"}
                    with patch.dict(os.environ, env, clear=True):
                        canonical_id = hook.session_from_payload(payload, agent)
                    result = subprocess.run([sys.executable, str(ROOT / "bin/agent-status-hook"),
                                             "--agent", agent, "--event", "Stop"], input=json.dumps(payload),
                                            env=env, capture_output=True, text=True, timeout=5)
                    self.assertEqual(result.returncode, 0, result.stderr)
                    state = json.loads(path.read_text())
                    self.assertNotIn(legacy_id, state["sessions"][agent])
                    self.assertEqual(state["sessions"][agent][canonical_id]["state"], "idle")
                    self.assertEqual(state["agents"][agent]["state"], "approval" if with_environment_id else "idle")
                    if with_environment_id:
                        self.assertEqual(state["sessions"][agent][other_id]["state"], "approval")

    def test_explicit_decision_tools_are_claude_only(self):
        for name in ("AskUserQuestion", "ExitPlanMode"):
            self.assertEqual(hook.state_for_event("PreToolUse", {"tool_name": name}, "claude"), "approval")
            self.assertEqual(hook.state_for_event("PreToolUse", {"tool_name": name}, "codex"), "working")

    def test_hook_does_not_spawn_an_interpreter_or_persist_payload_text(self):
        payload = {"session_id": "s", "cwd": "/private/demo", "message": "secret",
                   "tool_name": "AskUserQuestion", "tool_use_id": "a"}
        with tempfile.TemporaryDirectory() as directory:
            with patch.dict(os.environ, {"XDG_CACHE_HOME": directory}), \
                    patch.object(sys, "argv", ["hook", "--agent", "claude", "--event", "PreToolUse"]), \
                    patch.object(sys, "stdin", io.StringIO(json.dumps(payload))), \
                    patch.object(subprocess, "Popen", side_effect=AssertionError("unexpected subprocess")):
                self.assertEqual(hook.main(), 0)
            raw = (Path(directory) / "agent-status-indicator/state.json").read_text()
            self.assertNotIn("secret", raw)
            self.assertNotIn("/private", raw)
            record = json.loads(raw)["sessions"]["claude"]["claude:s"]
            self.assertEqual(record["attention"], "decision")
            self.assertEqual(record["project"], "demo")

    def test_nonterminal_events_are_ignored(self):
        for event, payload in [("SubagentStop", {}), ("SubagentStart", {}), ("Unknown", {}), ("Notification", {}), ("Notification", {"notification_type": "idle_prompt"}), ("SessionStart", {"source": "compact"})]:
            self.assertIsNone(hook.state_for_event(event, payload))
        self.assertEqual(hook.state_for_event("Notification", {"notification_type": "permission_prompt"}), "approval")
        self.assertEqual(hook.state_for_event("Interrupt", {}), "idle")
        self.assertEqual(hook.state_for_event("SessionEnd", {}), "idle")

    def test_identity_uses_ids_before_transcript_and_directory(self):
        self.assertEqual(hook.session_from_payload({"cwd": "/same", "params": {"thread_id": "t"}}, "codex"), "codex:t")
        self.assertNotEqual(hook.session_from_payload({"session_id": "a", "cwd": "/same"}, "codex"), hook.session_from_payload({"session_id": "b", "cwd": "/same"}, "codex"))
        with patch.dict(os.environ, {"PWD": "/same"}, clear=True):
            self.assertEqual(hook.session_from_payload({"cwd": "/same"}, "codex"), "")

    def test_real_hook_lifecycle_without_daemon(self):
        with tempfile.TemporaryDirectory() as directory:
            env = {**os.environ, "XDG_CACHE_HOME": directory}
            path = Path(directory) / "agent-status-indicator/state.json"
            for event, extra, expected in [
                ("UserPromptSubmit", {}, "working"),
                ("SessionStart", {"source": "compact"}, "working"),
                ("SubagentStop", {"agent_id": "child"}, "working"),
                ("Notification", {"notification_type": "idle_prompt"}, "working"),
                ("PermissionRequest", {}, "approval"),
                ("PostToolUse", {}, "working"),
                ("Interrupt", {}, "idle"),
                ("UserPromptSubmit", {"turn_id": "next"}, "working"),
                ("SessionEnd", {"turn_id": ""}, "idle"),
            ]:
                payload = {"session_id": "s", "turn_id": "turn", **extra}
                result = subprocess.run([sys.executable, str(ROOT / "bin/agent-status-hook"), "--agent", "codex", "--event", event], input=json.dumps(payload), text=True, env=env, capture_output=True, timeout=5)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(json.loads(path.read_text())["agents"]["codex"]["state"], expected, event)

    def test_invalid_payload_does_not_create_phantom_work(self):
        with tempfile.TemporaryDirectory() as directory:
            env = {"PATH": os.environ["PATH"], "XDG_CACHE_HOME": directory}
            for payload in ("null", "[]", "bad json"):
                result = subprocess.run([sys.executable, str(ROOT / "bin/agent-status-hook"), "--agent", "codex", "--event", "PreToolUse"], input=payload, text=True, env=env, capture_output=True)
                self.assertEqual(result.returncode, 1)
            self.assertFalse((Path(directory) / "agent-status-indicator/state.json").exists())


class WrapperTests(unittest.TestCase):
    def test_wrapper_keeps_one_identity_and_cleans_up(self):
        proc = unittest.mock.MagicMock()
        proc.stdout = ['null\n', 'not json\n', '{"type":"thread.started","thread_id":"abc"}\n', '{"type":"turn.completed"}\n']
        proc.wait.return_value = 0
        with patch.object(wrapper.subprocess, "Popen", return_value=proc), patch.object(wrapper, "update") as update:
            self.assertEqual(wrapper.main(["hello"]), 0)
            self.assertEqual(len({call.args[2] for call in update.call_args_list}), 1)
            self.assertEqual(update.call_args_list[-1].args[0], "idle")
            self.assertEqual(update.call_args_list[-1].args[1], "turn.completed")

    def test_real_wrapper_retains_stop_provenance_without_duplicate_alerts(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory)
            fake = path / "codex"
            fake.write_text(f"#!{sys.executable}\nprint('{{\"type\":\"thread.started\"}}')\nprint('{{\"type\":\"turn.completed\"}}')\n")
            fake.chmod(0o755)
            env = {**os.environ, "PATH": str(path) + os.pathsep + os.environ["PATH"], "XDG_CACHE_HOME": directory}
            result = subprocess.run([sys.executable, str(ROOT / "bin/codex-status-exec")], env=env,
                                    capture_output=True, text=True, timeout=10)
            self.assertEqual(result.returncode, 0, result.stderr)
            state = json.loads((path / "agent-status-indicator/state.json").read_text())
            record = next(iter(state["sessions"]["codex"].values()))
            self.assertEqual(record["event"], "Stop")
            self.assertEqual([item["kind"] for item in state["alerts"]["events"]], ["completion"])

    def test_spawn_failure_and_failed_turn_stay_red(self):
        with patch.object(wrapper.subprocess, "Popen", side_effect=FileNotFoundError("codex missing")), patch.object(wrapper, "update") as update:
            self.assertEqual(wrapper.main([]), 127)
            self.assertEqual(update.call_args_list[-1].args[0], "error")
        proc = unittest.mock.MagicMock()
        proc.stdout = ['{"type":"turn.failed"}\n']
        proc.wait.return_value = 0
        with patch.object(wrapper.subprocess, "Popen", return_value=proc), patch.object(wrapper, "update") as update:
            wrapper.main([])
            self.assertEqual(update.call_args_list[-1].args[0], "error")


class DesktopTests(unittest.TestCase):
    def test_bad_state_read_preserves_last_good_then_recovers(self):
        indicator = desktop.DesktopIndicator.__new__(desktop.DesktopIndicator)
        indicator.state = agent_status.normalize_state({"sessions": {"codex": {"s": {"state": "working"}}}})
        indicator.config = dict(desktop.DEFAULT_CONFIG)
        indicator.canvas = unittest.mock.MagicMock()
        indicator.root = unittest.mock.MagicMock()
        with patch.object(desktop, "read_state", side_effect=ValueError("broken")):
            indicator._refresh()
        self.assertEqual(desktop.combined_state(indicator.state), "working")
        self.assertIn("broken", indicator.read_error)
        self.assertEqual(indicator.canvas.create_oval.call_args.kwargs["fill"], desktop.DEFAULT_COLORS["error"])
        with patch.object(desktop, "read_state", return_value=indicator.state):
            indicator._refresh()
        self.assertEqual(indicator.read_error, "")
        self.assertEqual(indicator.canvas.create_oval.call_args.kwargs["fill"], desktop.DEFAULT_COLORS["working"])

    def test_poll_is_rescheduled_on_failure(self):
        indicator = desktop.DesktopIndicator.__new__(desktop.DesktopIndicator)
        indicator.root = unittest.mock.MagicMock()
        indicator._refresh = unittest.mock.Mock(side_effect=ValueError("bad"))
        with self.assertRaises(ValueError):
            indicator._poll()
        indicator.root.after.assert_called_once_with(400, indicator._poll)

    def test_offscreen_position_is_recovered(self):
        indicator = desktop.DesktopIndicator.__new__(desktop.DesktopIndicator)
        indicator.config = {**desktop.DEFAULT_CONFIG, "x": 9999, "y": -500}
        indicator.canvas = unittest.mock.MagicMock()
        indicator.root = unittest.mock.MagicMock()
        indicator.root.winfo_screenwidth.return_value = 1920
        indicator.root.winfo_screenheight.return_value = 1080
        indicator.transparent_color = '#010203'
        indicator._set_geometry()
        indicator.root.geometry.assert_called_once_with('38x38+1882+0')


if __name__ == "__main__":
    unittest.main()
