#!/usr/bin/env python3
"""Measure synthetic hook invocations in isolated state directories on POSIX."""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import statistics
import subprocess
import sys
import tempfile
import time

ROOT = Path(__file__).resolve().parents[1]
SOURCES = ("agent-status", "agent-status-hook", "agent_status_state.py")


def measure(directory: Path, events: int, sessions: int) -> dict:
    latencies = []
    cpu = 0.0
    peak_rss = 0
    env = {**os.environ, "XDG_CACHE_HOME": str(directory / "cache"), "PYTHONDONTWRITEBYTECODE": "1"}
    for index in range(events):
        slot = index % sessions
        cycle, phase = divmod(index // sessions, 4)
        agent = "claude" if slot % 2 else "codex"
        event = ("UserPromptSubmit", "PreToolUse", "PostToolUse", "Stop")[phase]
        payload = {"session_id": f"benchmark-{slot}", "turn_id": f"turn-{cycle}",
                   "tool_use_id": f"action-{cycle}", "cwd": "/benchmark/project"}
        started = time.perf_counter()
        with tempfile.TemporaryFile() as input_file:
            input_file.write(json.dumps(payload).encode())
            input_file.seek(0)
            proc = subprocess.Popen([sys.executable, str(directory / "bin/agent-status-hook"),
                                     "--agent", agent, "--event", event],
                                    stdin=input_file, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, env=env)
            _, status, usage = os.wait4(proc.pid, 0)
            proc.returncode = os.waitstatus_to_exitcode(status)
            error = proc.stderr.read().decode()
            proc.stderr.close()
        if proc.returncode:
            raise RuntimeError(error)
        latencies.append((time.perf_counter() - started) * 1000)
        cpu += usage.ru_utime + usage.ru_stime
        peak_rss = max(peak_rss, usage.ru_maxrss)
    state = directory / "cache/agent-status-indicator/state.json"
    records = json.loads(state.read_text())["sessions"]
    return {"events": events, "sessions": sum(len(items) for items in records.values()),
            "mean_ms": round(statistics.mean(latencies), 2),
            "median_ms": round(statistics.median(latencies), 2),
            "p95_ms": round(sorted(latencies)[int((len(latencies) - 1) * 0.95)], 2),
            "child_cpu_seconds": round(cpu, 3), "max_hook_rss_kib": peak_rss,
            "state_bytes": state.stat().st_size}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--baseline-ref", help="Compare with this local Git revision; never fetch or checkout.")
    parser.add_argument("--events", type=int, default=40)
    parser.add_argument("--sessions", type=int, default=10)
    args = parser.parse_args()
    if not hasattr(os, "wait4") or not sys.platform.startswith("linux"):
        parser.error("this measurement uses Linux wait4 RSS units")
    if args.sessions < 1 or args.events < args.sessions:
        parser.error("events must be at least sessions, and sessions must be positive")
    result = {}
    with tempfile.TemporaryDirectory(prefix="agent-status-benchmark-") as temporary:
        versions = [("current", None)]
        if args.baseline_ref:
            versions.insert(0, ("baseline", args.baseline_ref))
        for name, ref in versions:
            directory = Path(temporary) / name
            (directory / "bin").mkdir(parents=True)
            for source in SOURCES:
                data = subprocess.check_output(["git", "show", f"{ref}:bin/{source}"], cwd=ROOT) if ref else (ROOT / "bin" / source).read_bytes()
                (directory / "bin" / source).write_bytes(data)
            result[name] = measure(directory, args.events, args.sessions)
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
