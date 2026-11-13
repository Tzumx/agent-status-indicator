// SPDX-License-Identifier: MIT
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import Pango from 'gi://Pango';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as BarLevel from 'resource:///org/gnome/shell/ui/barLevel.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import {ensureActorVisibleInScrollView} from 'resource:///org/gnome/shell/misc/animationUtils.js';
import {Spinner} from 'resource:///org/gnome/shell/ui/animation.js';
import {summarize, COLORS, sessionRows, STATUS_LABELS, AGENT_LABELS, preferences, AlertCursor, sessionSummary, sessionDetail, SUMMARY_LABELS, STATUS_ICONS, settingsPreferences, quotaWindows, quotaLabel, currentAlerts, reportedTime, refreshFeedback} from './state.js';
import {Alerts, QuotaResetTimer} from './alerts.js';
import * as LoginManager from 'resource:///org/gnome/shell/misc/loginManager.js';
import {readJson, refreshUsage} from './io.js';


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
        this._usageRefreshing = false;
        this._refreshMessage = '';
        this._refreshError = '';
        this._feedbackId = 0;
        this._tooltipId = 0;
        this._missing = true;
        this._reading = false;
        this._stateDirty = true;
        this._configDirty = true;
        this._watchDirty = false;
        this._legacyPreferences = {};
        this._settings = this.getSettings();
        this._preferences = settingsPreferences(this._settings);
        this._settingsChangedId = this._settings.connect('changed', (_settings, key) => {
            this._preferences = settingsPreferences(this._settings, this._legacyPreferences);
            if (key === 'mute-all' || key.startsWith('sound-') || key.startsWith('notify-'))
                this._alerts.cancelSound();
            this._render();
        });
        this._showResetControls = false;
        this._metrics = new Map();
        this._rowWidgets = new Map();
        this._groupWidgets = new Map();
        this._rowOrder = '';
        this._sessionPage = {claude: 0, codex: 0};
        this._cursor = new AlertCursor();
        this._alerts = new Alerts(message => this._reportError(message));
        this._quotaTimer = new QuotaResetTimer((agent, window, notify) => {
            if (notify)
                this._alerts.quotaReset(agent, window, this._preferences);
            this._render();
        });
        this._loginManager = LoginManager.getLoginManager();
        this._resumeId = this._loginManager.connect('prepare-for-sleep', (_manager, sleeping) => {
            if (!sleeping)
                this._quotaTimer.update(this._lastState, this._preferences);
        });
        this._cancellable = new Gio.Cancellable();
        this._stateFile = Gio.File.new_for_path(GLib.build_filenamev([
            GLib.get_user_cache_dir(), 'agent-status-indicator', 'state.json',
        ]));
        this._configFile = Gio.File.new_for_path(GLib.build_filenamev([
            GLib.get_user_config_dir(), 'agent-status-indicator', 'gnome.json',
        ]));
        this._button = new PanelMenu.Button(0.0, 'Agent Status Indicator', false);
        this._button.menu.connect('open-state-changed', (_menu, open) => {
            if (open) {
                this._render();
                this._constrainMenuWidth();
            } else {
                this._hideRefreshTooltip();
                this._clearRefreshFeedback();
            }
        });
        this._panelIcons = {
            circle: new Gio.ThemedIcon({name: 'media-record-symbolic'}),
            robot: new Gio.FileIcon({file: this.dir.get_child('robot-head-symbolic.svg')}),
        };
        this._panelIcon = null;
        this._dot = new St.Icon({
            icon_name: 'media-record-symbolic', icon_size: 14,
            style_class: 'system-status-icon', y_align: Clutter.ActorAlign.CENTER,
        });
        this._button.add_child(this._dot);
        this._summary = new PopupMenu.PopupMenuItem('Agent status', {activate: false, hover: false, can_focus: false});
        this._summary.remove_style_class_name('popup-inactive-menu-item');
        this._summary.label.add_style_class_name('agent-status-heading');
        this._summary.label.x_expand = true;
        this._refreshIcon = new St.Icon({icon_name: 'view-refresh-symbolic', icon_size: 16});
        // Stop its frame timer immediately before replacing the child.
        this._refreshSpinner = new Spinner(16, {animate: false});
        this._refreshButton = new St.Button({
            style_class: 'button agent-status-refresh', can_focus: true, track_hover: true,
            accessible_name: 'Refresh local data', child: this._refreshIcon,
        });
        this._refreshButton.connect('clicked', () => this._refreshLocal());
        for (const signal of ['notify::hover', 'key-focus-in', 'key-focus-out'])
            this._refreshButton.connect(signal, () => this._syncRefreshTooltip());
        this._summary.add_child(this._refreshButton);
        this._refreshTooltip = new St.Label({
            text: 'Refresh local data', style_class: 'dash-label', visible: false,
        });
        Main.uiGroup.add_child(this._refreshTooltip);
        this._refreshFeedback = new PopupMenu.PopupMenuItem('', {activate: false, hover: false, can_focus: false});
        this._refreshHint = this._refreshFeedback.label;
        this._refreshHint.add_style_class_name('dim-label');
        this._refreshHint.clutter_text.line_wrap = true;
        this._refreshHint.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
        this._detail = new PopupMenu.PopupMenuItem('', {activate: false, hover: false, can_focus: false});
        this._detail.label.clutter_text.line_wrap = true;
        this._detail.label.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
        this._sessions = new PopupMenu.PopupSubMenuMenuItem('Sessions');
        this._button.menu.addMenuItem(this._summary);
        this._button.menu.addMenuItem(this._refreshFeedback);
        for (const [state, text] of Object.entries(SUMMARY_LABELS)) {
            const item = new PopupMenu.PopupBaseMenuItem({activate: false, hover: false, can_focus: false});
            item.remove_style_class_name('popup-inactive-menu-item');
            const icon = new St.Icon({icon_name: STATUS_ICONS[state], style_class: 'popup-menu-icon'});
            icon.set_style(`color: ${COLORS[state === 'decision' ? 'approval' : state]};`);
            const label = new St.Label({text, x_expand: true});
            const count = new St.Label({style_class: 'dim-label'});
            item.add_child(icon);
            item.add_child(label);
            item.add_child(count);
            this._metrics.set(state, {item, label, count});
            this._button.menu.addMenuItem(item);
        }
        this._button.menu.addMenuItem(this._detail);
        this._button.menu.addMenuItem(this._sessions);
        this._mute = this._button.menu.addAction('Mute all alerts', () => this._toggleMute());
        this._troubleshooting = new PopupMenu.PopupSubMenuMenuItem('Troubleshooting');
        this._button.menu.addMenuItem(this._troubleshooting);
        this._resetControls = new PopupMenu.PopupSwitchMenuItem('Show reset controls', false);
        this._resetControls.connect('toggled', (_item, state) => {
            this._showResetControls = state;
            this._render();
        });
        this._troubleshooting.menu.addMenuItem(this._resetControls);
        this._lastReported = new PopupMenu.PopupMenuItem('', {activate: false, hover: false, can_focus: false});
        this._troubleshooting.menu.addMenuItem(this._lastReported);
        this._notificationDetail = new PopupMenu.PopupMenuItem('', {activate: false, hover: false, can_focus: false});
        this._notificationDetail.label.clutter_text.line_wrap = true;
        this._notificationDetail.label.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
        this._troubleshooting.menu.addMenuItem(this._notificationDetail);
        this._refreshDetail = new PopupMenu.PopupMenuItem('', {activate: false, hover: false, can_focus: false});
        this._refreshDetail.label.clutter_text.line_wrap = true;
        this._refreshDetail.label.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
        this._troubleshooting.menu.addMenuItem(this._refreshDetail);
        this._troubleshooting.menu.addAction('Refresh status', () => this._refreshLocal());
        this._button.menu.addAction('Settings…', () => this.openPreferences());
        for (const item of [this._refreshFeedback, this._detail, this._lastReported,
            this._notificationDetail, this._refreshDetail])
            item.remove_style_class_name('popup-inactive-menu-item');
        Main.panel.addToStatusArea(this.uuid, this._button, 0, 'right');
        this._setupMonitors();
        this._render();
        this._refresh();
    }

    disable() {
        for (const id of [this._refreshId, this._recoveryId, this._feedbackId, this._tooltipId]) {
            if (id)
                GLib.source_remove(id);
        }
        this._refreshId = 0;
        this._recoveryId = 0;
        if (this._settingsChangedId)
            this._settings.disconnect(this._settingsChangedId);
        this._settingsChangedId = 0;
        this._settings = null;
        this._legacyPreferences = null;
        this._feedbackId = 0;
        this._tooltipId = 0;
        this._refreshSpinner?.stop();
        this._refreshTooltip?.destroy();
        this._refreshTooltip = null;
        this._refreshButton?.set_child(null);
        this._refreshIcon?.destroy();
        this._refreshSpinner?.destroy();
        this._cancellable?.cancel();
        this._cancellable = null;
        this._clearMonitors();
        this._quotaTimer?.destroy();
        this._quotaTimer = null;
        if (this._resumeId)
            this._loginManager.disconnect(this._resumeId);
        this._resumeId = 0;
        this._loginManager = null;
        this._alerts?.destroy();
        this._alerts = null;
        this._button?.destroy();
        this._button = null;
        this._dot = null;
        this._panelIcons = null;
        this._panelIcon = null;
        this._summary = null;
        this._refreshButton = null;
        this._refreshIcon = null;
        this._refreshSpinner = null;
        this._refreshFeedback = null;
        this._refreshHint = null;
        this._lastReported = null;
        this._detail = null;
        this._sessions = null;
        this._troubleshooting = null;
        this._resetControls = null;
        this._showResetControls = false;
        this._metrics.clear();
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
                    this._legacyPreferences = preferences(config);
                    this._preferences = settingsPreferences(this._settings, this._legacyPreferences);
                    this._configError = '';
                } catch (error) {
                    if (cancellable !== this._cancellable || cancellable.is_cancelled())
                        return;
                    if (isMissing(error)) {
                        this._legacyPreferences = {};
                        this._preferences = settingsPreferences(this._settings);
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
                    if (candidate.sessions !== undefined && currentAlerts(candidate) === null)
                        throw new Error('Invalid session records');
                    if (cancellable !== this._cancellable || cancellable.is_cancelled())
                        return;
                    this._lastState = candidate;
                    this._missing = false;
                    this._stateError = '';
                    const {events, warning} = this._cursor.read(candidate);
                    this._alertWarning = warning;
                    this._alerts.dispatch(events, this._preferences, candidate);
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

    _clearRefreshFeedback() {
        if (this._feedbackId)
            GLib.source_remove(this._feedbackId);
        this._feedbackId = 0;
        this._refreshMessage = '';
        if (this._refreshFeedback)
            this._refreshFeedback.visible = false;
    }

    _hideRefreshTooltip() {
        if (this._tooltipId)
            GLib.source_remove(this._tooltipId);
        this._tooltipId = 0;
        if (this._refreshTooltip)
            this._refreshTooltip.visible = false;
    }

    _syncRefreshTooltip() {
        this._hideRefreshTooltip();
        if (!this._cancellable || this._usageRefreshing || !this._button.menu.isOpen
            || !(this._refreshButton.hover || this._refreshButton.has_key_focus()))
            return;
        this._tooltipId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 500, () => {
            this._tooltipId = 0;
            const [x, y] = this._refreshButton.get_transformed_position();
            const [width, height] = this._refreshButton.get_transformed_size();
            const [, tooltipWidth] = this._refreshTooltip.get_preferred_width(-1);
            const [, tooltipHeight] = this._refreshTooltip.get_preferred_height(tooltipWidth);
            const area = Main.layoutManager.getWorkAreaForMonitor(Main.layoutManager.findIndexForActor(this._button));
            this._refreshTooltip.set_position(
                Math.max(area.x + 6, Math.min(x + (width - tooltipWidth) / 2, area.x + area.width - tooltipWidth - 6)),
                Math.min(y + height + 6, area.y + area.height - tooltipHeight - 6));
            Main.uiGroup.set_child_above_sibling(this._refreshTooltip, null);
            this._refreshTooltip.visible = true;
            return GLib.SOURCE_REMOVE;
        });
    }

    async _refreshLocal() {
        if (this._usageRefreshing || !this._cancellable)
            return;
        const cancellable = this._cancellable;
        this._usageRefreshing = true;
        this._clearRefreshFeedback();
        this._hideRefreshTooltip();
        this._refreshError = '';
        this._refreshSpinner.play();
        this._render();
        let message;
        try {
            message = refreshFeedback(await refreshUsage(cancellable));
        } catch (error) {
            if (cancellable !== this._cancellable || cancellable.is_cancelled())
                return;
            message = 'Refresh unavailable; see Troubleshooting.';
            this._refreshError = 'Check that the updated companion is installed. '
                + 'Claude usage updates through its status line. ' + String(error.message).slice(0, 160);
        } finally {
            if (cancellable === this._cancellable && !cancellable.is_cancelled()) {
                this._stateDirty = true;
                this._configDirty = true;
                this._watchDirty = true;
                await this._refresh();
                if (cancellable === this._cancellable && !cancellable.is_cancelled()) {
                    this._usageRefreshing = false;
                    this._refreshMessage = message;
                    this._feedbackId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 4000, () => {
                        this._feedbackId = 0;
                        this._refreshMessage = '';
                        this._render();
                        return GLib.SOURCE_REMOVE;
                    });
                    this._refreshSpinner.stop();
                    this._render();
                }
            }
        }
    }

    async _toggleMute() {
        try {
            if (!this._settings.set_boolean('mute-all', !this._preferences.mute_all))
                throw new Error('Cannot save alert preferences.');
            this._preferences = settingsPreferences(this._settings, this._legacyPreferences);
            if (this._configError === 'Cannot save alert preferences.')
                this._configError = '';
            this._alerts.cancelSound();
            this._render();
        } catch (error) {
            this._configError = 'Cannot save alert preferences.';
            this._reportError(error.message);
            this._render();
        }
    }

    _reportError(message) {
        if (message !== this._lastError)
            console.error(`Agent Status: ${message}`);
        this._lastError = message;
    }

    _constrainMenuWidth() {
        const actor = this._button.menu.actor;
        const monitor = Main.layoutManager.findIndexForActor(this._button);
        const area = Main.layoutManager.getWorkAreaForMonitor(monitor);
        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        const padding = actor.get_theme_node().get_length('-arrow-rise');
        const margins = actor.margin_left + actor.margin_right;
        // Keep BoxPointer's edge padding and PanelMenu's existing height limit.
        const width = Math.max(1, Math.min(520, Math.floor((area.width - 2 * padding - margins) / scale)));
        actor.style = `${actor.style || ''} max-width: ${width}px;`;
    }

    _render() {
        this._quotaTimer?.update(this._lastState, this._preferences);
        const {status} = summarize(this._lastState);
        const rows = sessionRows(this._lastState, this._preferences.show_closed_sessions);
        let visible = this._stateError ? 'error' : status;
        if (visible === 'idle' && rows.some(row => row.state === 'finished'))
            visible = 'finished';
        if (visible === 'approval' && !rows.some(row => row.state === 'approval'))
            visible = 'decision';
        const {counts, headline} = sessionSummary(rows);
        const description = [this._stateError,
            this._missing ? 'Waiting for agent status. Open Settings → Integration for setup help.' : '',
            this._configError].filter(Boolean).join('\n');
        if (this._panelIcon !== this._preferences.panel_icon) {
            this._panelIcon = this._preferences.panel_icon;
            this._dot.gicon = this._panelIcons[this._panelIcon];
        }
        this._dot.set_style(`color: ${COLORS[visible === 'decision' ? 'approval' : visible] || COLORS.idle};`);
        const countText = Object.entries(counts).filter(([, count]) => count > 0)
            .map(([state, count]) => `${SUMMARY_LABELS[state]}: ${count}`).join('. ');
        this._button.set_accessible_name(`Agent status: ${STATUS_LABELS[visible]}. ${countText}. ${description}`);
        this._summary.label.set_text(this._stateError ? 'Status unavailable'
            : this._missing ? 'Waiting for agent status' : headline);
        this._detail.label.set_text(description);
        this._detail.visible = Boolean(description);
        this._lastReported.label.set_text(Number.isFinite(this._lastState.updated_at)
            ? reportedTime(this._lastState.updated_at).replace('Last reported', 'Status updated') : 'No status updates received');
        this._refreshHint.set_text(this._refreshMessage);
        this._refreshFeedback.visible = Boolean(this._refreshMessage) && !this._usageRefreshing;
        const refreshChild = this._usageRefreshing ? this._refreshSpinner : this._refreshIcon;
        if (this._refreshButton.get_child() !== refreshChild)
            this._refreshButton.set_child(refreshChild);
        this._refreshButton.reactive = !this._usageRefreshing;
        this._refreshButton.can_focus = !this._usageRefreshing;
        this._refreshButton.set_accessible_name(this._usageRefreshing ? 'Refreshing local data' : 'Refresh local data');
        this._troubleshooting.label.set_text(this._alertWarning || this._refreshError
            ? 'Troubleshooting · Needs attention' : 'Troubleshooting');
        this._notificationDetail.visible = Boolean(this._alertWarning);
        this._notificationDetail.label.set_text(this._alertWarning
            + (this._alertWarning === 'Notification tracking unavailable.'
                ? ' Session status remains available, but new session notifications cannot be delivered. Update the companion commands and hooks if this persists.' : ''));
        this._refreshDetail.visible = Boolean(this._refreshError);
        this._refreshDetail.label.set_text(this._refreshError);
        for (const [state, metric] of this._metrics) {
            metric.count.set_text(String(counts[state]));
            metric.item.visible = this._preferences.show_state_counts && counts[state] > 0;
        }
        this._mute.label.set_text(this._preferences.mute_all ? 'Unmute alerts' : 'Mute all alerts');
        this._renderSessions(rows);
        this._button.show();
    }

    _usageWidget() {
        const box = new St.BoxLayout({vertical: true, style_class: 'agent-status-usage', x_expand: true});
        const title = new St.BoxLayout({style_class: 'agent-status-secondary'});
        const label = new St.Label({x_expand: true});
        const amount = new St.Label();
        title.add_child(label);
        title.add_child(amount);
        const bar = new BarLevel.BarLevel({style_class: 'barlevel agent-status-usage-bar', x_expand: true});
        box.add_child(title);
        box.add_child(bar);
        const reported = new St.Label({style_class: 'agent-status-usage-time'});
        box.add_child(reported);
        return {box, label, amount, bar, reported};
    }

    _updateUsage(widget, value, title) {
        widget.box.visible = Boolean(value);
        if (!value)
            return;
        const percent = Math.round(value.used_percent);
        widget.label.set_text(title);
        widget.amount.set_text(`${percent}% used`);
        widget.reported.visible = Number.isFinite(value.updated_at) && value.updated_at > 0;
        if (widget.reported.visible)
            widget.reported.set_text(reportedTime(value.updated_at));
        widget.bar.value = value.used_percent / 100;
        widget.bar.set_accessible_name(`${title}: ${percent}% used`);
        const color = percent >= 95 ? COLORS.error : percent >= 80 ? COLORS.approval : COLORS.finished;
        widget.bar.set_style(`-barlevel-active-background-color: ${color};`);
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
        this._sessions.visible = rows.length > 0 || this._preferences.show_empty_agents;
        if (!this._sessions.visible)
            this._sessions.menu.close();
        const order = JSON.stringify([this._preferences.show_empty_agents, totals,
            Object.values(groups).flat().map(row => [row.agent, row.session])]);
        const rebuilding = order !== this._rowOrder;
        if (rebuilding) {
            this._sessions.menu.removeAll();
            this._rowWidgets.clear();
            this._groupWidgets.clear();
            this._rowOrder = order;
        }
        for (const agent of ['claude', 'codex']) {
            if (groups[agent].length === 0 && !this._preferences.show_empty_agents)
                continue;
            let group = this._groupWidgets.get(agent);
            if (!group) {
                // GNOME permits one open submenu per top-level menu. Keep
                // agent groups and session controls inside that single submenu.
                group = new PopupMenu.PopupMenuSection();
                const heading = new PopupMenu.PopupBaseMenuItem({activate: false, hover: false, can_focus: false});
                heading.remove_style_class_name('popup-inactive-menu-item');
                const content = new St.BoxLayout({vertical: true, x_expand: true, style_class: 'agent-status-group'});
                content.add_child(new St.Label({text: AGENT_LABELS[agent], style_class: 'agent-status-heading'}));
                group.usage = [];
                for (let index = 0; index < 2; index++) {
                    const widget = this._usageWidget();
                    content.add_child(widget.box);
                    group.usage.push(widget);
                }
                group.reported = new St.Label({style_class: 'agent-status-usage-time'});
                content.add_child(group.reported);
                heading.add_child(content);
                group.addMenuItem(heading);
                this._groupWidgets.set(agent, group);
                this._sessions.menu.addMenuItem(group);
            }
            const windows = this._preferences.show_account_usage ? quotaWindows(this._lastState, agent) : [];
            for (const [index, widget] of group.usage.entries()) {
                const window = windows[index];
                this._updateUsage(widget, window, window ? `${quotaLabel(window.window_minutes)} quota` : '');
            }
            group.reported.visible = windows.length > 0;
            if (windows.length)
                group.reported.set_text(reportedTime(this._lastState.usage[agent].updated_at));
            const sessions = groups[agent];
            if (rebuilding && sessions.length === 0)
                group.addMenuItem(new PopupMenu.PopupMenuItem('No sessions', {activate: false, hover: false, can_focus: false}));
            if (rebuilding && totals[agent] > 50) {
                const start = this._sessionPage[agent] * 50;
                group.addMenuItem(new PopupMenu.PopupMenuItem(
                    `Showing ${start + 1}–${start + sessions.length} of ${totals[agent]}`, {reactive: false}));
                const pager = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false});
                for (const [label, delta, visible] of [
                    ['Previous sessions', -1, start > 0],
                    ['Next sessions', 1, start + sessions.length < totals[agent]],
                ]) {
                    if (!visible)
                        continue;
                    const button = new St.Button({label, style_class: 'button', can_focus: true});
                    button.connect('key-focus-in', () =>
                        ensureActorVisibleInScrollView(this._sessions.menu.actor, pager));
                    button.connect('clicked', () => {
                        this._sessionPage[agent] += delta;
                        this._render();
                    });
                    pager.add_child(button);
                }
                group.addMenuItem(pager);
            }
            for (const row of sessions) {
                const key = JSON.stringify([row.agent, row.session]);
                let widget = this._rowWidgets.get(key);
                if (!widget) {
                    const item = new PopupMenu.PopupBaseMenuItem({activate: false, hover: false, can_focus: false});
                    item.remove_style_class_name('popup-inactive-menu-item');
                    item.connect('key-focus-in', () =>
                        ensureActorVisibleInScrollView(this._sessions.menu.actor, item));
                    const labels = new St.BoxLayout({vertical: true, x_expand: true});
                    const title = new St.BoxLayout({style_class: 'agent-status-session-title'});
                    const label = new St.Label({x_expand: true, style_class: 'agent-status-project'});
                    label.clutter_text.ellipsize = Pango.EllipsizeMode.END;
                    const status = new St.Label({style_class: 'agent-status-state'});
                    status.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
                    const statusBox = new St.BoxLayout({style_class: 'agent-status-session-state'});
                    const statusIcon = new St.Icon({style_class: 'popup-menu-icon', icon_size: 16});
                    statusBox.add_child(statusIcon);
                    statusBox.add_child(status);
                    title.add_child(label);
                    title.add_child(statusBox);
                    const secondary = new St.BoxLayout({style_class: 'agent-status-secondary'});
                    const identity = new St.Label({style_class: 'dim-label'});
                    identity.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
                    const detail = new St.Label({style_class: 'dim-label', x_expand: true});
                    detail.clutter_text.ellipsize = Pango.EllipsizeMode.MIDDLE;
                    secondary.add_child(identity);
                    secondary.add_child(detail);
                    labels.add_child(title);
                    labels.add_child(secondary);
                    const context = this._usageWidget();
                    labels.add_child(context.box);
                    item.add_child(labels);
                    const reset = new St.Button({
                        label: 'Copy reset command', style_class: 'button',
                        can_focus: true, y_align: Clutter.ActorAlign.CENTER,
                    });
                    item.add_child(reset);
                    reset.connect('key-focus-in', () =>
                        ensureActorVisibleInScrollView(this._sessions.menu.actor, item));
                    reset.connect('clicked', () => {
                        const command = `agent-status update ${row.agent} idle --session ${GLib.shell_quote(row.session)}`;
                        St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, command);
                        this._detail.label.set_text('Reset command copied. Review and run it in a terminal.');
                        this._detail.visible = true;
                    });
                    widget = {item, label, status, statusIcon, identity, detail, reset, context};
                    this._rowWidgets.set(key, widget);
                    group.addMenuItem(item);
                }
                widget.item.can_focus = !this._showResetControls;
                const detail = sessionDetail(row, this._preferences.show_event_details);
                this._updateUsage(widget.context, this._preferences.show_context_usage ? row.context : null, 'Context ≈');
                const contextDetail = this._preferences.show_context_usage && row.context
                    ? ` Context approximately ${Math.round(row.context.used_percent)}% used; reported ${sessionDetail({updatedAt: row.context.updated_at})}.` : '';
                widget.item.set_accessible_name(
                    `${AGENT_LABELS[row.agent]}: ${row.project} · ${STATUS_LABELS[row.state]}. Session ${row.short}. ${detail}${contextDetail}`);
                widget.reset.visible = this._showResetControls;
                widget.label.set_text(row.project);
                widget.status.set_text(STATUS_LABELS[row.state]);
                widget.statusIcon.icon_name = STATUS_ICONS[row.state];
                widget.statusIcon.set_style(`color: ${COLORS[row.state === 'decision' ? 'approval' : row.state]};`);
                widget.identity.set_text('#' + row.short);
                widget.detail.set_text(detail);
                widget.reset.set_accessible_name(`Copy reset command for ${row.project} [${row.short}]`);
            }
        }
    }
}
