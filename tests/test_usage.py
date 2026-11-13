from __future__ import annotations

from datetime import datetime, timezone
import importlib.machinery
import importlib.util
import io
import json
import os
import shlex
import signal
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "bin"))


def load_module(name, path):
    loader = importlib.machinery.SourceFileLoader(name, str(path))
    spec = importlib.util.spec_from_loader(name, loader)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


status = load_module("usage_status", ROOT / "bin/agent-status")
hook = load_module("usage_hook", ROOT / "bin/agent-status-hook")


class UsageTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.environment = patch.dict(os.environ, {
            "XDG_CONFIG_HOME": str(self.root / "config"),
            "XDG_CACHE_HOME": str(self.root / "cache"),
            "CODEX_HOME": str(self.root / "codex"),
        })
        self.environment.start()
        self.addCleanup(self.environment.stop)
        self.config = self.root / "config/agent-status-indicator/usage.json"
        self.config.parent.mkdir(parents=True)
        self.path = self.root / "codex/sessions/rollout.jsonl"
        self.path.parent.mkdir(parents=True)
        self.observed = time.time()
        self.reported = self.observed - 1

    def enable(self, **values):
        self.config.write_text(json.dumps(values))

    def record(self, updated=None, context=4200, quota=63):
        return {
            "timestamp": datetime.fromtimestamp(updated or self.reported, timezone.utc).isoformat(),
            "type": "event_msg", "payload": {"type": "token_count",
                "info": {"model_context_window": 10000,
                         "last_token_usage": {"total_tokens": context},
                         "total_token_usage": {"total_tokens": 9999999}},
                "rate_limits": {"limit_id": "codex", "primary": {
                    "used_percent": quota, "window_minutes": 300, "resets_at": self.observed + 3600}},
                "unrelated": "PRIVATE MESSAGE"},
        }

    def write_session(self, *records, session="thread", padding=0):
        with self.path.open("w") as stream:
            stream.write(json.dumps({"type": "session_meta", "payload": {"id": session,
                "instructions": "PRIVATE INSTRUCTIONS"}}) + "\n")
            for _ in range(padding):
                stream.write(json.dumps({"type": "response_item", "payload": "PRIVATE TEXT" * 100}) + "\n")
            for record in records:
                stream.write(json.dumps(record) + "\n")

    def collect(self):
        return hook.codex_usage({"transcript_path": str(self.path)}, "codex:thread", self.observed)

    def test_collection_is_opt_in_and_fails_closed(self):
        self.write_session(self.record())
        with patch.object(hook.os, "open", wraps=hook.os.open) as opened:
            self.assertEqual(self.collect(), {})
            for raw in ('null', '[]', '{"codex_metadata":"true"}', '{bad', 'x' * 5000):
                self.config.write_text(raw)
                self.assertEqual(self.collect(), {})
            self.assertTrue(all(Path(call.args[0]) == self.config for call in opened.call_args_list))
        if os.name == "posix":
            self.config.unlink()
            os.mkfifo(self.config)
            self.assertFalse(hook.usage_enabled("codex_metadata"))
            self.config.unlink()
        self.enable(codex_metadata=True)
        value = self.collect()
        self.assertEqual(value["context"]["used_percent"], 42)
        self.assertEqual(value["quota"]["windows"][0]["used_percent"], 63)
        self.assertNotIn("PRIVATE", json.dumps(value))
        self.assertNotIn(str(self.path), json.dumps(value))

    def test_reads_are_bounded_and_ignore_partial_or_text_records(self):
        self.enable(codex_metadata=True)
        self.write_session(self.record(context=2000), self.record(context=3500), padding=400)
        original = os.fdopen
        byte_count = []
        session_inode = self.path.stat().st_ino
        class Reader:
            def __init__(self, stream): self.stream = stream
            def __enter__(self): return self
            def __exit__(self, *args): return self.stream.__exit__(*args)
            def fileno(self): return self.stream.fileno()
            def seek(self, offset): return self.stream.seek(offset)
            def read(self, size):
                self_data = self.stream.read(size)
                if os.fstat(self.stream.fileno()).st_ino == session_inode:
                    byte_count.append(len(self_data))
                return self_data
        with patch.object(hook.os, "fdopen", side_effect=lambda *args: Reader(original(*args))):
            self.assertEqual(self.collect()["context"]["used_percent"], 35)
        self.assertLessEqual(sum(byte_count), hook.USAGE_HEAD_BYTES + hook.USAGE_TAIL_BYTES)
        with self.path.open("a") as stream:
            stream.write(json.dumps({"type": "response_item", "payload": self.record(context=9000)}) + "\n")
            stream.write(json.dumps(self.record(context=9900))[:-1])
        self.assertEqual(self.collect()["context"]["used_percent"], 35)

    def test_only_matching_regular_session_files_are_read(self):
        self.enable(codex_metadata=True)
        self.write_session(self.record(), session="different-thread")
        self.assertEqual(self.collect(), {})
        self.write_session(self.record())
        outside = self.root / "outside.jsonl"
        outside.write_bytes(self.path.read_bytes())
        self.assertEqual(hook.codex_usage({"transcript_path": str(outside)}, "codex:thread", self.observed), {})
        link = self.path.parent / "link.jsonl"
        if os.name == "posix":
            link.symlink_to(self.path)
            self.assertEqual(hook.codex_usage({"transcript_path": str(link)}, "codex:thread", self.observed), {})
            fifo = self.path.parent / "fifo.jsonl"
            os.mkfifo(fifo)
            self.assertEqual(hook.codex_usage({"transcript_path": str(fifo)}, "codex:thread", self.observed), {})
        self.assertEqual(hook.codex_usage({"transcript_path": "relative.jsonl"}, "codex:thread", self.observed), {})

    def test_malformed_metadata_cannot_replace_a_valid_sample(self):
        self.enable(codex_metadata=True)
        bad = self.record()
        bad["payload"]["info"]["model_context_window"] = None
        bad["payload"]["rate_limits"]["primary"]["used_percent"] = "99"
        self.write_session(self.record(context=2300), bad,
                           self.record(updated=self.observed + 500, context=9800))
        value = self.collect()
        self.assertEqual(value["context"]["used_percent"], 23)
        self.assertEqual(value["quota"]["windows"], [])
        self.write_session(self.record(updated=self.reported, context=2300),
                           self.record(updated=self.reported - 5, context=8900))
        self.assertEqual(self.collect()["context"]["used_percent"], 23)
        self.write_session(self.record())
        with self.path.open("a") as stream:
            stream.write(json.dumps({"type": "event_msg", "payload": {"type": "token_count",
                         "unused": "x" * (hook.USAGE_LINE_BYTES + 1)}}) + "\n")
        self.assertEqual(self.collect()["context"]["used_percent"], 42)

    def test_usage_transactions_preserve_lifecycle_and_reject_stale_updates(self):
        before = status.apply_update("codex", "approval", session_id="codex:thread",
                                     event="PermissionRequest", turn_id="t", observed_at=self.reported - 1)
        value = {"context": {"used_percent": 42, "updated_at": self.reported},
                 "quota": {"updated_at": self.reported, "windows": [{
                     "used_percent": 63, "window_minutes": 300, "resets_at": self.observed + 3600}]},
                 "message": "PRIVATE"}
        status.apply_usage("codex", "codex:thread", value, self.observed)
        state = status.load_state()
        record = state["sessions"]["codex"]["codex:thread"]
        self.assertEqual({key: item for key, item in record.items() if key != "context"},
                         before["sessions"]["codex"]["codex:thread"])
        self.assertEqual(state["alerts"], before["alerts"])
        self.assertEqual(state["updated_at"], before["updated_at"])
        self.assertNotIn("PRIVATE", status.state_path().read_text())
        older = {"context": {"used_percent": 98, "updated_at": self.reported - 2},
                 "quota": {"updated_at": self.reported - 2, "windows": []}}
        status.apply_usage("codex", "codex:thread", older, self.observed)
        self.assertEqual(status.load_state()["sessions"]["codex"]["codex:thread"]["context"]["used_percent"], 42)
        self.assertEqual(len(status.load_state()["usage"]["codex"]["windows"]), 1)
        status.apply_usage("codex", "unknown", value, self.observed)
        self.assertNotIn("unknown", status.load_state()["sessions"]["codex"])
        status.apply_update("codex", "working", session_id="codex:thread",
                            event="UserPromptSubmit", turn_id="new", observed_at=self.observed)
        state = status.apply_update("codex", "idle", session_id="codex:thread", event="Stop",
                                    turn_id="t", observed_at=self.observed + 1, usage=older)
        self.assertEqual(state["sessions"]["codex"]["codex:thread"]["state"], "working")
        self.assertEqual(state["sessions"]["codex"]["codex:thread"]["context"]["used_percent"], 42)

    def test_concurrent_usage_keeps_all_sessions_and_newest_quota(self):
        for agent in ("codex", "claude"):
            for index in range(5):
                status.apply_update(agent, "working", session_id=f"{agent}:{index}",
                                    event="UserPromptSubmit", observed_at=self.reported - 2)
        errors = []
        def update(agent, index):
            try:
                status.apply_usage(agent, f"{agent}:{index}", {
                    "context": {"used_percent": index * 10, "updated_at": self.reported},
                    "quota": {"updated_at": self.reported + index / 10, "windows": [{
                        "used_percent": index, "window_minutes": 300, "resets_at": self.observed + 3600}]}},
                    self.observed)
            except Exception as exc:
                errors.append(exc)
        threads = [threading.Thread(target=update, args=(agent, index))
                   for agent in ("codex", "claude") for index in range(5)]
        for thread in threads: thread.start()
        for thread in threads: thread.join()
        self.assertEqual(errors, [])
        state = status.load_state()
        for agent in ("codex", "claude"):
            self.assertEqual(state["usage"][agent]["windows"][0]["used_percent"], 4)
            self.assertEqual(len(state["sessions"][agent]), 5)
            self.assertTrue(all("context" in record for record in state["sessions"][agent].values()))

    def test_codex_hook_collects_in_existing_transaction(self):
        self.enable(codex_metadata=True)
        self.write_session(self.record())
        result = subprocess.run([sys.executable, str(ROOT / "bin/agent-status-hook"),
                                 "--agent", "codex", "--event", "Stop"],
                                input=json.dumps({"session_id": "thread", "transcript_path": str(self.path)}),
                                text=True, capture_output=True, timeout=5)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.strip(), "{}")
        state = status.load_state()
        self.assertEqual(state["sessions"]["codex"]["codex:thread"]["context"]["used_percent"], 42)
        self.assertEqual(state["alerts"]["sequence"], 1)
        self.assertIn("codex:thread", status.usage_sources(state))

    def register_source(self, sid="codex:thread", path=None, observed=None):
        return status.apply_update("codex", "approval", session_id=sid, event="PermissionRequest",
                                   turn_id="t", observed_at=observed or self.reported,
                                   usage=self.collect(), usage_source=str(path or self.path))

    def test_manual_refresh_collects_new_metadata_without_changing_lifecycle(self):
        self.enable(codex_metadata=True)
        self.write_session(self.record())
        self.register_source()
        before = status.load_state()
        self.write_session(self.record(updated=self.observed - 0.1, context=7300, quota=81))
        result = hook.refresh_usage(self.observed)
        self.assertEqual(result, {"status": "updated", "checked": 1, "updated": 1, "unavailable": 0})
        after = status.load_state()
        self.assertEqual(after["updated_at"], before["updated_at"])
        self.assertEqual(after["alerts"], before["alerts"])
        old = before["sessions"]["codex"]["codex:thread"]
        new = after["sessions"]["codex"]["codex:thread"]
        self.assertEqual({k: v for k, v in new.items() if k != "context"},
                         {k: v for k, v in old.items() if k != "context"})
        self.assertEqual(new["context"]["used_percent"], 73)
        self.assertEqual(after["usage"]["codex"]["windows"][0]["used_percent"], 81)
        saved = status.state_path().read_bytes()
        self.assertEqual(hook.refresh_usage(self.observed)["status"], "unchanged")
        self.assertEqual(status.state_path().read_bytes(), saved)
        self.assertNotIn(str(self.path), saved.decode())
        self.assertNotIn("PRIVATE", saved.decode())
        sources = status.state_path().with_name("usage-sources.json")
        self.assertEqual(json.loads(sources.read_text())["codex:thread"]["path"], str(self.path))
        if os.name == "posix":
            self.assertEqual(sources.stat().st_mode & 0o777, 0o600)

    def test_manual_refresh_preserves_the_registered_codex_home(self):
        self.enable(codex_metadata=True)
        self.write_session(self.record())
        self.register_source()
        self.write_session(self.record(updated=self.observed - 0.1, context=5700))
        with patch.dict(os.environ, {"CODEX_HOME": str(self.root / "another-codex")}):
            self.assertEqual(hook.refresh_usage(self.observed)["updated"], 1)
        self.assertAlmostEqual(status.load_state()["sessions"]["codex"]["codex:thread"]["context"]["used_percent"], 57)

    def test_manual_refresh_is_opt_in_and_requires_registered_sources(self):
        with patch.object(hook, "codex_usage") as collect:
            self.assertEqual(hook.refresh_usage(self.observed)["status"], "disabled")
            collect.assert_not_called()
        self.enable(codex_metadata=True)
        self.write_session(self.record())
        with patch.object(hook, "codex_usage") as collect:
            self.assertEqual(hook.refresh_usage(self.observed)["status"], "no-sources")
            collect.assert_not_called()
        self.register_source()
        self.enable(codex_metadata=False)
        with patch.object(hook, "codex_usage") as collect:
            self.assertEqual(hook.refresh_usage(self.observed)["status"], "disabled")
            collect.assert_not_called()
        self.enable(codex_metadata=True)
        original = hook.codex_usage
        def revoke(*args):
            value = original(*args)
            self.enable(codex_metadata=False)
            return value
        before = status.state_path().read_bytes()
        with patch.object(hook, "codex_usage", side_effect=revoke):
            self.assertEqual(hook.refresh_usage(self.observed)["status"], "disabled")
        self.assertEqual(status.state_path().read_bytes(), before)

    def test_manual_refresh_revalidates_sources_and_preserves_previous_reports(self):
        self.enable(codex_metadata=True)
        self.write_session(self.record())
        self.register_source()
        before = status.state_path().read_bytes()
        self.write_session(self.record(context=9700), session="another-session")
        result = hook.refresh_usage(self.observed)
        self.assertEqual(result["unavailable"], 1)
        self.assertEqual(result["updated"], 0)
        self.assertEqual(status.state_path().read_bytes(), before)
        self.path.unlink()
        self.assertEqual(hook.refresh_usage(self.observed)["unavailable"], 1)
        sources = status.state_path().with_name("usage-sources.json")
        for raw in ("{bad", "[]", "x" * 262145):
            sources.write_text(raw)
            self.assertEqual(hook.refresh_usage(self.observed)["status"], "no-sources")
        if os.name == "posix":
            sources.unlink()
            os.mkfifo(sources)
            self.assertEqual(hook.refresh_usage(self.observed)["status"], "no-sources")

    @unittest.skipUnless(os.name == "posix", "POSIX symbolic-link behavior")
    def test_broken_source_loop_does_not_block_refresh_or_lifecycle(self):
        self.enable(codex_metadata=True)
        self.write_session(self.record())
        self.register_source()
        before = status.state_path().read_bytes()
        sessions = self.path.parent
        sessions.rename(self.root / "saved-sessions")
        sessions.symlink_to(sessions.name, target_is_directory=True)
        self.assertEqual(self.collect(), {})
        result = hook.refresh_usage(self.observed)
        self.assertEqual(result["unavailable"], 1)
        self.assertEqual(result["updated"], 0)
        self.assertEqual(status.state_path().read_bytes(), before)
        result = subprocess.run([sys.executable, str(ROOT / "bin/agent-status-hook"),
                                 "--agent", "codex", "--event", "UserPromptSubmit"],
                                input=json.dumps({"session_id": "thread", "turn_id": "after-loop",
                                                  "transcript_path": str(self.path)}),
                                text=True, capture_output=True, timeout=5)
        self.assertEqual(result.returncode, 0, result.stderr)
        record = status.load_state()["sessions"]["codex"]["codex:thread"]
        self.assertEqual(record["state"], "working")
        self.assertEqual(record["turn_id"], "after-loop")

    def test_manual_refresh_never_reopens_closed_sessions_or_overwrites_new_turns(self):
        self.enable(codex_metadata=True)
        self.write_session(self.record())
        self.register_source()
        original = hook.codex_usage
        def advance(*args):
            value = original(*args)
            status.apply_update("codex", "working", session_id="codex:thread",
                                event="UserPromptSubmit", turn_id="new", observed_at=self.observed + 1)
            return value
        with patch.object(hook, "codex_usage", side_effect=advance):
            self.assertEqual(hook.refresh_usage(self.observed)["updated"], 0)
        record = status.load_state()["sessions"]["codex"]["codex:thread"]
        self.assertEqual(record["state"], "working")
        self.assertEqual(record["turn_id"], "new")
        status.apply_update("codex", "idle", session_id="codex:thread", event="SessionEnd",
                            turn_id="new", observed_at=self.observed + 2)
        with patch.object(hook, "codex_usage") as collect:
            self.assertEqual(hook.refresh_usage(self.observed + 3)["status"], "no-sources")
            collect.assert_not_called()
        self.assertNotIn("context", status.load_state()["sessions"]["codex"]["codex:thread"])

    def test_registered_sources_have_a_fixed_bound_and_skip_unrelated_sessions(self):
        self.enable(codex_metadata=True)
        self.write_session(self.record())
        for index in range(status.MAX_USAGE_SOURCES + 3):
            self.register_source(sid=f"codex:{index}", observed=self.reported + index / 100)
        state = status.load_state()
        with status.state_lock():
            sources = status.usage_sources(state)
        self.assertEqual(len(sources), status.MAX_USAGE_SOURCES)
        self.assertNotIn("codex:0", sources)
        self.assertNotIn("codex:2", sources)
        self.assertIn(f"codex:{status.MAX_USAGE_SOURCES + 2}", sources)
        with patch.object(hook, "codex_usage", return_value={}) as collect:
            result = hook.refresh_usage(self.observed)
        self.assertEqual(collect.call_count, status.MAX_USAGE_SOURCES)
        self.assertEqual(result["checked"], status.MAX_USAGE_SOURCES)
        self.assertEqual(len(state["sessions"]["codex"]), status.MAX_USAGE_SOURCES + 3)

    def test_refresh_command_accepts_no_lifecycle_options_or_stdin(self):
        result = subprocess.run([sys.executable, str(ROOT / "bin/agent-status-hook"),
                                 "--agent", "codex", "--refresh-usage"],
                                input="PRIVATE INVALID INPUT", text=True, capture_output=True, timeout=5)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout)["status"], "disabled")
        self.assertFalse(status.state_path().exists())
        for options in (["--event", "Stop"], ["--status-line"], ["--state", "idle"], ["--session", "thread"]):
            result = subprocess.run([sys.executable, str(ROOT / "bin/agent-status-hook"),
                                     "--agent", "codex", "--refresh-usage", *options],
                                    text=True, capture_output=True, timeout=5)
            self.assertNotEqual(result.returncode, 0)
            self.assertFalse(status.state_path().exists())

    def test_claude_status_line_is_opt_in_and_preserves_existing_command(self):
        status.apply_update("claude", "working", session_id="claude:s", event="UserPromptSubmit",
                            observed_at=self.reported - 1)
        payload = {"session_id": "s", "context_window": {"used_percentage": 37},
                   "rate_limits": {"five_hour": {"used_percentage": 80, "resets_at": self.observed + 3600}},
                   "private": "PRIVATE"}
        with patch.object(sys, "stdin", io.StringIO(json.dumps(payload))), patch.object(sys, "stdout", io.StringIO()):
            self.assertEqual(hook.status_line("", self.observed), 0)
        self.assertNotIn("context", status.load_state()["sessions"]["claude"]["claude:s"])
        self.enable(claude_statusline=True)
        command = shlex.join([sys.executable, "-c", 'import json,sys; print(json.load(sys.stdin)["session_id"])'])
        with patch.object(sys, "stdin", io.StringIO(json.dumps(payload))):
            self.assertEqual(hook.status_line(command, self.observed), 0)
        state = status.load_state()
        self.assertEqual(state["sessions"]["claude"]["claude:s"]["context"]["used_percent"], 37)
        self.assertEqual(state["usage"]["claude"]["windows"][0]["used_percent"], 80)
        self.assertEqual(state["sessions"]["claude"]["claude:s"]["state"], "working")
        self.assertNotIn("PRIVATE", status.state_path().read_text())

    @unittest.skipUnless(sys.platform.startswith("linux"), "Linux owned-process cleanup check")
    def test_status_line_timeout_stops_its_command_children(self):
        pid_file = self.root / "command.pid"
        child_code = "import os,sys,time; from pathlib import Path; Path(sys.argv[1]).write_text(str(os.getpid())); time.sleep(30)"
        command = shlex.join([sys.executable, "-c", child_code, str(pid_file)])
        try:
            with patch.object(sys, "stdin", io.StringIO("{}")):
                self.assertEqual(hook.status_line(command, self.observed), 0)
            self.assertTrue(pid_file.exists(), "synthetic child must start before the deadline")
            pid = int(pid_file.read_text())
            deadline = time.monotonic() + 1
            while self.process_running(pid) and time.monotonic() < deadline:
                time.sleep(0.01)
            self.assertFalse(self.process_running(pid), "timing out the shell must not leave its child running")
        finally:
            if pid_file.exists():
                pid = int(pid_file.read_text())
                if self.process_running(pid):
                    os.kill(pid, signal.SIGKILL)

    @unittest.skipUnless(sys.platform.startswith("linux"), "Linux owned-process cleanup check")
    def test_status_line_cancellation_stops_its_command_children(self):
        pid_file = self.root / "cancelled-command.pid"
        child_code = "import os,sys,time; from pathlib import Path; Path(sys.argv[1]).write_text(str(os.getpid())); time.sleep(30)"
        command = shlex.join([sys.executable, "-c", child_code, str(pid_file)])
        process = subprocess.Popen([sys.executable, str(ROOT / "bin/agent-status-hook"),
                                    "--agent", "claude", "--status-line", "--status-line-command", command],
                                   stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                                   text=True)
        try:
            process.stdin.write("{}")
            process.stdin.close()
            deadline = time.monotonic() + 5
            while not pid_file.exists() and process.poll() is None and time.monotonic() < deadline:
                time.sleep(0.01)
            self.assertTrue(pid_file.exists(), "synthetic command must start before cancellation")
            process.terminate()
            self.assertEqual(process.wait(timeout=3), 128 + signal.SIGTERM)
            pid = int(pid_file.read_text())
            deadline = time.monotonic() + 1
            while self.process_running(pid) and time.monotonic() < deadline:
                time.sleep(0.01)
            self.assertFalse(self.process_running(pid), "cancelling the adapter must also stop its child")
        finally:
            if process.poll() is None:
                process.kill()
            process.wait(timeout=3)
            if pid_file.exists():
                pid = int(pid_file.read_text())
                if self.process_running(pid):
                    os.kill(pid, signal.SIGKILL)

    @staticmethod
    def process_running(pid):
        try:
            return Path(f"/proc/{pid}/stat").read_text().rsplit(")", 1)[1].split()[0] != "Z"
        except FileNotFoundError:
            return False

    def test_invalid_numeric_metadata_is_removed(self):
        from agent_status_state import usage_snapshot
        for invalid in (None, True, "50", -1, 101, float("nan"), float("inf"), 10**400):
            self.assertNotIn("context", usage_snapshot({"context": {
                "used_percent": invalid, "updated_at": self.reported}}))
        self.assertEqual(usage_snapshot({"context": {"used_percent": 50, "updated_at": 10**400}}), {})
        self.assertEqual(usage_snapshot({"quota": {"updated_at": self.reported, "windows": [{
            "used_percent": 50, "window_minutes": 300, "resets_at": 10**400}]}})["quota"]["windows"], [])
        self.assertEqual(hook.claude_usage({"context_window": None, "rate_limits": []}, self.observed), {})
        value = hook.claude_usage({"rate_limits": {"five_hour": {
            "used_percentage": 0, "resets_at": self.observed - 1}}}, self.observed)
        self.assertEqual(value["quota"]["windows"], [])


if __name__ == "__main__":
    unittest.main()
