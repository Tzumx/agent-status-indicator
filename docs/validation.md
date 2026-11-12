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

The Node harness supplies GNOME actors and services as mocks. It covers startup/reload suppression, complete and partial directory-monitor failures, events during reads, malformed/oversized input, open menu stability, ten-session bursts, notification failures, invalid preference types, category preferences, native sound selection, and cleanup. Python regressions cover large hook payloads and transcript-identity upgrades, including newer canonical records and unrelated sessions. These checks do not prove desktop rendering or audible playback.

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

## Hook measurements

A Linux-only benchmark compares temporary copies of the working tree with a local Git revision. It never fetches, checks out files, modifies agent configuration, or invokes a model:

```bash
python3 scripts/benchmark-hooks.py --baseline-ref 730855d --events 40 --sessions 10
```

The workload sends four lifecycle events to ten independent synthetic sessions split between Claude Code and Codex. Both versions use fresh temporary cache directories. Wall time includes hook startup and the complete transaction; child CPU includes waited descendants. Maximum RSS is the largest `wait4` per-invocation report, not simultaneous aggregate RSS and not GNOME Shell memory.

One run on 2026-11-12 used Ubuntu 24.04.5, Python 3.12.3, and an Intel Core i5-1135G7 (four cores/eight logical CPUs):

| Measurement | Upstream 730855d | Extended implementation |
| --- | ---: | ---: |
| Mean hook wall time | 180.19 ms | 108.67 ms |
| Median | 178.25 ms | 104.47 ms |
| p95 | 215.39 ms | 141.44 ms |
| Total child CPU, 40 hooks | 6.408 s | 4.091 s |
| Maximum per-invocation RSS | 16,244 KiB | 20,464 KiB |
| Final state size | 2,253 bytes | 6,530 bytes |

This single synthetic run shows lower startup/CPU cost and increased per-invocation RSS/state size. It predates subsequent robustness fixes and does not establish battery savings, a stable performance guarantee, GNOME idle CPU, Shell memory, or notification latency. Repeat measurements on the release candidate under comparable load.

## GNOME resource measurements still required

Compare extension-disabled, upstream polling, and event-driven versions with the daemon stopped. Keep hardware, desktop settings, other extensions, and live session count constant.

For each version, collect at least three equal idle intervals, a burst workload, and a ten-session workload. Record Shell CPU time, RSS or PSS/memory delta, scheduling/wakeup activity, and median/p95 event-to-notification latency. Use the same process and measurement method throughout; distinguish whole-Shell background activity from incremental extension cost.

Verify zero recurring status reads in the event-driven idle case. Record the tools, interval lengths, sample counts, event timestamps, and raw results before deriving comparisons. These desktop measurements have not been run; no numerical idle or power claim is made.
