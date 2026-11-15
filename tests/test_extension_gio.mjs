// Run with gjs -m tests/test_extension_gio.mjs. No running Shell is required.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import {readJson, writeJson} from '../gnome-extension/agent-status-indicator@Ruochen0513.github.io/io.js';
import * as State from '../gnome-extension/agent-status-indicator@Ruochen0513.github.io/state.js';

const root = Gio.File.new_for_uri(import.meta.url).get_parent().get_parent();
const sourceFile = root.resolve_relative_path(
    'gnome-extension/agent-status-indicator@Ruochen0513.github.io/extension.js');
const [, bytes] = sourceFile.load_contents(null);
// Bind only the Shell-facing imports to stubs; exercise the shipped GIO code.
const source = new TextDecoder().decode(bytes).replace(/^import .*;$/gm, '')
    .replace('export default class', 'class').replace('export async function', 'async function');
const bindings = {
    GLib, Gio, St: {}, Clutter: {}, Main: {}, PanelMenu: {}, PopupMenu: {},
    Extension: class {}, ...State, readJson, Alerts: class {},
};
const {AgentStatusExtension} = new Function(...Object.keys(bindings),
    source + '; return {AgentStatusExtension};')(...Object.values(bindings));
const directory = Gio.File.new_for_path(GLib.dir_make_tmp('agent-status-gio-XXXXXX'));
const stateDirectory = directory.get_child('state');
const stateFile = stateDirectory.get_child('state.json');
const temporary = stateDirectory.get_child('state.tmp');
const configDirectory = directory.get_child('config');
const configFile = configDirectory.get_child('gnome.json');
const usageDirectory = directory.get_child('usage').get_child('nested');
const usageFile = usageDirectory.get_child('usage.json');
const loop = new GLib.MainLoop(null, false);
const instance = new AgentStatusExtension();
instance._monitors = [];
instance._metrics = new Map();
instance._rowWidgets = new Map();
instance._groupWidgets = new Map();
instance._refreshId = 0;
instance._cancellable = new Gio.Cancellable();
instance._reportError = message => { throw Error(message); };
let stage = 0;
let failure = null;
let deadline = 0;
function finish(error = null) {
    failure = error;
    if (deadline)
        GLib.source_remove(deadline);
    deadline = 0;
    loop.quit();
}
function replaceState(value) {
    temporary.replace_contents(JSON.stringify({value}), null, false, Gio.FileCreateFlags.PRIVATE, null);
    temporary.move(stateFile, Gio.FileCopyFlags.OVERWRITE, null, null);
}
instance._refresh = async () => {
    try {
        instance._clearMonitors();
        instance._watchFile(stateFile, 'state');
        const data = await readJson(stateFile, instance._cancellable);
        if (stage === 0) {
            if (data.value !== 1)
                throw Error('directory creation was not observed');
            stage = 1;
            replaceState(2);
        } else if (stage === 1) {
            if (data.value !== 2)
                throw Error('second atomic replacement was not observed');
            stage = 2;
            instance._clearMonitors();
            replaceState('x'.repeat(100));
            let rejected = false;
            try {
                await readJson(stateFile, instance._cancellable, 32);
            } catch (error) {
                rejected = /size limit/.test(error.message);
            }
            if (!rejected)
                throw Error('bounded read accepted oversized input');
            configDirectory.make_directory(null);
            configFile.replace_contents(JSON.stringify({sounds: {error: false}}), null, false, Gio.FileCreateFlags.PRIVATE, null);
            instance._configFile = configFile;
            instance._legacyPreferences = {sounds: {error: false}};
            instance._preferences = State.preferences(instance._legacyPreferences);
            let muted = null;
            instance._settings = {
                set_boolean(_key, value) { muted = value; return true; },
                get_user_value(key) { return key === 'mute-all' && muted !== null ? {} : null; },
                get_boolean() { return muted; },
            };
            instance._render = () => {};
            instance._alerts = {cancelSound() {}, destroy() {}};
            instance._settings.set_boolean('mute-all', true);
            instance._preferences = State.settingsPreferences(instance._settings, instance._legacyPreferences);
            const config = await readJson(configFile, instance._cancellable);
            const mode = configFile.query_info('unix::mode', Gio.FileQueryInfoFlags.NONE, null).get_attribute_uint32('unix::mode');
            if (!instance._preferences.mute_all || instance._preferences.sounds.error !== false
                || config.sounds.error !== false || Object.hasOwn(config, 'mute_all') || (mode & 0o777) !== 0o600)
                throw Error('native mute did not preserve legacy preferences');
            await writeJson(usageFile, {codex_metadata: true}, instance._cancellable);
            const usageMode = usageFile.query_info('unix::mode', Gio.FileQueryInfoFlags.NONE, null).get_attribute_uint32('unix::mode');
            if ((usageMode & 0o777) !== 0o600 || !(await readJson(usageFile, instance._cancellable)).codex_metadata)
                throw Error('usage consent was not privately saved');
            const oldStream = usageFile.read(null);
            await writeJson(usageFile, {codex_metadata: false}, instance._cancellable);
            const oldValue = JSON.parse(new TextDecoder().decode(oldStream.read_bytes(4096, null).get_data()));
            oldStream.close(null);
            if (!oldValue.codex_metadata || (await readJson(usageFile, instance._cancellable)).codex_metadata)
                throw Error('usage consent replacement was not atomic');
            const cancelled = new Gio.Cancellable();
            cancelled.cancel();
            let cancelledWrite = false;
            try {
                await writeJson(usageFile, {codex_metadata: true}, cancelled);
            } catch (error) {
                cancelledWrite = error.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED);
            }
            if (!cancelledWrite || (await readJson(usageFile, instance._cancellable)).codex_metadata)
                throw Error('cancelled consent write changed the saved preference');
            finish();
        }
    } catch (error) {
        finish(error);
    }
};
instance._watchFile(stateFile, 'state');
deadline = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 5000, () => {
    deadline = 0;
    finish(Error('directory monitoring timed out'));
    return GLib.SOURCE_REMOVE;
});
stateDirectory.make_directory(null);
replaceState(1);
loop.run();
instance.disable();
for (const item of [temporary, stateFile, stateDirectory, configFile, configDirectory, usageFile, usageDirectory, usageDirectory.get_parent(), directory]) {
    if (item.query_exists(null))
        item.delete(null);
}
if (failure)
    throw failure;
if (stage !== 2)
    throw Error('monitoring test did not complete');
print('Native GIO directory creation, atomic replacements, bounded reads, legacy preferences and private atomic usage consent passed');
