# Validation and measurements

## Automated checks

Run from the repository root:

```bash
python3 -m unittest discover -s tests -v
python3 -m py_compile bin/agent-status bin/agent_status_state.py bin/agent-status-hook bin/codex-status-exec bin/agent-status-desktop desktop/agent_status_desktop.py
node --experimental-vm-modules tests/test_extension.mjs
for script in install.sh scripts/*.sh uninstall.sh; do bash -n "$script" || exit; done
bash scripts/package-extension.sh
```

The Python suite uses isolated state and installation directories, tests concurrent processes and locks, and never calls a model. If `gjs` is installed, it also runs `tests/test_extension_gio.mjs` against native GIO. That test exercises the shipped file-monitor, bounded-read, and preference-write code with Shell-facing imports stubbed. Without `gjs`, that test is explicitly skipped.

The Node harness supplies GNOME actors and services as mocks. It covers startup/reload suppression, complete and partial directory-monitor failures, events during reads, malformed/oversized input, open menu stability, monitor/scale width constraints, focus-driven scrolling, ten-session bursts, notification failures, invalid preference types, category preferences, native sound selection, and cleanup. Python regressions cover large hook payloads and transcript-identity upgrades, including newer canonical records and unrelated sessions. These checks do not prove desktop rendering or audible playback.

## Desktop release checks

These checks change a desktop installation and must be run deliberately on a test account or VM, after preserving existing configuration.

1. On Ubuntu 24.04 / GNOME 46 Wayland, install the exact archive and companion with the GNOME-only option. Confirm one panel icon and normal operation without the socket daemon or desktop clients.
2. Exercise both agents, at least ten sessions, two sessions sharing a project, missing metadata, and orphaned sessions. Verify distinct rows, usable submenus during updates, state counts, accessible labels, and session-specific reset commands.
3. Verify actual agent registration and Codex trust. Observe real prompt, permission, decision-tool, successful stop, interruption, and failure events where the installed agent supports them. Synthetic fixtures do not substitute for this check.
4. Trigger all four alert categories. Check notification-center retention, desktop banner policy, four audible signals, independent category mute, global mute, custom sound files, sound-effects volume, unavailable audio, and notification failures.
5. Check repeated hooks, old turns, burst updates, startup/reload, screen lock/unlock, suspend/resume, cache deletion/recreation, malformed/oversized files, and disable/enable. Watch Shell logs for leaks or repeated errors.
6. Repeat on Ubuntu 26.04 / GNOME 50 in a VM. Use a disposable test package to exercise that version; add 50 to release metadata only after success. GNOME 46 X11 is best effort when available; GNOME 50 validation targets Wayland.
7. Exercise install/upgrade/uninstall in the disposable account, including XDG overrides and preservation of unrelated hooks/settings. The normal unit suite does not uninstall from the real user account.

Record the exact source revision, archive digest, OS/Shell/tool versions, display backend, hardware, and observed outcomes. Offscreen coverage and remaining desktop checks are recorded below.

### Local setup check (2026-11-12)

Revision `b9880ee` was installed with `--gnome-only` on Ubuntu 24.04.5 / GNOME 46.0 Wayland. All eight installed companion/extension files matched the source, comparing metadata as JSON. Neither optional user service was active. The running Shell did not discover the newly installed extension; it is queued for the next login. That setup did not exercise the panel, notifications, audio, or Shell resources.

The opt-in hook merge preserved the existing Claude Code settings and hook group, verified against the installer backup. Codex 0.167.2 registered all eight supplied events with no configuration errors, but every hook remained untrusted (`needs_trust`). Claude Code 2.1.322 was present. Real agent hook firing remains unverified; review Codex hooks in `/hooks` and restart agent sessions before testing.

The original archive at setup had SHA-256 `90633d28b68402993739b8c1841c3f9768c310f2f6361e657243493984bab75a`. This setup used source installation; the corrected candidate archive was subsequently checked as described below. GNOME 50 was untested at setup; subsequent VM coverage is recorded below.

### Offscreen GNOME 46 smoke check (2026-11-12)

The corrected session menu was tested in fresh GNOME Shell 46.0 / Mutter 46.2 Wayland processes on Ubuntu 24.04.5, using a 1024×768 virtual monitor and software rendering with two rendering threads. Checks exercised theme scale factors 1 and 2; physical HiDPI hardware was not tested. The source was `b9880ee` plus the session-menu, width and keyboard-navigation corrections. The exact tested archive has SHA-256 `108dcbd2af07211f56cb0f106545b296881d4f8c19e67c747580746654c58d78`; its five files matched the source before launch.

Bubblewrap provided separate user, process, network and mount namespaces, temporary HOME/XDG directories, a private runtime directory and D-Bus session, and read-only system files. The test had no host desktop sockets, audio/graphics devices, or external network route. The real desktop process/start time, enabled-extension list and hook files were unchanged after testing. The test processes were stopped after each run.

All 73 real-Shell assertions passed:

- One panel icon, ten independent sessions, same-project identity separation, visible agent headings and readable session rows. Ordinary updates preserved the open list and row actors.
- Native reset-command copying selected only the intended session and preserved the open list. Tab navigation reached every reset button while keeping its whole session row visible; paging buttons also scrolled into view on focus.
- Eighty-character ASCII and CJK project names stayed within the monitor at both theme scales. Menu widths were 1,012 and 1,000 pixels on the 1,024-pixel monitor. Native text layout checks verified shortening without hiding the full session ID/status suffix.
- All four MessageTray notification categories, a ten-session burst retaining fourteen notices, silent startup, duplicate suppression, and rejection of delayed old-turn events.
- Global mute, private preference writes, invalid-preference recovery, malformed/oversized state, atomic replacement and cache-directory deletion/recreation without replay.
- Zero refresh calls during a settled five-second idle interval; 105 Codex sessions with bounded paging and native page-button activation that kept the list open.
- Four disable/enable cycles that cancelled reads, timers and monitors and did not replay alerts. The extension manager recorded no errors. Deliberately corrupt fixtures produced the expected diagnostics.

The first real-Shell run exposed unsupported nested submenus: opening a child closed its ancestor and hid the session list. The correction keeps one scrollable Sessions submenu with agent sections, inline details and copy/paging buttons. Screenshots of the corrected native menu were inspected.

Single helper-invocation-to-notification-object observations were completion 305.1 ms, permission 244.0 ms, decision 268.2 ms, error 274.7 ms. They include hook startup, debounce and 50 ms observation intervals; they do not measure banner presentation latency or establish latency distributions.

Separate namespace checks ran the real installer and uninstaller against read-only source copies and synthetic settings. All ten checks passed: GNOME-only installation, legacy and canonical UUIDs, XDG overrides, repeated hook upgrades with backups and preservation, CLI cache placement, both uninstall modes, repeated uninstall, and preservation of unrelated hooks/services. This found and fixed cleanup aborting when the user service manager was unavailable. The complete regression suite then passed 50 Python tests, native GIO, the JavaScript harness, six-entry-point compilation, shell syntax and archive validation.

These results cover a real offscreen Shell with synthetic lifecycle events. Physical input, audible sound/volume, lock and suspend/resume, actual agent hook firing/trust, and a normal desktop's resource/latency measurements remain unvalidated. Subsequent GNOME 50 coverage is recorded below. The corrected candidate has not been installed or loaded into the main desktop session.

### GNOME 46 archive installation check (2026-11-12)

At revision `802e7b8`, the same candidate archive was installed into a temporary home with `gnome-extensions install`, then upgraded with `--force`, before starting a fresh isolated GNOME 46 Shell. All five installed files matched the archive by SHA-256. The 73 native smoke assertions passed again, followed by three checks of GNOME's native extension-removal API: removal succeeded, the installed directory disappeared, and an unrelated extension remained. This gives 76 passing assertions. Removal was exercised while the disposable Shell was running; the standalone uninstall confirmation application was not tested.

The archive digest remained `108dcbd2af07211f56cb0f106545b296881d4f8c19e67c747580746654c58d78`. Neither the corrected source nor archive was installed into the main desktop session.

### GNOME 50 VM and final release archive (2026-11-12)

The final candidate adds GNOME 50 to the declared versions without changing the runtime JavaScript from `802e7b8`. Its archive SHA-256 is `6694e30a1f4d2d2738b08c16f1355cb747c6a254a9bc82723fa795b994082b28`. This exact ZIP passed fresh CLI installation, forced upgrade, the same 76 native assertions and GNOME-native removal on both GNOME 46 and 50. All five installed file hashes matched the final archive on both versions.

The GNOME 50 test used a KVM guest prepared from an [official signed Ubuntu 26.04 cloud image](https://cloud-images.ubuntu.com/releases/resolute/release/). The environment was GNOME Shell 50.1-0ubuntu1.5, Mutter 50.1-0ubuntu2.5, GJS 1.88.0, Python 3.14.4 and Linux 7.0.0-38-generic. Private QEMU 8.2.2 binaries ran with two virtual CPUs, 2 GiB guest RAM, software rendering with two threads, and a 1024×768 offscreen Wayland monitor.

Only guest provisioning fetched packages. Compatibility runs had no network device or external route, shared host home, desktop sockets, or audio/graphics devices. Every accepted run began with fresh guest test directories and a unique identifier; result identity and installed hashes were checked before accepting the report. The VM shut down after collecting results.

Native checks covered ten independent sessions, same-project rows, all four notification categories, deduplication, keyboard scrolling, bounded paging, malformed state/preferences, atomic replacement, directory recreation and four disable/enable cycles. ASCII and CJK project labels stayed within the monitor at theme scales 1 and 2, preserving their session ID/status suffixes; menu widths were 1,012 and 1,000 pixels respectively. Native screenshots were inspected with CJK fonts installed. The extension manager reported no errors.

All 50 Python tests, including native GIO and isolated installation regressions, passed under the guest's Python 3.14.4. Six entry points compiled, shell syntax checks passed, and the final archive validator accepted the package. Tkinter and CJK fonts were optional test-image additions; the GNOME-only installation path still requires neither a desktop client nor Tkinter. The host's 50 Python tests, JavaScript harness, compilation, syntax and package checks also passed.

Single helper-invocation-to-notification-object observations in the VM were completion 421.7 ms, permission 295.0 ms, decision 253.4 ms and error 270.3 ms. These include hook startup, debounce and observation intervals; they are not banner latency distributions or hardware performance guarantees.

The main Shell process/start time, enabled-extension list and hook-file hashes were unchanged. No final-candidate installation or activation occurred in the main desktop session. Physical input/audio, volume, lock/suspend/resume, actual agent hook firing/trust, and normal desktop resource/wakeup/banner-latency measurements remain release checks.

## Hook measurements

A Linux-only benchmark compares temporary copies of the working tree with a local Git revision. It never fetches, checks out files, modifies agent configuration, or invokes a model:

```bash
python3 scripts/benchmark-hooks.py --baseline-ref 730855d --events 40 --sessions 10
```

The workload sends four lifecycle events to ten independent synthetic sessions split between Claude Code and Codex. Both versions use fresh temporary cache directories. Wall time includes hook startup and the complete transaction; child CPU includes waited descendants. Maximum RSS is the largest `wait4` per-invocation report, not simultaneous aggregate RSS and not GNOME Shell memory.

One hook benchmark at revision `b9880ee` on 2026-11-12 used Ubuntu 24.04.5, Python 3.12.3, Linux 7.0.0-42-generic, and an Intel Core i5-1135G7 (four cores/eight logical CPUs):

| Measurement | Upstream 730855d | Extended implementation |
| --- | ---: | ---: |
| Mean hook wall time | 156.91 ms | 104.10 ms |
| Median | 145.24 ms | 101.78 ms |
| p95 | 202.85 ms | 122.78 ms |
| Total child CPU, 40 hooks | 5.880 s | 3.981 s |
| Maximum per-invocation RSS | 16,228 KiB | 20,444 KiB |
| Final state size | 2,252 bytes | 6,523 bytes |

This single synthetic run shows lower startup/CPU cost and increased per-invocation RSS/state size. It does not establish battery savings, a stable performance guarantee, GNOME idle CPU, Shell memory, or notification latency. Repeat measurements under comparable load before deriving performance guarantees.

## Offscreen GNOME 46 resource comparison (2026-11-12)

A single isolated GNOME 46 Shell compared the extension disabled, upstream polling at `730855d`, and the event-driven implementation at `802e7b8`. Each version had three 15-second idle intervals, rotating version order between rounds, followed by a burst and a ten-session workload. Menus stayed closed, sounds were disabled, and the optional daemon was absent. Software rendering used two threads, with the disposable process at low priority. The main Shell process/start time, enabled-extension list and hook-file hashes remained unchanged.

The common in-Shell driver wrote synthetic state through atomic replacement. It sampled process CPU ticks, RSS/PSS and main-thread context switches before and after each interval; refresh callbacks and alert dispatches supplied read counts and latency observations. CPU ticks had 10 ms resolution. Results include the test Shell and measurement driver, not just the extension.

| Idle measurement, three 15-second intervals | Disabled | Upstream polling | Event-driven |
| --- | ---: | ---: | ---: |
| Status reads per interval | 0 / 0 / 0 | 15 / 15 / 15 | 0 / 0 / 0 |
| Shell CPU time, ms | 130 / 30 / 30 | 50 / 30 / 50 | 10 / 10 / 20 |
| Main-thread voluntary context switches | 23 / 3 / 6 | 92 / 88 / 97 | 2 / 2 / 8 |
| Median ending RSS, KiB | 253,816 | 253,844 | 253,720 |
| Median ending PSS, KiB | 172,024 | 172,049 | 171,925 |

These absolute memory observations overlap. Version switching and allocator caches in the same Shell prevent treating the small differences as reliable incremental memory savings. The initial disabled interval also included more background activity. CPU observations and context switches do not establish battery savings or kernel wakeup counts. Host scheduling statistics were disabled and perf access restricted; neither setting was changed.

| Workload | Disabled CPU, ms | Upstream CPU, ms | Event-driven CPU, ms | Event-driven alerts |
| --- | ---: | ---: | ---: | ---: |
| 40 atomic writes, 25 ms apart, about 2.8 s including settling | 60 | 50 | 250 | 32 / 32 |
| 60 writes across ten sessions, 250 ms apart, about 16.9 s including settling | 70 | 90 | 500 | 48 / 48 |

Each five-update cycle contained one working update and four alert categories. The event-driven version delivered all 80 alert records. It performed eight refreshes for the burst and sixty for the slower workload; upstream performed two and seventeen respectively. Additional session rendering and notifications cost more CPU during activity than the upstream aggregate-only display. These are different feature sets, so the active CPU comparison is a trade-off, not an equal-functionality performance claim.

State-file replacement to notification dispatch/object creation had median/p95 104.1/226.0 ms for the 32 burst notices and 205.5/220.0 ms for the 48 ten-session notices. The p95 uses the nearest-rank method. These synthetic observations exclude hook startup and do not measure banner presentation. The offscreen comparison supplements, but does not replace, the desktop measurements below.

## GNOME resource measurements still required

Compare extension-disabled, upstream polling, and event-driven versions with the daemon stopped. Keep hardware, desktop settings, other extensions, and live session count constant.

For each version, collect at least three equal idle intervals, a burst workload, and a ten-session workload. Record Shell CPU time, RSS or PSS/memory delta, scheduling/wakeup activity, and median/p95 event-to-notification latency. Use the same process and measurement method throughout; distinguish whole-Shell background activity from incremental extension cost.

Verify zero recurring status reads in the event-driven idle case. Record the tools, interval lengths, sample counts, event timestamps, and raw results before deriving comparisons. These normal desktop measurements have not been run. The offscreen results above do not establish incremental desktop resource use or power savings.
