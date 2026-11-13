// Run through test_gnome_io.py with an isolated home; never use an installed helper.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import {refreshUsage} from '../gnome-extension/agent-status-indicator@Ruochen0513.github.io/io.js';

if (!GLib.getenv('AGENT_STATUS_TEST_HOME') || GLib.get_home_dir() !== GLib.getenv('AGENT_STATUS_TEST_HOME'))
    throw Error('An isolated test home is required');
const directory = Gio.File.new_for_path(GLib.build_filenamev([GLib.get_home_dir(), '.local', 'bin']));
directory.make_directory_with_parents(null);
const helper = directory.get_child('agent-status-hook');
function install(body) {
    helper.replace_contents('#!/usr/bin/python3\n' + body + '\n', null, false,
        Gio.FileCreateFlags.PRIVATE | Gio.FileCreateFlags.REPLACE_DESTINATION, null);
    helper.set_attribute_uint32('unix::mode', 0o700, Gio.FileQueryInfoFlags.NONE, null);
}
async function rejected(body, expected, cancel = false) {
    install(body);
    const cancellable = new Gio.Cancellable();
    if (cancel)
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 100, () => {
            cancellable.cancel();
            return GLib.SOURCE_REMOVE;
        });
    try {
        await refreshUsage(cancellable);
    } catch (error) {
        if (!expected.test(error.message))
            throw error;
        return;
    }
    throw Error('Unsafe or cancelled refresh was accepted');
}
async function run() {
    install('import json,sys\nassert sys.argv[1:] == ["--agent","codex","--refresh-usage"]\nprint(json.dumps({"status":"updated","checked":2,"updated":1,"unavailable":0}))');
    const result = await refreshUsage(new Gio.Cancellable());
    if (result.updated !== 1 || result.checked !== 2)
        throw Error('Native refresh result was not decoded');
    await rejected('print("x" * 10000)', /size limit/);
    await rejected('print("[]")', /Invalid usage refresh result/);
    await rejected('import time\ntime.sleep(30)', /timed out/);
    await rejected('import time\ntime.sleep(30)', /cancelled|canceled/i, true);
    helper.delete(null);
    let missing = false;
    try {
        await refreshUsage(new Gio.Cancellable());
    } catch (error) {
        missing = error.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND)
            || /No such file|not found/i.test(error.message);
    }
    if (!missing)
        throw Error('Missing companion was not reported');
}
const loop = new GLib.MainLoop(null, false);
let failure;
run().then(() => loop.quit(), error => { failure = error; loop.quit(); });
loop.run();
if (failure)
    throw failure;
print('Native refresh helper, bounded output, deadline, cancellation and missing companion passed');
