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
const previewExports = new Map();
const playbacks = [];
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
const refreshChildren = [];
let refreshOutput = JSON.stringify({status: 'unchanged', checked: 1, updated: 0, unavailable: 0});
let refreshMissing = false;
let refreshWait = false;
class RefreshChild {
    constructor(argv) {
        assert.deepEqual(Array.from(argv), ['/home/test/.local/bin/agent-status-hook', '--agent', 'codex', '--refresh-usage']);
        if (refreshMissing) throw Error('helper not installed');
        refreshChildren.push(this);
        this.output = refreshOutput;
    }
    get_stdout_pipe() { return file('/helper-output').read_finish({payload: this.output}); }
    wait_check_async(cancellable, callback) {
        this.done = () => queueMicrotask(() => callback(this, {cancellable}));
        if (!refreshWait) this.done();
    }
    wait_check_finish(result) {
        checkCancelled(result.cancellable);
        if (this.killed) throw Error('helper terminated');
        return true;
    }
    force_exit() { this.killed = true; this.done?.(); }
}
const settingsValues = new Map();
const settingsSignals = new Map();
let settingsSignalId = 0;
const settings = {
    get_user_value: key => settingsValues.has(key) ? {} : null,
    get_boolean: key => settingsValues.get(key),
    get_string: key => settingsValues.get(key),
    get_strv: key => settingsValues.get(key) ?? [],
    set_strv(key, value) { return this.set_boolean(key, value); },
    set_boolean(key, value) {
        settingsValues.set(key, value);
        for (const callback of settingsSignals.values()) callback(this, key);
        return true;
    },
    set_string(key, value) { return this.set_boolean(key, value); },
    reset(key) {
        settingsValues.delete(key);
        for (const callback of settingsSignals.values()) callback(this, key);
    },
    connect(_signal, callback) { settingsSignals.set(++settingsSignalId, callback); return settingsSignalId; },
    disconnect(id) { settingsSignals.delete(id); },
};
let preferencesOpened = 0;
let clipboard = '';
const scrollRequests = [];
const menuGeometry = {width: 1024, scale: 1, padding: 6, monitor: 1, margin: 0};
class GLibError extends Error {
    constructor(message, code) { super(message); this.code = code; }
    matches(_domain, code) { return this.code === code; }
}
class Cancellable {
    cancelled = false;
    signals = new Map();
    connect(callback) { const id = this.signals.size + 1; this.signals.set(id, callback); return id; }
    disconnect(id) { this.signals.delete(id); }
    cancel() { this.cancelled = true; for (const callback of this.signals.values()) callback(); }
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
        get_child(name) { return file(path + '/' + name); },
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
    add_child(child) { this.children.push(child); child.parent = this; }
    constructor(text) {
        this.label = new Label({text});
        this.children = [this.label];
        this.label.set_text = value => { this.text = value; this.label.text = value; };
        this.text = text;
    }
    remove_style_class_name(value) { this.removedStyle = value; }
}
class Menu {
    constructor() {
        this.signals = new Map();
        this.actor = {style: '', margin_left: 0, margin_right: 0,
            get_theme_node: () => ({get_length: () => menuGeometry.padding})};
    }
    connect(name, callback) {
        const handlers = this.signals.get(name) || [];
        handlers.push(callback);
        this.signals.set(name, handlers);
    }
    emit(name, value) {
        for (const handler of this.signals.get(name) || [])
            handler(this, value);
    }
    items = [];
    actions = [];
    addMenuItem(item) {
        this.items.push(item);
        if (item instanceof Menu)
            item.parentMenu = this;
        else if (item.menu)
            item.menu.parentMenu = this;
    }
    addAction(label, callback) {
        const action = new MenuItem(label);
        action.callback = callback;
        this.actions.push(action);
        return action;
    }
    removeAll() { this.items = []; this.actions = []; }
    open() {
        if (this.isOpen)
            return;
        this.isOpen = true;
        this.emit('open-state-changed', true);
        if (this.parentMenu) {
            let root = this.parentMenu;
            while (root.parentMenu)
                root = root.parentMenu;
            root.openedSubMenu?.close();
            root.openedSubMenu = this;
        }
    }
    close() { this.isOpen = false; this.emit('open-state-changed', false); }
}
class Actor {
    constructor(props = {}) { Object.assign(this, props); this.children = []; this.signals = new Map(); }
    add_child(child) { this.children.push(child); child.parent = this; }
    get_parent() { return this.parent; }
    get_child() { return this.child || null; }
    set_child(child) {
        if (this.child) this.child.parent = null;
        this.child = child;
        if (child) child.parent = this;
    }
    has_key_focus() { return Boolean(this.focused); }
    get_transformed_position() { return [200, 50]; }
    get_transformed_size() { return [28, 28]; }
    get_preferred_width() { return [120, 120]; }
    get_preferred_height() { return [24, 24]; }
    set_position(x, y) { this.position = [x, y]; }
    set_child_above_sibling() {}
    destroy() {
        this.destroyed = true;
        if (this.parent)
            this.parent.children = this.parent.children.filter(child => child !== this);
        this.signals.clear();
    }
    remove_style_class_name(value) { this.removedStyle = value; }
    add_style_class_name(value) { this.addedStyle = value; }
    set_style(value) { this.style = value; }
    connect(name, callback) { this.signals.set(name, callback); }
    set_accessible_name(value) { this.accessible = value; }
}
class Label extends Actor {
    constructor(props) { super(props); this.clutter_text = {}; }
    set_text(value) { this.text = value; }
}
class ActionButton extends Actor {
    click() { this.signals.get('clicked')(); }
    focus() { this.focused = true; this.signals.get('key-focus-in')?.(); }
}
class Section extends Menu {}
class SubMenu extends MenuItem {
    constructor(text) { super(text); this.menu = new Menu(); }
}
class SwitchMenuItem extends Actor {
    constructor(text, state) { super(); this.text = text; this.state = state; }
    toggle() { this.state = !this.state; this.signals.get('toggled')?.(this, this.state); }
}
class Button {
    constructor() {
        this.menu = new Menu();
        this.menu.connect('open-state-changed', () => {
            this.menu.actor.style = 'max-height: 700px;';
            this.menu.actor.margin_left = this.menu.actor.margin_right = menuGeometry.margin;
        });
    }
    add_child(icon) { this.icon = icon; }
    set_accessible_name(value) { this.accessible = value; }
    show() { this.visible = true; }
    destroy() { this.destroyed = true; registrations.delete('test-extension'); }
}
class Icon extends Actor {
    constructor(props) { super(props); }
    set_style(value) { this.style = value; }
}
class Notification {
    constructor(props) { Object.assign(this, props); this.signals = []; }
    connect(_signal, callback) { this.signals.push(callback); }
    destroy(reason) {
        if (this.destroyed) return;
        this.destroyed = true;
        this.reason = reason;
        for (const callback of this.signals) callback(this, reason);
    }
}
class Source {
    constructor(props) { Object.assign(this, props); this.notifications = []; sources.push(this); }
    connect(_signal, callback) { this.onDestroy = callback; }
    addNotification(notification) {
        if (notificationFailure)
            throw Error('notifications unavailable');
        notification.connect('destroy', () => {
            this.notifications = this.notifications.filter(item => item !== notification);
            if (!this.notifications.length && !this.destroyed) this.destroy();
        });
        this.notifications.push(notification);
        if (this.notifications.length > 3)
            this.notifications[0].destroy();
    }
    destroy() {
        if (this.destroyed) return;
        this.destroyed = true;
        for (const notification of [...this.notifications]) notification.destroy();
        this.onDestroy?.();
    }
}

const context = vm.createContext({
    TextDecoder, TextEncoder, Uint8Array, console: {error(message) { loggedErrors.push(message); }},
    global: {stage: {}, display: {get_sound_player() {
        if (audioFailure)
            throw Error('audio unavailable');
        return {
            play_from_theme: (name, _description, cancellable) => {
                sounds.push(name); playbacks.push({name, cancellable});
            },
            play_from_file: (path, _description, cancellable) => {
                sounds.push(path.path); playbacks.push({name: path.path, cancellable});
            },
        };
    }}},
});
const model = new vm.SourceTextModule(fs.readFileSync(new URL('state.js', base), 'utf8'), {context});
await model.link(() => { throw Error('unexpected import'); });
await model.evaluate();
const {summarize, sessionRows, sessionSummary, sessionDetail, COLORS, AlertCursor, preferences} = model.namespace;
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
const exitState = {sessions: {codex: {
    closed: {state: 'idle', event: 'SessionEnd', project: 'shared'},
    finished: {state: 'idle', event: 'Stop', project: 'shared'},
    interrupted: {state: 'idle', event: 'Interrupt'},
}, claude: {
    closed: {state: 'idle', event: 'SessionEnd'},
    ready: {state: 'idle', event: 'SessionStart'},
}}};
const exitSnapshot = JSON.stringify(exitState);
assert.equal(sessionRows(exitState).length, 3, 'only confirmed exits are hidden by default');
assert.equal(sessionRows(exitState).filter(row => row.state === 'finished').length, 1,
    'finished responses stay visible while the CLI is open');
const historyRows = sessionRows(exitState, true);
assert.equal(historyRows.length, 5);
assert.equal(historyRows.filter(row => row.state === 'closed').length, 2);
assert.equal(sessionSummary(historyRows).counts.closed, 2);
assert.equal(JSON.stringify(exitState), exitSnapshot, 'visibility never removes internal records');
assert.equal(preferences().show_closed_sessions, false);
assert.throws(() => preferences({show_closed_sessions: 'true'}));
assert.equal(preferences({sounds: {error: false}}).notifications.error, true);
assert.equal(preferences({sounds: {error: false}}).sounds.error, false);
assert.equal(preferences({sound_files: {error: 'relative.wav'}}).sound_files.error, undefined);
for (const invalid of [null, [], false, 1, 'invalid', {mute_all: 'true'},
    {notifications: []}, {sounds: null}, {sounds: {error: 'false'}}, {sound_files: {error: 42}}])
    assert.throws(() => preferences(invalid));
function log(sequence, events = [], generation = 'one') {
    const sessions = {claude: {}, codex: {}};
    for (const event of events) {
        const state = {completion: 'idle', permission: 'approval', decision: 'approval', error: 'error'}[event.kind];
        sessions[event.agent][event.session] = {state, event: event.kind === 'completion' ? 'Stop' : '',
            attention: event.kind === 'decision' ? 'decision' : ''};
    }
    return {alerts: {generation, sequence, events}, sessions};
}
function event(sequence, kind = 'completion', session = 's') {
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
        get_user_cache_dir: () => '/cache', get_user_config_dir: () => '/config', get_home_dir: () => '/home/test',
        build_filenamev: parts => parts.join('/'),
        timeout_add: (_priority, delay, callback) => { timers.set(++timerId, {delay, callback}); return timerId; },
        source_remove: id => { timers.delete(id); },
        shell_quote: value => "'" + value + "'",
        Bytes: class { constructor(data) { this.data = data; } },
    }},
    'gi://Gio': {default: {
        DBus: {session: {}},
        DBusExportedObject: {wrapJSObject: (_xml, methods) => ({
            export(_connection, path) { assert(!previewExports.has(path)); this.path = path; previewExports.set(path, methods); },
            unexport() { previewExports.delete(this.path); },
        })},
        Subprocess: {new: argv => new RefreshChild(argv)}, SubprocessFlags: {STDOUT_PIPE: 1, STDERR_SILENCE: 2},
        Cancellable, IOErrorEnum: {NOT_FOUND: 1, EXISTS: 3, WRONG_ETAG: 4}, FileMonitorFlags: {WATCH_MOVES: 1},
        ThemedIcon: class {constructor(props) { Object.assign(this, props); }},
        FileIcon: class {constructor(props) { Object.assign(this, props); }},
        FileCreateFlags: {PRIVATE: 4}, FileCopyFlags: {NONE: 0}, File: {new_for_path: file},
        AppInfo: {launch_default_for_uri: url => openedUrls.push(url)},
    }},
    'gi://St': {default: {
        ThemeContext: {get_for_stage: () => ({scale_factor: menuGeometry.scale})},
        Icon, BoxLayout: Actor, Label, Button: ActionButton, ClipboardType: {CLIPBOARD: 1},
        Clipboard: {get_default: () => ({set_text: (_type, text) => { clipboard = text; }})},
    }},
    'gi://Clutter': {default: {ActorAlign: {CENTER: 1}}},
    'gi://Pango': {default: {EllipsizeMode: {START: 1, END: 2, MIDDLE: 3, NONE: 0}}},
    'resource:///org/gnome/shell/ui/main.js': {
        uiGroup: new Actor(),
        panel: {addToStatusArea(id, button, position, side) {
            assert.equal(side, 'right'); assert.equal(position, 0);
            assert(!registrations.has(id)); registrations.set(id, button);
        }},
        layoutManager: {
            findIndexForActor: actor => { assert(actor instanceof Button); return menuGeometry.monitor; },
            getWorkAreaForMonitor: index => {
                assert.equal(index, menuGeometry.monitor, 'use the indicator monitor');
                return {x: 0, y: 0, width: menuGeometry.width, height: 768};
            },
        },
        messageTray: {add() {}},
    },
    'resource:///org/gnome/shell/misc/animationUtils.js': {
        ensureActorVisibleInScrollView: (view, actor) => scrollRequests.push([view, actor]),
    },
    'resource:///org/gnome/shell/ui/animation.js': {
        Spinner: class extends Actor {play() { this.playing = true; } stop() { this.playing = false; }},
    },
    'resource:///org/gnome/shell/ui/messageTray.js': {
        Source, Notification, NotificationDestroyedReason: {EXPIRED: 1, DISMISSED: 2, REPLACED: 4},
        Urgency: {NORMAL: 1, HIGH: 2},
    },
    'resource:///org/gnome/shell/ui/panelMenu.js': {Button},
    'resource:///org/gnome/shell/ui/barLevel.js': {BarLevel: Actor},
    'resource:///org/gnome/shell/misc/loginManager.js': {
        getLoginManager: () => ({connect() { return 1; }, disconnect() {}}),
    },
    'resource:///org/gnome/shell/ui/popupMenu.js': {
        PopupMenuItem: MenuItem, PopupSubMenuMenuItem: SubMenu,
        PopupBaseMenuItem: Actor, PopupMenuSection: Section, PopupSwitchMenuItem: SwitchMenuItem,
    },
    'resource:///org/gnome/shell/extensions/extension.js': {
        Extension: class {getSettings() { return settings; } openPreferences() { preferencesOpened++; } dir = file('/extension'); uuid = 'test-extension'; metadata = {url: 'https://github.com/Ruochen0513/agent-status-indicator'};},
    },
};
const ioModule = new vm.SourceTextModule(fs.readFileSync(new URL('io.js', base), 'utf8'), {context});
const alertsModule = new vm.SourceTextModule(fs.readFileSync(new URL('alerts.js', base), 'utf8'), {context});
const extension = new vm.SourceTextModule(fs.readFileSync(new URL('extension.js', base), 'utf8'), {context});
async function link(specifier) {
    if (specifier === './state.js')
        return model;
    if (specifier === './io.js')
        return ioModule;
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
await ioModule.link(link);
await ioModule.evaluate();
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
assert.equal(instance._dot.gicon.name, 'media-record-symbolic', 'circle remains the default');
settings.set_string('panel-icon', 'robot');
assert.equal(instance._dot.gicon.file.path, '/extension/robot-head-symbolic.svg');
assert.match(instance._dot.style, /#2ea043/, 'switching shape keeps the current status color');
settings.reset('panel-icon');
assert.equal(instance._dot.gicon.name, 'media-record-symbolic', 'switching back restores the circle');
assert.equal(preferences({panel_icon: 'robot'}).panel_icon, 'robot');
for (const invalid of ['unknown', ['robot'], {}, null, false, 1])
    assert.throws(() => preferences({panel_icon: invalid}));
assert.match(instance._dot.style, /#2ea043/);
assert.equal(sources.length, 0, 'no notification at startup');
assert.equal(timers.size, 0, 'no periodic refresh source');
assert.equal(refreshChildren.length, 0, 'enabling the extension never starts a helper');
assert(instance._summary.children.includes(instance._refreshButton), 'refresh shares the session heading');
assert.equal(instance._summary.label.x_expand, true, 'heading pushes refresh to its right');
assert.equal(instance._refreshButton.get_child(), instance._refreshIcon);
assert.equal(instance._refreshFeedback.visible, false, 'normal menu has no refresh text block');
assert(instance._troubleshooting.menu.items.includes(instance._lastReported), 'global update time belongs in Troubleshooting');

const refreshPromise = instance._refreshLocal();
assert.equal(instance._refreshSpinner.playing, true);
assert.equal(instance._refreshButton.reactive, false);
assert.equal(instance._refreshButton.get_child(), instance._refreshSpinner, 'busy spinner replaces the icon');
await instance._refreshLocal();
assert.equal(refreshChildren.length, 1, 'duplicate clicks cannot start another helper');
await settle();
await refreshPromise;
assert.equal(instance._refreshSpinner.playing, false);
assert.equal(instance._refreshButton.reactive, true);
assert.match(instance._refreshHint.text, /No newer usage reports/);
assert.equal(instance._refreshButton.get_child(), instance._refreshIcon);
assert.equal(instance._refreshFeedback.visible, true, 'click results are visible briefly');
const completedRefreshText = instance._refreshHint.text;
await updateState({...instance._lastState, updated_at: (instance._lastState.updated_at || 0) + 1});
assert.equal(instance._refreshHint.text, completedRefreshText, 'normal state updates preserve the fresh click result');
assert.equal(instance._refreshFeedback.visible, true, 'refresh feedback lasts until its own deadline or menu close');
runTimers(4000);
assert.equal(instance._refreshFeedback.visible, false, 'result text expires without polling');
instance._button.menu.open();
instance._refreshButton.hover = true;
instance._syncRefreshTooltip();
runTimers(500);
assert.equal(instance._refreshTooltip.visible, true, 'hover reveals the action tooltip');
assert.equal(instance._refreshTooltip.text, 'Refresh local data');
assert(instance._refreshTooltip.position.every(Number.isFinite));
instance._refreshButton.hover = false;
instance._syncRefreshTooltip();
assert.equal(instance._refreshTooltip.visible, false);
instance._refreshButton.focus();
runTimers(500);
assert.equal(instance._refreshTooltip.visible, true, 'keyboard focus reveals the tooltip');
instance._button.menu.close();
assert.equal(instance._refreshTooltip.visible, false, 'closing the menu hides its tooltip');
instance._refreshButton.focused = false;

assert.equal(timers.size, 0, 'refresh leaves no polling or deadline timer behind');
assert.equal(sources.length, 0, 'manual refresh does not replay startup alerts');

assert(monitors.some(monitor => !monitor.cancelled && monitor.path === '/config'));
assert.deepEqual(instance._button.menu.actions.map(action => action.text), ['Settings…']);
instance._button.menu.actions.find(action => action.text === 'Settings…').callback();
assert.equal(preferencesOpened, 1, 'Settings opens the native preferences window');
assert(!instance._troubleshooting.menu.actions.some(action => /hook/i.test(action.text)), 'setup help belongs in preferences');
assert.equal(instance._summary.text, '1 session');
assert.equal(instance._groupWidgets.has('claude'), false, 'unused agent group is absent');
settings.set_boolean('show-state-counts', false);
assert.equal(instance._metrics.get('working').item.visible, false);
settings.reset('show-state-counts');
assert.equal(sessionDetail({event: 'UserPromptSubmit', updatedAt: 0}), 'Time unavailable', 'event details are optional');
assert.equal(instance._metrics.get('working').count.text, '1');
assert.equal(instance._metrics.get('working').item.visible, true);
assert.equal(instance._metrics.get('error').item.visible, false);
assert.equal(instance._detail.visible, false, 'normal operation has no diagnostic block');
const validBeforeMalformed = instance._lastState;
await updateState({...validBeforeMalformed, sessions: {codex: {s: {state: ['working']}}}});
assert.equal(instance._lastState, validBeforeMalformed, 'malformed session records retain the last valid menu state');
assert.match(instance._stateError, /keeping last valid/);
await updateState(validBeforeMalformed);
assert.equal(instance._stateError, '');
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
assert.equal(sources.length, 0, 'a completion already superseded by resumed work is not announced');
await updateState({...log(2, [event(2)]), sessions: {codex: {s: {state: 'working'}}}});
assert.equal(sources.length, 0, 'repeated reads cannot replay the obsolete completion');
runTimers(1000);
assert.equal(sounds.at(-1), '/tmp/error.wav', 'obsolete completion does not queue a sound');
await updateState({...log(2, [event(2)]), sessions: {codex: {s: {state: 'idle', event: 'Stop'}}}});
assert.match(instance._summary.text, /1 session/);
assert.match(instance._dot.style, /#62a0ea/, 'finished responses use blue');
for (const icon of ['circle', 'robot']) {
    settings.set_string('panel-icon', icon);
    for (const [status, eventName, attention, color] of [
        ['working', 'UserPromptSubmit', '', COLORS.working], ['approval', 'PermissionRequest', '', COLORS.approval],
        ['approval', 'PreToolUse', 'decision', COLORS.approval], ['error', 'Error', '', COLORS.error],
        ['idle', 'Stop', '', COLORS.finished], ['idle', 'SessionStart', '', COLORS.idle],
    ]) {
        const previousState = instance._lastState;
        instance._lastState = {sessions: {codex: {s: {state: status, event: eventName, attention}}}};
        instance._render();
        assert.equal(instance._dot.style, 'color: ' + color + ';');
        instance._lastState = previousState;
    }
}
settings.reset('panel-icon');
settings.set_boolean('sound-error', false);
settings.set_string('sound-file-completion', '/tmp/custom.ogg');
const overrides = model.namespace.settingsPreferences(settings, {sounds: {error: true, permission: false}});
assert.equal(overrides.sounds.error, false, 'explicit native settings override legacy values');
assert.equal(overrides.sounds.permission, false, 'unmodified settings retain legacy values');
assert.equal(overrides.sound_files.completion, '/tmp/custom.ogg');
settings.reset('sound-error');
settings.reset('sound-file-completion');
assert.equal(sessionSummary([]).headline, 'No sessions');
assert.equal(sessionSummary([{state: 'error'}, {state: 'decision'}, {state: 'working'}]).headline, '3 sessions');
assert.match(sessionDetail({short: '12345678', event: 'PostToolUseFailure', updatedAt: 0}, true), /Tool failed · Time unavailable/);
assert(!sessionDetail({short: '12345678', event: 'InternalPayload', updatedAt: 0}).includes('InternalPayload'));
const burst = Array.from({length: 10}, (_unused, index) => event(index + 3, 'error', 'session-' + index));
await updateState({...log(12, burst), sessions: {codex: Object.fromEntries(
    burst.map(item => [item.session, {state: 'error', project: 'same'}]))}});
assert.equal(sources.filter(source => !source.destroyed).length, 10, 'separate sources preserve ten-session bursts');
assert.equal([...timers.values()].filter(timer => timer.delay === 1000).length, 1);
runTimers(1000);
assert.equal(sounds.at(-1), 'dialog-error');
instance._button.menu.open();
assert.match(instance._button.menu.actor.style, /max-height: 700px;/, 'preserve native height constraints');
assert.match(instance._button.menu.actor.style, /max-width: 520px;/, 'keep the menu within its monitor and arrow gaps');
instance._button.menu.close();
Object.assign(menuGeometry, {width: 1920, scale: 2, padding: 12, monitor: 2, margin: 4});
instance._button.menu.open();
assert.match(instance._button.menu.actor.style, /max-width: 520px;/, 'convert physical work area and margins to CSS pixels');
assert.equal((instance._button.menu.actor.style.match(/max-width:/g) || []).length, 1, 'reopening does not accumulate width rules');
instance._button.menu.close();
Object.assign(menuGeometry, {width: 400, scale: 1, padding: 6, monitor: 1, margin: 0});
instance._button.menu.open();
assert.match(instance._button.menu.actor.style, /max-width: 388px;/, 'recompute width after moving to a smaller monitor');
instance._sessions.menu.open();
const codexGroup = instance._groupWidgets.get('codex');
assert(codexGroup instanceof Section, 'agent groups must not open a second native submenu');
assert.equal(codexGroup.items.length, 11, 'one heading plus ten session rows');
assert.equal(codexGroup.items[0].removedStyle, 'popup-inactive-menu-item', 'quota information is not styled as a disabled control');
assert.notEqual(codexGroup.items[0].reactive, false, 'informational text avoids GNOME’s insensitive pseudo-class');
const readableRow = [...instance._rowWidgets.values()][0];
assert(!readableRow.status.style, 'state words inherit theme contrast, including keyboard focus');
assert.match(readableRow.statusIcon.style, /color:/, 'a separate icon retains the status color');
const quotaWidget = instance._usageWidget();
instance._updateUsage(quotaWidget, {used_percent: 42, resets_at: Date.now() / 1000 + 3600}, '5h quota');
assert(quotaWidget.reported.visible);
assert.match(quotaWidget.reported.text, /^Reported reset: /);
assert.match(quotaWidget.bar.accessible, /Reported reset:/, 'quota reset is included in the accessible value');
assert.equal(previewExports.size, 1, 'the enabled extension registers one sound preview endpoint');
assert(codexGroup.items.every(item => !(item instanceof SubMenu)), 'session controls stay inline');
const preservedRow = codexGroup.items[1];
await updateState({...log(12, burst), sessions: {codex: Object.fromEntries(
    burst.map(item => [item.session, {state: 'error', project: 'same', updated_at: 1}]))}});
assert.equal(instance._groupWidgets.get('codex').items[1], preservedRow, 'ordinary events preserve open menu actors');
assert.equal(instance._sessions.menu.isOpen, true, 'session updates keep the native submenu open');
const firstWidget = [...instance._rowWidgets.values()].find(widget => widget.item === preservedRow);
assert.equal(firstWidget.reset.visible, false, 'reset buttons are hidden during normal use');
assert.equal(firstWidget.item.can_focus, true, 'normal session rows remain keyboard-focusable');
assert.match(firstWidget.item.accessible, /Codex: same.*Error/);
firstWidget.item.signals.get('key-focus-in')();
assert.deepEqual(scrollRequests.at(-1), [instance._sessions.menu.actor, firstWidget.item], 'keyboard focus reveals normal session rows');
const beforeRecovery = {state: files.get(statePath), config: files.get(configPath),
    reads: reads.get(statePath), notifications: sources.reduce((total, source) => total + source.notifications.length, 0)};
instance._troubleshooting.menu.open();
assert.equal(instance._sessions.menu.isOpen, false, 'troubleshooting is a sibling submenu');
instance._resetControls.toggle();
assert.equal(firstWidget.reset.visible, true);
assert.equal(firstWidget.item.can_focus, false, 'recovery rows have one focusable reset button');
instance._sessions.menu.open();
assert.equal(instance._troubleshooting.menu.isOpen, false);
assert.match(firstWidget.reset.accessible, /Copy reset command for same/);
firstWidget.reset.focus();
assert.deepEqual(scrollRequests.at(-1), [instance._sessions.menu.actor, firstWidget.item], 'keyboard focus reveals the whole session row');
firstWidget.reset.click();
assert.equal(instance._sessions.menu.isOpen, true, 'copying a command does not close the session list');
assert.match(clipboard, /^agent-status update codex idle --session '/);
assert.match(instance._detail.text, /Review and run/);
instance._troubleshooting.menu.open();
instance._resetControls.toggle();
instance._sessions.menu.open();
assert.equal(firstWidget.reset.visible, false, 'turning recovery off hides the reset buttons again');
assert.equal(firstWidget.item.can_focus, true);
assert.equal(files.get(statePath), beforeRecovery.state, 'recovery controls never change session state');
assert.equal(files.get(configPath), beforeRecovery.config, 'recovery visibility is temporary');
assert.equal(reads.get(statePath), beforeRecovery.reads, 'showing controls does not reread state');
assert.equal(sources.reduce((total, source) => total + source.notifications.length, 0), beforeRecovery.notifications);
await updateState({...log(12, burst), sessions: {codex: Object.fromEntries(
    Array.from({length: 150}, (_unused, index) => ['page-' + index, {state: 'working'}]))}});
assert.equal(instance._rowWidgets.size, 50, 'large files cannot allocate unbounded menu actors');
const firstPage = [...instance._rowWidgets.keys()][0];
const nextPage = instance._groupWidgets.get('codex').items.flatMap(item => item.children || [])
    .find(button => button.label === 'Next sessions');
nextPage.focus();
assert.equal(scrollRequests.at(-1)[0], instance._sessions.menu.actor);
assert(scrollRequests.at(-1)[1].children.includes(nextPage), 'keyboard focus reveals the pager row');
nextPage.click();
assert.equal(instance._sessions.menu.isOpen, true, 'paging keeps the session list open');
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
assert.equal(notificationsBeforeMute, 1);
assert.equal(sources.reduce((total, source) => total + source.notifications.length, 0), 0, 'mute still removes the superseded completion notice');
assert(![...timers.values()].some(timer => timer.delay === 1000), 'mute cancels queued sound');
settings.set_boolean('mute-all', false);
await settle();
runTimers(100);
await settle();
assert.equal(settings.get_boolean('mute-all'), false);
assert.equal(JSON.parse(files.get(configPath)).mute_all, true, 'native settings leave the legacy file unchanged');
settings.reset('mute-all');
files.set(configPath, JSON.stringify({mute_all: false}));
emit(configPath);
runTimers(100);
await settle();
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
assert.match(instance._detail.text, /Settings → Integration/);
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
assert.equal(settingsSignals.size, 0, 'disable disconnects native settings callbacks');
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
// Remove only notices superseded by authoritative state from their own session.
const unrelatedSource = new Source({title: 'Another extension'});
const unrelatedNotice = new Notification({source: unrelatedSource});
unrelatedSource.addNotification(unrelatedNotice);
const lifecycle = new alertsModule.namespace.Alerts(message => loggedErrors.push(message));
const liveConfig = preferences();
const permission = {...event(1, 'permission', 'same'), agent: 'codex'};
const failure = {...event(2, 'error', 'same'), agent: 'claude'};
let live = {alerts: {generation: 'lifecycle', sequence: 2, events: [permission, failure]}, sessions: {
    codex: {same: {state: 'approval', turn_id: 'one', updated_at: 1}},
    claude: {same: {state: 'error', turn_id: 'one', updated_at: 1}},
}};
lifecycle.dispatch([permission, failure], liveConfig, live);
const firstPermission = lifecycle._notices.get(JSON.stringify(['codex', 'same'])).notification;
const firstError = lifecycle._notices.get(JSON.stringify(['claude', 'same'])).notification;
lifecycle.dispatch([], liveConfig, {...live, alerts: {generation: {}, events: []}});
assert(!firstPermission.destroyed && !firstError.destroyed, 'invalid history does not invent a resolution');
lifecycle.dispatch([], liveConfig, {...live, sessions: {codex: [], claude: live.sessions.claude}});
lifecycle.dispatch([], liveConfig, {...live, sessions: {codex: {same: {state: 'invalid'}}}});
lifecycle.dispatch([], liveConfig, {});
assert(!firstPermission.destroyed && !firstError.destroyed, 'malformed or missing session data cannot establish resolution');
for (const invalid of [['working'], {toString: 'error'}, null, true]) {
    const malformed = {...live, sessions: {codex: {same: {state: invalid}}, claude: live.sessions.claude}};
    assert.doesNotThrow(() => lifecycle.dispatch([], liveConfig, malformed));
    assert(!firstPermission.destroyed && !firstError.destroyed,
        'invalid state types cannot establish that a request resolved');
    assert.equal(sessionRows(malformed).length, 1, 'invalid state types are omitted from presentation');
}
lifecycle.dispatch([], liveConfig, live);
assert(!firstPermission.destroyed && !firstError.destroyed, 'age and repeated reads do not expire valid notices');
live.sessions.codex.same = {state: 'working', turn_id: 'one'};
lifecycle.dispatch([], liveConfig, live);
assert(firstPermission.destroyed, 'resuming removes that session permission notice');
assert(!firstError.destroyed, 'same ID in another agent remains independent');
live.sessions.claude.same = {state: 'working', turn_id: 'one'};
const soundsBeforeResolution = sounds.length;
lifecycle.dispatch([], liveConfig, live);
runTimers(1000);
assert(firstError.destroyed);
assert.equal(sounds.length, soundsBeforeResolution, 'resolved queued sound is cancelled');
const completion = {...event(3, 'completion', 'same'), agent: 'codex'};
live.alerts.sequence = 3;
live.alerts.events.push(completion);
live.sessions.codex.same = {state: 'idle', event: 'Stop', turn_id: 'one'};
lifecycle.dispatch([completion], liveConfig, live);
const finished = lifecycle._notices.get(JSON.stringify(['codex', 'same'])).notification;
live.sessions.codex.same = {state: 'working', turn_id: 'two'};
lifecycle.dispatch([], liveConfig, live);
assert(finished.destroyed, 'the next turn removes the previous completion notice');
const nextPermission = {...permission, sequence: 4};
live.alerts.sequence = 4;
live.alerts.events.push(nextPermission);
live.sessions.codex.same = {state: 'approval', turn_id: 'two'};
lifecycle.dispatch([nextPermission], liveConfig, live);
const currentPermission = lifecycle._notices.get(JSON.stringify(['codex', 'same'])).notification;
lifecycle.dispatch([permission, completion], liveConfig, live);
assert(!currentPermission.destroyed, 'late old events cannot clear a newer permission notice');
assert.equal(lifecycle._notices.size, 1);
const nextCompletion = {...completion, sequence: 5};
live.alerts.sequence = 5;
live.alerts.events.push(nextCompletion);
live.sessions.codex.same = {state: 'idle', event: 'Stop', turn_id: 'two'};
lifecycle.dispatch([nextCompletion], preferences({mute_all: true}), live);
assert(currentPermission.destroyed, 'mute does not prevent cleanup of resolved notices');
assert.equal(lifecycle._notices.size, 0, 'mute suppresses replacement notices');
const decision = {...event(6, 'decision', 'same'), agent: 'claude'};
live.alerts.sequence = 6;
live.alerts.events.push(decision);
live.sessions.claude.same = {state: 'approval', attention: 'decision', turn_id: 'three'};
lifecycle.dispatch([decision], liveConfig, live);
const decisionNotice = lifecycle._notices.get(JSON.stringify(['claude', 'same'])).notification;
live.sessions.claude.same = {state: 'idle', event: 'Reset', turn_id: 'three'};
lifecycle.dispatch([], liveConfig, live);
assert(decisionNotice.destroyed, 'a manual reset resolves the decision notice');
live.sessions.claude.same = {state: 'approval', attention: 'decision', turn_id: 'four'};
live.alerts.sequence = 7;
const laterDecision = {...decision, sequence: 7};
live.alerts.events.push(laterDecision);
lifecycle.dispatch([laterDecision], liveConfig, live);
const removedSession = lifecycle._notices.get(JSON.stringify(['claude', 'same'])).notification;
delete live.sessions.claude.same;
lifecycle.dispatch([], liveConfig, live);
assert(removedSession.destroyed, 'removing a session clears its notice');
assert.equal(lifecycle._notices.size, 0);
assert.equal(lifecycle._sources.size, 0, 'empty sources are released');
live.sessions.claude.same = {state: 'approval', attention: 'decision', turn_id: 'five'};
const dismissible = {...decision, sequence: 8};
live.alerts.sequence = 8;
live.alerts.events.push(dismissible);
lifecycle.dispatch([dismissible], liveConfig, live);
const dismissed = lifecycle._notices.get(JSON.stringify(['claude', 'same'])).notification;
dismissed.destroy(2);
lifecycle.dispatch([], liveConfig, live);
assert.equal(lifecycle._notices.size, 0, 'a manually dismissed notice is not recreated by rereading state');
const renewedError = {...failure, sequence: 9};
live.alerts.sequence = 9;
live.alerts.events.push(renewedError);
live.sessions.claude.same = {state: 'error', turn_id: 'six'};
lifecycle.dispatch([renewedError], liveConfig, live);
const earlierError = lifecycle._notices.get(JSON.stringify(['claude', 'same'])).notification;
const newerError = {...renewedError, sequence: 10};
live.alerts.sequence = 10;
live.alerts.events.push(newerError);
lifecycle.dispatch([newerError], liveConfig, live);
assert(earlierError.destroyed, 'a newer failure supersedes the previous notice from that session');
assert.equal(lifecycle._notices.size, 1);
assert.equal([...lifecycle._sources.values()][0].notifications.length, 1);
live.alerts = {generation: 'replacement-history', sequence: 0, events: []};
lifecycle.dispatch([], liveConfig, live);
assert.equal(lifecycle._notices.size, 1, 'history reset alone does not resolve an active error');
live.sessions.claude.same = {state: 'working', turn_id: 'six'};
lifecycle.dispatch([], liveConfig, live);
assert.equal(lifecycle._notices.size, 0, 'a real recovery clears the error after history reset');
assert(!unrelatedNotice.destroyed, 'another extension notification stays untouched');
unrelatedSource.destroy();
lifecycle.destroy();
const closeNotices = new alertsModule.namespace.Alerts(message => assert.fail(message));
const closeEvents = [event(1, 'completion', 'ending'), event(2, 'permission', 'waiting')];
const closeNoticeState = log(2, closeEvents);
const closeConfig = preferences({sounds: {completion: false, permission: false}});
closeNotices.dispatch(closeEvents, closeConfig, closeNoticeState);
const endingNotice = closeNotices._notices.get(JSON.stringify(['codex', 'ending'])).notification;
const waitingNotice = closeNotices._notices.get(JSON.stringify(['codex', 'waiting'])).notification;
closeNoticeState.sessions.codex.ending.event = 'SessionEnd';
closeNotices.dispatch([], closeConfig, closeNoticeState);
assert(endingNotice.destroyed, 'a confirmed exit removes its obsolete completion notice');
assert(!waitingNotice.destroyed, 'another session permission notice remains unresolved');
assert.equal(closeNotices._notices.size, 1);
assert.equal(sessionRows(closeNoticeState, true).find(row => row.session === 'ending').state, 'closed');
closeNotices.dispatch([], preferences({...closeConfig, show_closed_sessions: true}), closeNoticeState);
assert.equal(closeNotices._notices.size, 1, 'revealing closed rows never replays their notices');
closeNotices.destroy();
// Display settings are independent of lifecycle and notifications.
instance.enable();
await settle();
instance._lastState = exitState;
instance._render();
const preservedFinishedId = instance._rowWidgets.get(JSON.stringify(['codex', 'finished'])).identity.text;
assert.equal(instance._rowWidgets.size, 3);
assert.equal(instance._summary.label.text, '3 sessions');
settings.set_boolean('show-closed-sessions', true);
assert.equal(instance._rowWidgets.size, 5);
assert.equal(instance._rowWidgets.get(JSON.stringify(['claude', 'closed'])).status.text, 'Closed');
assert.equal(instance._metrics.get('closed').count.text, '2');
settings.reset('show-closed-sessions');
assert.equal(instance._rowWidgets.size, 3);
assert.equal(instance._rowWidgets.get(JSON.stringify(['codex', 'finished'])).identity.text, preservedFinishedId);
assert.equal(instance._rowWidgets.get(JSON.stringify(['codex', 'finished'])).status.text, 'Finished responding');
assert.equal(instance._lastState, exitState);
instance._lastState = {sessions: {codex: {closed: {state: 'idle', event: 'SessionEnd'}}}};
instance._render();
assert.equal(instance._summary.label.text, 'No sessions');
assert.equal(instance._sessions.visible, false);
assert.equal(instance._groupWidgets.size, 0);
instance._lastState = {sessions: {codex: {}, claude: {}}};
instance._render();
assert.equal(instance._sessions.visible, false);
assert.equal(instance._groupWidgets.size, 0);
settings.set_boolean('show-empty-agents', true);
assert.equal(instance._sessions.visible, true);
assert.equal(instance._groupWidgets.size, 2);
settings.reset('show-empty-agents');
assert.equal(instance._groupWidgets.size, 0);
const sampleTime = Date.now() / 1000;
instance._lastState = {sessions: {codex: {s: {state: 'working', context: {used_percent: 42, updated_at: sampleTime}}}},
    usage: {codex: {updated_at: sampleTime, windows: [{used_percent: 60, window_minutes: 300, resets_at: sampleTime + 3600}]}}};
instance._render();
const usageRow = [...instance._rowWidgets.values()][0];
assert.equal(usageRow.context.box.visible, true);
assert.equal(usageRow.context.bar.value, 0.42);
assert.match(usageRow.item.accessible, /Context approximately 42%/);
const quotaGroup = instance._groupWidgets.get('codex');
assert.equal(quotaGroup.usage[0].bar.value, 0.6);
assert.equal(quotaGroup.usage[1].box.visible, false);
settings.set_boolean('show-context-usage', false);
assert.equal(usageRow.context.box.visible, false);
settings.set_boolean('show-account-usage', false);
assert.equal(quotaGroup.usage[0].box.visible, false);
settings.reset('show-context-usage');
settings.reset('show-account-usage');
settings.set_boolean('mute-all', false);
settings.set_boolean('sound-error', true);
instance._alerts.dispatch([event(1000, 'error', 'queued')], instance._preferences);
const queuedBeforeDisplay = instance._alerts._pendingSound;
assert(queuedBeforeDisplay);
settings.set_string('panel-icon', 'robot');
settings.set_boolean('show-state-counts', false);
assert.equal(instance._alerts._pendingSound, queuedBeforeDisplay,
    'changing display choices must not discard an unrelated queued sound');
settings.reset('panel-icon');
settings.reset('show-state-counts');
const playedBeforeDisplay = sounds.length;
runTimers(1000);
assert.equal(sounds.length, playedBeforeDisplay + 1);
settings.reset('mute-all');
settings.reset('sound-error');
instance.disable();

// Visible quota expires at its deadline even when reset notifications are off.
let displayNow = 100;
const displayDeadlines = [];
const displayTimer = new alertsModule.namespace.QuotaResetTimer(
    (agent, window, notify) => displayDeadlines.push({agent, window, notify}), () => displayNow);
const displayState = {usage: {codex: {updated_at: 90, windows: [
    {used_percent: 95, window_minutes: 300, resets_at: 110},
]}}};
displayTimer.update(displayState, preferences());
assert.equal(timers.size, 1, 'visible quota schedules one expiry without enabling reset alerts');
displayNow = 111;
runTimers(10000);
assert.equal(displayDeadlines.length, 1);
assert.equal(displayDeadlines[0].notify, false, 'display expiry must not invent notification consent');
displayTimer.update(displayState, preferences({notifications: {'quota-reset': true}}));
assert.equal(displayDeadlines.length, 1, 'enabling alerts after expiry cannot replay its display deadline');
displayTimer.destroy();
displayNow = 100;
displayTimer.update(displayState, preferences({notifications: {'quota-reset': true}}));
displayTimer.update(displayState, preferences({mute_all: true}));
displayNow = 111;
runTimers(10000);
assert.equal(displayDeadlines.at(-1).notify, false, 'mute suppresses the reset alert while expiring visible quota');
displayTimer.destroy();

// Real reset deadlines, no inferred resets or historical replay.
let resetNow = 100;
const resets = [];
const resetConfig = preferences({notifications: {'quota-reset': true}});
const resetTimer = new alertsModule.namespace.QuotaResetTimer((agent, window) => resets.push({agent, window}), () => resetNow);
const quotaState = {usage: {codex: {updated_at: 90, windows: [
    {used_percent: 95, window_minutes: 300, resets_at: 110},
    {used_percent: 40, window_minutes: 10080, resets_at: 120},
]}}};
resetTimer.update(quotaState, resetConfig);
assert.equal(timers.size, 1, 'one timer covers all quota deadlines');
resetNow = 110;
runTimers(10000);
assert.equal(resets.length, 1);
resetTimer.update(quotaState, resetConfig);
assert.equal(resets.length, 1, 'repeated state cannot replay reset');
resetNow = 130;
resetTimer.update(quotaState, resetConfig);
assert.equal(resets.length, 2, 'resume processes an armed deadline that passed while suspended');
resetTimer.update(quotaState, resetConfig);
assert.equal(resets.length, 2);
resetTimer.destroy();
const lateResetTimer = new alertsModule.namespace.QuotaResetTimer(() => { throw Error('startup replay'); }, () => 130);
lateResetTimer.update(quotaState, resetConfig);
assert.equal(timers.size, 0, 'expired startup snapshots schedule nothing');
lateResetTimer.destroy();
resetNow = 100;
resetTimer.update(quotaState, resetConfig);
assert.equal(timers.size, 1);
resetTimer.update(quotaState, preferences({mute_all: true, show_account_usage: false}));
assert.equal(timers.size, 0, 'hidden quota with muted alerts needs no deadline');
resetTimer.destroy();

const quotaAlerts = new alertsModule.namespace.Alerts(message => { throw Error(message); });
quotaAlerts.quotaReset('codex', quotaState.usage.codex.windows[0], resetConfig);
const quotaNotice = quotaAlerts._quotaNotices.get('codex').notification;
assert.match(quotaNotice.title, /Quota reset time reached/);
assert.match(quotaNotice.body, /Usage refreshes/);
quotaAlerts.dispatch([], resetConfig, {sessions: {codex: {}, claude: {}}, usage: {codex: {updated_at: '111', windows: []}}});
assert.equal(quotaAlerts._quotaNotices.size, 1, 'malformed metadata cannot resolve the reset notice');
quotaAlerts.dispatch([], resetConfig, {sessions: {codex: {}, claude: {}}, usage: {codex: {updated_at: 111, windows: []}}});
assert.equal(quotaAlerts._quotaNotices.size, 0, 'new authoritative quota metadata removes obsolete reset notice');
quotaAlerts.destroy();
notificationFailure = true;
const quotaFailures = [];
const failingQuotaAlerts = new alertsModule.namespace.Alerts(message => quotaFailures.push(message));
failingQuotaAlerts.quotaReset('codex', quotaState.usage.codex.windows[0], resetConfig);
assert.equal(failingQuotaAlerts._quotaNotices.size, 0);
assert.equal(quotaFailures.length, 1, 'notification backend failure is contained');
failingQuotaAlerts.destroy();
notificationFailure = false;
assert.equal(timers.size, 0);

const previewConfig = preferences({mute_all: true, sounds: {completion: false}, sound_files: {error: '/sounds/custom.wav'}});
const audition = new alertsModule.namespace.Alerts(message => { throw Error(message); });
const beforePreviewTimers = timers.size;
const beforePreviewSources = sources.length;
audition.preview('completion', previewConfig);
assert.equal(playbacks.at(-1).name, 'complete', 'explicit preview works while alerts are muted');
const firstPreview = playbacks.at(-1).cancellable;
audition.preview('error', previewConfig);
assert(firstPreview.is_cancelled(), 'a new preview cancels the previous sound');
assert.equal(playbacks.at(-1).name, '/sounds/custom.wav', 'preview uses the saved custom sound');
const customPreview = playbacks.at(-1).cancellable;
assert.throws(() => audition.preview('/untrusted/path.wav', previewConfig), /Unknown alert sound/);
assert(!customPreview.is_cancelled(), 'invalid requests do not replace a valid preview');
assert.equal(timers.size, beforePreviewTimers, 'preview adds no idle timer');
assert.equal(sources.length, beforePreviewSources, 'preview creates no notification source');
audition.destroy();
assert(customPreview.is_cancelled(), 'disable cleanup cancels preview playback');
audioFailure = true;
assert.throws(() => audition.preview('completion', previewConfig), /audio unavailable/);
assert.equal(audition._previewCancellable, null, 'failed playback releases preview state');
audioFailure = false;
assert.equal(previewExports.size, 0, 'disable removes the sound preview endpoint');

const {reportedTime, refreshFeedback, quotaResetTime} = model.namespace;
const resetClock = new Date(2026, 0, 2, 10, 0).getTime() / 1000;
const todayReset = new Date(2026, 0, 2, 14, 30);
assert.equal(quotaResetTime(todayReset.getTime() / 1000, resetClock),
    `Reported reset: ${todayReset.toLocaleString([], {hour: '2-digit', minute: '2-digit'})}`);
const tomorrowReset = new Date(2026, 0, 3, 14, 30);
assert.equal(quotaResetTime(tomorrowReset.getTime() / 1000, resetClock),
    `Reported reset: ${tomorrowReset.toLocaleString([], {hour: '2-digit', minute: '2-digit', month: 'short', day: 'numeric'})}`);
const nextYearReset = new Date(2027, 0, 2, 14, 30);
assert.equal(quotaResetTime(nextYearReset.getTime() / 1000, resetClock),
    `Reported reset: ${nextYearReset.toLocaleString([], {hour: '2-digit', minute: '2-digit', month: 'short', day: 'numeric', year: 'numeric'})}`);
for (const reset of [undefined, null, NaN, Infinity, 1e30, '2000000000', resetClock, resetClock - 1])
    assert.equal(quotaResetTime(reset, resetClock), '');
assert.equal(reportedTime(0, 10000), 'Not reported yet');
assert.equal(reportedTime(9999, 10000), 'Last reported just now');
assert.equal(reportedTime(9880, 10000), 'Last reported 2 min ago');
assert.equal(reportedTime(2800, 10000), 'Last reported 2 h ago');
assert.equal(reportedTime(1, 86401), 'Last reported 1 day ago');
assert.equal(reportedTime(1, 172801), 'Last reported 2 days ago');
assert.equal(reportedTime(10001, 10000), 'Last reported just now');
assert.match(refreshFeedback({status: 'no-sources'}), /No Codex usage reports yet/);
const historyMissing = new AlertCursor();
assert.equal(historyMissing.read({sessions: {}}).warning, 'Notification tracking unavailable.');

for (const invalid of ['[]', '{bad', 'x'.repeat(4097),
    JSON.stringify({status: 'updated', checked: 1, updated: 2, unavailable: 0})]) {
    refreshOutput = invalid;
    await assert.rejects(ioModule.namespace.refreshUsage(new Cancellable()));
    assert(refreshChildren.at(-1).killed, 'invalid helper results terminate the child');
    assert.equal(timers.size, 0);
}
refreshOutput = JSON.stringify({status: 'unchanged', checked: 1, updated: 0, unavailable: 0});
refreshWait = true;
const timedRefresh = assert.rejects(ioModule.namespace.refreshUsage(new Cancellable()), /timed out/);
await drain();
runTimers(5000);
await timedRefresh;
assert(refreshChildren.at(-1).killed);
assert.equal(timers.size, 0);
const cancelledRefresh = new Cancellable();
const cancelledPromise = assert.rejects(ioModule.namespace.refreshUsage(cancelledRefresh), /cancelled/);
await drain();
cancelledRefresh.cancel();
await cancelledPromise;
assert(refreshChildren.at(-1).killed);
assert.equal(cancelledRefresh.signals.size, 0);
assert.equal(timers.size, 0);
refreshWait = false;
instance.enable();
await settle();
await updateState({sessions: {codex: {s: {state: 'working'}}}});
assert.equal(instance._detail.visible, false, 'notification diagnostics do not occupy the main status block');
assert.equal(instance._notificationDetail.visible, true);
assert.match(instance._notificationDetail.label.text, /Notification tracking unavailable/);
assert.match(instance._troubleshooting.label.text, /Needs attention/);
refreshMissing = true;
const missingRefresh = instance._refreshLocal();
await settle();
await missingRefresh;
assert.match(instance._refreshHint.text, /Refresh unavailable/);
runTimers(4000);
assert.equal(instance._refreshFeedback.visible, false);
assert.equal(instance._refreshDetail.visible, true);
assert.equal(instance._lastState.sessions.codex.s.state, 'working', 'missing helper preserves status');
refreshMissing = false;
refreshWait = true;
const closingRefresh = instance._refreshLocal();
await drain();
instance.disable();
await closingRefresh;
assert(refreshChildren.at(-1).killed, 'disable terminates only its owned helper');
assert.equal(imports['resource:///org/gnome/shell/ui/main.js'].uiGroup.children.length, 0, 'disable destroys tooltip actors');
assert.equal(timers.size, 0);
refreshWait = false;

const mutedKey = JSON.stringify(['codex', 'quiet']);
const sessionConfig = {...preferences(), muted_permission_sessions: [mutedKey]};
const {permissionAlertsMuted, retainedPermissionMutes} = model.namespace;
assert(permissionAlertsMuted(sessionConfig, 'codex', 'quiet'));
assert(!permissionAlertsMuted(sessionConfig, 'codex', 'other'));
assert(!permissionAlertsMuted({...sessionConfig, muted_permission_sessions: [JSON.stringify(['claude', 'quiet'])]}, 'claude', 'quiet'));
for (const kind of ['permission', 'completion', 'error', 'decision']) {
    const scoped = new alertsModule.namespace.Alerts(message => { throw Error(message); });
    const notice = event(1, kind, 'quiet');
    scoped.dispatch([notice], sessionConfig, log(1, [notice]));
    assert.equal(scoped._notices.size, kind === 'permission' ? 0 : 1, `${kind} keeps its independent session policy`);
    assert.equal(scoped._pendingSound === null, kind === 'permission', `${kind} sound follows the same scope`);
    scoped.destroy();
}
const scopeAlerts = new alertsModule.namespace.Alerts(message => { throw Error(message); });
const requestA = event(1, 'permission', 'quiet');
const requestB = event(2, 'permission', 'other');
const requestC = {...event(3, 'permission', 'quiet'), agent: 'claude'};
const scopeState = log(3, [requestA, requestB, requestC]);
scopeAlerts.dispatch([requestA, requestB, requestC], sessionConfig, scopeState);
assert(!scopeAlerts._notices.has(mutedKey));
assert(scopeAlerts._notices.has(JSON.stringify(['codex', 'other'])));
assert(scopeAlerts._notices.has(JSON.stringify(['claude', 'quiet'])));
scopeAlerts.destroy();
const cancelMuted = new alertsModule.namespace.Alerts(message => { throw Error(message); });
cancelMuted.dispatch([requestA], preferences(), log(1, [requestA]));
const visibleRequest = cancelMuted._notices.get(mutedKey).notification;
cancelMuted.dispatch([], sessionConfig, log(1, [requestA]));
assert(visibleRequest.destroyed, 'muting removes only the session’s existing permission notice');
assert.equal(cancelMuted._pendingSound, null, 'muting cancels queued permission playback');
cancelMuted.dispatch([], preferences(), log(1, [requestA]));
assert.equal(cancelMuted._notices.size, 0, 'restoring permission alerts does not replay old notices');
cancelMuted.destroy();
const pruning = {sessions: {codex: {quiet: {state: 'working'}, closed: {state: 'idle', event: 'SessionEnd'}}}};
assert.equal(JSON.stringify(retainedPermissionMutes(pruning, [mutedKey, JSON.stringify(['codex', 'closed']), JSON.stringify(['codex', 'gone']), 'bad'])), JSON.stringify([mutedKey]));
assert.equal(retainedPermissionMutes({}, [mutedKey])[0], mutedKey, 'an unavailable session table cannot revoke the choice');
instance.enable();
await settle();
instance._lastState = {sessions: {codex: {quiet: {state: 'working', project: 'same'}, other: {state: 'working', project: 'same'}}, claude: {quiet: {state: 'working'}}}};
instance._render();
const quietRow = instance._rowWidgets.get(mutedKey);
const otherRow = instance._rowWidgets.get(JSON.stringify(['codex', 'other']));
assert(quietRow.permissionMute.visible && !quietRow.permissionMute.checked);
assert(!instance._rowWidgets.get(JSON.stringify(['claude', 'quiet'])).permissionMute.visible);
quietRow.permissionMute.click();
assert(quietRow.permissionMute.checked && !otherRow.permissionMute.checked, 'same-project session choices stay independent');
assert.match(quietRow.permissionIcon.icon_name, /disabled/);
assert.match(quietRow.permissionIcon.style, /d29922/);
assert.match(instance._refreshMessage, /including manual requests/);
assert.equal(settings.get_strv('muted-permission-sessions')[0], mutedKey);
instance._render();
assert(quietRow.permissionMute.checked, 'ordinary renders retain the session choice');
quietRow.permissionMute.click();
assert(!quietRow.permissionMute.checked);
assert.equal(settings.get_strv('muted-permission-sessions').length, 0);
const saveSessionMutes = settings.set_strv;
for (const fail of [() => false, () => { throw Error('write unavailable'); }]) {
    settings.set_strv = fail;
    quietRow.permissionMute.click();
    assert(!quietRow.permissionMute.checked, 'failed preference writes preserve the current bell state');
    assert.match(instance._refreshMessage, /Could not save/);
}
settings.set_strv = saveSessionMutes;
settings.reset('muted-permission-sessions');
settings.set_boolean('mute-all', false);
settings.set_boolean('notify-completion', true);
for (const fail of [() => false, () => { throw Error('preference backend unavailable'); }]) {
    await updateState(log(0, [], 'cleanup-test'));
    settings.set_strv('muted-permission-sessions', [mutedKey]);
    settings.set_strv = fail;
    await updateState(log(1, [event(1, 'completion', 'other')], 'cleanup-test'));
    assert.equal(instance._stateError, '', 'optional mute cleanup cannot mark valid state unreadable');
    assert(instance._alerts._notices.has(JSON.stringify(['codex', 'other'])),
        'optional cleanup cannot drop another session completion');
    settings.set_strv = saveSessionMutes;
    settings.reset('muted-permission-sessions');
}
instance.disable();
assert.equal(timers.size, 0);

console.log('GNOME monitoring, bounded reads, sessions, alert history, sounds, preferences and reload lifecycle passed');
