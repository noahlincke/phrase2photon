#!/bin/bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC="$SCRIPT_DIR/probe_rekordbox_memory_macos.c"
CACHE_DIR="${TMPDIR:-/tmp}/phrase2photon-rekordbox-probe"
HASH="$(shasum -a 256 "$SRC" | cut -d' ' -f1)"
BIN="$CACHE_DIR/probe-$HASH"

mkdir -p "$CACHE_DIR"
if [ ! -x "$BIN" ]; then
  clang -Wall -Wextra -O2 "$SRC" -o "$BIN"
fi
"$BIN" "$@"
