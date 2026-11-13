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

    @unittest.skipUnless(shutil.which("gjs") and shutil.which("dbus-run-session")
                         and Path("/usr/share/gnome-shell/org.gnome.Shell.Extensions.src.gresource").exists(),
                         "GNOME preferences resources are optional outside GNOME")
    def test_native_preferences_report_literal_errors(self):
        script = Path(__file__).with_name("test_preferences_gio.mjs")
        env = {**os.environ, "AGENT_STATUS_TEST_BUS": "1", "GIO_USE_VFS": "local"}
        for name, directory in (("GI_TYPELIB_PATH", "/usr/lib/gnome-shell/girepository-1.0"),
                                ("LD_LIBRARY_PATH", "/usr/lib/gnome-shell")):
            env[name] = os.pathsep.join(filter(None, (directory, env.get(name))))
        result = subprocess.run(["dbus-run-session", "--", "gjs", "-m", str(script)],
                                env=env, capture_output=True, text=True, timeout=10)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("Native preferences", result.stdout)

    @unittest.skipUnless(shutil.which("gjs") and shutil.which("dbus-run-session"),
                         "gjs and dbus-run-session are optional outside GNOME")
    def test_native_sound_preview_is_bounded_and_cancellable(self):
        script = Path(__file__).with_name("test_sound_preview_gio.mjs")
        env = {**os.environ, "AGENT_STATUS_TEST_BUS": "1"}
        result = subprocess.run(["dbus-run-session", "--", "gjs", "-m", str(script)],
                                env=env, capture_output=True, text=True, timeout=12)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("Native sound preview", result.stdout)

    @unittest.skipUnless(shutil.which("gjs"), "gjs is optional outside GNOME")
    def test_native_refresh_is_bounded_and_cancellable(self):
        script = Path(__file__).with_name("test_usage_refresh_gio.mjs")
        with tempfile.TemporaryDirectory() as directory:
            env = {**os.environ, "HOME": directory, "AGENT_STATUS_TEST_HOME": directory}
            result = subprocess.run(["gjs", "-m", str(script)], env=env,
                                    capture_output=True, text=True, timeout=15)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("Native refresh", result.stdout)
