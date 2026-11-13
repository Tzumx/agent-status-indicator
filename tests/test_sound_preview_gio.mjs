// Run on a private dbus-run-session bus through test_gnome_io.py.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import {exportSoundPreview, requestSoundPreview, stopSoundPreview} from '../gnome-extension/agent-status-indicator@Ruochen0513.github.io/io.js';

if (GLib.getenv('AGENT_STATUS_TEST_BUS') !== '1')
    throw Error('A disposable session bus is required');
const connection = Gio.DBus.session;
connection.call_sync('org.freedesktop.DBus', '/org/freedesktop/DBus', 'org.freedesktop.DBus',
    'RequestName', new GLib.Variant('(su)', ['org.gnome.Shell', 0]), null, Gio.DBusCallFlags.NONE, 2000, null);
const received = [];
let stops = 0;
function check(value, message) {
    if (!value) throw Error(message);
}
async function rejects(action, predicate) {
    try {
        await action();
    } catch (error) {
        check(predicate(error), error.message);
        return;
    }
    throw Error('Unsafe or unavailable preview was accepted');
}
async function run() {
    const object = exportSoundPreview(kind => {
        if (!['completion', 'error'].includes(kind)) throw Error('Unknown alert sound.');
        received.push(kind);
    }, () => { stops++; });
    try {
        await requestSoundPreview('completion', new Gio.Cancellable());
        check(received.join() === 'completion', 'Preview did not reach the exported service');
        await rejects(() => requestSoundPreview('invalid', new Gio.Cancellable()),
            error => Gio.DBusError.get_remote_error(error).endsWith('.PreviewFailed'));
        check(received.length === 1, 'Invalid preview reached playback');
        await stopSoundPreview();
        check(stops === 1, 'Stop did not reach the exported service');
    } finally {
        object.unexport();
    }
    await rejects(() => requestSoundPreview('completion', new Gio.Cancellable()),
        error => Gio.DBusError.is_remote_error(error));
    const pending = [];
    const slow = Gio.DBusExportedObject.wrapJSObject(`<node><interface name="org.gnome.Shell.Extensions.AgentStatusIndicator">
        <method name="PreviewSound"><arg name="kind" type="s" direction="in"/></method>
    </interface></node>`, {PreviewSoundAsync(_args, invocation) { pending.push(invocation); }});
    slow.export(connection, '/org/gnome/Shell/Extensions/AgentStatusIndicator');
    try {
        await rejects(() => requestSoundPreview('completion', new Gio.Cancellable()),
            error => error.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.TIMED_OUT));
        const cancellable = new Gio.Cancellable();
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 50, () => {
            cancellable.cancel();
            return GLib.SOURCE_REMOVE;
        });
        await rejects(() => requestSoundPreview('completion', cancellable),
            error => error.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED));
    } finally {
        for (const invocation of pending) invocation.return_value(null);
        slow.unexport();
    }
}
const loop = new GLib.MainLoop(null, false);
let failure;
run().then(() => loop.quit(), error => { failure = error; loop.quit(); });
loop.run();
if (failure) throw failure;
print('Native sound preview: dispatch, errors, stop, unexport, timeout and cancellation passed');
