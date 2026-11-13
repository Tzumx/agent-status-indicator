#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
EXT_DIR="$ROOT/gnome-extension/agent-status-indicator@Ruochen0513.github.io"
SCHEMA="org.gnome.shell.extensions.agent-status-indicator.gschema.xml"
OUT="$ROOT/agent-status-indicator@Ruochen0513.github.io.shell-extension.zip"
STAGING_DIR="$(mktemp -d)"
trap 'rm -rf "$STAGING_DIR"' EXIT

# Keep the marketplace archive independent of the Python companion and installers.
cp "$EXT_DIR/metadata.json" "$EXT_DIR/extension.js" "$EXT_DIR/state.js" "$EXT_DIR/alerts.js" "$EXT_DIR/io.js" "$EXT_DIR/prefs.js" "$EXT_DIR/stylesheet.css" "$ROOT/LICENSE" "$STAGING_DIR/"
mkdir -p "$STAGING_DIR/schemas"
cp "$EXT_DIR/schemas/$SCHEMA" "$STAGING_DIR/schemas/"
if command -v gnome-extensions >/dev/null 2>&1; then
  gnome-extensions pack --force --out-dir "$ROOT" \
    --schema="$STAGING_DIR/schemas/$SCHEMA" --extra-source=state.js --extra-source=alerts.js --extra-source=io.js --extra-source=LICENSE "$STAGING_DIR"
else
  # Source users on other platforms can still produce the identical archive layout.
  rm -f "$OUT"
  (cd "$STAGING_DIR" && zip -q "$OUT" metadata.json extension.js state.js alerts.js io.js prefs.js stylesheet.css LICENSE "schemas/$SCHEMA")
fi

"${PYTHON_BIN:-python3}" "$ROOT/scripts/validate-extension.py" "$OUT"
echo "$OUT"
