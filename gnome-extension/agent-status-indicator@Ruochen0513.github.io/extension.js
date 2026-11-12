// SPDX-License-Identifier: MIT
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import {summarize, COLORS, sessionRows, STATUS_LABELS, AGENT_LABELS, preferences, AlertCursor} from './state.js';
import {Alerts} from './alerts.js';

function asyncCall(object, start, finish, args) {
    return new Promise((resolve, reject) => {
        object[start](...args, (source, result) => {
            try {
                resolve(source[finish](result));
            } catch (error) {
                reject(error);
            }
        });
    });
}

export async function readJson(file, cancellable, limit = 1048576) {
    const stream = await asyncCall(file, 'read_async', 'read_finish', [GLib.PRIORITY_DEFAULT, cancellable]);
    try {
        const chunks = [];
        let length = 0;
        while (true) {
            const bytes = await asyncCall(stream, 'read_bytes_async', 'read_bytes_finish',
                [Math.min(65536, limit + 1 - length), GLib.PRIORITY_DEFAULT, cancellable]);
            const chunk = bytes.get_data();
            if (chunk.length === 0)
                break;
            length += chunk.length;
            if (length > limit)
                throw new Error('Status/config file exceeds size limit');
            chunks.push(chunk);
        }
        const data = new Uint8Array(length);
        let offset = 0;
        for (const chunk of chunks) {
            data.set(chunk, offset);
            offset += chunk.length;
        }
        return JSON.parse(new TextDecoder().decode(data));
    } finally {
        await asyncCall(stream, 'close_async', 'close_finish', [GLib.PRIORITY_DEFAULT, null]);
    }
}

function isMissing(error) {
    return error instanceof GLib.Error && error.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND);
}

export default class AgentStatusExtension extends Extension {
    enable() {
        this._refreshId = 0;
        this._recoveryId = 0;
        this._recoveryAttempt = 0;
        this._monitors = [];
        this._lastState = {};
        this._lastError = '';
        this._stateError = '';
        this._configError = '';
        this._alertWarning = '';
        this._missing = true;
        this._reading = false;
        this._savingMute = false;
        this._stateDirty = true;
        this._configDirty = true;
        this._watchDirty = false;
        this._preferences = preferences();
        this._rowWidgets = new Map();
        this._groupWidgets = new Map();
        this._rowOrder = '';
        this._sessionPage = {claude: 0, codex: 0};
        this._cursor = new AlertCursor();
        this._alerts = new Alerts(message => this._reportError(message));
        this._cancellable = new Gio.Cancellable();
        this._stateFile = Gio.File.new_for_path(GLib.build_filenamev([
            GLib.get_user_cache_dir(), 'agent-status-indicator', 'state.json',
        ]));
        this._configFile = Gio.File.new_for_path(GLib.build_filenamev([
            GLib.get_user_config_dir(), 'agent-status-indicator', 'gnome.json',
        ]));
        this._button = new PanelMenu.Button(0.0, 'Agent Status Indicator', false);
        this._dot = new St.Icon({
            icon_name: 'media-record-symbolic', icon_size: 14,
            style_class: 'system-status-icon', y_align: Clutter.ActorAlign.CENTER,
        });
        this._button.add_child(this._dot);
        this._summary = new PopupMenu.PopupMenuItem('Agent status', {reactive: false});
        this._detail = new PopupMenu.PopupMenuItem('', {reactive: false});
        this._sessions = new PopupMenu.PopupSubMenuMenuItem('Sessions');
        this._button.menu.addMenuItem(this._summary);
        this._button.menu.addMenuItem(this._detail);
        this._button.menu.addMenuItem(this._sessions);
        this._mute = this._button.menu.addAction('Mute all alerts', () => this._toggleMute());
        this._button.menu.addAction('Refresh status', () => {
            this._stateDirty = true;
            this._configDirty = true;
            this._watchDirty = true;
            this._queueRefresh();
        });
        this._button.menu.addAction('Set up agent hooks…', () => {
            try {
                Gio.AppInfo.launch_default_for_uri(`${this.metadata.url}#enabling-agent-hooks`, null);
            } catch (error) {
                this._reportError(`Cannot open setup instructions: ${error.message}`);
            }
        });
        Main.panel.addToStatusArea(this.uuid, this._button, 0, 'left');
        this._setupMonitors();
        this._render();
        this._refresh();
    }

    disable() {
        for (const id of [this._refreshId, this._recoveryId]) {
            if (id)
                GLib.source_remove(id);
        }
        this._refreshId = 0;
        this._recoveryId = 0;
        this._cancellable?.cancel();
        this._cancellable = null;
        this._clearMonitors();
        this._alerts?.destroy();
        this._alerts = null;
        this._button?.destroy();
        this._button = null;
        this._dot = null;
        this._summary = null;
        this._detail = null;
        this._sessions = null;
        this._rowWidgets.clear();
        this._groupWidgets.clear();
        this._mute = null;
        this._stateFile = null;
        this._configFile = null;
        this._lastState = null;
        this._reading = false;
    }

    _clearMonitors() {
        for (const [monitor, signal] of this._monitors) {
            monitor.disconnect(signal);
            monitor.cancel();
        }
        this._monitors = [];
    }

    _watchFile(file, kind) {
        const directory = file.get_parent();
        let ancestor = directory.get_parent();
        let child = directory;
        while (ancestor && !ancestor.query_exists(null)) {
            child = ancestor;
            ancestor = ancestor.get_parent();
        }
        const watches = [[directory, file]];
        if (ancestor)
            watches.push([ancestor, child]);
        const directoryExists = directory.query_exists(null);
        let directoryWatched = false;
        let ancestorWatched = ancestor === null;
        for (const [parent, target] of watches) {
            if (!parent.query_exists(null))
                continue;
            try {
                const monitor = parent.monitor_directory(Gio.FileMonitorFlags.WATCH_MOVES, this._cancellable);
                const cancellable = this._cancellable;
                const signal = monitor.connect('changed', (_monitor, changed, other) => {
                    if (this._cancellable !== cancellable || cancellable.is_cancelled())
                        return;
                    if (![changed, other].some(path => path?.equal(target) || path?.equal(parent)))
                        return;
                    this._watchDirty ||= !changed?.equal(file) && !other?.equal(file);
                    if (kind === 'state')
                        this._stateDirty = true;
                    else
                        this._configDirty = true;
                    this._queueRefresh();
                });
                this._monitors.push([monitor, signal]);
                if (parent.equal(directory))
                    directoryWatched = true;
                else
                    ancestorWatched = true;
            } catch (error) {
                this._reportError(`Cannot monitor status/config directory: ${error.message}`);
            }
        }
        return ancestorWatched && (!directoryExists || directoryWatched);
    }

    _setupMonitors() {
        this._clearMonitors();
        const stateWatched = this._watchFile(this._stateFile, 'state');
        const configWatched = this._watchFile(this._configFile, 'config');
        if (stateWatched && configWatched) {
            this._recoveryAttempt = 0;
            if (this._recoveryId)
                GLib.source_remove(this._recoveryId);
            this._recoveryId = 0;
        } else if (!this._recoveryId && this._recoveryAttempt < 6) {
            const delay = Math.min(30000, 1000 * 2 ** this._recoveryAttempt++);
            this._recoveryId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, delay, () => {
                this._recoveryId = 0;
                this._watchDirty = true;
                this._stateDirty = true;
                this._configDirty = true;
                this._queueRefresh();
                return GLib.SOURCE_REMOVE;
            });
        }
    }

    _queueRefresh() {
        if (this._refreshId || !this._cancellable)
            return;
        this._refreshId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 100, () => {
            this._refreshId = 0;
            this._refresh();
            return GLib.SOURCE_REMOVE;
        });
    }

    async _refresh() {
        if (this._reading || !this._cancellable)
            return;
        this._reading = true;
        const cancellable = this._cancellable;
        try {
            if (this._watchDirty) {
                this._watchDirty = false;
                this._setupMonitors();
            }
            // Preferences settle before dispatch, including when a mute change
            // and a status update arrive in the same filesystem burst.
            if (this._configDirty) {
                this._configDirty = false;
                try {
                    const config = await readJson(this._configFile, cancellable, 65536);
                    if (cancellable !== this._cancellable || cancellable.is_cancelled())
                        return;
                    this._preferences = preferences(config);
                    this._configError = '';
                } catch (error) {
                    if (cancellable !== this._cancellable || cancellable.is_cancelled())
                        return;
                    if (isMissing(error)) {
                        this._preferences = preferences();
                        this._configError = '';
                    } else if (!cancellable.is_cancelled()) {
                        this._configError = 'Cannot read alert preferences; keeping previous settings.';
                        this._reportError(this._configError);
                    }
                }
                if (cancellable !== this._cancellable || cancellable.is_cancelled())
                    return;
                this._alerts.cancelSound();
            }
            if (this._stateDirty) {
                this._stateDirty = false;
                try {
                    const candidate = await readJson(this._stateFile, cancellable);
                    summarize(candidate);
                    if (cancellable !== this._cancellable || cancellable.is_cancelled())
                        return;
                    this._lastState = candidate;
                    this._missing = false;
                    this._stateError = '';
                    const {events, warning} = this._cursor.read(candidate);
                    this._alertWarning = warning;
                    this._alerts.dispatch(events, this._preferences);
                } catch (error) {
                    if (cancellable !== this._cancellable || cancellable.is_cancelled())
                        return;
                    if (isMissing(error)) {
                        this._lastState = {};
                        this._missing = true;
                        this._stateError = '';
                        this._alertWarning = this._cursor.read({}, true).warning;
                    } else {
                        this._stateError = 'Cannot read status; keeping last valid sessions.';
                        this._reportError(this._stateError);
                    }
                }
            }
            if (cancellable === this._cancellable && !cancellable.is_cancelled())
                this._render();
        } catch (error) {
            if (cancellable === this._cancellable && !cancellable.is_cancelled())
                this._reportError(error.message);
        } finally {
            if (cancellable === this._cancellable && !cancellable.is_cancelled()) {
                this._reading = false;
                if (this._stateDirty || this._configDirty || this._watchDirty)
                    this._queueRefresh();
            }
        }
    }

    async _toggleMute() {
        if (this._savingMute)
            return;
        this._savingMute = true;
        const cancellable = this._cancellable;
        const previous = this._preferences;
        this._preferences = {...previous, mute_all: !previous.mute_all};
        this._alerts.cancelSound();
        this._render();
        try {
            try {
                this._configFile.get_parent().make_directory_with_parents(cancellable);
            } catch (error) {
                if (!(error instanceof GLib.Error && error.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.EXISTS)))
                    throw error;
            }
            await asyncCall(this._configFile, 'replace_contents_bytes_async', 'replace_contents_finish',
                [new GLib.Bytes(new TextEncoder().encode(JSON.stringify(this._preferences, null, 2) + '\n')),
                    null, false, Gio.FileCreateFlags.PRIVATE, cancellable]);
        } catch (error) {
            if (cancellable === this._cancellable && !cancellable.is_cancelled()) {
                this._preferences = previous;
                this._configError = 'Cannot save alert preferences.';
                this._reportError(this._configError);
            }
        } finally {
            if (cancellable === this._cancellable && !cancellable.is_cancelled()) {
                this._savingMute = false;
                this._render();
            }
        }
    }

    _reportError(message) {
        if (message !== this._lastError)
            console.error(`Agent Status: ${message}`);
        this._lastError = message;
    }

    _render() {
        const {status} = summarize(this._lastState);
        const rows = sessionRows(this._lastState);
        let visible = this._stateError ? 'error' : status;
        if (visible === 'idle' && rows.some(row => row.state === 'finished'))
            visible = 'finished';
        if (visible === 'approval' && !rows.some(row => row.state === 'approval'))
            visible = 'decision';
        const attention = rows.filter(row => ['approval', 'decision', 'error'].includes(row.state)).length;
        const working = rows.filter(row => row.state === 'working').length;
        const finished = rows.filter(row => row.state === 'finished').length;
        const permission = rows.filter(row => row.state === 'approval').length;
        const decisions = rows.filter(row => row.state === 'decision').length;
        const errors = rows.filter(row => row.state === 'error').length;
        const idle = rows.filter(row => row.state === 'idle').length;
        const description = [this._stateError,
            this._missing ? 'No status received. Set up the companion and agent hooks.'
                : `Needs attention: ${attention} | Working: ${working} | Finished: ${finished} | Idle: ${idle}`,
            `Permissions: ${permission} | Decisions: ${decisions} | Errors: ${errors}`,
            this._configError, this._alertWarning].filter(Boolean).join('\n');
        this._dot.set_style(`color: ${COLORS[visible === 'decision' ? 'approval' : visible] || COLORS.idle};`);
        this._button.set_accessible_name(`Agent status: ${visible}. ${description}`);
        this._summary.label.set_text(`Agent status: ${STATUS_LABELS[visible]}`);
        this._detail.label.set_text(description);
        this._mute.label.set_text(this._preferences.mute_all ? 'Unmute alerts' : 'Mute all alerts');
        this._renderSessions(rows);
        this._button.show();
    }

    _renderSessions(rows) {
        const groups = {};
        const totals = {};
        for (const agent of ['claude', 'codex']) {
            const sessions = rows.filter(row => row.agent === agent);
            totals[agent] = sessions.length;
            this._sessionPage[agent] = Math.min(this._sessionPage[agent], Math.max(0, Math.ceil(sessions.length / 50) - 1));
            const start = this._sessionPage[agent] * 50;
            groups[agent] = sessions.slice(start, start + 50);
        }
        const order = JSON.stringify([totals, Object.values(groups).flat().map(row => [row.agent, row.session])]);
        const rebuilding = order !== this._rowOrder || this._groupWidgets.size === 0;
        const openRows = new Set([...this._rowWidgets].filter(([, widget]) => widget.item.menu.isOpen).map(([key]) => key));
        const openGroups = new Set([...this._groupWidgets].filter(([, widget]) => widget.menu.isOpen).map(([key]) => key));
        if (rebuilding) {
            this._sessions.menu.removeAll();
            this._rowWidgets.clear();
            this._groupWidgets.clear();
            this._rowOrder = order;
        }
        for (const agent of ['claude', 'codex']) {
            let group = this._groupWidgets.get(agent);
            if (!group) {
                group = new PopupMenu.PopupSubMenuMenuItem(AGENT_LABELS[agent]);
                this._groupWidgets.set(agent, group);
                this._sessions.menu.addMenuItem(group);
            }
            const sessions = groups[agent];
            if (rebuilding && sessions.length === 0)
                group.menu.addMenuItem(new PopupMenu.PopupMenuItem('No sessions', {reactive: false}));
            if (rebuilding && totals[agent] > 50) {
                const start = this._sessionPage[agent] * 50;
                group.menu.addMenuItem(new PopupMenu.PopupMenuItem(
                    `Showing ${start + 1}–${start + sessions.length} of ${totals[agent]}`, {reactive: false}));
                if (start > 0) {
                    group.menu.addAction('Previous sessions', () => {
                        this._sessionPage[agent]--;
                        this._render();
                    });
                }
                if (start + 50 < totals[agent]) {
                    group.menu.addAction('Next sessions', () => {
                        this._sessionPage[agent]++;
                        this._render();
                    });
                }
            }
            for (const row of sessions) {
                const key = JSON.stringify([row.agent, row.session]);
                let widget = this._rowWidgets.get(key);
                if (!widget) {
                    const item = new PopupMenu.PopupSubMenuMenuItem('');
                    const detail = new PopupMenu.PopupMenuItem('', {reactive: false});
                    item.menu.addMenuItem(detail);
                    item.menu.addAction('Copy session reset command', () => {
                        const command = `agent-status update ${row.agent} idle --session ${GLib.shell_quote(row.session)}`;
                        St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, command);
                        this._detail.label.set_text('Reset command copied. Review and run it in a terminal.');
                    });
                    widget = {item, detail};
                    this._rowWidgets.set(key, widget);
                    group.menu.addMenuItem(item);
                }
                widget.item.label.set_text(`${row.project} [${row.short}] · ${STATUS_LABELS[row.state]}`);
                const time = row.updatedAt > 0 && row.updatedAt < 8640000000000
                    ? new Date(row.updatedAt * 1000).toLocaleString() : 'Time unavailable';
                widget.detail.label.set_text(`${row.event || 'Last event unavailable'} · ${time}`);
                if (rebuilding && openRows.has(key))
                    widget.item.menu.open();
            }
            if (rebuilding && openGroups.has(agent))
                group.menu.open();
        }
    }
}
