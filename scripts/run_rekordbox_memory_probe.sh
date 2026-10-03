#!/bin/bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC="$SCRIPT_DIR/probe_rekordbox_memory_macos.c"
CACHE_DIR="${TMPDIR:-/tmp}/phrase2photon-rekordbox-probe"
HASH="$(shasum -a 256 "$SRC" | cut -d' ' -f1)"
BIN="$CACHE_DIR/probe-$HASH"

sdk_candidates() {
  {
    ls -d /Library/Developer/CommandLineTools/SDKs/MacOSX*.sdk 2>/dev/null
    ls -d /Applications/Xcode.app/Contents/Developer/Platforms/MacOSX.platform/Developer/SDKs/MacOSX*.sdk 2>/dev/null
  } | grep -v '/MacOSX\.sdk$' | sort -rV
}

if [ ! -x "$BIN" ]; then
  mkdir -p "$CACHE_DIR"
  if ! clang -Wall -Wextra -O2 "$SRC" -o "$BIN.partial" 2>/dev/null; then
    compiled=""
    for sdk in $(sdk_candidates); do
      if SDKROOT="$sdk" clang -Wall -Wextra -O2 "$SRC" -o "$BIN.partial" 2>/dev/null; then
        compiled="$sdk"
        break
      fi
    done
    if [ -z "$compiled" ]; then
      echo "probe compile failed with default toolchain and SDKROOT candidates: $(sdk_candidates | tr '\n' ' ')" >&2
      exit 1
    fi
  fi
  mv "$BIN.partial" "$BIN"
fi
"$BIN" "$@"
