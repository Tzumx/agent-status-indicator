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

## Account quota and session context

The companion can retain optional numeric quota/context snapshots in the local state file. Collection defaults to off. Configure the source switches in `$XDG_CONFIG_HOME/agent-status-indicator/usage.json` (normally `~/.config/agent-status-indicator/usage.json`):

```json
{
  "codex_metadata": false,
  "claude_statusline": false
}
```

Enable only the sources you want. Disabling a source stops future reads; existing numeric snapshots remain until replaced or the cache is cleared.

**Codex:** set `codex_metadata` to `true` after installing the updated companion and lifecycle hooks. Each supported hook may read at most 64 KiB from the header and 256 KiB from the tail of its supplied session file. The file must be a matching regular JSONL session under `$CODEX_HOME/sessions` (default `~/.codex/sessions`). No directory scan, unbounded history traversal, daemon or account request is used. These files also contain conversation text; only numeric usage metadata is retained.

The adapter recognizes `event_msg/token_count` records, uses `last_token_usage.total_tokens / model_context_window` for an approximate context percentage, and accepts the shared Codex primary/secondary quota windows. It never divides accumulated lifetime usage by the context window or combines session quota percentages. Specialized model-limit buckets are not displayed as shared account quota. Codex's terminal may show a different context percentage because it adjusts for reserved prompt/tool capacity. The [Codex hooks reference](https://learn.chatgpt.com/docs/hooks) warns that transcript format is unstable; incompatible versions, large/incomplete records, missing paths or unavailable metadata leave usage hidden.

**Claude Code:** set `claude_statusline` to `true`, then opt into the [official status-line interface](https://code.claude.com/docs/en/statusline). Merge this property into your existing Claude settings without replacing unrelated settings:

```json
{
  "statusLine": {
    "type": "command",
    "command": "agent-status-hook --agent claude --status-line"
  }
}
```

The adapter displays a compact context line in the terminal and sends only usage metadata to an already known session. Lifecycle hooks remain necessary. If you already have a custom status-line command, preserve it with `--status-line-command 'your existing command'`, quoting that command as a single shell argument and escaping it appropriately inside JSON. The wrapper forwards the original JSON stdin and the existing command's stdout; its foreground execution is bounded to two seconds. On Linux/POSIX, timeout or termination also stops its owned command process group. Keep existing status-line options such as padding. The adapter does not modify Claude configuration automatically.

Claude supplies context percentage directly. Five-hour/seven-day quota fields depend on account/version support and may be absent until an API response. Unsupported accounts and missing windows remain unavailable.

## Missing, corrupt, or orphaned state

The extension watches the state file's parent directory and relevant ancestor, including atomic renames and directory recreation. It does not periodically poll state. Reads are asynchronous and limited to 1 MiB for state and 64 KiB for preferences. Parse/read failures retain valid session data and display a diagnostic. A missing state file displays setup guidance.

If monitoring is unavailable, six one-shot recovery attempts back off from one to thirty seconds. **Refresh status** retries immediately. This is a recovery path, not a recurring status scan.

A killed agent may leave a working or approval record. Time alone does not establish completion. Find that session and select its **Copy reset command** button. Review the copied command and run it in a terminal to reset only that session. The extension never executes the reset or writes the state file.

For an unreadable cache, `agent-status update all idle` explicitly backs it up before resetting. A global reset affects every session; use the session-specific command when possible.

Update all companion writers together. Older versions may discard optional metadata/history: ordinary four-state display remains compatible, but reliable detailed alerts require updated writers.

## Compatibility and validation

Release metadata declares GNOME 46 and 50. Native GIO and JavaScript harness tests are supplemented by offscreen GNOME 46 checks and an Ubuntu 26.04 / GNOME 50 KVM smoke test. Physical desktop input, audio, lock/suspend/resume, actual agent hook firing/trust, and desktop resource/wakeup measurements remain release checks. See [validation and measurements](validation.md).
