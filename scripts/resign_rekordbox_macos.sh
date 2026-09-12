#!/bin/bash

set -euo pipefail

APP_PATH="${1:-/Applications/rekordbox 7/rekordbox.app}"

if [[ ! -d "$APP_PATH" ]]; then
  echo "Rekordbox app not found at: $APP_PATH" >&2
  exit 1
fi

if pgrep -f "$APP_PATH/Contents/MacOS/rekordbox" >/dev/null 2>&1; then
  echo "Rekordbox is running. Close it before re-signing: $APP_PATH" >&2
  exit 1
fi

TEMP_ENTITLEMENTS="$(mktemp "${TMPDIR:-/tmp}/rekordbox-entitlements.XXXXXX.plist")"
trap 'rm -f "$TEMP_ENTITLEMENTS"' EXIT

if ! codesign -d --entitlements :- "$APP_PATH" >"$TEMP_ENTITLEMENTS" 2>/dev/null; then
  echo "Failed to extract entitlements from: $APP_PATH" >&2
  exit 1
fi

if ! /usr/libexec/PlistBuddy -c "Print :com.apple.security.get-task-allow" "$TEMP_ENTITLEMENTS" >/dev/null 2>&1; then
  /usr/libexec/PlistBuddy -c "Add :com.apple.security.get-task-allow bool true" "$TEMP_ENTITLEMENTS"
fi

echo "Re-signing Rekordbox with get-task-allow:"
echo "  app: $APP_PATH"
echo "  temp entitlements: $TEMP_ENTITLEMENTS"

run_codesign() {
  if [[ -w "$APP_PATH" ]]; then
    codesign "$@"
  else
    sudo codesign "$@"
  fi
}

run_codesign --remove-signature "$APP_PATH" 2>/dev/null || true
run_codesign -s - --deep --force --entitlements "$TEMP_ENTITLEMENTS" "$APP_PATH"

if ! codesign -d --entitlements :- "$APP_PATH" 2>&1 | grep -q "com.apple.security.get-task-allow"; then
  echo "Re-sign succeeded, but get-task-allow was not present in the final entitlements." >&2
  exit 1
fi

echo "Re-sign complete."
echo "Expect macOS to treat this install as locally modified and no longer notarized."
