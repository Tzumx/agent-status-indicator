"""Exercise the extension's GIO code without activating GNOME Shell."""
from pathlib import Path
import os
import tempfile
import shutil
import subprocess
import unittest


class GnomeIOTests(unittest.TestCase):
    @unittest.skipUnless(shutil.which("gjs"), "gjs is optional outside GNOME")
    def test_native_directory_monitor_and_bounded_reads(self):
        script = Path(__file__).with_name("test_extension_gio.mjs")
        result = subprocess.run(["gjs", "-m", str(script)], capture_output=True, text=True, timeout=10)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("Native GIO", result.stdout)

    @unittest.skipUnless(shutil.which("gjs"), "gjs is optional outside GNOME")
    def test_native_refresh_is_bounded_and_cancellable(self):
        script = Path(__file__).with_name("test_usage_refresh_gio.mjs")
        with tempfile.TemporaryDirectory() as directory:
            env = {**os.environ, "HOME": directory, "AGENT_STATUS_TEST_HOME": directory}
            result = subprocess.run(["gjs", "-m", str(script)], env=env,
                                    capture_output=True, text=True, timeout=15)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("Native refresh", result.stdout)
