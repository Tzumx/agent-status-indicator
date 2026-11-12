# GNOME Extensions submission

This document prepares a first review submission. It does not mean the extension has been uploaded or approved.

## Upload artifact

Build from the repository root:

```bash
bash scripts/package-extension.sh
```

Upload `agent-status-indicator@Ruochen0513.github.io.shell-extension.zip` at <https://extensions.gnome.org/upload/> after signing in. The archive is produced with `gnome-extensions pack` when available, with a ZIP fallback for other platforms. Its only files are `metadata.json`, `extension.js`, `state.js`, `alerts.js` and `LICENSE`. The build validates the archive before reporting success.

Keep the UUID `agent-status-indicator@Ruochen0513.github.io` for all marketplace updates. The older local-install UUID is not the marketplace identity. The initial display version is `1.0.0`; the website assigns its own numeric submission version. GNOME Shell 46 and 50 are declared after offscreen native checks, including an Ubuntu 26.04 KVM test. Test additional Shell versions before adding them.

## Listing text

Name:

> Agent Status Indicator

Description:

> Show local Codex and Claude Code session status in the top bar: working, waiting for approval, idle, or error.
>
> Requires the separately installed agent-status companion and configured agent hooks. See the project website for setup and Codex hook trust instructions. The extension reads only a local status file; it does not access conversation logs or the network.

Project / issue tracker:

- <https://github.com/Ruochen0513/agent-status-indicator>
- <https://github.com/Ruochen0513/agent-status-indicator/issues>

If screenshots are requested, capture the actual GNOME 46 top bar and expanded status menu with a real or explicitly identified demo session. Do not include unrelated desktop content or private agent messages. No screenshot has been fabricated for this submission.

## Reviewer notes

The archive contains the GNOME presentation client only. It monitors `$XDG_CACHE_HOME/agent-status-indicator/state.json` (or `~/.cache/agent-status-indicator/state.json`). The separately installed Python companion writes this file atomically from agent lifecycle callbacks. Installing the companion and enabling hooks are deliberate user actions outside the extension; the extension does not install or run Python, a shell command or a custom subprocess.

The extension watches the parent directory, filters atomic file replacements, and debounces events before bounded asynchronous reads. It does not periodically poll state. `disable()` cancels pending reads, releases monitors, notifications and one-shot sources, and destroys the panel button. Callbacks from a previous enable cycle cannot update new actors. Missing data gives a setup message; malformed data retains valid sessions with a diagnostic. User actions can open setup instructions or copy a session reset command; the extension never executes that command.

The compatible status priority remains error, approval, working, idle. GNOME derives decision and finished-response details from source provenance. Active states do not expire based on elapsed time. Native notifications and sounds consume bounded meaningful transitions; startup does not replay alerts. Preferences live under XDG config. Clipboard writes occur only when the user chooses to copy a reset command; there are no clipboard reads, telemetry, network calls, lock-screen mode, administrator or password access. The source is readable ES-module JavaScript. The MIT license is included; the companion and its installers are not in the archive. See [GNOME usage](gnome-usage.md) for retention and degraded-mode behavior.

## Validation and remaining release actions

The original package passed automated checks on 2026-10-21. The extended implementation adds lifecycle, native GIO, session-menu and alert tests. See [validation and measurements](validation.md) for reproducible checks and measured hook costs. The exact packaged UI has offscreen native coverage for GNOME 46 and 50. Physical desktop input, audio, lock/suspend/resume and real agent integration still require validation as recorded there.

Run:

```bash
node --experimental-vm-modules tests/test_extension.mjs
python3 -m unittest discover -s tests -v
for script in install.sh scripts/*.sh uninstall.sh; do bash -n "$script" || exit; done
bash scripts/package-extension.sh
```

The JavaScript harness tests state priority, long tasks, asynchronous reads, read errors, cancellation, missing-file guidance, and callbacks crossing disable/enable cycles. Python tests cover the companion, installation and archive validation. The remaining physical desktop checks for GNOME 46 and 50 are recorded in the validation document.

Before submitting:

1. A human maintainer must read and understand the JavaScript, be able to explain it to reviewers, and undertake ongoing maintenance.
2. Complete the remaining GNOME 46 and 50 desktop checks in [validation and measurements](validation.md), including physical input, audio, locking and suspend/resume. Keep the result and environment in the release notes.
3. Publish the corresponding source revision so reviewers can inspect the same code.
4. Sign in, select the ZIP, read the current upload agreement, and approve its terms personally before final submission.
5. Save the actual review URL and respond to reviewer feedback. A successful upload is a request for review, not immediate public availability.

References checked on 2026-10-21: [review rules](https://gjs.guide/extensions/review-guidelines/review-guidelines.html), [maintainership guidance](https://gjs.guide/extensions/review-guidelines/best-practices.html), [metadata and packaging](https://gjs.guide/extensions/overview/anatomy.html).
