// Run with gjs -m tests/test_extension_gio.mjs. No running Shell is required.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
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
    Extension: class {}, ...State, Alerts: class {},
};
const {AgentStatusExtension, readJson} = new Function(...Object.keys(bindings),
    source + '; return {AgentStatusExtension, readJson};')(...Object.values(bindings));
const directory = Gio.File.new_for_path(GLib.dir_make_tmp('agent-status-gio-XXXXXX'));
const stateDirectory = directory.get_child('state');
const stateFile = stateDirectory.get_child('state.json');
const temporary = stateDirectory.get_child('state.tmp');
const configDirectory = directory.get_child('config');
const configFile = configDirectory.get_child('gnome.json');
const loop = new GLib.MainLoop(null, false);
const instance = new AgentStatusExtension();
instance._monitors = [];
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
            instance._configFile = configFile;
            instance._preferences = State.preferences();
            instance._render = () => {};
            instance._alerts = {cancelSound() {}, destroy() {}};
            await instance._toggleMute();
            const config = await readJson(configFile, instance._cancellable);
            const mode = configFile.query_info('unix::mode', Gio.FileQueryInfoFlags.NONE, null).get_attribute_uint32('unix::mode');
            if (!config.mute_all || (mode & 0o777) !== 0o600)
                throw Error('native preference write failed or was not private');
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
for (const item of [temporary, stateFile, stateDirectory, configFile, configDirectory, directory]) {
    if (item.query_exists(null))
        item.delete(null);
}
if (failure)
    throw failure;
if (stage !== 2)
    throw Error('monitoring test did not complete');
print('Native GIO directory creation, atomic replacements, bounded reads and private preferences passed');
