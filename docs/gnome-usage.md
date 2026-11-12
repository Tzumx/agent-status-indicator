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

Open the indicator and expand **Sessions**. Claude Code and Codex headings group the rows in one scrollable submenu; session details and reset controls remain inline. Each session has its own project basename, stable abbreviated identifier, state, and last-event time. Missing project metadata displays **Session**. Sessions in the same project remain separate. The summary counts permission requests, decisions, errors, working, finished, and idle sessions.

Each agent group shows up to fifty sessions per page with **Previous sessions** and **Next sessions** controls. Counts include every valid session; paging bounds Shell actors without dropping records. Ordinary event updates preserve open row widgets where ordering remains unchanged.

When opened, the menu fits the available width of the indicator’s monitor. Long project labels are shortened from the start to keep the session ID and status visible. Keyboard focus scrolls reset and paging controls into view with their surrounding row.

The persistent protocol retains `idle`, `working`, `approval`, and `error`. GNOME derives **Decision required** from optional approval metadata and **Finished responding** only from a confirmed normal `Stop`. Session initialization, interruption, reset, and process exit alone never establish successful response completion.

Claude Code's `AskUserQuestion` and `ExitPlanMode` tool-start events indicate explicit decisions. Codex currently uses supported permission and lifecycle events; ordinary text questions are not detected as decisions.

When turn or tool-call IDs are available, the writer rejects retired turns, repeated prompts, and resolved attention events. Claude's permission payload can omit the tool-call ID; the preceding tool-start ID is retained when available. Events without reliable IDs have weaker ordering guarantees, particularly for parallel tool actions. The cache retains 32 retired turn IDs and 64 identified alert keys per session, not an unlimited event history.

Hooks parse the producer's full JSON payload so large tool bodies or final responses do not discard lifecycle events. Only supported metadata survives parsing; conversation text and tool bodies are not persisted. This transient parsing happens in the short-lived hook, not GNOME Shell.

On upgrade, a matching legacy transcript-path identity is migrated to the current hashed or environment identity in the same locked transaction. Existing canonical records remain authoritative, replay guards and alert references are retained, and unrelated sessions are left separate. The transcript file is never opened.

## Notifications and sounds

The extension delivers completion, permission, decision, and error notices through GNOME. Titles contain the agent, project basename, and abbreviated session ID. Bodies use fixed category messages, without conversation text, tool input, or full project paths.

Completion has normal urgency; other categories have elevated urgency. Desktop settings determine banner visibility. Each session has its own notification source so a burst from ten sessions does not compete for GNOME 46's three-notification-per-source limit. Desktop limits still apply to successive notices from the same session. At most 256 session sources are retained; dismissing notifications releases empty sources. Disabling the extension destroys its sources.

The writer stores the latest 256 meaningful alert transitions in the same atomic state transaction. This preserves an intermediate completion even if a new prompt arrives before GNOME reads the file. Duplicate identified events do not append another notice. Startup and reload seed the cursor silently; alerts generated while the extension is disabled are not replayed. History gaps or resets show a diagnostic and suppress uncertain backlog, while current session records remain available.

Use **Mute all alerts** to toggle persistent global mute. For category preferences, edit:

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

All categories are enabled by default. Notifications and sounds can be disabled independently. Muted transitions are consumed and will not replay when unmuted. Invalid preferences retain the previous valid settings, or defaults at startup; the menu shows a diagnostic.

The preferences root and category maps must be JSON objects, and mute/category flags must be booleans. Parseable values such as `null`, arrays, or `"mute_all": "true"` are rejected rather than silently enabling alerts.

| Category | Default theme sound |
| --- | --- |
| Completion | `complete` |
| Permission | `dialog-warning` |
| Decision | `dialog-question` |
| Error | `dialog-error` |

GNOME's native sound player handles playback; `paplay` is unnecessary. Sound volume follows the desktop's sound-effects volume and mute settings, with no separate volume override. Theme contents vary: verify distinguishability on the actual desktop. To override a category, put an absolute OGG/OGA/WAV path in `sound_files`, for example `"error": "/absolute/path/error.wav"`.

One sound is selected per one-second burst, with priority error, permission, decision, completion. Individual visual notices are preserved. Missing sounds or an unavailable audio backend do not stop state tracking or block the agent.

## Missing, corrupt, or orphaned state

The extension watches the state file's parent directory and relevant ancestor, including atomic renames and directory recreation. It does not periodically poll state. Reads are asynchronous and limited to 1 MiB for state and 64 KiB for preferences. Parse/read failures retain valid session data and display a diagnostic. A missing state file displays setup guidance.

If monitoring is unavailable, six one-shot recovery attempts back off from one to thirty seconds. **Refresh status** retries immediately. This is a recovery path, not a recurring status scan.

A killed agent may leave a working or approval record. Time alone does not establish completion. Find that session and select its **Copy reset command** button. Review the copied command and run it in a terminal to reset only that session. The extension never executes the reset or writes the state file.

For an unreadable cache, `agent-status update all idle` explicitly backs it up before resetting. A global reset affects every session; use the session-specific command when possible.

Update all companion writers together. Older versions may discard optional metadata/history: ordinary four-state display remains compatible, but reliable detailed alerts require updated writers.

## Compatibility and validation

Release metadata declares GNOME 46 only. Native GIO and JavaScript harness tests are supplemented by real offscreen GNOME 46 smoke checks. Interactive desktop, audio and suspend/resume checks, resource measurements, actual agent hook firing/trust and GNOME 50 VM tests remain required before release claims. See [validation and measurements](validation.md).
