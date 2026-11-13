// SPDX-License-Identifier: MIT
import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';
import {ALERT_KINDS, SOUND_NAMES, STATUS_ICONS, preferences, settingsPreferences, safeText, DISPLAY_SETTINGS, PANEL_ICONS} from './state.js';
import {readJson, writeJson} from './io.js';

const CATEGORIES = {
    completion: ['Response finished', 'An agent has finished responding.', 'finished'],
    permission: ['Permission request', 'An agent needs permission to continue.', 'approval'],
    decision: ['Your decision', 'An agent explicitly requests your input.', 'decision'],
    error: ['Error', 'An agent operation failed.', 'error'],
    'quota-reset': ['Quota window reset', 'The reported reset time has arrived. Usage refreshes on the next agent update.', 'finished'],
};

export default class AgentStatusPreferences extends ExtensionPreferences {
    async fillPreferencesWindow(window) {
        this._window = window;
        this._closed = false;
        this._syncing = true;
        this._cancellable = new Gio.Cancellable();
        this._file = Gio.File.new_for_path(GLib.build_filenamev([
            GLib.get_user_config_dir(), 'agent-status-indicator', 'gnome.json',
        ]));
        this._usageFile = this._file.get_parent().get_child('usage.json');
        this._usageConfig = {};
        this._collectorRows = new Map();
        this._settings = this.getSettings();
        this._legacy = {};
        this._rows = new Map();
        this._displayRows = new Map();
        window.set_default_size(640, 650);
        window.search_enabled = true;
        window.connect('close-request', () => {
            this._closed = true;
            this._cancellable.cancel();
            this._settings.disconnect(this._settingsChangedId);
            return false;
        });

        this._soundsPage = new Adw.PreferencesPage({title: 'Alerts', icon_name: 'audio-volume-high-symbolic'});
        window.add(this._soundsPage);
        const alerts = new Adw.PreferencesGroup({
            title: 'Notifications and sounds',
            description: 'Changes apply immediately. Sound follows the desktop sound-effects volume.',
        });
        this._soundsPage.add(alerts);
        this._mute = new Adw.SwitchRow({
            title: 'Mute all alerts', subtitle: 'Keep tracking sessions without notifications or sounds.',
        });
        this._mute.connect('notify::active', () => this._save({mute_all: this._mute.active}));
        alerts.add(this._mute);
        this._error = new Adw.ActionRow({title: 'Settings unavailable', visible: false});
        const retry = new Gtk.Button({label: 'Retry', valign: Gtk.Align.CENTER});
        retry.connect('clicked', () => this._load());
        this._error.add_suffix(retry);
        alerts.add(this._error);

        this._categories = new Adw.PreferencesGroup({
            title: 'Alert types', description: 'Choose a sound and notification policy for each event.',
        });
        this._soundsPage.add(this._categories);
        for (const kind of ALERT_KINDS) {
            const [title, subtitle, state] = CATEGORIES[kind];
            const section = new Adw.ExpanderRow({title, subtitle, icon_name: STATUS_ICONS[state]});
            this._categories.add(section);
            const notification = new Adw.SwitchRow({title: 'Desktop notification'});
            const sound = new Adw.SwitchRow({title: 'Play sound'});
            notification.connect('notify::active', () => this._save({notifications: {[kind]: notification.active}}));
            sound.connect('notify::active', () => this._save({sounds: {[kind]: sound.active}}));
            section.add_row(notification);
            section.add_row(sound);
            const file = new Adw.ActionRow({title: 'Sound file', subtitle: 'System default', use_markup: false});
            const choose = new Gtk.Button({
                icon_name: 'document-open-symbolic', tooltip_text: 'Choose a sound file', valign: Gtk.Align.CENTER,
            });
            choose.connect('clicked', () => this._chooseSound(kind));
            const reset = new Gtk.Button({
                icon_name: 'edit-undo-symbolic', tooltip_text: 'Use the system default sound', valign: Gtk.Align.CENTER,
            });
            reset.connect('clicked', () => this._save({sound_files: {[kind]: ''}}));
            file.add_suffix(choose);
            file.add_suffix(reset);
            section.add_row(file);
            this._rows.set(kind, {section, notification, sound, file, reset});
        }

        const display = new Adw.PreferencesPage({title: 'Display', icon_name: 'preferences-desktop-display-symbolic'});
        window.add(display);
        const appearance = new Adw.PreferencesGroup({title: 'Panel indicator'});
        display.add(appearance);
        this._panelIcon = new Adw.ComboRow({
            title: 'Panel icon', subtitle: 'Both shapes use the current status color.',
            model: Gtk.StringList.new(Object.values(PANEL_ICONS)),
        });
        this._panelIcon.connect('notify::selected', () =>
            this._save({panel_icon: Object.keys(PANEL_ICONS)[this._panelIcon.selected]}));
        appearance.add(this._panelIcon);
        const sessions = new Adw.PreferencesGroup({title: 'Session list'});
        const usage = new Adw.PreferencesGroup({
            title: 'Usage', description: 'Show reported account quota per agent and context usage per session.',
        });
        display.add(sessions);
        display.add(usage);
        for (const [name, title, subtitle] of [
            ['show_empty_agents', 'Show empty agent groups', 'Keep a group visible even when it has no sessions.'],
            ['show_closed_sessions', 'Show closed sessions', 'Keep sessions visible after a confirmed exit.'],
            ['show_state_counts', 'Show state counts', 'Show the overall state distribution above the session list.'],
            ['show_event_details', 'Show last-event details', 'Include the event description beside each session timestamp.'],
            ['show_account_usage', 'Show account quota', 'Show available quota percentages once per agent group.'],
            ['show_context_usage', 'Show session context usage', 'Show available context-window percentages for individual sessions.'],
        ]) {
            const row = new Adw.SwitchRow({title, subtitle});
            row.connect('notify::active', () => this._save({[name]: row.active}));
            (name === 'show_account_usage' || name === 'show_context_usage' ? usage : sessions).add(row);
            this._displayRows.set(name, row);
        }

        const integration = new Adw.PreferencesPage({title: 'Integration', icon_name: 'preferences-system-symbolic'});
        window.add(integration);
        const hooks = new Adw.PreferencesGroup({
            title: 'Automatic session status',
            description: 'The companion and lifecycle hooks connect Claude Code and Codex to the indicator. Set them up once; opening Settings does not change agent configuration.',
        });
        integration.add(hooks);
        const collectors = new Adw.PreferencesGroup({
            title: 'Usage sources',
            description: 'Optional and local. Disabling collection stops future reads; display switches hide cached snapshots. No account requests or background collector.',
        });
        integration.add(collectors);
        for (const [name, title, subtitle] of [
            ['codex_metadata', 'Read Codex usage metadata',
                'Read bounded portions of session files supplied by hooks, including manual refresh of known files. Files also contain conversation text; only usage metadata and known file locations are retained. The file format may change.'],
            ['claude_statusline', 'Receive Claude Code usage',
                'Receive metadata from the optional status-line adapter. Requires one-time status-line setup; existing commands can be preserved.'],
        ]) {
            const row = new Adw.SwitchRow({title, subtitle, sensitive: false});
            row.connect('notify::active', () => this._saveUsage(name, row.active));
            collectors.add(row);
            this._collectorRows.set(name, row);
        }
        this._usageError = new Adw.ActionRow({title: 'Usage settings unavailable', visible: false});
        const retryUsage = new Gtk.Button({label: 'Retry', valign: Gtk.Align.CENTER});
        retryUsage.connect('clicked', () => this._loadUsage());
        this._usageError.add_suffix(retryUsage);
        collectors.add(this._usageError);
        const help = new Adw.ExpanderRow({
            title: 'Setup instructions', subtitle: 'Hook registration and optional usage data',
        });
        for (const [title, subtitle] of [
            ['Enable lifecycle hooks',
                'From the project directory, run ./install.sh --gnome-only --merge-hooks. Existing agent configuration is backed up and merged.'],
            ['Activate the hooks',
                'Restart existing agent sessions. In Codex, open /hooks and review and trust the indicator’s hook entries.'],
            ['Optional usage data',
                'Enable the sources below. Codex reports through hooks and Refresh local data. Claude Code also needs the status-line command shown next.'],
            ['Claude Code status-line command',
                'Set agent-status-hook --agent claude --status-line as the statusLine command in Claude Code settings. Preserve an existing command with --status-line-command; see agent-status-hook --help.'],
        ])
            help.add_row(new Adw.ActionRow({title, subtitle, use_markup: false}));
        hooks.add(help);
        this._settingsChangedId = this._settings.connect('changed', () => {
            if (!this._closed)
                this._sync(settingsPreferences(this._settings, this._legacy));
        });
        await Promise.all([this._load(), this._loadUsage()]);
    }

    async _loadUsage() {
        try {
            let value;
            try {
                value = await readJson(this._usageFile, this._cancellable, 4096);
            } catch (error) {
                if (!error.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND))
                    throw error;
                value = {};
            }
            if (!value || typeof value !== 'object' || Array.isArray(value)
                || ['codex_metadata', 'claude_statusline'].some(key => key in value && typeof value[key] !== 'boolean'))
                throw new Error('Usage settings must contain boolean source switches.');
            if (this._closed)
                return;
            this._usageConfig = value;
            this._usageError.visible = false;
            for (const [name, row] of this._collectorRows) {
                row.sensitive = false;
                row.active = value[name] === true;
                row.sensitive = true;
            }
        } catch (error) {
            if (!this._closed) {
                for (const row of this._collectorRows.values())
                    row.sensitive = false;
                this._usageError.subtitle = safeText(error.message, 180);
                this._usageError.visible = true;
            }
        }
    }

    async _saveUsage(name, enabled) {
        if (this._closed || !this._collectorRows.get(name).sensitive)
            return;
        for (const row of this._collectorRows.values())
            row.sensitive = false;
        try {
            const value = {...this._usageConfig, [name]: enabled};
            await writeJson(this._usageFile, value, this._cancellable);
            if (this._closed)
                return;
            this._usageConfig = value;
            this._usageError.visible = false;
        } catch (error) {
            if (!this._closed) {
                this._usageError.subtitle = 'Changes could not be saved. ' + safeText(error.message, 180);
                this._usageError.visible = true;
            }
        } finally {
            if (!this._closed) {
                for (const [key, row] of this._collectorRows) {
                    row.active = this._usageConfig[key] === true;
                    row.sensitive = true;
                }
            }
        }
    }

    async _load() {
        this._soundsPage.sensitive = false;
        try {
            let value;
            try {
                value = await readJson(this._file, this._cancellable, 65536);
            } catch (error) {
                if (!error.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND))
                    throw error;
                value = {};
            }
            if (!this._closed) {
                this._legacy = preferences(value);
                this._sync(settingsPreferences(this._settings, this._legacy));
                this._error.visible = false;
            }
        } catch (error) {
            if (!this._closed) {
                this._mute.sensitive = false;
                this._categories.sensitive = false;
                this._error.subtitle = safeText(error.message, 180);
                this._error.visible = true;
                this._showError(error, 'Settings could not be loaded.');
            }
        } finally {
            if (!this._closed)
                this._soundsPage.sensitive = true;
        }
    }

    _sync(value) {
        this._syncing = true;
        this._mute.sensitive = true;
        this._categories.sensitive = true;
        this._mute.active = value.mute_all;
        this._panelIcon.selected = Object.keys(PANEL_ICONS).indexOf(value.panel_icon);
        for (const [name, row] of this._displayRows)
            row.active = value[name];
        for (const [kind, row] of this._rows) {
            row.notification.active = value.notifications[kind];
            row.sound.active = value.sounds[kind];
            const path = value.sound_files[kind];
            row.file.subtitle = path ? safeText(Gio.File.new_for_path(path).get_basename())
                : `System default (${SOUND_NAMES[kind]})`;
            row.reset.visible = Boolean(path);
        }
        this._syncing = false;
    }

    _save(patch) {
        if (this._syncing || this._closed)
            return;
        try {
            const [group, values] = Object.entries(patch)[0];
            let saved;
            if (group === 'mute_all') {
                saved = this._settings.set_boolean('mute-all', values);
            } else if (group === 'panel_icon') {
                saved = this._settings.set_string('panel-icon', values);
            } else if (Object.hasOwn(DISPLAY_SETTINGS, group)) {
                saved = this._settings.set_boolean(DISPLAY_SETTINGS[group][0], values);
            } else {
                const [kind, value] = Object.entries(values)[0];
                const prefix = {notifications: 'notify', sounds: 'sound', sound_files: 'sound-file'}[group];
                saved = group === 'sound_files'
                    ? this._settings.set_string(`${prefix}-${kind}`, value)
                    : this._settings.set_boolean(`${prefix}-${kind}`, value);
            }
            if (!saved)
                throw new Error('Settings are not writable.');
            this._sync(settingsPreferences(this._settings, this._legacy));
            this._error.visible = false;
        } catch (error) {
            this._sync(settingsPreferences(this._settings, this._legacy));
            this._showError(error);
        }
    }

    _chooseSound(kind) {
        const filter = new Gtk.FileFilter({name: 'Sound files (OGG, OGA, WAV)'});
        for (const pattern of ['*.ogg', '*.oga', '*.wav', '*.OGG', '*.OGA', '*.WAV'])
            filter.add_pattern(pattern);
        const filters = new Gio.ListStore({item_type: Gtk.FileFilter});
        filters.append(filter);
        const dialog = new Gtk.FileDialog({title: 'Choose alert sound', filters, default_filter: filter});
        dialog.open(this._window, this._cancellable, (source, result) => {
            try {
                const path = source.open_finish(result).get_path();
                if (!path || !/\.(ogg|oga|wav)$/i.test(path))
                    throw new Error('Choose a local OGG, OGA or WAV sound file.');
                this._save({sound_files: {[kind]: path}});
            } catch (error) {
                if (!error.matches?.(Gtk.DialogError, Gtk.DialogError.DISMISSED)
                    && !error.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                    this._showError(error, 'Could not choose the sound file.');
            }
        });
    }

    _showError(error, message = 'Changes could not be saved.') {
        if (this._closed)
            return;
        if (error instanceof GLib.Error && Gio.DBusError.is_remote_error(error))
            Gio.DBusError.strip_remote_error(error);
        this._window.add_toast(new Adw.Toast({
            title: message + ' ' + safeText(error.message, 180), timeout: 6,
            priority: Adw.ToastPriority.HIGH, use_markup: false,
        }));
    }
}
