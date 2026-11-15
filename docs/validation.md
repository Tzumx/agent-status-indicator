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

The Python suite uses isolated state and installation directories, tests concurrent processes and locks, and never calls a model. If `gjs` is installed, it also runs `tests/test_extension_gio.mjs` against native GIO and `tests/test_usage_refresh_gio.mjs` with disposable helpers in an isolated home. The monitor test exercises the shipped file-monitor, bounded-read, legacy preference, and private atomic usage-consent write code with Shell-facing imports stubbed. The helper test covers bounded results, timeout, cancellation and missing companions. With `gjs` and `dbus-run-session`, `tests/test_sound_preview_gio.mjs` exercises sound-preview dispatch, rejection, stopping, unexport, deadlines and cancellation on a disposable session bus. With GNOME preferences resources, `tests/test_preferences_gio.mjs` checks literal error text, clean remote errors, toast priority and close cleanup without opening a window. Missing optional test tools cause explicit skips.

The Node harness supplies GNOME actors and services as mocks. It covers startup/reload suppression, complete and partial directory-monitor failures, events during reads, malformed/oversized input, open menu stability, monitor/scale width constraints, focus-driven scrolling in normal and recovery views, hidden reset controls, ten-session bursts, notification failures, invalid preference types, category preferences, native sound selection, and cleanup. Python regressions cover large hook payloads and transcript-identity upgrades, including newer canonical records and unrelated sessions. New usage tests cover opt-in consent, bounded session reads, identity/path/type checks, partial and malformed records, latest-request context, concurrent atomic writes, stale snapshots, privacy filtering, Claude status-line forwarding, and reset scheduling/deduplication. These checks do not prove desktop rendering or audible playback.

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

### Panel placement and recovery menu check (2026-11-12)

The UI revision based on `671d457` places the indicator in the right status area and hides reset buttons until **Troubleshooting → Show reset controls** is enabled. Refresh and hook setup help are grouped under Troubleshooting. The tested archive SHA-256 is `48d00741a46d57cd8b893404658c0a32e3713dcbf10bd887f0a0c400d0f00c1c`.

This exact archive passed fresh installation, forced upgrade and native removal in the isolated GNOME 46 and GNOME 50 environments described above. All five installed file hashes matched the archive. GNOME 46 passed 119 native assertions; GNOME 50 passed 113. Both checked keyboard access in normal and recovery views, copying the selected session command without state/config changes or notifications, hidden reset controls after four enable cycles, and 80-character ASCII/CJK labels at theme scales 1 and 2. Screenshots were inspected. The six additional GNOME 46 assertions verified moving the existing panel actor from left to right while preserving system-control position, other panel actors, session widgets and the running extension.

All 50 Python tests passed on the host and guest, including native GIO. The host JavaScript harness, six-entry-point compilation, shell syntax and archive validation also passed. The main Shell process/start time, enabled-extension list and hook files remained unchanged. This UI revision was not installed into the main desktop; physical input/audio and the remaining desktop release checks are still required.

### Native settings and readable session menu (2026-11-13)

The candidate based on `671d457` adds a standard GTK4/libadwaita preferences window, per-event native GSettings keys, legacy JSON fallbacks, separate overview counts, and readable session rows. Its archive SHA-256 is `427d180efd87bddaeb13ae2ad066108a232dc54031f9721c4b1bf4a4485d6ab4`.

The exact archive passed fresh installation, forced upgrade, schema compilation and native removal on GNOME 46 and 50. All nine shipped file hashes matched the installed files. GNOME 46 passed 142 native assertions; GNOME 50 passed 136. The six additional GNOME 46 checks covered live panel movement. Both environments checked long ASCII/CJK names at theme scales 1 and 2, keyboard access, full status/identifier visibility, overview contrast, notification deduplication, file-monitor recovery and enable/disable cleanup.

Eleven preferences assertions on each version exercised the real extension preferences class and GTK/Adwaita window: legacy initialization, independent category updates, custom sound-path persistence, native mute, preservation of the JSON file, and closing both during and after loading. The indicator received settings changes from the separate preferences process. The native sound chooser opened and cancelled cleanly; no physical file-selection walkthrough or audible playback was performed. Native GSettings used an isolated keyfile backend for these tests. Screenshots of the menu and preferences were inspected on both versions.

All 50 Python tests passed on the host and GNOME 50 guest, including native GIO. The JavaScript harness, six-entry-point compilation, shell syntax and archive validation passed. The main Shell process/start time, enabled-extension list and hook files were unchanged. The candidate remains uninstalled in the main desktop. Physical input/audio, the normal desktop settings backend, lock/suspend/resume and the remaining desktop release checks still require validation.

### Outdated notification cleanup (2026-11-13)

The notification-cleanup candidate has archive SHA-256 `854fba5476e353440d3a9d1dbea2c0df53f6bfddeacee9c0871b214186676bd5`. This exact package passed fresh installation, forced upgrade and native removal on GNOME 46 and 50, with all nine installed file hashes matching the archive. GNOME 46 passed 149 native assertions; GNOME 50 passed 143.

Native checks resolved completion, permission, decision and error notices individually, preserving the other sessions' notices and an unrelated application's notification. A ten-session burst retained one current notice per session. Duplicate and delayed events did not clear a newer request. Muted transitions still removed resolved notices, while alert-history resets preserved unresolved requests. Existing preferences, rendering, monitor recovery, malformed-file and enable/disable checks passed again.

The JavaScript harness also checked malformed/missing session data, manual dismissal without replay, same-session replacement, resolved queued sounds and cleanup after a history reset. The host and guest each passed all 50 Python tests, including native GIO; compilation, shell syntax and archive validation passed. Tests used the isolated desktops and settings backend described above. The main Shell process/start time, enabled-extension list and hook files remained unchanged. No installation or reload occurred in the main desktop; remaining physical desktop release checks still apply.

### Optional usage display and reset alerts (2026-11-13)

The usage candidate is revision `671d457` plus the settings, notification-cleanup and usage changes. Its archive SHA-256 is `7758b411ab3301cd384b4c871ecf7449b3b242e09b935ee9668807dc3f1c2216`. This exact package passed fresh installation, forced upgrade and native removal on isolated GNOME 46 and 50; all nine installed file hashes matched. GNOME 46 passed 167 native assertions and GNOME 50 passed 161, using the isolation and software-rendering environments described above.

New native checks covered hidden empty groups, the opt-in empty-group setting, independent account/context display switches, native level bars for two account windows and one session, and five configurable alert categories. Seventeen preferences assertions included both source switches defaulting to off, saving/revoking Codex consent with mode 0600, preserving the legacy JSON file and cancelling work on close. Menu, context-bar and preferences screenshots were inspected on both versions.

A synthetic future quota deadline produced one native reset notification with wording that distinguishes the reported reset time from refreshed usage. Repeated rendering did not duplicate it; newer quota metadata removed it. Opting out removed the deadline timer. JavaScript tests additionally exercised past-deadline startup suppression, mute, an armed deadline passed during a simulated resume, malformed cleanup data and a failing notification backend. Physical suspend/resume and audible reset-sound playback were not exercised.

All 59 Python tests passed on both the host (Python 3.12.3) and guest (Python 3.14.4), including nine synthetic collector/state tests. These verified consent gating, bounded reads, matching session identity, regular-file/path checks, partial/malformed input, numeric bounds, latest-request context, concurrent updates, stale snapshots, privacy filtering and Claude status-line forwarding. Native GIO also verified private atomic consent replacement, recursive directory creation and cancellation without changing saved consent. The JavaScript harness, six-entry-point compilation, shell syntax and archive validation passed.

No real Codex session file or Claude status-line payload was collected during these tests. Agent/version-specific data availability, real hook firing/trust, normal desktop settings backend, physical input/audio, lock/suspend and updated resource/latency measurements remain release checks. No collector overhead or power improvement is claimed. The main Shell process/start time, enabled-extension list and hook files were unchanged; this candidate was not installed or loaded in the main desktop.

### Configurable panel icon (2026-11-13)

The icon candidate has archive SHA-256 `484284ba4201a2b3c58672b12e2adb7c97d890a5015d91a747561fd523dbc3ad`. It adds one bundled symbolic SVG and a native Circle/Robot head preference, preserving Circle as the default and the existing 14-pixel icon size. Fresh installation, forced upgrade and native removal passed on GNOME 46 and 50, with all ten installed file hashes matching the archive.

GNOME 46 passed 183 native assertions and GNOME 50 passed 177. The native preferences selector saved Robot head, received external setting changes and restored Circle when reset. Five screenshots per version confirmed the robot head in idle gray, working green, waiting amber, error red and finished blue. Pixel analysis accounted for antialiasing and verified the head's visible internal gaps and the expected foreground colors, rather than relying only on the icon property or CSS string. Icon-color screenshots used scale 1; the existing menu scale/width checks also passed.

All 59 Python tests passed on the host and guest, including installation of the SVG. JavaScript checks exercised both shapes across the display states and rejected invalid icon choices. Native GIO, compilation, shell syntax, SVG/schema XML parsing and archive validation passed. The main desktop and installed hooks remained unchanged. The candidate was not installed or reloaded into that session; the remaining physical desktop checks above still apply.

### Audit corrections and final package (2026-11-13)

Revision `b39ecbf` contains the final settings, usage and icon changes. Its archive SHA-256 is `ec0c65da5ab5a9e00233733bf468ae3ae3c349942acbfe78bb179de0540462b9`. Fresh installation, forced upgrade and native removal passed in the isolated GNOME 46 and GNOME 50 environments described above; all ten installed file hashes matched the archive. GNOME 46 passed 187 native assertions and GNOME 50 passed 181, including the existing preferences, robot colors, menu bounds, notification cleanup and lifecycle checks.

Four corrections have regression coverage:

- The Claude status-line wrapper kills its owned process group on a two-second timeout or termination on POSIX, then reaps its child. Synthetic timeout and termination tests verify that the foreground child stops; no existing user process is targeted.
- Invalid session-state types no longer replace valid cached data or dismiss unresolved notices. Native checks preserve the last valid ten-session menu and nine unresolved notices, then recover on valid input.
- Display-only preference changes preserve an already queued sound; alert and sound preference changes can still cancel it.
- One shared quota deadline updates an open menu when a window expires, including while reset alerts are disabled or muted. JavaScript tests verify no late notification replay when alerts are subsequently enabled; native checks verify expiry without a notification when reset alerts are disabled. No polling is added.

All 61 Python tests passed on the host (Python 3.12.3) and guest (Python 3.14.4), including the two new process-cleanup regressions. The JavaScript harness, native GIO, six-entry-point compilation, shell syntax and archive validation passed. Each of the three feature commits was also checked independently against its staged source and, where applicable, its matching package.

The main Shell process/start time, enabled-extension list and hook-file hashes remained unchanged. The final package was not installed or reloaded in the main desktop. Physical input/audio and volume, the normal desktop settings backend, lock/suspend/resume, real agent hook firing/trust and usage availability, and updated desktop resource/latency measurements remain release checks. Synthetic metadata fixtures do not establish support for every agent version or refresh account quota after a reported deadline.

### Session lifecycle and local usage refresh (2026-11-13)

The verified archive has SHA-256 `6ff1cd0379a90a34d6102fc11753dea9c31b2a6317981aa68459d49d6e5f2ada`. The host and GNOME 50 guest both passed all 81 Python tests. The JavaScript harness, native GIO, six-entry-point compilation, shell syntax, packaging and archive validation also passed.

Lifecycle regressions cover supported/unsupported model-request hooks, resumed root turns, preserved same-turn attention, retired/delayed turns, subagent isolation, confirmed exit after response completion, late events after exit and independent sessions. Usage coverage includes opt-in consent and withdrawal, bounded/revalidated known files, custom Codex directories, missing/malformed sources, unchanged snapshots, concurrent turns and closed-session exclusion. A symlink-loop regression verifies that an unavailable optional source cannot abort a lifecycle hook on the tested Python versions. Native GIO tests exercise helper output bounds, timeouts, cancellation and missing companions; packaging checks allow only the fixed usage-only invocation.

The exact archive passed 213 native GNOME 46 checks and 207 on GNOME 50, including fresh installation, forced upgrade and removal. Both exercised closed-session visibility, manual refresh with newer/unchanged data, preserved lifecycle and alert history, source report ages, notification diagnostics, header alignment, keyboard tooltip, fixed icon/spinner dimensions, stopped idle animation and result expiry. A focused regression first reproduced automatic state reads dismissing refresh feedback early; it now verifies that the result remains until its deadline or menu close, including a native automatic-reload scenario.

All installed archive hashes matched source. The GNOME 50 result matched its fresh run identifier and the guest had no network routes. Screenshots were inspected. The isolated tests preserved the host Shell process/start time, enabled extensions and agent configuration.

Synthetic metadata does not establish fresh provider quota or availability in every CLI version. Actual prompt-free resume and exit in existing user sessions, physical input/audio, lock/suspend/resume, and updated CPU/memory/power measurements remain release checks. The tests did not force those actions or inject events into the real session cache. Updated GNOME modules load at the next normal login.

### UI readability and preferences (2026-11-13)

The verified archive has SHA-256 `fdb577ae373a949a4c5ec0897a0d2e2e1b01c8a6403a30c23812a779351dfc19`. It passed 230 native GNOME 46 checks and 224 on Ubuntu 26.04 / GNOME 50.1, including fresh installation, forced upgrade and removal. All ten installed asset hashes matched the archive and source. The host and guest passed all 83 Python tests; the JavaScript harness, native GIO, compilation, shell syntax and archive validation also passed.

Native theme measurements covered every session state and quota report age in normal, keyboard-focused, high-contrast and 150% text views. The lowest measured text contrast was 5.17:1 on GNOME 46 and 5.61:1 on GNOME 50. These exceed the 4.5:1 normal-text benchmark in the tested themes; they do not certify arbitrary third-party themes. All status icons resolved in both installed icon themes, including the completion checkmark.

Screenshots covered all preferences pages, light/dark appearance, expanded offline setup instructions, enlarged text and 400-pixel windows. Injected settings-write failures produced visible error text on the active Alerts and Display pages, preserving literal markup characters. Remote preview failures omit transport prefixes. Setup guidance appears once in the expandable instructions. Native preferences requests reached the Shell sound player for custom and theme sounds while alerts stayed muted. Replacement and preferences-close cancellation were verified; the audio call itself was intercepted, so this does not establish audible output. Unit tests separately cover invalid requests, unavailable playback, timeout, cancellation and disable cleanup without notifications or preference changes.

Quota reset labels use reported deadlines and the existing render/expiry paths without new polling. Long ASCII/CJK names, scale factors 1 and 2, keyboard scrolling, session lifecycle, alert deduplication and refresh behavior remained covered. The isolated environments preserved the host Shell process, enabled extensions and agent configuration; the GNOME 50 guest had no network routes. Physical audio/input, screen-reader operation and the remaining desktop release checks above are still required.

### Per-session permission alerts (2026-11-15)

The verified archive has SHA-256 `263fa19906f1d82cfdd0972916be7adcb4a0da00ae5b29c74a141ce80051a8ad`. It passed 252 native GNOME 46 checks and 246 on Ubuntu 26.04 / GNOME 50.1, including fresh installation, forced upgrade and removal. All ten installed asset hashes matched the archive and source. Both environments passed all 83 Python tests; the JavaScript harness, native GIO, six-entry-point compilation, shell syntax and archive validation also passed.

Synthetic hooks verified that the session bell suppresses only the selected Codex session’s permission notifications, while other Codex sessions, Claude Code, completion and error notifications remain active. Choices survived extension reloads, confirmed exit cleared only the matching choice, existing permission notices were removed and restoring alerts did not replay requests. JavaScript regressions also cover permission-only sound cancellation, decision alerts and failed preference writes. Injected cleanup-write failures preserved valid native session status and other sessions’ completion alerts; JavaScript tests cover both refused and throwing writes. Native checks verified keyboard help, the click target, visible bell after feedback and the absence of a duplicate global mute row. Screenshots were inspected on both versions. Global mute remains in Settings → Alerts.

The host Shell process/start time, enabled extensions and hook files remained unchanged, and the GNOME 50 guest had no network routes. The package was not installed into the main desktop. This control also silences genuine manual permission requests; it does not distinguish reviewers or change session status. Physical input/audio and the remaining desktop release checks above still apply.

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

This single synthetic run shows lower startup/CPU cost and increased per-invocation RSS/state size. It does not establish battery savings, a stable performance guarantee, GNOME idle CPU, Shell memory, or notification latency. Repeat measurements under comparable load before deriving performance guarantees. This benchmark predates the optional usage collector; its overhead has not been remeasured.

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
