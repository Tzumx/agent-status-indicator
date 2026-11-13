// SPDX-License-Identifier: MIT
// Presentation only: lifecycle events, never elapsed time, determine status.
export const PRIORITY = {idle: 0, working: 1, approval: 2, error: 3};
export const COLORS = {idle: '#8b949e', working: '#2ea043', approval: '#d29922', error: '#f85149', finished: '#62a0ea', closed: '#8b949e'};

export function summarize(state) {
    if (!state || typeof state !== 'object' || Array.isArray(state))
        throw new Error('State file must contain an object');
    const agents = {};
    let status = 'idle';
    for (const name of ['codex', 'claude']) {
        let best = 'idle';
        let count = 0;
        // Session records are authoritative, including when the daemon is down.
        const items = state.sessions?.[name];
        const records = state.sessions && typeof state.sessions === 'object'
            ? Object.values(items && typeof items === 'object' ? items : {})
            : [state.agents?.[name]];
        for (const item of records) {
            const value = item?.state;
            if (typeof value !== 'string' || !Object.hasOwn(PRIORITY, value))
                continue;
            if (value !== 'idle')
                count++;
            if (PRIORITY[value] > PRIORITY[best])
                best = value;
        }
        agents[name] = {state: best, active_sessions: count};
        if (PRIORITY[best] > PRIORITY[status])
            status = best;
    }
    return {status, agents};
}

// UI detail does not change the four-state protocol used by other clients.
export const STATUS_LABELS = {
    idle: 'Idle', working: 'Working', approval: 'Permission required',
    decision: 'Decision required', finished: 'Finished responding', error: 'Error', closed: 'Closed',
};
export const DISPLAY_PRIORITY = {...PRIORITY, finished: 0.5, decision: 2, closed: -1};
export const AGENT_LABELS = {codex: 'Codex', claude: 'Claude Code'};

export const STATUS_ICONS = {
    idle: 'media-record-symbolic', working: 'media-playback-start-symbolic',
    approval: 'dialog-password-symbolic', decision: 'dialog-question-symbolic',
    finished: 'object-select-symbolic', error: 'dialog-error-symbolic', closed: 'window-close-symbolic',
};
export const SUMMARY_LABELS = {
    error: 'Errors', approval: 'Waiting for permission', decision: 'Waiting for your decision',
    working: 'Working', finished: 'Finished responding', idle: 'Idle', closed: 'Closed',
};
export const PANEL_ICONS = {circle: 'Circle', robot: 'Robot head'};
export const DISPLAY_SETTINGS = {
    show_empty_agents: ['show-empty-agents', false],
    show_closed_sessions: ['show-closed-sessions', false],
    show_state_counts: ['show-state-counts', true],
    show_event_details: ['show-event-details', false],
    show_account_usage: ['show-account-usage', true],
    show_context_usage: ['show-context-usage', true],
};
const EVENT_LABELS = {
    SessionStart: 'Session started', UserPromptSubmit: 'Prompt started',
    PreToolUse: 'Tool started', PostToolUse: 'Tool completed',
    PermissionRequest: 'Permission requested', Stop: 'Response finished',
    StopFailure: 'Response failed', PostToolUseFailure: 'Tool failed',
    Error: 'Operation failed', SessionEnd: 'Session ended', Interrupt: 'Interrupted',
    Notification: 'Agent update',
};

export function sessionSummary(rows) {
    const counts = Object.fromEntries(Object.keys(SUMMARY_LABELS).map(state => [state, 0]));
    for (const row of rows)
        counts[row.state]++;
    const headline = rows.length === 0 ? 'No sessions'
        : rows.length === 1 ? '1 session' : `${rows.length} sessions`;
    return {counts, headline};
}

export function sessionDetail(row, showEvent = false, now = new Date()) {
    let time = 'Time unavailable';
    if (row.updatedAt > 0 && row.updatedAt < 8640000000000) {
        const date = new Date(row.updatedAt * 1000);
        time = date.toDateString() === now.toDateString()
            ? date.toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'})
            : date.toLocaleString([], {month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'});
    }
    return showEvent ? `${EVENT_LABELS[row.event] || 'Agent update'} · ${time}` : time;
}


export function safeText(value, limit = 80) {
    return typeof value === 'string' ? value.replace(/[\p{Cc}\p{Cf}]/gu, '').slice(0, limit) : '';
}

export function shortId(value) {
    let hash = 2166136261;
    for (const char of value)
        hash = Math.imul(hash ^ char.codePointAt(0), 16777619);
    return (hash >>> 0).toString(16).padStart(8, '0');
}

export function displayState(item) {
    if (item.state === 'idle' && item.event === 'SessionEnd')
        return 'closed';
    if (item.state === 'approval' && item.attention === 'decision')
        return 'decision';
    if (item.state === 'idle' && item.event === 'Stop')
        return 'finished';
    return item.state;
}

export function sessionRows(state, showClosed = false) {
    summarize(state);
    const rows = [];
    for (const agent of ['claude', 'codex']) {
        const sessions = state.sessions && typeof state.sessions === 'object'
            ? state.sessions[agent] : {[agent + ':legacy']: state.agents?.[agent]};
        if (!sessions || typeof sessions !== 'object' || Array.isArray(sessions))
            continue;
        for (const [session, item] of Object.entries(sessions)) {
            if (!item || typeof item.state !== 'string' || !Object.hasOwn(PRIORITY, item.state))
                continue;
            if (showClosed !== true && item.state === 'idle' && item.event === 'SessionEnd')
                continue;
            rows.push({
                agent, session, short: shortId(session),
                project: safeText(item.project).split(/[\\/]/).at(-1) || 'Session',
                state: displayState(item), event: safeText(item.event, 48),
                updatedAt: Number.isFinite(item.updated_at) ? item.updated_at : 0,
                context: contextUsage(item.context),
            });
        }
    }
    return rows.sort((a, b) => a.agent.localeCompare(b.agent)
        || DISPLAY_PRIORITY[b.state] - DISPLAY_PRIORITY[a.state]
        || a.project.localeCompare(b.project) || a.session.localeCompare(b.session));
}

export const ALERT_KINDS = ['completion', 'permission', 'decision', 'error', 'quota-reset'];
export function alertHistory(state) {
    const log = state?.alerts;
    return log && typeof log.generation === 'string' && log.generation.length > 0
        && Number.isSafeInteger(log.sequence) && log.sequence >= 0 && Array.isArray(log.events) ? log : null;
}

export function currentAlerts(state) {
    if (!state.sessions || typeof state.sessions !== 'object' || Array.isArray(state.sessions))
        return null;
    const current = new Map();
    const kinds = {finished: 'completion', approval: 'permission', decision: 'decision', error: 'error'};
    for (const agent of Object.keys(AGENT_LABELS)) {
        const sessions = state.sessions?.[agent];
        if (sessions === undefined)
            continue;
        if (!sessions || typeof sessions !== 'object' || Array.isArray(sessions))
            return null;
        for (const [session, record] of Object.entries(sessions)) {
            if (!record || typeof record.state !== 'string' || !Object.hasOwn(PRIORITY, record.state))
                return null;
            const kind = kinds[displayState(record)];
            if (kind)
                current.set(JSON.stringify([agent, session]), {kind, sequence: null, turn: typeof record.turn_id === 'string' ? record.turn_id : ''});
        }
    }
    const log = alertHistory(state);
    for (const event of Array.isArray(log?.events) ? log.events.slice(-256) : []) {
        if (!event || !ALERT_KINDS.includes(event.kind) || !Number.isSafeInteger(event.sequence)
            || event.sequence < 1 || event.sequence > log.sequence)
            continue;
        const item = current.get(JSON.stringify([event.agent, event.session]));
        if (item)
            item.sequence = Math.max(item.sequence || 0, event.sequence);
    }
    return current;
}

export const SOUND_NAMES = {
    completion: 'complete', permission: 'dialog-warning',
    decision: 'dialog-question', error: 'dialog-error', 'quota-reset': 'complete',
};

export function preferences(value = {}) {
    const isObject = item => item !== null && typeof item === 'object' && !Array.isArray(item);
    if (!isObject(value))
        throw new Error('Alert preferences must contain an object');
    if (Object.hasOwn(value, 'mute_all') && typeof value.mute_all !== 'boolean')
        throw new Error('mute_all must be a boolean');
    for (const key of ['notifications', 'sounds', 'sound_files']) {
        if (Object.hasOwn(value, key) && !isObject(value[key]))
            throw new Error(`${key} must contain an object`);
    }
    if (Object.hasOwn(value, 'panel_icon')
        && (typeof value.panel_icon !== 'string' || !Object.hasOwn(PANEL_ICONS, value.panel_icon)))
        throw new Error('panel_icon must be circle or robot');
    const result = {panel_icon: value.panel_icon ?? 'circle', mute_all: value.mute_all === true, notifications: {}, sounds: {}, sound_files: {}};
    for (const [name, [, fallback]] of Object.entries(DISPLAY_SETTINGS)) {
        if (Object.hasOwn(value, name) && typeof value[name] !== 'boolean')
            throw new Error(`${name} must be a boolean`);
        result[name] = value[name] ?? fallback;
    }
    for (const kind of ALERT_KINDS) {
        for (const key of ['notifications', 'sounds']) {
            if (value[key] && Object.hasOwn(value[key], kind) && typeof value[key][kind] !== 'boolean')
                throw new Error(`${key}.${kind} must be a boolean`);
        }
        if (value.sound_files && Object.hasOwn(value.sound_files, kind) && typeof value.sound_files[kind] !== 'string')
            throw new Error(`sound_files.${kind} must be a string`);
        result.notifications[kind] = value?.notifications?.[kind] ?? (kind !== 'quota-reset');
        result.sounds[kind] = value?.sounds?.[kind] ?? (kind !== 'quota-reset');
        const path = value?.sound_files?.[kind];
        if (typeof path === 'string' && path.startsWith('/') && /\.(ogg|oga|wav)$/i.test(path))
            result.sound_files[kind] = path;
    }
    return result;
}

export function settingsPreferences(settings, legacy = {}) {
    const value = preferences(legacy);
    if (settings.get_user_value('panel-icon') !== null)
        value.panel_icon = settings.get_string('panel-icon');
    if (settings.get_user_value('mute-all') !== null)
        value.mute_all = settings.get_boolean('mute-all');
    for (const [name, [key]] of Object.entries(DISPLAY_SETTINGS)) {
        if (settings.get_user_value(key) !== null)
            value[name] = settings.get_boolean(key);
    }
    for (const kind of ALERT_KINDS) {
        for (const [group, prefix] of [['notifications', 'notify'], ['sounds', 'sound'], ['sound_files', 'sound-file']]) {
            const key = `${prefix}-${kind}`;
            if (settings.get_user_value(key) !== null)
                value[group][kind] = group === 'sound_files' ? settings.get_string(key) : settings.get_boolean(key);
        }
    }
    return preferences(value);
}

export class AlertCursor {
    constructor() {
        this.ready = false;
        this.generation = null;
        this.sequence = 0;
        this.fromMissing = false;
    }

    read(state, missing = false) {
        const log = alertHistory(state);
        if (!log) {
            if (missing && this.ready)
                return {events: [], warning: ''};
            this.ready = true;
            this.generation = null;
            this.sequence = 0;
            this.fromMissing = missing;
            return {events: [], warning: missing ? '' : 'Notification tracking unavailable.'};
        }
        const events = log.events.slice(-256).filter(item =>
            item && Number.isSafeInteger(item.sequence) && item.sequence > 0
            && item.sequence <= log.sequence && Object.hasOwn(AGENT_LABELS, item.agent)
            && ALERT_KINDS.includes(item.kind) && typeof item.session === 'string')
            .sort((a, b) => a.sequence - b.sequence);
        let warning = '';
        let pending = [];
        if (this.ready && (log.generation === this.generation || this.fromMissing)) {
            pending = events.filter(item => item.sequence > this.sequence);
            if (log.sequence < this.sequence || (log.sequence > this.sequence
                && (pending.length === 0 || pending[0].sequence !== this.sequence + 1
                    || pending.some((item, index) => index > 0 && item.sequence !== pending[index - 1].sequence + 1)
                    || pending.at(-1).sequence !== log.sequence))) {
                warning = 'Alert history gap; current sessions retained, old alerts suppressed.';
                pending = [];
            }
        } else if (this.ready && this.generation !== null) {
            warning = 'Alert history reset; existing alerts suppressed.';
        }
        this.ready = true;
        this.generation = log.generation;
        this.sequence = log.sequence;
        this.fromMissing = false;
        return {events: pending, warning};
    }
}

export function contextUsage(value) {
    return value && Number.isFinite(value.used_percent) && value.used_percent >= 0 && value.used_percent <= 100
        && Number.isFinite(value.updated_at) && value.updated_at > 0 ? value : null;
}

export function quotaWindows(state, agent, now = Date.now() / 1000) {
    const quota = state.usage?.[agent];
    if (!quota || !Number.isFinite(quota.updated_at) || quota.updated_at <= 0 || !Array.isArray(quota.windows))
        return [];
    return quota.windows.slice(0, 2).filter(window => window
        && Number.isFinite(window.used_percent) && window.used_percent >= 0 && window.used_percent <= 100
        && Number.isSafeInteger(window.window_minutes) && window.window_minutes > 0 && window.window_minutes <= 525600
        && Number.isFinite(window.resets_at) && window.resets_at > now && window.resets_at > quota.updated_at);
}

export function quotaLabel(minutes) {
    return minutes % 1440 === 0 ? `${minutes / 1440}d`
        : minutes % 60 === 0 ? `${minutes / 60}h` : `${minutes}m`;
}

export function reportedTime(updated, now = Date.now() / 1000) {
    if (!Number.isFinite(updated) || updated <= 0)
        return 'Not reported yet';
    const age = Math.max(0, Math.floor(now - updated));
    if (age < 60)
        return 'Last reported just now';
    if (age < 3600)
        return `Last reported ${Math.floor(age / 60)} min ago`;
    if (age < 86400)
        return `Last reported ${Math.floor(age / 3600)} h ago`;
    const days = Math.floor(age / 86400);
    return `Last reported ${days} ${days === 1 ? 'day' : 'days'} ago`;
}

export function refreshFeedback(result) {
    if (result.status === 'disabled')
        return 'Status reloaded. Codex usage collection is off.';
    if (result.status === 'no-sources')
        return 'No Codex usage reports yet.';
    if (result.updated)
        return `Updated ${result.updated} Codex ${result.updated === 1 ? 'session' : 'sessions'}.`
            + (result.unavailable ? ' Some reports were unavailable.' : '');
    if (result.unavailable)
        return 'Some usage reports are unavailable; keeping previous values.';
    return 'No newer usage reports.';
}
