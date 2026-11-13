// Run with a disposable session bus through test_gnome_io.py; no window is opened.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Adw from 'gi://Adw';

if (GLib.getenv('AGENT_STATUS_TEST_BUS') !== '1')
    throw Error('A disposable session bus is required');
for (const name of ['gnome-shell-dbus-interfaces.gresource', 'org.gnome.Shell.Extensions.src.gresource'])
    Gio.resources_register(Gio.Resource.load('/usr/share/gnome-shell/' + name));
const {default: Preferences} = await import('../gnome-extension/agent-status-indicator@Ruochen0513.github.io/prefs.js');
const toasts = [];
const instance = {_closed: false, _window: {add_toast: toast => toasts.push(toast)}};
const detail = 'Cannot read <sound & settings>.ogg';
Preferences.prototype._showError.call(instance, new Error(detail));
const remote = Gio.DBusError.new_for_dbus_error(
    'org.gnome.Shell.Extensions.AgentStatusIndicator.PreviewFailed', detail);
Preferences.prototype._showError.call(instance, remote, 'Could not preview the sound.');
const failures = [];
if (toasts.some(toast => toast.use_markup)) failures.push('Error text is interpreted as markup');
if (toasts[0].title !== 'Changes could not be saved. ' + detail) failures.push('Literal error detail changed');
if (toasts[1].title !== 'Could not preview the sound. ' + detail) failures.push('Remote error leaks its transport prefix');
if (toasts.some(toast => toast.priority !== Adw.ToastPriority.HIGH)) failures.push('Errors can queue behind normal feedback');
instance._closed = true;
Preferences.prototype._showError.call(instance, new Error('Closed window'));
if (toasts.length !== 2) failures.push('A closed preferences window receives feedback');
if (failures.length) throw Error(failures.join('; '));
print('Native preferences: literal errors, clean remote messages, priority and close cleanup passed');
