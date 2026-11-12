// Run with node --experimental-vm-modules tests/test_extension.mjs.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const base = new URL('../gnome-extension/agent-status-indicator@Ruochen0513.github.io/', import.meta.url);
const loggedErrors = [];
const timers = new Map();
const monitors = [];
const streams = [];
const pendingReads = [];
const openedUrls = [];
const sources = [];
const sounds = [];
const files = new Map();
const reads = new Map();
const directories = new Set(['/', '/cache', '/cache/agent-status-indicator', '/config']);
const registrations = new Map();
const statePath = '/cache/agent-status-indicator/state.json';
const configPath = '/config/agent-status-indicator/gnome.json';
let timerId = 0;
let monitorFailure = false;
const failedMonitorPaths = new Set();
let notificationFailure = false;
let audioFailure = false;
let clipboard = '';
class GLibError extends Error {
    constructor(message, code) { super(message); this.code = code; }
    matches(_domain, code) { return this.code === code; }
}
class Cancellable {
    cancelled = false;
    cancel() { this.cancelled = true; }
    is_cancelled() { return this.cancelled; }
}
function checkCancelled(cancellable) {
    if (cancellable?.is_cancelled())
        throw new GLibError('cancelled', 2);
}
function file(path) {
    return {
        path,
        equal(other) { return path === other?.path; },
        get_parent() { return path === '/' ? null : file(path.slice(0, path.lastIndexOf('/')) || '/'); },
        query_exists() { return directories.has(path) || files.has(path); },
        monitor_directory() {
            if (monitorFailure || failedMonitorPaths.has(path))
                throw Error('monitor unavailable');
            const monitor = {
                path, cancelled: false,
                connect(_signal, callback) { this.callback = callback; return 1; },
                disconnect() { this.callback = null; },
                cancel() { this.cancelled = true; },
            };
            monitors.push(monitor);
            return monitor;
        },
        read_async(_priority, cancellable, callback) {
            reads.set(path, (reads.get(path) || 0) + 1);
            pendingReads.push({file: this, cancellable, callback, payload: files.get(path)});
        },
        read_finish(result) {
            checkCancelled(result.cancellable);
            if (result.payload instanceof Error)
                throw result.payload;
            if (result.payload === undefined)
                throw new GLibError('not found', 1);
            const data = Buffer.from(result.payload);
            const stream = {
                offset: 0, closed: false,
                read_bytes_async(count, _priority, cancellable, callback) {
                    const chunk = data.subarray(this.offset, this.offset + count);
                    this.offset += chunk.length;
                    queueMicrotask(() => callback(this, {chunk, cancellable}));
                },
                read_bytes_finish(response) {
                    checkCancelled(response.cancellable);
                    return {get_data: () => response.chunk};
                },
                close_async(_priority, _cancellable, callback) {
                    this.closed = true;
                    queueMicrotask(() => callback(this, {}));
                },
                close_finish() { return true; },
            };
            streams.push(stream);
            return stream;
        },
        make_directory_with_parents() { directories.add(path); },
        replace_contents_bytes_async(bytes, _etag, _backup, flags, cancellable, callback) {
            assert.equal(flags, 4, 'preferences must be private');
            queueMicrotask(() => {
                if (!cancellable.is_cancelled()) {
                    files.set(path, new TextDecoder().decode(bytes.data));
                    emit(path);
                }
                callback(this, {cancellable});
            });
        },
        replace_contents_finish(result) { checkCancelled(result.cancellable); return [true, 'etag']; },
    };
}
function completeRead(index = 0) {
    const request = pendingReads.splice(index, 1)[0];
    assert(request, 'expected a pending asynchronous read');
    request.callback(request.file, request);
}
async function drain() {
    for (let index = 0; index < 150; index++)
        await Promise.resolve();
}
async function settle() {
    for (let index = 0; index < 100; index++) {
        await drain();
        if (!pendingReads.length)
            return;
        completeRead();
    }
    throw Error('reads did not settle');
}
function emit(path, other = null) {
    const parent = path.slice(0, path.lastIndexOf('/')) || '/';
    for (const monitor of [...monitors]) {
        if (!monitor.cancelled && (monitor.path === parent || monitor.path === path))
            monitor.callback?.(monitor, file(path), other ? file(other) : null, 0);
    }
}
function runTimers(delay) {
    for (const [id, timer] of [...timers]) {
        if (timer.delay !== delay)
            continue;
        timers.delete(id);
        assert.equal(timer.callback(), false, 'sources must be one-shot');
    }
}
async function updateState(value) {
    files.set(statePath, typeof value === 'string' ? value : JSON.stringify(value));
    emit(statePath);
    runTimers(100);
    await settle();
}
class MenuItem {
    constructor(text) { this.label = {set_text: value => { this.text = value; }}; this.text = text; }
}
class Menu {
    items = [];
    actions = [];
    addMenuItem(item) { this.items.push(item); }
    addAction(label, callback) {
        const action = new MenuItem(label);
        action.callback = callback;
        this.actions.push(action);
        return action;
    }
    removeAll() { this.items = []; this.actions = []; }
    open() { this.isOpen = true; }
}
class SubMenu extends MenuItem {
    constructor(text) { super(text); this.menu = new Menu(); }
}
class Button {
    constructor() { this.menu = new Menu(); }
    add_child(icon) { this.icon = icon; }
    set_accessible_name(value) { this.accessible = value; }
    show() { this.visible = true; }
    destroy() { this.destroyed = true; registrations.delete('test-extension'); }
}
class Icon {
    constructor(props) { Object.assign(this, props); }
    set_style(value) { this.style = value; }
}
class Source {
    constructor(props) { Object.assign(this, props); this.notifications = []; sources.push(this); }
    connect(_signal, callback) { this.onDestroy = callback; }
    addNotification(notification) {
        if (notificationFailure)
            throw Error('notifications unavailable');
        this.notifications.push(notification);
        if (this.notifications.length > 3)
            this.notifications.shift();
    }
    destroy() { this.destroyed = true; this.notifications = []; this.onDestroy?.(); }
}
const context = vm.createContext({
    TextDecoder, TextEncoder, Uint8Array, console: {error(message) { loggedErrors.push(message); }},
    global: {display: {get_sound_player() {
        if (audioFailure)
            throw Error('audio unavailable');
        return {
            play_from_theme: name => sounds.push(name),
            play_from_file: path => sounds.push(path.path),
        };
    }}},
});
const model = new vm.SourceTextModule(fs.readFileSync(new URL('state.js', base), 'utf8'), {context});
await model.link(() => { throw Error('unexpected import'); });
await model.evaluate();
const {summarize, sessionRows, AlertCursor, preferences} = model.namespace;
for (const state of ['working', 'approval', 'error']) {
    const result = summarize({ttl_seconds: 1, sessions: {codex: {s: {state, updated_at: 1}}}});
    assert.equal(result.status, state);
}
assert.throws(() => summarize(null));
assert.throws(() => summarize([]));
assert.equal(summarize({agents: {codex: {state: 'error'}}, sessions: {codex: {}}}).status, 'idle');
assert.equal(summarize({agents: {codex: {state: 'working'}}}).status, 'working');
assert.equal(summarize({sessions: {codex: {s: {state: 'working'}}, claude: {s: {state: 'approval'}}}}).status, 'approval');
const rows = sessionRows({sessions: {codex: {
    a: {state: 'idle', event: 'SessionStart', project: '/private/demo'},
    b: {state: 'idle', event: 'Stop', project: 'demo'},
    c: {state: 'approval', attention: 'decision'},
}}});
assert.equal(rows.length, 3);
assert.equal(rows.find(row => row.session === 'a').state, 'idle');
assert.equal(rows.find(row => row.session === 'a').project, 'demo');
assert.equal(rows.find(row => row.session === 'b').state, 'finished');
assert.equal(rows.find(row => row.session === 'c').state, 'decision');
assert.equal(new Set(rows.map(row => row.short)).size, 3);
assert.equal(preferences({sounds: {error: false}}).notifications.error, true);
assert.equal(preferences({sounds: {error: false}}).sounds.error, false);
assert.equal(preferences({sound_files: {error: 'relative.wav'}}).sound_files.error, undefined);
for (const invalid of [null, [], false, 1, 'invalid', {mute_all: 'true'},
    {notifications: []}, {sounds: null}, {sounds: {error: 'false'}}, {sound_files: {error: 42}}])
    assert.throws(() => preferences(invalid));
function log(sequence, events = [], generation = 'one') {
    return {alerts: {generation, sequence, events}};
}
function event(sequence, kind = 'completion', session = 'codex:s') {
    return {sequence, kind, session, agent: 'codex', project: 'demo'};
}
const cursor = new AlertCursor();
assert.equal(cursor.read(log(1, [event(1)])).events.length, 0, 'startup is silent');
assert.equal(cursor.read(log(2, [event(1), event(2)])).events.length, 1);
assert.equal(cursor.read(log(2, [event(2)])).events.length, 0, 'replays are silent');
cursor.read({}, true);
assert.equal(cursor.read(log(2, [event(2)])).events.length, 0, 'temporary removal cannot replay');
assert.match(cursor.read(log(10, [event(10)])).warning, /gap/);
assert.equal(cursor.read(log(1, [event(1)], 'new')).events.length, 0, 'resets are silent');
const fresh = new AlertCursor();
fresh.read({}, true);
assert.equal(fresh.read(log(1, [event(1)])).events.length, 1, 'first live event after missing startup');
const imports = {
    'gi://GLib': {default: {
        PRIORITY_DEFAULT: 0, SOURCE_REMOVE: false, Error: GLibError,
        get_user_cache_dir: () => '/cache', get_user_config_dir: () => '/config',
        build_filenamev: parts => parts.join('/'),
        timeout_add: (_priority, delay, callback) => { timers.set(++timerId, {delay, callback}); return timerId; },
        source_remove: id => { timers.delete(id); },
        shell_quote: value => "'" + value + "'",
        Bytes: class { constructor(data) { this.data = data; } },
    }},
    'gi://Gio': {default: {
        Cancellable, IOErrorEnum: {NOT_FOUND: 1, EXISTS: 3}, FileMonitorFlags: {WATCH_MOVES: 1},
        FileCreateFlags: {PRIVATE: 4}, File: {new_for_path: file},
        AppInfo: {launch_default_for_uri: url => openedUrls.push(url)},
    }},
    'gi://St': {default: {
        Icon, ClipboardType: {CLIPBOARD: 1},
        Clipboard: {get_default: () => ({set_text: (_type, text) => { clipboard = text; }})},
    }},
    'gi://Clutter': {default: {ActorAlign: {CENTER: 1}}},
    'resource:///org/gnome/shell/ui/main.js': {
        panel: {addToStatusArea(id, button, position, side) {
            assert.equal(side, 'left'); assert.equal(position, 0);
            assert(!registrations.has(id)); registrations.set(id, button);
        }},
        messageTray: {add() {}},
    },
    'resource:///org/gnome/shell/ui/messageTray.js': {
        Source, Notification: class { constructor(props) { Object.assign(this, props); } },
        Urgency: {NORMAL: 1, HIGH: 2},
    },
    'resource:///org/gnome/shell/ui/panelMenu.js': {Button},
    'resource:///org/gnome/shell/ui/popupMenu.js': {PopupMenuItem: MenuItem, PopupSubMenuMenuItem: SubMenu},
    'resource:///org/gnome/shell/extensions/extension.js': {
        Extension: class {uuid = 'test-extension'; metadata = {url: 'https://github.com/Ruochen0513/agent-status-indicator'};},
    },
};
const alertsModule = new vm.SourceTextModule(fs.readFileSync(new URL('alerts.js', base), 'utf8'), {context});
const extension = new vm.SourceTextModule(fs.readFileSync(new URL('extension.js', base), 'utf8'), {context});
async function link(specifier) {
    if (specifier === './state.js')
        return model;
    if (specifier === './alerts.js')
        return alertsModule;
    const values = imports[specifier];
    assert(values, specifier);
    const module = new vm.SyntheticModule(Object.keys(values), function() {
        for (const [key, value] of Object.entries(values))
            this.setExport(key, value);
    }, {context});
    await module.link(() => {});
    await module.evaluate();
    return module;
}
await alertsModule.link(link);
await alertsModule.evaluate();
await extension.link(link);
await extension.evaluate();
const isolatedAlerts = new alertsModule.namespace.Alerts(message => loggedErrors.push(message));
const audioOnly = preferences({notifications: Object.fromEntries(
    ['completion', 'permission', 'decision', 'error'].map(kind => [kind, false])),
    sound_files: {error: '/tmp/error.wav'}});
isolatedAlerts.dispatch([event(1, 'completion'), event(2, 'permission'), event(3, 'decision'), event(4, 'error')], audioOnly);
assert.equal(sources.length, 0, 'visual categories can be disabled independently');
runTimers(1000);
assert.equal(sounds.at(-1), '/tmp/error.wav', 'highest-priority custom sound wins the burst');
isolatedAlerts.destroy();
const instance = new extension.namespace.default();
files.set(statePath, JSON.stringify({...log(1, [event(1)]), sessions: {codex: {s: {state: 'working'}}}}));
instance.enable();
await settle();
assert.equal(instance._dot.icon_size, 14);
assert.match(instance._dot.style, /#2ea043/);
assert.equal(sources.length, 0, 'no notification at startup');
assert.equal(timers.size, 0, 'no periodic refresh source');
assert(monitors.some(monitor => !monitor.cancelled && monitor.path === '/config'));
instance._button.menu.actions.find(action => /Set up/.test(action.text)).callback();
assert.match(openedUrls.at(-1), /#enabling-agent-hooks$/);
const count = reads.get(statePath);
emit('/cache/agent-status-indicator/state.lock');
emit('/cache/agent-status-indicator/state.tmp');
assert.equal(timers.size, 0, 'ignore unrelated writes');
files.set(statePath, JSON.stringify({...log(2, [event(1), event(2)]), sessions: {codex: {s: {state: 'working'}}}}));
for (let index = 0; index < 10; index++)
    emit('/cache/agent-status-indicator/state.tmp', statePath);
assert.equal(timers.size, 1, 'debounce atomic rename bursts');
runTimers(100);
await settle();
assert.equal(reads.get(statePath), count + 1);
assert.equal(sources[0].notifications[0].body, 'Finished responding', 'history retains intermediate completion');
await updateState({...log(2, [event(2)]), sessions: {codex: {s: {state: 'working'}}}});
assert.equal(sources[0].notifications.length, 1);
runTimers(1000);
assert.equal(sounds.at(-1), 'complete');
await updateState({...log(2, [event(2)]), sessions: {codex: {s: {state: 'idle', event: 'Stop'}}}});
assert.match(instance._summary.text, /Finished responding/);
const burst = Array.from({length: 10}, (_unused, index) => event(index + 3, 'error', 'session-' + index));
await updateState({...log(12, burst), sessions: {codex: Object.fromEntries(
    burst.map(item => [item.session, {state: 'error', project: 'same'}]))}});
assert.equal(sources.filter(source => !source.destroyed).length, 11, 'separate sources preserve ten-session bursts');
assert.equal([...timers.values()].filter(timer => timer.delay === 1000).length, 1);
runTimers(1000);
assert.equal(sounds.at(-1), 'dialog-error');
const codexGroup = instance._sessions.menu.items.find(item => item.text === 'Codex');
assert.equal(codexGroup.menu.items.length, 10);
codexGroup.menu.items[0].menu.open();
const preservedRow = codexGroup.menu.items[0];
await updateState({...log(12, burst), sessions: {codex: Object.fromEntries(
    burst.map(item => [item.session, {state: 'error', project: 'same', updated_at: 1}]))}});
assert.equal(instance._groupWidgets.get('codex').menu.items[0], preservedRow, 'ordinary events preserve open menu actors');
assert.equal(preservedRow.menu.isOpen, true);
codexGroup.menu.items[0].menu.actions[0].callback();
assert.match(clipboard, /^agent-status update codex idle --session '/);
assert.match(instance._detail.text, /Review and run/);
await updateState({...log(12, burst), sessions: {codex: Object.fromEntries(
    Array.from({length: 150}, (_unused, index) => ['page-' + index, {state: 'working'}]))}});
assert.equal(instance._rowWidgets.size, 50, 'large files cannot allocate unbounded menu actors');
const firstPage = [...instance._rowWidgets.keys()][0];
instance._groupWidgets.get('codex').menu.actions.find(action => action.text === 'Next sessions').callback();
assert.notEqual([...instance._rowWidgets.keys()][0], firstPage);
assert.equal(instance._rowWidgets.size, 50);
await updateState({...log(12, burst), sessions: {codex: Object.fromEntries(
    burst.map(item => [item.session, {state: 'error', project: 'same'}]))}});
for (const invalid of ['null', '[]', '{broken', 'x'.repeat(1048577)]) {
    await updateState(invalid);
    assert.match(instance._dot.style, /#f85149/);
    assert.equal(sessionRows(instance._lastState).length, 10, 'retain valid sessions');
}
assert(streams.every(stream => stream.closed), 'all streams closed, including oversized input');
await updateState({...log(13, [...burst, event(13, 'permission')]), sessions: {codex: {s: {state: 'approval'}}}});
assert.match(instance._dot.style, /#d29922/);
// A change during a read must cause a follow-up without parallel state reads.
files.set(statePath, JSON.stringify(log(14, [event(14)])));
emit(statePath);
runTimers(100);
assert.equal(pendingReads.length, 1);
files.set(statePath, JSON.stringify(log(15, [event(14), event(15)])));
emit(statePath);
runTimers(100);
assert.equal(pendingReads.length, 1);
await settle();
runTimers(100);
await settle();
assert.equal(instance._cursor.sequence, 15);
const notificationsBeforeMute = sources.reduce((total, source) => total + source.notifications.length, 0);
files.set(configPath, JSON.stringify({mute_all: true}));
directories.add('/config/agent-status-indicator');
emit('/config/agent-status-indicator');
emit(configPath);
files.set(statePath, JSON.stringify(log(16, [event(16, 'error')])));
emit(statePath);
runTimers(100);
await settle();
assert.equal(instance._preferences.mute_all, true);
assert.equal(sources.reduce((total, source) => total + source.notifications.length, 0), notificationsBeforeMute);
assert(![...timers.values()].some(timer => timer.delay === 1000), 'mute cancels queued sound');
await instance._toggleMute();
await settle();
runTimers(100);
await settle();
assert.equal(JSON.parse(files.get(configPath)).mute_all, false);
files.set(configPath, '{broken');
emit(configPath);
runTimers(100);
await settle();
assert.match(instance._detail.text, /preferences/);
assert.equal(instance._preferences.mute_all, false, 'bad config preserves settings');
files.set(configPath, JSON.stringify({mute_all: true, sounds: {completion: false}}));
emit(configPath);
runTimers(100);
await settle();
for (const invalid of [null, [], 1, 'invalid', {mute_all: 'false'},
    {notifications: []}, {sounds: {error: 'false'}}, {sound_files: null}]) {
    files.set(configPath, JSON.stringify(invalid));
    emit(configPath);
    runTimers(100);
    await settle();
    assert.equal(instance._preferences.mute_all, true, 'invalid JSON values must not unmute alerts');
    assert.equal(instance._preferences.sounds.completion, false);
    assert.match(instance._detail.text, /preferences/);
}
files.set(configPath, '{}');
emit(configPath);
runTimers(100);
await settle();
notificationFailure = true;
audioFailure = true;
await updateState(log(17, [event(17, 'error')]));
runTimers(1000);
assert(loggedErrors.some(message => /notification/.test(message)));
assert(loggedErrors.some(message => /sound/.test(message)));
notificationFailure = false;
audioFailure = false;
files.delete(statePath);
emit(statePath);
runTimers(100);
await settle();
assert.match(instance._detail.text, /Set up the companion/);
directories.delete('/cache/agent-status-indicator');
emit('/cache/agent-status-indicator');
runTimers(100);
await settle();
assert(monitors.some(monitor => !monitor.cancelled && monitor.path === '/cache'));
directories.add('/cache/agent-status-indicator');
emit('/cache/agent-status-indicator');
files.set(statePath, JSON.stringify(log(18, [event(18)])));
runTimers(100);
await settle();
assert(monitors.some(monitor => !monitor.cancelled && monitor.path === '/cache/agent-status-indicator'));
// Render exceptions must not wedge the read flag or monitoring.
const setStyle = instance._dot.set_style;
instance._dot.set_style = () => { throw Error('temporary actor error'); };
await updateState(log(19, [event(19)]));
assert.equal(instance._reading, false);
instance._dot.set_style = setStyle;
await updateState(log(20, [event(20)]));
const oldCancellable = instance._cancellable;
files.set(statePath, JSON.stringify(log(21, [event(21)])));
emit(statePath);
runTimers(100);
assert.equal(pendingReads.length, 1);
instance.disable();
assert(oldCancellable.is_cancelled());
assert.equal(registrations.size, 0);
assert(monitors.every(monitor => monitor.cancelled));
assert.equal(timers.size, 0);
instance.enable();
await settle();
assert.equal(instance._cursor.sequence, 21, 'old callback cannot touch the new enable cycle');
assert.equal(instance._reading, false);
instance.disable();
assert.equal(pendingReads.length, 0);
assert.equal(timers.size, 0);
assert(sources.every(source => source.destroyed));
// Unsupported monitoring gets bounded one-shot recovery, never status polling.
monitorFailure = true;
instance.enable();
await settle();
for (const delay of [1000, 2000, 4000, 8000, 16000, 30000]) {
    runTimers(delay);
    runTimers(100);
    await settle();
}
assert.equal(instance._recoveryAttempt, 6);
assert.equal(timers.size, 0);
instance.disable();
monitorFailure = false;
// Either missing required watch must retain recovery, even if the other succeeds.
for (const path of ['/cache/agent-status-indicator', '/cache', '/config/agent-status-indicator']) {
    failedMonitorPaths.add(path);
    instance.enable();
    await settle();
    assert.notEqual(instance._recoveryId, 0, 'partial monitoring failure needs bounded recovery');
    assert(monitors.some(monitor => !monitor.cancelled), 'the working watch is retained');
    failedMonitorPaths.delete(path);
    runTimers(1000);
    runTimers(100);
    await settle();
    assert.equal(instance._recoveryId, 0);
    assert(monitors.some(monitor => !monitor.cancelled && monitor.path === path));
    if (path.startsWith('/cache')) {
        const before = reads.get(statePath);
        await updateState(log(22, [event(22)]));
        assert.equal(reads.get(statePath), before + 1, 'state updates resume after recovery');
    } else {
        files.set(configPath, JSON.stringify({mute_all: true}));
        emit(configPath);
        runTimers(100);
        await settle();
        assert.equal(instance._preferences.mute_all, true, 'config updates resume after recovery');
    }
    instance.disable();
    assert.equal(timers.size, 0);
}
console.log('GNOME monitoring, bounded reads, sessions, alert history, sounds, preferences and reload lifecycle passed');
