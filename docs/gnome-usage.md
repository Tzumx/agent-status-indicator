# GNOME usage

## Installation

For the native top-bar indicator without desktop clients, Tkinter, or new systemd services:

```bash
./install.sh --gnome-only
```

Hooks remain opt-in. To merge them, preserving unrelated settings and creating backups:

```bash
./install.sh --gnome-only --merge-hooks
```

Use `--no-start` to copy files without changing extension activation. Restart agent sessions after hook changes; review and trust Codex hooks in `/hooks`, then run `agent-status doctor --check-codex`. A successful installation or synthetic hook test does not establish that a real agent invokes the hooks.

The default installer still provides the upstream desktop clients and service. GNOME-only mode leaves previously installed services and desktop clients unchanged. Existing services can be disabled separately by the user; the native indicator and hooks do not require them. Never run a second tray client merely to support the extension.

## Sessions and states

The indicator appears on the right side of the top bar, before the system controls. Open it and expand **Sessions**. Claude Code and Codex headings group the rows in one scrollable submenu; session details remain inline. Recovery controls are hidden by default. Each session has its own project basename, stable abbreviated identifier, state, and last-event time. Missing project metadata displays **Session**. Sessions in the same project remain separate. The overview uses one labeled count per state and hides empty categories. The headline shows the total session count. Empty agent groups and an entirely empty Sessions submenu are hidden by default. Project names and status labels are separate; the smaller line shows a stable session ID and timestamp. Event descriptions and overview counts can be toggled in Settings.

Each agent group shows up to fifty sessions per page with **Previous sessions** and **Next sessions** controls. Counts include every valid session; paging bounds Shell actors without dropping records. Ordinary event updates preserve open row widgets where ordering remains unchanged.

When opened, the menu fits the available width of the indicator’s monitor. Long project names are shortened while separate session identifiers and status labels remain visible. Keyboard focus scrolls session rows and paging controls into view. When recovery controls are shown, focus moves to each row's reset button.

A confirmed `SessionEnd` hides that session immediately. **Settings → Display → Show closed sessions** reveals retained entries with a **Closed** label. A normal `Stop` still shows **Finished responding** while the CLI remains open, and an interruption does not establish that the session closed. Closing a session removes neither another session nor the internal record: replay guards remain until normal idle-record pruning, and a later explicit start can show the session again. A force-killed process may emit no exit hook and still needs the manual recovery described below.

The persistent protocol retains `idle`, `working`, `approval`, and `error`. GNOME derives **Decision required** from optional approval metadata and **Finished responding** only from a confirmed normal `Stop`. Session initialization, interruption, reset, and process exit alone never establish successful response completion.

Claude Code's `AskUserQuestion` and `ExitPlanMode` tool-start events indicate explicit decisions. Codex currently uses supported permission and lifecycle events; ordinary text questions are not detected as decisions.

On Codex releases that support it, the model-request hook establishes a resumed turn even when no new prompt-submit event reaches the indicator. Requests in an already known turn leave its state unchanged, including pending approval, errors and a completed or manually reset turn. Subagent model requests do not establish the parent turn. Older releases omit this hook and rely on prompt-submit events. Review the added hook in Codex's **/hooks** menu after upgrading.

When turn or tool-call IDs are available, the writer rejects retired turns, repeated prompts, and resolved attention events. Claude's permission payload can omit the tool-call ID; the preceding tool-start ID is retained when available. Events without reliable IDs have weaker ordering guarantees, particularly for parallel tool actions. The cache retains 32 retired turn IDs and 64 identified alert keys per session, not an unlimited event history.

Hooks parse the producer's full JSON payload so large tool bodies or final responses do not discard lifecycle events. Only supported metadata survives parsing; conversation text and tool bodies are not persisted. This transient parsing happens in the short-lived hook, not GNOME Shell.

On upgrade, a matching legacy transcript-path identity is migrated to the current hashed or environment identity in the same locked transaction. Existing canonical records remain authoritative, replay guards and alert references are retained, and unrelated sessions are left separate. Identity migration never needs the transcript contents. The separate optional Codex usage collector is described below.

## Settings

Choose **Settings…** in the indicator menu, or use the preferences button in GNOME Extensions or Extension Manager. The native preferences window has **Alerts**, **Display**, and **Integration** pages.

Under **Alerts**, expand an event category to enable its desktop notification and sound independently. Use the file button to choose a local OGG, OGA or WAV sound, and the undo button to restore the system theme sound. **Mute all alerts** suppresses both notifications and sounds. Changes apply immediately to the loaded version supporting these settings; a Shell code update still requires the next normal login.

**Display → Panel icon** selects **Circle** (default) or **Robot head**. Both keep the same status colors and update immediately in a loaded version supporting this setting. The robot is a bundled symbolic SVG, so it does not depend on a theme providing a robot icon.

**Display** also controls empty agent groups, closed sessions, state counts, last-event descriptions, account quota and per-session context usage.

**Integration** controls optional usage collection and provides brief, expandable **Setup instructions** for lifecycle hooks, Codex trust and the Claude Code status-line adapter. These instructions work offline and do not change agent configuration.

Settings use the native GSettings schema `org.gnome.shell.extensions.agent-status-indicator`. Each choice has its own key, so menu mute and preferences changes do not overwrite unrelated choices. Existing JSON preferences remain read-only fallbacks until an individual setting is explicitly changed in Settings. Resetting a native key restores its legacy fallback, or the built-in default.

The panel icon uses gray for idle, green for working, amber for permission or decision requests, blue for a confirmed finished response, and red for an agent error or unreadable state. Session rows pair colored icons with theme-colored status text. Quota information uses normal text contrast rather than disabled-control styling.

## Notifications and sounds

The extension delivers completion, permission, decision, and error notices through GNOME. Titles contain the agent, project basename, and abbreviated session ID. Bodies use fixed category messages, without conversation text, tool input, or full project paths.

Completion has normal urgency; other categories have elevated urgency. Desktop settings determine banner visibility. Each session has its own notification source and at most one current notice. A burst from ten sessions preserves ten independent notices, without competing for GNOME 46's three-notification-per-source limit. At most 256 session sources are retained; dismissing notifications releases empty sources. Disabling the extension destroys its sources.

The writer stores the latest 256 meaningful alert transitions in the same atomic state transaction. GNOME consumes this history but announces only a transition that still matches the session's latest state. If work has already resumed before the file is read, the superseded completion/request is not announced. Duplicate identified events do not append another notice. Startup and reload seed the cursor silently; alerts generated while the extension is disabled are not replayed. History gaps or resets show a diagnostic and suppress uncertain backlog, while current session records remain available.

Notices leave GNOME's notification history when they become obsolete: permission/decision notices clear when that session resumes, errors clear when it recovers, and completion notices clear when its next turn starts. A valid update marking the session ended, reset or explicitly removed also clears its notice. Other sessions and applications remain untouched. Duplicate or delayed events do not dismiss a newer request. Cleanup follows lifecycle state, with no age-based expiry, and still works while alerts are muted. A history-counter reset or a missing/corrupt cache does not establish resolution; notices remain until valid state supplies evidence. Queued sounds are cancelled if their transition resolves before playback.

Use **Mute all alerts** for persistent global mute, and **Settings… → Alerts** for category preferences. Older installations may also supply fallback values in:

```text
$XDG_CONFIG_HOME/agent-status-indicator/gnome.json
```

The fallback is `~/.config/agent-status-indicator/gnome.json`. Example:

```json
{
  "mute_all": false,
  "notifications": {
    "completion": true,
    "permission": true,
    "decision": true,
    "error": true
  },
  "sounds": {
    "completion": true,
    "permission": true,
    "decision": true,
    "error": true
  },
  "sound_files": {}
}
```

The four lifecycle categories are enabled by default. **Quota window reset** notifications and sounds are disabled by default. Notifications and sounds can be disabled independently in Settings. Muted transitions are consumed and will not replay when unmuted. Invalid preferences retain the previous valid settings, or defaults at startup; the menu shows a diagnostic.

The preferences root and category maps must be JSON objects, and mute/category flags must be booleans. Parseable values such as `null`, arrays, or `"mute_all": "true"` are rejected rather than silently enabling alerts.

| Category | Default theme sound |
| --- | --- |
| Completion | `complete` |
| Permission | `dialog-warning` |
| Decision | `dialog-question` |
| Error | `dialog-error` |
| Quota window reset (opt-in) | `complete` |

GNOME's native sound player handles playback; `paplay` is unnecessary. Sound volume follows the desktop's sound-effects volume and mute settings, with no separate volume override. Theme contents vary: verify distinguishability on the actual desktop. Choose a custom sound through Settings. A legacy `sound_files` entry can also supply an absolute OGG/OGA/WAV path until that category is explicitly changed in Settings.

One sound is selected per one-second burst, with priority error, permission, decision, completion/quota reset. Individual visual notices are preserved. Missing sounds or an unavailable audio backend do not stop state tracking or block the agent.

## Account quota and session context

Enable the sources you want under **Settings → Integration → Usage sources**. Both default to off. Collection preferences live in `$XDG_CONFIG_HOME/agent-status-indicator/usage.json` (normally `~/.config/agent-status-indicator/usage.json`), separate from the read-only legacy alert file. The file contains only the `codex_metadata` and `claude_statusline` boolean switches and is written privately by Settings. Disabling collection stops future reads; existing snapshots remain in the cache until replaced or cleared, and Display switches can hide them.

**Codex:** enable **Read Codex usage metadata** after installing the updated companion and lifecycle hooks. Each supported hook may read at most 64 KiB from the header and 256 KiB from the tail of its supplied session file. The file must be a matching regular JSONL session under `$CODEX_HOME/sessions` (default `~/.codex/sessions`). No directory scan, unbounded history traversal, daemon or account request is used. These files also contain conversation text; only numeric usage metadata is retained in status data. For manual refresh, a private `usage-sources.json` cache stores at most 32 known session file locations, original Codex sessions directories and registration times; it contains no conversation text.

The adapter recognizes `event_msg/token_count` records, uses `last_token_usage.total_tokens / model_context_window` for an approximate context percentage, and accepts the shared Codex primary/secondary quota windows. It never divides accumulated lifetime usage by the context window or combines session quota percentages. Specialized model-limit buckets are not displayed as shared account quota. Codex's terminal may show a different context percentage because it adjusts for reserved prompt/tool capacity. The [Codex hooks reference](https://learn.chatgpt.com/docs/hooks) warns that transcript format is unstable; incompatible versions, large/incomplete records, missing paths or unavailable metadata leave usage hidden.

**Claude Code:** enable **Receive Claude Code usage**, then opt into the [official status-line interface](https://code.claude.com/docs/en/statusline). Merge this property into your existing Claude settings without replacing unrelated settings:

```json
{
  "statusLine": {
    "type": "command",
    "command": "agent-status-hook --agent claude --status-line"
  }
}
```

The adapter displays a compact context line in the terminal and sends only usage metadata to an already known session. Lifecycle hooks remain necessary. If you already have a custom status-line command, preserve it with `--status-line-command 'your existing command'`, quoting that command as a single shell argument and escaping it appropriately inside JSON. The wrapper forwards the original JSON stdin and the existing command's stdout; its foreground execution is bounded to two seconds. On Linux/POSIX, timeout or termination also stops its owned command process group. Keep existing status-line options such as padding. Settings does not modify Claude configuration automatically.

Claude supplies context percentage directly. Five-hour/seven-day quota fields depend on account/version support and may be absent until an API response. Unsupported accounts and missing windows remain unavailable.

Each agent group uses its most recently reported shared account snapshot. Simultaneous accounts for the same agent are not distinguished; their quotas cannot be combined reliably.

Available account quota appears once under its agent heading; session context appears within that session row. Bars always label **percent used** and use blue, amber (80%+) and red (95%+) accents. Quota labels use reported window durations and show each window’s **Reported reset** time in local time, with its date for another day. This is the source’s reported deadline, not a newly verified allowance. Quota and context show **Last reported…** ages, updated when the menu opens or new data arrives. These identify snapshots; percentages are not continuous live measurements. Missing fields are hidden, and a quota whose reset time passed disappears until new data arrives.

The circular-arrow **Refresh local data** button sits at the right of the session-count heading. Its tooltip appears on hover or keyboard focus. It reloads saved status and settings and reconnects file monitoring. With Codex collection enabled, one short-lived helper rescans only previously registered session files using the same validation and read bounds. No files are discovered and no account request is made. One hook must first register a source while collection is enabled; at most 32 recent sources are retained. Closed, reset and interrupted sessions are excluded. A spinner replaces the icon in the same button while busy. Result text appears for four seconds after a click or until the menu closes; persistent errors remain under Troubleshooting. No permanent refresh text is shown. Missing/outdated companions leave saved status available. Refresh is limited to five seconds and cancelled when the extension is disabled.

Refresh never changes session status, event timestamps, notification history or approval state. Claude usage still requires its next configured status-line update. A fresh local read can return an older report; activity elsewhere may also change account quota. **Status updated** under Troubleshooting describes lifecycle activity separately from usage report times. Silence alone does not establish that a session ended.

**Notification tracking unavailable** under Troubleshooting means the internal transition history is missing or invalid, not that GNOME's notification center or conversations are unavailable. Session status remains visible, but new lifecycle notifications are suppressed until valid history returns. Update the companion commands and hooks if the condition persists.

Under **Settings → Alerts → Quota window reset**, opt into a desktop notice, a sound, or both. One shared timer expires visible quota windows and handles enabled reset alerts, including checking armed deadlines after resume; there is no quota polling. Past deadlines do not replay on startup, reload, enable or unmute. The message says the reported reset time has arrived; it does not claim the account has confirmed a fresh allowance. New quota data removes that agent's obsolete reset notice. Reset alerts work independently of the Display switches and follow global mute.

## Missing, corrupt, or orphaned state

The extension watches the state file's parent directory and relevant ancestor, including atomic renames and directory recreation. It does not periodically poll state. Reads are asynchronous and limited to 1 MiB for state and 64 KiB for preferences. Parse/read failures retain valid session data and display a diagnostic. A missing state file displays setup guidance.

If monitoring is unavailable, six one-shot recovery attempts back off from one to thirty seconds. **Troubleshooting → Refresh status** retries immediately. Hook setup help is under **Settings… → Integration**. This is a recovery path, not a recurring status scan.

A killed agent may leave a working or approval record. Time alone does not establish completion. Open **Troubleshooting**, turn on **Show reset controls**, then return to **Sessions** and select that session's **Copy reset command** button. Review the copied command and run it in a terminal to reset only that session. This changes only the recorded indicator status to Idle; it does not restart or stop the agent. The extension never executes the reset or writes the state file. Reset controls are hidden again when the extension is next enabled.

For an unreadable cache, `agent-status update all idle` explicitly backs it up before resetting. A global reset affects every session; use the session-specific command when possible.

Update all companion writers together. Older versions may discard optional metadata/history: ordinary four-state display remains compatible, but reliable detailed alerts require updated writers.

## Compatibility and validation

Release metadata declares GNOME 46 and 50. Native GIO and JavaScript harness tests are supplemented by offscreen GNOME 46 checks and an Ubuntu 26.04 / GNOME 50 KVM smoke test. Physical desktop input, audio, lock/suspend/resume, actual agent hook firing/trust, and desktop resource/wakeup measurements remain release checks. See [validation and measurements](validation.md).
