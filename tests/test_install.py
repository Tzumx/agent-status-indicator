"""Exercise installation and upgrades in an isolated user directory."""
import json
import os
from pathlib import Path
import subprocess
import tempfile
import sys
import unittest

ROOT = Path(__file__).resolve().parents[1]


class InstallTests(unittest.TestCase):
    def test_gnome_only_does_not_install_or_activate_services_or_desktop(self):
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory)
            fake_bin = home / 'fake-bin'
            fake_bin.mkdir()
            log = home / 'commands'
            for command in ('systemctl', 'gnome-extensions'):
                executable = fake_bin / command
                executable.write_text('#!/bin/sh\n' + f'echo {command} "$@" >> "{log}"\n')
                executable.chmod(0o755)
            env = {**os.environ, 'HOME': str(home), 'PATH': str(fake_bin) + os.pathsep + os.environ['PATH'],
                   'XDG_DATA_HOME': str(home / 'data'), 'XDG_CONFIG_HOME': str(home / 'config'),
                   'XDG_CACHE_HOME': str(home / 'cache')}
            result = subprocess.run(['bash', str(ROOT / 'install.sh'), '--gnome-only'], env=env,
                                    capture_output=True, text=True, timeout=10)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertNotIn('systemctl', log.read_text())
            self.assertIn('gnome-extensions enable', log.read_text())
            for path in ('config/systemd', 'data/agent-status-indicator', '.local/bin/agent-status-desktop', '.codex', '.claude'):
                self.assertFalse((home / path).exists(), path)
            for name in ('agent-status', 'agent-status-hook', 'agent_status_state.py'):
                self.assertTrue((home / '.local/bin' / name).exists())
            extension = home / 'data/gnome-shell/extensions/agent-status-indicator@Ruochen0513.github.io'
            self.assertTrue((extension / 'alerts.js').exists())
            self.assertTrue((extension / 'io.js').exists())
            self.assertTrue((extension / 'prefs.js').exists())
            self.assertTrue((extension / 'stylesheet.css').exists())
            self.assertEqual((extension / 'robot-head-symbolic.svg').read_bytes(),
                             (ROOT / 'gnome-extension/agent-status-indicator@Ruochen0513.github.io/robot-head-symbolic.svg').read_bytes())
            result = subprocess.run([str(home / '.local/bin/agent-status-hook'), '--agent', 'claude', '--event', 'Stop'],
                                    input=json.dumps({'session_id': 's'}), env=env, capture_output=True, text=True, timeout=5)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertTrue((home / 'cache/agent-status-indicator/state.json').exists())

    def test_uninstall_without_user_manager_preserves_hooks_and_respects_xdg(self):
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory)
            fake_bin = home / 'fake-bin'
            fake_bin.mkdir()
            for command in ('systemctl', 'gnome-extensions'):
                executable = fake_bin / command
                executable.write_text('#!/bin/sh\nexit 1\n')
                executable.chmod(0o755)
            env = {**os.environ, 'HOME': str(home), 'PATH': str(fake_bin) + os.pathsep + os.environ['PATH'],
                   'XDG_DATA_HOME': str(home / 'data'), 'XDG_CONFIG_HOME': str(home / 'config'),
                   'XDG_CACHE_HOME': str(home / 'cache'), 'XDG_RUNTIME_DIR': str(home / 'runtime'),
                   'CODEX_HOME': str(home / 'codex'), 'PYTHON_BIN': sys.executable}
            result = subprocess.run(['bash', str(ROOT / 'install.sh'), '--gnome-only', '--no-start'],
                                    env=env, capture_output=True, text=True, timeout=10)
            self.assertEqual(result.returncode, 0, result.stderr)
            hooks = home / 'codex/hooks.json'
            hooks.parent.mkdir()
            hooks.write_text('{"unrelated": true}')
            cache = home / 'cache/agent-status-indicator'
            cache.mkdir(parents=True)
            (cache / 'state.json').write_text('{}')
            default_cache = home / '.cache/agent-status-indicator'
            default_cache.mkdir(parents=True)
            (default_cache / 'unrelated').write_text('keep')
            unrelated_service = home / 'config/systemd/user/unrelated.service'
            unrelated_service.parent.mkdir(parents=True)
            unrelated_service.write_text('keep')
            for keep_config in (True, False):
                result = subprocess.run(['bash', str(ROOT / 'uninstall.sh')] + (['--keep-config'] if keep_config else []),
                                        env=env, capture_output=True, text=True, timeout=10)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertFalse((home / '.local/bin/agent-status').exists())
                self.assertFalse((home / 'data/gnome-shell/extensions/agent-status-indicator@Ruochen0513.github.io').exists())
                self.assertEqual(cache.exists(), keep_config)
                self.assertEqual(json.loads(hooks.read_text()), {'unrelated': True})
                self.assertEqual((default_cache / 'unrelated').read_text(), 'keep')
                self.assertEqual(unrelated_service.read_text(), 'keep')

    def test_upgrade_preserves_unrelated_hooks_and_existing_extension_identity(self):
        with tempfile.TemporaryDirectory(prefix='status install ') as directory:
            home = Path(directory)
            legacy_uuid = 'agent-status-indicator@yuhaozhang.github.io'
            extension = home / '.local/share/gnome-shell/extensions' / legacy_uuid
            extension.mkdir(parents=True)
            hook_file = home / '.codex/hooks.json'
            hook_file.parent.mkdir()
            hook_file.write_text(json.dumps({'unrelated': 42, 'hooks': {
                'PreToolUse': [{'matcher': '*', 'hooks': [
                    {'type': 'command', 'command': 'agent-status-hook --agent codex --event PreToolUse'},
                    {'type': 'command', 'command': 'my-existing-hook'},
                ]}],
                'SubagentStop': [{'hooks': [{'type': 'command', 'command': 'agent-status-hook --agent codex --event SubagentStop'}]}],
            }}))
            # Environment overrides are confined to the child installer process.
            env = {**os.environ, 'HOME': str(home)}
            fake_bin = home / 'fake-bin'
            fake_bin.mkdir()
            fake_codex = fake_bin / 'codex'
            fake_codex.write_text(f"#!{sys.executable}\n" + "import sys,json\nfrom pathlib import Path\np=Path(sys.argv[sys.argv.index('--out')+1])/'v2'/'HooksListResponse.json'\np.parent.mkdir(parents=True,exist_ok=True)\np.write_text(json.dumps({'definitions':{'HookEventName':{'enum':['sessionStart','userPromptSubmit','preToolUse','permissionRequest','postToolUse','stop']}}}))\n")
            fake_codex.chmod(0o755)
            env['PATH'] = str(fake_bin) + os.pathsep + os.environ['PATH']
            for key in ('CODEX_HOME', 'XDG_DATA_HOME', 'XDG_CONFIG_HOME'):
                env.pop(key, None)
            for _ in range(2):
                result = subprocess.run(['bash', str(ROOT / 'install.sh'), '--no-start', '--merge-hooks'], env=env, capture_output=True, text=True, timeout=15)
                self.assertEqual(result.returncode, 0, result.stderr)
                config = json.loads(hook_file.read_text())
                self.assertEqual(config['unrelated'], 42)
                groups = config['hooks']['PreToolUse']
                self.assertEqual(len(groups), 2)
                self.assertEqual(groups[0]['hooks'][0]['command'], 'my-existing-hook')
                self.assertEqual(groups[1]['matcher'], '.*')
                self.assertIn(str(home / '.local/bin/agent-status-hook'), groups[1]['hooks'][0]['command'])
                self.assertNotIn('SubagentStop', config['hooks'])
                self.assertNotIn('Interrupt', config['hooks'])
                self.assertNotIn('SessionEnd', config['hooks'])
                self.assertIn('omitted: SessionEnd, Interrupt', result.stdout)
                self.assertIn('reviewed and trusted', result.stdout)
            self.assertEqual(json.loads((extension / 'metadata.json').read_text())['uuid'], legacy_uuid)
            self.assertTrue((extension / 'state.js').exists())
            self.assertFalse((extension.parent / 'agent-status-indicator@Ruochen0513.github.io').exists())
            backups = list(hook_file.parent.glob('hooks.json.bak-*'))
            self.assertEqual(len(backups), 2)
            self.assertTrue(any('SubagentStop' in backup.read_text() for backup in backups))
            for module in [home / '.local/bin/agent_status_state.py', home / '.local/share/agent-status-indicator/desktop/agent_status_state.py']:
                self.assertEqual(module.read_bytes(), (ROOT / 'bin/agent_status_state.py').read_bytes())
            env['XDG_CACHE_HOME'] = str(home / 'cache')
            result = subprocess.run([str(home / '.local/bin/agent-status'), 'update', 'codex', 'working'], env=env, capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            result = subprocess.run([str(home / '.local/bin/agent-status'), 'get', 'codex'], env=env, capture_output=True, text=True)
            self.assertEqual(json.loads(result.stdout)['state'], 'working')
