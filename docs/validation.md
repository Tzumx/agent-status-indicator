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

Record the exact source revision, archive digest, OS/Shell/tool versions, display backend, hardware, and observed outcomes. Current release validation remains pending for actual GNOME 46 and 50 desktops.

### Local setup check (2026-11-12)

Revision `b9880ee` was installed with `--gnome-only` on Ubuntu 24.04.5 / GNOME 46.0 Wayland. All eight installed companion/extension files matched the source, comparing metadata as JSON. Neither optional user service was active. The running Shell did not discover the newly installed extension; it is queued for the next login. That setup did not exercise the panel, notifications, audio, or Shell resources.

The opt-in hook merge preserved the existing Claude Code settings and hook group, verified against the installer backup. Codex 0.167.2 registered all eight supplied events with no configuration errors, but every hook remained untrusted (`needs_trust`). Claude Code 2.1.322 was present. Real agent hook firing remains unverified; review Codex hooks in `/hooks` and restart agent sessions before testing.

The original archive at setup had SHA-256 `90633d28b68402993739b8c1841c3f9768c310f2f6361e657243493984bab75a`. This setup used source installation; installation through the GNOME archive-install command still needs testing. No GNOME 50 VM tooling was installed, so that target remains untested.

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

These results cover a real offscreen Shell with synthetic lifecycle events. Physical input, audible sound/volume, lock and suspend/resume, actual agent hook firing/trust, a normal desktop's resource/latency measurements, and GNOME 50 remain unvalidated. The corrected candidate has not been installed or loaded into the main desktop session.

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

## GNOME resource measurements still required

Compare extension-disabled, upstream polling, and event-driven versions with the daemon stopped. Keep hardware, desktop settings, other extensions, and live session count constant.

For each version, collect at least three equal idle intervals, a burst workload, and a ten-session workload. Record Shell CPU time, RSS or PSS/memory delta, scheduling/wakeup activity, and median/p95 event-to-notification latency. Use the same process and measurement method throughout; distinguish whole-Shell background activity from incremental extension cost.

Verify zero recurring status reads in the event-driven idle case. Record the tools, interval lengths, sample counts, event timestamps, and raw results before deriving comparisons. These desktop measurements have not been run; no numerical idle or power claim is made.
