// SPDX-License-Identifier: MIT
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

export function asyncCall(object, start, finish, args) {
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
    return readStreamJson(stream, cancellable, limit);
}

async function readStreamJson(stream, cancellable, limit) {
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
        const value = JSON.parse(new TextDecoder().decode(data));
        return value;
    } finally {
        await asyncCall(stream, 'close_async', 'close_finish', [GLib.PRIORITY_DEFAULT, null]);
    }
}

export async function writeJson(file, value, cancellable) {
    async function directory(parent) {
        try {
            await asyncCall(parent, 'make_directory_async', 'make_directory_finish',
                [GLib.PRIORITY_DEFAULT, cancellable]);
        } catch (error) {
            if (error.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.EXISTS))
                return;
            if (!error.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND) || !parent.get_parent())
                throw error;
            await directory(parent.get_parent());
            await directory(parent);
        }
    }
    await directory(file.get_parent());
    await asyncCall(file, 'replace_contents_async', 'replace_contents_finish', [
        new TextEncoder().encode(JSON.stringify(value) + '\n'), null, false,
        Gio.FileCreateFlags.PRIVATE | Gio.FileCreateFlags.REPLACE_DESTINATION, cancellable,
    ]);
}

export async function refreshUsage(cancellable) {
    if (cancellable.is_cancelled())
        throw new Error('Refresh cancelled');
    // Only an explicit click launches this fixed, separately installed helper.
    const child = Gio.Subprocess.new([
        GLib.build_filenamev([GLib.get_home_dir(), '.local', 'bin', 'agent-status-hook']),
        '--agent', 'codex', '--refresh-usage',
    ], Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE);
    const cancelled = cancellable.connect(() => child.force_exit());
    let timedOut = false;
    let deadline = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 5000, () => {
        deadline = 0;
        timedOut = true;
        child.force_exit();
        return GLib.SOURCE_REMOVE;
    });
    try {
        const value = await readStreamJson(child.get_stdout_pipe(), cancellable, 4096);
        await asyncCall(child, 'wait_check_async', 'wait_check_finish', [cancellable]);
        if (!['disabled', 'no-sources', 'updated', 'unchanged'].includes(value?.status)
            || !['checked', 'updated', 'unavailable'].every(key => Number.isSafeInteger(value[key])
                && value[key] >= 0 && value[key] <= 32)
            || value.updated > value.checked || value.unavailable > value.checked)
            throw new Error('Invalid usage refresh result');
        return value;
    } catch (error) {
        child.force_exit();
        if (timedOut)
            throw new Error('Local usage refresh timed out');
        throw error;
    } finally {
        if (deadline)
            GLib.source_remove(deadline);
        cancellable.disconnect(cancelled);
    }
}
