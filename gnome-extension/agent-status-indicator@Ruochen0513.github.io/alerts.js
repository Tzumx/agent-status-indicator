// SPDX-License-Identifier: MIT
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';
import {AGENT_LABELS, SOUND_NAMES, safeText, shortId, currentAlerts, alertHistory, quotaWindows, quotaLabel} from './state.js';

const MESSAGES = {
    completion: 'Finished responding', permission: 'Permission required',
    decision: 'Decision required', error: 'An agent operation failed',
};
const SOUND_PRIORITY = {'quota-reset': 0, completion: 0, decision: 1, permission: 2, error: 3};

export class Alerts {
    constructor(reportError) {
        this._reportError = reportError;
        this._sources = new Map();
        this._notices = new Map();
        this._quotaNotices = new Map();
        this._soundId = 0;
        this._pendingSound = null;
    }

    dispatch(events, config, state = null) {
        const current = state ? currentAlerts(state) : null;
        const generation = alertHistory(state)?.generation;
        if (state && !current)
            return;
        if (state) {
            for (const [agent, notice] of this._quotaNotices) {
                if (Number.isFinite(state.usage?.[agent]?.updated_at)
                    && Array.isArray(state.usage[agent].windows)
                    && state.usage[agent].updated_at >= notice.reset)
                    notice.notification.destroy(MessageTray.NotificationDestroyedReason.EXPIRED);
            }
            if (this._pendingSound?.kind === 'quota-reset'
                && Number.isFinite(state.usage?.[this._pendingSound.event.agent]?.updated_at)
                && Array.isArray(state.usage[this._pendingSound.event.agent].windows)
                && state.usage[this._pendingSound.event.agent].updated_at >= this._pendingSound.event.reset)
                this.cancelSound();
        }
        if (current) {
            for (const [key, notice] of this._notices) {
                if (!this._isCurrent(notice, current.get(key), generation))
                    notice.notification.destroy(MessageTray.NotificationDestroyedReason.EXPIRED);
            }
            if (this._pendingSound && this._pendingSound.kind !== 'quota-reset' && !this._isCurrent(this._pendingSound,
                current.get(JSON.stringify([this._pendingSound.event.agent, this._pendingSound.event.session])), generation))
                this.cancelSound();
        }
        if (config.mute_all)
            return;
        for (const event of events) {
            const key = JSON.stringify([event.agent, event.session]);
            const turn = current?.get(key)?.turn;
            if (current && !this._isCurrent({event, generation, turn}, current.get(key), generation))
                continue;
            if (config.notifications[event.kind]) {
                let notification;
                try {
                    let source = this._sources.get(key);
                    if (!source) {
                        if (this._sources.size >= 256)
                            this._sources.values().next().value.destroy();
                        source = new MessageTray.Source({
                            title: AGENT_LABELS[event.agent], iconName: 'dialog-information-symbolic',
                        });
                        source.connect('destroy', () => this._sources.delete(key));
                        this._sources.set(key, source);
                        Main.messageTray.add(source);
                    }
                    const project = safeText(event.project).split(/[\\/]/).at(-1) || 'Session';
                    const previous = this._notices.get(key);
                    notification = new MessageTray.Notification({
                        source,
                        title: `${AGENT_LABELS[event.agent]} · ${project} [${shortId(event.session)}]`,
                        body: MESSAGES[event.kind], sound: null, isTransient: false,
                        urgency: event.kind === 'completion'
                            ? MessageTray.Urgency.NORMAL : MessageTray.Urgency.HIGH,
                    });
                    notification.connect('destroy', () => {
                        if (this._notices.get(key)?.notification === notification)
                            this._notices.delete(key);
                    });
                    this._notices.set(key, {notification, event, generation, turn});
                    source.addNotification(notification);
                    previous?.notification.destroy(MessageTray.NotificationDestroyedReason.REPLACED);
                } catch (error) {
                    this._notices.delete(key);
                    this._sources.get(key)?.destroy();
                    this._reportError(`Cannot show notification: ${error.message}`);
                }
            }
            if (config.sounds[event.kind])
                this._queueSound(event, config.sound_files[event.kind], generation, turn);
        }
    }

    quotaReset(agent, window, config) {
        if (config.mute_all)
            return;
        const kind = 'quota-reset';
        if (config.notifications[kind]) {
            let source;
            let notification;
            try {
                const previous = this._quotaNotices.get(agent);
                source = previous?.notification.source ?? new MessageTray.Source({
                    title: AGENT_LABELS[agent], iconName: 'appointment-soon-symbolic',
                });
                if (!previous)
                    Main.messageTray.add(source);
                notification = new MessageTray.Notification({
                    source, title: `${AGENT_LABELS[agent]} · Quota reset time reached`,
                    body: `${quotaLabel(window.window_minutes)} quota window reached its reported reset time. Usage refreshes on the next agent update.`,
                    sound: null, isTransient: false, urgency: MessageTray.Urgency.NORMAL,
                });
                notification.connect('destroy', () => {
                    if (this._quotaNotices.get(agent)?.notification === notification)
                        this._quotaNotices.delete(agent);
                });
                this._quotaNotices.set(agent, {notification, reset: window.resets_at});
                source.addNotification(notification);
                previous?.notification.destroy(MessageTray.NotificationDestroyedReason.REPLACED);
            } catch (error) {
                this._quotaNotices.delete(agent);
                notification?.destroy(MessageTray.NotificationDestroyedReason.EXPIRED);
                source?.destroy();
                this._reportError(`Cannot show quota notification: ${error.message}`);
            }
        }
        if (config.sounds[kind])
            this._queueSound({kind, agent, reset: window.resets_at}, config.sound_files[kind]);
    }

    _isCurrent(notice, current, generation) {
        // Restarted history counters do not establish that a session resumed.
        const newHistory = notice.generation && generation && notice.generation !== generation;
        return current?.kind === notice.event.kind
            && (newHistory || current.sequence === null || current.sequence === notice.event.sequence)
            && (!notice.turn || !current.turn || notice.turn === current.turn);
    }

    _queueSound(event, path, generation, turn) {
        if (!this._pendingSound || SOUND_PRIORITY[event.kind] > SOUND_PRIORITY[this._pendingSound.kind])
            this._pendingSound = {kind: event.kind, path, event, generation, turn};
        if (this._soundId)
            return;
        this._soundId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1000, () => {
            this._soundId = 0;
            const sound = this._pendingSound;
            this._pendingSound = null;
            try {
                const player = global.display.get_sound_player();
                if (sound.path)
                    player.play_from_file(Gio.File.new_for_path(sound.path), 'Agent status', null);
                else
                    player.play_from_theme(SOUND_NAMES[sound.kind], 'Agent status', null);
            } catch (error) {
                this._reportError(`Cannot play alert sound: ${error.message}`);
            }
            return GLib.SOURCE_REMOVE;
        });
    }

    cancelSound() {
        if (this._soundId)
            GLib.source_remove(this._soundId);
        this._soundId = 0;
        this._pendingSound = null;
    }

    destroy() {
        this.cancelSound();
        for (const source of [...this._sources.values()])
            source.destroy();
        this._sources.clear();
        this._notices.clear();
        for (const {notification} of [...this._quotaNotices.values()])
            notification.destroy(MessageTray.NotificationDestroyedReason.EXPIRED);
        this._quotaNotices.clear();
    }
}

// One deadline expires visible quota and delivers opted-in reset alerts.
export class QuotaResetTimer {
    constructor(onDeadline, clock = () => Date.now() / 1000) {
        this._onDeadline = onDeadline;
        this._clock = clock;
        this._pending = new Map();
        this._seen = new Set();
        this._id = 0;
    }

    update(state, config) {
        this._state = state;
        this._config = config;
        if (this._id)
            GLib.source_remove(this._id);
        this._id = 0;
        const next = new Map();
        const due = [];
        const now = this._clock();
        const notifyEnabled = !config.mute_all
            && (config.notifications['quota-reset'] || config.sounds['quota-reset']);
        if (config.show_account_usage || notifyEnabled) {
            for (const agent of ['claude', 'codex']) {
                for (const window of quotaWindows(state, agent, 0)) {
                    const key = JSON.stringify([agent, window.window_minutes, window.resets_at]);
                    if (this._seen.has(key))
                        continue;
                    if (window.resets_at > now) {
                        next.set(key, {agent, window, notify: notifyEnabled});
                    } else if (this._pending.has(key)) {
                        this._seen.add(key);
                        due.push({agent, window, notify: notifyEnabled && this._pending.get(key).notify});
                    }
                }
            }
        }
        this._pending = next;
        this._seen = new Set([...this._seen].slice(-256));
        if (next.size) {
            const deadline = Math.min(...[...next.values()].map(item => item.window.resets_at));
            const delay = Math.max(1, Math.min(2147483647, Math.ceil((deadline - now) * 1000)));
            this._id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, delay, () => {
                this._id = 0;
                this.update(this._state, this._config);
                return GLib.SOURCE_REMOVE;
            });
        }
        for (const {agent, window, notify} of due)
            this._onDeadline(agent, window, notify);
    }

    destroy() {
        if (this._id)
            GLib.source_remove(this._id);
        this._id = 0;
        this._pending.clear();
        this._seen.clear();
        this._state = null;
        this._config = null;
    }
}
