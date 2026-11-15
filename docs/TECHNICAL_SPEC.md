# Agent Status Indicator - Technical Specification

**Repository:** `Tzumx/agent-status-indicator` (fork of `Ruochen0513/agent-status-indicator`)

**Status:** Implementation requirements. Automated coverage and current limits are recorded in [validation and measurements](validation.md); desktop release validation remains required. A requirement is not evidence that it has passed a desktop test.

## 1. Purpose

Provide one lightweight, native Ubuntu GNOME top-bar indicator for concurrent **Claude Code** and **Codex** sessions. The indicator must show which session is working, waiting for approval or a user decision, finished responding, or failed. Important transitions must produce GNOME desktop notifications and distinct audible signals, without requiring an open browser.

The primary deployment is **Ubuntu 24.04 LTS / GNOME 46**. The next compatibility target is **Ubuntu 26.04 LTS / GNOME 50**, subject to verification on that release. The GNOME integration must work without a mandatory resident monitoring daemon.

## 2. Existing baseline and gaps

The upstream project already provides:

- A native GNOME Shell extension plus a separate cross-platform floating desktop client.
- Claude Code and Codex hook adapters and local per-session status records.
- Session aggregation with `idle`, `working`, `approval`, and `error` states.
- Atomic state-file updates with locking and delayed-event protections.
- A local status file at the XDG cache location, typically `~/.cache/agent-status-indicator/state.json`.
- Tests and installation scripts; hook setup is opt-in.

As of the baseline reviewed for this specification, the GNOME extension refreshes the state file every second; its menu primarily exposes aggregate summaries. The Linux installer enables a user-level daemon by default, although direct state-file updates can work without it. Hook handling may start an additional Python process. These are improvement opportunities, not reasons to replace the working state engine.

## 3. Scope and exclusions

### In scope

1. One native GNOME top-bar icon for both agents.
2. Accurate concurrent session tracking and an expandable session list.
3. Event-driven updates from the existing state file, with no periodic state polling in normal operation.
4. Desktop notifications and distinct sounds for completion, permission requests, user decisions, and failures.
5. Graceful operation without a resident daemon or extra tray process.
6. GNOME 46 support and a tested migration path to GNOME 50.
7. Automated tests, installation safety, troubleshooting, and resource measurements.
8. Opt-in local usage metadata, configurable quota/context display, and reported quota-reset alerts.

### Out of scope for the initial release

- Running or controlling agent sessions from the indicator.
- Full conversation-log reads or inferring task intent from conversation text. The optional bounded Codex usage-metadata collector described below is the only session-file exception.
- Cloud accounts, synchronization, remote dashboards, telemetry, or browser integrations.
- Exact task-level completion prediction; a lifecycle `Stop` event means a response/turn stopped, not necessarily that the whole project is complete.
- Reliable focus switching to every possible terminal emulator; this may be explored later as an opt-in enhancement.
- Replacing the project's cross-platform desktop client.

### Upstream compatibility and minimal divergence

This is a downstream extension of an active upstream codebase, not a replacement architecture. Changes should remain easy to maintain as a fork **and** suitable for selective pull requests to the original repository.

- Preserve the upstream directory layout, existing code and documentation filenames, user-facing entry points, and public contracts wherever practical. Add the smallest functional change in the existing location instead of moving code or reorganizing documentation.
- Put new product documentation under `docs/`, while updating existing upstream documentation in place when necessary. Do not rename, delete, or wholesale restructure upstream documents solely to enforce a new documentation convention.
- Keep behavior changes, tests, and relevant documentation together in small reviewable patches; separate unrelated refactors, broad formatting changes, and cosmetic cleanups.
- Preserve optional cross-platform functionality even if the immediate target is GNOME on Ubuntu. Any incompatible schema, installer, CLI, or public-interface change needs a documented reason and a migration/compatibility strategy.
- For fork-specific experiments or non-essential local work, prefer ignored local-only files rather than introducing unnecessary tracked divergence. Files required to build, test, install, or operate the released product must remain versioned.
- Before a significant structural departure, compare its impact on upstream synchronization and the ability to submit the change upstream; prefer the smaller alternative unless the larger change is explicitly approved.

## 4. User experience

### 4.1 Top-bar indicator

Show one compact icon in the right status area of the GNOME top bar, before the system controls. Its color/state reflects the highest-priority session requiring attention. Settings → Display offers Circle (the default) or a bundled symbolic Robot head; both use the same status colors and accessible state text. The menu opens on click and shows:

- A session-count headline with a compact refresh button at its right and optional separate labeled counts by state, omitting empty categories. The refresh icon becomes a spinner in the same space while busy; tooltip and keyboard access identify the action. Show result text briefly after a click, with persistent errors and global update time under Troubleshooting. Keep report ages beside quota and context; omit permanent generic refresh text.
- Separate groups for Claude Code and Codex; hide empty groups by default, with a preference to show them.
- One row per session with a project name, independently visible status and short stable session identifier, and a timestamp. Last-event descriptions are optional to avoid repeating the status.
- Distinct rows when two sessions share the same working directory or project name.
- Hide sessions with a confirmed `SessionEnd` by default, retaining their internal replay guards. **Display → Show closed sessions** reveals them as Closed. A stopped response remains visible while its CLI stays open; interruption or silence alone must not hide a session.
- Recovery controls hidden by default, exposed explicitly through **Troubleshooting → Show reset controls** for stale or orphaned sessions. The user reviews and executes a session-specific reset command in a terminal; the extension does not execute resets.

An illustrative menu (not a required visual layout):

```text
Agent Status Indicator
  Needs attention: 2 | Working: 2 | Finished: 1

  Claude Code
    trading-bot [a3f21b]   Working
    backend [b8e92c]       Permission required

  Codex
    analytics [c7d11f]     Decision required
    website [d4a56e]       Finished responding
```

A missing project label falls back to a neutral session label. Never invent project names. Project labels should normally be the final component of the working directory, not a full private path.

### 4.2 Meaning of states

| UI state | Meaning | Notification policy |
| --- | --- | --- |
| Idle | A session exists but has no active turn | No notification on initialization |
| Working | Processing a prompt, tool call, or turn | No routine alert |
| Permission required | A supported permission hook indicates an approval prompt | Important alert and warning sound |
| Decision required | A supported tool-specific hook indicates an explicit user choice is needed | Important alert and distinct question sound |
| Finished responding | A turn or response ended normally | Completion notification and distinct completion sound |
| Error | An explicit failure event occurred | Error notification and distinct error sound |

`Finished responding` must not be inferred merely from an `idle` record: `SessionStart` may initialize a session as idle. It may be derived from the last confirmed `Stop` event or represented by a compatible state-schema extension. Preserve the existing four-state compatibility contract until a carefully tested migration is approved.

Default priority for overall display: `error` > `permission/decision required` > `working` > `finished` > `idle`. Counts must still distinguish the underlying states.

### 4.3 GNOME desktop notifications

- Notifications must appear in Ubuntu's standard notification system and remain available in GNOME's notification center according to desktop settings.
- Titles must identify agent, project label, and shortened session ID.
- Use distinct human-readable messages for completion, permission, decision, and failure.
- Prefer normal urgency for completion and elevated urgency for events that need a response; do not assume a desktop environment will always show a banner.
- Notify once per meaningful transition. Reloading the extension, rereading the state file, or replaying the same hook must not send another alert.
- Keep at most one current notification per session. Remove that session's obsolete notification when authoritative lifecycle state shows that the request resolved, work resumed, the next turn started, or the session ended/reset/disappeared.
- Preserve unresolved notices from other sessions and applications. Age alone must never expire a session notice.
- Consume historical transitions that are already superseded without raising a stale notice or sound. Cancel queued sounds if their transition is resolved before playback; delayed old events must not remove a newer notice.
- Notifications must be configurable by event category, with a way to mute all alerts in Settings → Alerts. Keep the global mute control there rather than duplicating it in the main session menu.
- Each Codex session offers a compact permission-alert toggle beside its timestamp. It suppresses only that session’s permission notifications and sounds, including genuine manual requests. Completion, error, decision and quota-reset alerts keep their existing policy. State and lifecycle evidence are unchanged. A slashed amber bell marks suppression, with hover/keyboard help and a brief confirmation. Choices persist by session identity across extension reloads; confirmed exit or removal clears them. Restoring alerts must not replay earlier requests.
- Missing/invalid internal notification history must use plain diagnostic wording under Troubleshooting while preserving session display and suppressing uncertain alerts. Complete normal-display fixtures must include valid history metadata.
- If the desktop's notification service is unavailable, state tracking and the panel must keep working.

### 4.4 Sounds

- Provide four individually distinguishable sounds: completion, permission, decision, and error.
- Prefer sounds from the installed freedesktop sound theme through GNOME's native player; permit user-supplied OGG/WAV paths without requiring `paplay` or custom subprocesses.
- Sound mapping and volume/mute behavior must be documented and independently configurable from visual notifications.
- Never play sound on every tool call, render tick, extension startup, or repeated state-file update.
- Missing sound files or an unavailable audio backend must fail silently or with a useful diagnostic, never interrupt the agent. Volume follows desktop sound-effects settings; category mute is independently configurable from visual notifications.
- Bursts of simultaneous completions should be rate-limited or coalesced to prevent sound floods while preserving per-session visible notifications.

### 4.5 Preferences

- Provide a standard GTK4/libadwaita extension preferences window, accessible from the menu and GNOME extension managers.
- Allow global mute, independent sound/notification toggles for each event category, local OGG/OGA/WAV selection, restoration of the system theme sound, and an explicit sound preview. Preview uses the enabled extension’s native sound player even while alerts are muted, never creates notifications or changes settings, and stops on replacement, preferences close or extension disable. No extra audio dependency, subprocess or idle timer is required.
- Use native GSettings keys for editable preferences, preserving existing `gnome.json` values as read-only fallbacks until each setting is explicitly changed.
- Put brief, expandable hook and usage setup instructions on the Integration page. Help must remain useful offline. Show plain-text action errors in the active preferences window; retain retry controls for settings load failures.
- Provide a Circle/Robot head panel-icon selector and Display switches for empty groups, closed sessions, overview counts, event descriptions, account quota and session context usage.
- Provide separate opt-in usage-source switches on Integration and independent quota-reset notification/sound controls on Alerts.
- Keep settings pages extensible without moving session parsing or lifecycle semantics into the UI.
- Distinguish idle, working, waiting, finished and error through theme-colored text and the documented icon colors. Keep status text and quota information readable in normal, focused and high-contrast menus on both supported Shell versions.

### 4.6 Optional usage display

- Show the most recent shared account quota once per agent group and context-window usage per session, using labeled percentages and native level bars. Do not sum account percentages across sessions. Multiple simultaneous accounts for one agent are not distinguished in this version.
- Show only validated reported data; unavailable values are hidden rather than presented as zero. Show each quota window’s reported local reset time, including its date when needed. Retain report timestamps and hide expired quota windows without inventing a new zero-usage snapshot. Reset labels update on existing render events without additional polling.
- Codex collection is disabled by default and enabled explicitly in Settings. At supported lifecycle hooks, read only the supplied session file under the configured Codex sessions directory, verify its session identity, and extract numeric token-count/rate-limit metadata. Bound each read to a 64 KiB header plus a 256 KiB tail and each parsed record to 64 KiB; ignore incomplete records.
- An explicit **Refresh local data** control rereads saved state/settings and, with Codex collection enabled, rescans up to 32 previously registered session files. A single short-lived fixed helper handles this user action with a five-second UI deadline and bounded output; it is cancelled on extension disable. It must not change lifecycle timestamps, replay guards or alert history, discover session files, make account requests or force a Claude status-line update. Report ages and unchanged/unavailable results must be visible.
- A private cache may retain those known Codex file locations, their original configured sessions directories and registration times separately from status data. Each rescan revalidates the file identity, consent and existing read bounds; closed/reset/interrupted records are excluded.
- Session files also contain conversation text. Never retain, display, log or infer meaning from that text. Do not scan for other session files, traverse complete histories, request account credentials, add network calls, or require a daemon.
- Codex context is an estimate from the latest model request's token count and reported context window, never cumulative lifetime tokens. The file format is unstable; unsupported/missing metadata means unavailable usage.
- Claude Code uses its documented optional status-line JSON input, including reported context percentage and available account quota windows. Preserve existing status-line commands when the user chooses a wrapper; never silently replace configuration.
- Usage-only writes preserve session lifecycle, event timestamps, replay guards and alert history, using the existing locked atomic state transaction. Older snapshots must not overwrite newer data.
- Visible quota expiry and optional reset alerts share one one-shot timer for all known reported deadlines. Notify once when an armed deadline arrives, including on resume; do not replay past deadlines at startup or after unmuting.
- Reset alerts describe the reported reset time, not verified remaining quota. Refresh usage only on new source data and clear the obsolete reset notice when newer quota metadata arrives. Notification and sound are independently configurable and disabled by default.
- Source consent is stored in a small private XDG config file readable by the companion; no GSettings process is launched per hook. Display and alert preferences remain native GSettings.

## 5. Architecture

### 5.1 Proposed event path

```text
Claude Code sessions --- hooks ---+
                                  +--> event normalization --> locked atomic state update
Codex sessions -------- hooks ---+                                |
                                                                   v
                                                    XDG cache state.json
                                                                   |
                                                    parent-directory file monitor
                                                                   |
                                                                   v
                                                     GNOME Shell extension
                                                          |        |
                                                          |        +--> session menu / icon
                                                          +--> notifications / sounds
```

No persistent polling process is required in the GNOME deployment. Hook commands are short-lived and run on lifecycle callbacks or an explicit manual usage refresh. Implementation may route notifications through a short-lived utility or a GNOME-native API, but the chosen mechanism must not depend on a resident Python/GTK/Tauri application.

### 5.2 File monitoring

- Replace the extension's one-second refresh timer with `Gio.FileMonitor` or an equivalent GLib/GIO event source.
- Watch the **directory containing `state.json`**, because writers atomically replace the file and a file-inode watch may become invalid.
- Filter relevant file events and debounce bursts. Do one asynchronous, cancellable read per settled update, not one read per filesystem event.
- Perform one initial state read at extension enable. Do not perform periodic normal-operation reads.
- Re-establish monitoring if the containing directory is created, replaced, or temporarily unavailable; use a bounded recovery path without high-frequency polling.
- Release monitors, callbacks, cancellables, and pending sources on extension disable or reload.
- Bound state-file size and parser failures. On corruption, show a diagnostic state and preserve the last known-good data where safe.

### 5.3 State and concurrency

- Keep one stable identity per session: `(agent, session_id)`; the working directory is metadata, not an identifier.
- Keep project metadata optional and privacy-minimized; never store conversation text.
- Preserve atomic writes, locking, and last-writer consistency under concurrent hook invocations.
- Ignore stale events from older turns where a newer turn is already authoritative.
- On supported Codex releases, use a root-session model-request hook as an additional explicit turn boundary after resume. Same-turn retries must not clear attention, reopen stopped/reset turns, or affect another session; retain retired-turn and timestamp guards.
- Handle session start, normal end, interruption, error, subagent events, and context compaction according to actual source semantics.
- Do not arbitrarily expire long-running work solely because time has passed.
- For abrupt termination without a final lifecycle event, expose manual reset/clear rather than declaring the task finished.
- Maintain backward compatibility with the existing state JSON format and CLI unless a versioned migration is explicitly approved and tested.

### 5.4 Hook event mapping

Use only events supported by the installed release of each agent. Verify registration, matcher semantics, and trust rather than assuming that a hook configuration was accepted.

| Observable event | Desired effect |
| --- | --- |
| Session start/resume | Initialize or retain the session as appropriate; no completion notification |
| User prompt submitted | Transition the correct session to working |
| Codex model request, when supported | Establish a new identified root turn as working; leave an already known turn unchanged |
| Ordinary tool begins/ends | Preserve working state; no sound |
| Permission request | Mark permission required; notify once |
| Explicit user-question tool, when available | Mark decision required; notify once |
| Normal turn stop | Mark finished responding / idle with `Stop` provenance; notify once |
| Explicit stop failure or tool error | Mark error; notify once if meaningful |
| Session end / interruption, if supported | Settle or clear only that session; avoid a false success signal |

For Claude Code, examine the actual `PreToolUse` payload for tools such as `AskUserQuestion` or `ExitPlanMode`. For Codex, detect decisions only when a reliable supported hook exists. A generic assistant question in plain text may be impossible to identify; document this limitation rather than faking a decision state.

Do not allow a generic `PreToolUse` working update to immediately overwrite a pending permission/decision state during the same blocked action. Preserve compatibility with other user-defined hooks.

### 5.5 Installation and configuration

- The native GNOME extension must not require the socket daemon to be enabled or running.
- Keep cross-platform components available; do not delete their working code as an optimization for GNOME.
- Provide a clear GNOME-only installation path that does not enable the daemon by default. Keep any legacy service explicitly optional.
- Hook setup must remain opt-in, merge with existing Claude Code/Codex settings, and back up the user's files before edits.
- Support the installed Codex version's hook-trust workflow and expose a truthful health check.
- Store user preferences under XDG config directories and status under XDG cache directories; do not hard-code the home directory.
- State which external packages, if any, are optional for notifications and audio.
- The installer and uninstaller must not silently remove unrelated hooks or settings.

## 6. Compatibility

| Environment | Requirement | Evidence required |
| --- | --- | --- |
| Ubuntu 24.04 / GNOME 46 | Supported baseline | Local GNOME desktop test and automated checks |
| Ubuntu 26.04 / GNOME 50 | Planned supported target | Real installation or VM test before claiming support |
| GNOME Wayland | First-class target | Enable/disable, notifications, menu, and suspend/resume tests |
| GNOME X11, when available | Best effort | Record tested version and limitations |
| No audio backend or theme sound | Degraded mode | Icon and notifications still function |
| No notification service | Degraded mode | Icon and state tracking still function |
| Missing or untrusted agent hooks | Degraded mode | Clear diagnostics; no false active-session claims |

Only declare a GNOME Shell version in extension metadata after smoke tests for that version. Avoid speculative compatibility declarations.

## 7. Reliability, performance, and privacy

**Reliability**

- One session must never erase or mask another session's state record.
- A hook handler must not block a coding session for noticeable time. Failures in the indicator path must not alter an agent's approval or execution semantics.
- Do not generate notifications while replaying existing cache state at extension startup.
- Failing, malformed, or missing state must not crash GNOME Shell.

**Resource use**

- No recurring one-second reads or scan loops in normal GNOME use.
- No required background service, UI helper, web server, or network requests.
- Minimize hook subprocesses and avoid launching a second interpreter per event where practical.
- Keep idle wakeups and CPU use negligible; quantify rather than assume.
- Record incremental memory use, CPU load, wakeups, and notification latency against an extension-disabled baseline on representative hardware.
- Do not promise a specific battery-life improvement without reproducible measurements.

**Privacy and security**

- Entirely local state and notification path; no analytics or telemetry.
- No credentials, conversation transcripts, or tool payload dumps in status files or notifications.
- Show shortened session IDs and project basenames by default; never expose full private paths in desktop notifications.
- Validate event payloads and bound untrusted strings before rendering.
- Keep user-owned files under appropriate permissions; preserve atomic writes and crash-safe behavior.

## 8. Delivery plan

### Phase 0 - Baseline and safeguards

- Capture current passing tests and existing behaviors.
- Add regression tests for multiple sessions, delayed events, atomic replacement, errors, and GNOME reload behavior.
- Confirm the current Codex/Claude hook capabilities locally without sending model prompts.

### Phase 1 - Event-driven GNOME updates

- Replace the polling timer with directory monitoring and one initial asynchronous read.
- Verify atomic file replacement, missing-directory recovery, and teardown.
- Make GNOME-only installation genuinely daemon-free while preserving optional legacy transport.
- Reduce redundant hook processes if feasible without broad changes.

### Phase 2 - Session-aware menu

- Add grouped per-session rows, project label, abbreviated session ID, state, and last event.
- Handle same-project sessions, absent metadata, dozens of sessions, and stale/orphaned entries.
- Keep the overall icon readable and compact.

### Phase 3 - Notifications and audible alerts

- Implement event-level deduplication and category preferences.
- Add desktop notifications, four sound mappings, per-category mute, and error fallbacks.
- Check that completion refers to a finished response/turn, not a guarantee that all work is complete.

### Phase 4 - Compatibility, packaging, and measurements

- Verify GNOME 46 and GNOME 50 in the actual environments.
- Run automated tests, user-level installation/uninstallation smoke tests, and performance measurements.
- Update user documentation in `docs/` and adjust metadata/release packaging only after validation.

Changes should be small, independently reviewable, and suitable for separate pull requests. Avoid a single large rewrite.

## 9. Acceptance criteria

The initial release is acceptable only when these checks have evidence:

1. **Single indicator:** one native icon covers both Claude Code and Codex; no duplicate resident tray app is required.
2. **Parallel work:** at least ten simulated concurrent sessions across both agents retain independent identities and statuses.
3. **Same project:** two sessions in the same directory appear as distinct rows with distinct short IDs.
4. **Awaiting input:** supported permission and explicit decision hooks produce the correct state, notification, and sound.
5. **Completion:** stopping one turn notifies once without falsely reporting other running sessions complete.
6. **Failures:** errors notify distinctly and do not crash the extension or clear unrelated sessions.
7. **No duplicate alerts:** duplicate/out-of-order hook events, extension reload, and initial cache load do not replay notifications.
8. **Atomic updates:** state changes are observed through a directory monitor despite atomic file replacement.
9. **No periodic polling:** source inspection and runtime observation confirm no recurring status refresh loop in normal operation.
10. **No mandatory daemon:** GNOME extension + hook integration continues to work with the optional socket daemon stopped and disabled.
11. **Graceful degradation:** missing sound, notifications, project metadata, or state file do not break the panel.
12. **Safe setup:** installation requires explicit opt-in for hook changes; existing unrelated settings survive install/uninstall.
13. **Crash recovery:** abruptly killed sessions are not silently marked complete; a documented manual reset is available.
14. **GNOME 46 and 50:** both versions have documented smoke-test results before declaring support.
15. **Resources:** measured CPU, RSS/memory delta, wakeup activity, and alert latency are recorded for idle, burst, and ten-session scenarios.
16. **Privacy:** no conversation content, secrets, private full paths, or network transmission are introduced.
17. **Regression checks:** Python unit tests, JS extension tests, Python compilation, and shell syntax checks pass; failures or unavailable tests are reported.
18. **Upstream portability:** changed code and docs preserve the upstream layout where possible; any necessary structural divergence is justified, isolated, and documented for future upstream PRs.
19. **Optional usage:** collection defaults to off; bounded reads and metadata-only persistence are verified. Account quota appears once per agent and context per session, with missing/expired data hidden and independent display controls.
20. **Quota reset alerts:** reported deadlines notify once only when enabled, without polling or startup replay; newer quota data clears obsolete notices. Physical suspend/resume and real account data remain explicit release checks.

## 10. Project checks

Run the existing project checks and extend them as necessary:

```bash
python3 -m unittest discover -s tests -v
python3 -m py_compile bin/agent-status bin/agent_status_state.py bin/agent-status-hook bin/codex-status-exec bin/agent-status-desktop desktop/agent_status_desktop.py
node --experimental-vm-modules tests/test_extension.mjs
for script in install.sh scripts/*.sh uninstall.sh; do bash -n "$script" || exit; done
```

For measurements, document Ubuntu/GNOME versions, hardware, number of live sessions, tool versions, conditions, methods, and observed numbers. Compare with the extension disabled and with the daemon stopped. Do not substitute estimates for measurements.

## 11. Implementation decisions and remaining validation

The implementation preserves upstream filenames, entry points, and the four-state version-3 contract:

- The GNOME extension dispatches native notifications and sounds; hooks normalize lifecycle data, optionally extract usage metadata, and transact state in-process.
- Optional project/action/attention metadata and a generation/sequence alert log extend the existing JSON. Decision remains `approval`; finished responding requires confirmed `Stop` provenance.
- Legacy transcript-path identities are migrated atomically when the matching hook next updates state. Existing canonical records keep precedence; unrelated session identities are never merged by project or directory.
- The latest 256 meaningful alert transitions are retained. Startup/reload is silent; gaps, resets, or old writers dropping metadata cause conservative resynchronization and a diagnostic. This is bounded delivery, not unlimited backlog replay.
- Retired-turn and identified-alert guards are bounded. Missing source IDs limit causal ordering and deduplication, particularly for parallel actions. Do not infer stronger guarantees from configuration presence.
- `--gnome-only` installs no desktop clients or new services and leaves existing services unchanged. Legacy installer defaults remain compatible.
- Orphans require explicit session-specific CLI reset; no process scanner or time-based completion is added. Terminal focus switching remains deferred.
- Actual GNOME 46 and GNOME 50 desktop behavior, real agent hook firing/trust, sound distinguishability, and Shell resource/latency measurements remain release gates.
