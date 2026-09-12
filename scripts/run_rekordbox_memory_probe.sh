#!/bin/bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC="$SCRIPT_DIR/probe_rekordbox_memory_macos.c"
BIN="${TMPDIR:-/tmp}/probe_rekordbox_memory_macos"

clang -Wall -Wextra -O2 "$SRC" -o "$BIN"
"$BIN" "$@"
