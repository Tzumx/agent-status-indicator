// SPDX-License-Identifier: MIT
// Presentation only: lifecycle events, never elapsed time, determine status.
export const PRIORITY = {idle: 0, working: 1, approval: 2, error: 3};
export const COLORS = {idle: '#8b949e', working: '#2ea043', approval: '#d29922', error: '#f85149'};

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
    decision: 'Decision required', finished: 'Finished responding', error: 'Error',
};
export const DISPLAY_PRIORITY = {...PRIORITY, finished: 0.5, decision: 2};
export const AGENT_LABELS = {codex: 'Codex', claude: 'Claude Code'};

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
    if (item.state === 'approval' && item.attention === 'decision')
        return 'decision';
    if (item.state === 'idle' && item.event === 'Stop')
        return 'finished';
    return item.state;
}

export function sessionRows(state) {
    summarize(state);
    const rows = [];
    for (const agent of ['claude', 'codex']) {
        const sessions = state.sessions && typeof state.sessions === 'object'
            ? state.sessions[agent] : {[agent + ':legacy']: state.agents?.[agent]};
        if (!sessions || typeof sessions !== 'object' || Array.isArray(sessions))
            continue;
        for (const [session, item] of Object.entries(sessions)) {
            if (!item || !Object.hasOwn(PRIORITY, item.state))
                continue;
            rows.push({
                agent, session, short: shortId(session),
                project: safeText(item.project).split(/[\\/]/).at(-1) || 'Session',
                state: displayState(item), event: safeText(item.event, 48),
                updatedAt: Number.isFinite(item.updated_at) ? item.updated_at : 0,
            });
        }
    }
    return rows.sort((a, b) => a.agent.localeCompare(b.agent)
        || DISPLAY_PRIORITY[b.state] - DISPLAY_PRIORITY[a.state]
        || a.project.localeCompare(b.project) || a.session.localeCompare(b.session));
}

export const ALERT_KINDS = ['completion', 'permission', 'decision', 'error'];
export const SOUND_NAMES = {
    completion: 'complete', permission: 'dialog-warning',
    decision: 'dialog-question', error: 'dialog-error',
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
    const result = {mute_all: value.mute_all === true, notifications: {}, sounds: {}, sound_files: {}};
    for (const kind of ALERT_KINDS) {
        for (const key of ['notifications', 'sounds']) {
            if (value[key] && Object.hasOwn(value[key], kind) && typeof value[key][kind] !== 'boolean')
                throw new Error(`${key}.${kind} must be a boolean`);
        }
        if (value.sound_files && Object.hasOwn(value.sound_files, kind) && typeof value.sound_files[kind] !== 'string')
            throw new Error(`sound_files.${kind} must be a string`);
        result.notifications[kind] = value?.notifications?.[kind] !== false;
        result.sounds[kind] = value?.sounds?.[kind] !== false;
        const path = value?.sound_files?.[kind];
        if (typeof path === 'string' && path.startsWith('/') && /\.(ogg|oga|wav)$/i.test(path))
            result.sound_files[kind] = path;
    }
    return result;
}

export class AlertCursor {
    constructor() {
        this.ready = false;
        this.generation = null;
        this.sequence = 0;
        this.fromMissing = false;
    }

    read(state, missing = false) {
        const log = state.alerts;
        const valid = log && typeof log.generation === 'string' && log.generation.length > 0
            && Number.isSafeInteger(log.sequence) && log.sequence >= 0 && Array.isArray(log.events);
        if (!valid) {
            if (missing && this.ready)
                return {events: [], warning: ''};
            this.ready = true;
            this.generation = null;
            this.sequence = 0;
            this.fromMissing = missing;
            return {events: [], warning: missing ? '' : 'Alert history unavailable; update all companion writers.'};
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
