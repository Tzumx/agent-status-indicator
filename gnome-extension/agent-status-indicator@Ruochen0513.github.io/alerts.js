// SPDX-License-Identifier: MIT
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';
import {AGENT_LABELS, SOUND_NAMES, safeText, shortId} from './state.js';

const MESSAGES = {
    completion: 'Finished responding', permission: 'Permission required',
    decision: 'Decision required', error: 'An agent operation failed',
};
const SOUND_PRIORITY = {completion: 0, decision: 1, permission: 2, error: 3};

export class Alerts {
    constructor(reportError) {
        this._reportError = reportError;
        this._sources = new Map();
        this._soundId = 0;
        this._pendingSound = null;
    }

    dispatch(events, config) {
        if (config.mute_all)
            return;
        for (const event of events) {
            if (config.notifications[event.kind]) {
                const key = JSON.stringify([event.agent, event.session]);
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
                    source.addNotification(new MessageTray.Notification({
                        source,
                        title: `${AGENT_LABELS[event.agent]} · ${project} [${shortId(event.session)}]`,
                        body: MESSAGES[event.kind], sound: null, isTransient: false,
                        urgency: event.kind === 'completion'
                            ? MessageTray.Urgency.NORMAL : MessageTray.Urgency.HIGH,
                    }));
                } catch (error) {
                    this._sources.get(key)?.destroy();
                    this._reportError(`Cannot show notification: ${error.message}`);
                }
            }
            if (config.sounds[event.kind])
                this._queueSound(event.kind, config.sound_files[event.kind]);
        }
    }

    _queueSound(kind, path) {
        if (!this._pendingSound || SOUND_PRIORITY[kind] > SOUND_PRIORITY[this._pendingSound.kind])
            this._pendingSound = {kind, path};
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
    }
}
