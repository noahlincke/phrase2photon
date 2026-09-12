#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
workdir="$(mktemp -d)"
cleanup() {
  if [[ -f "$home_dir/Library/Caches/local-web-apps/phrase2photon.pid" ]]; then
    pid="$(cat "$home_dir/Library/Caches/local-web-apps/phrase2photon.pid" 2>/dev/null || true)"
    if [[ -n "${pid:-}" ]]; then
      kill "$pid" 2>/dev/null || true
      wait "$pid" 2>/dev/null || true
    fi
  fi
  rm -rf "$workdir"
}
trap cleanup EXIT

mockbin="$workdir/mockbin"
home_dir="$workdir/home"
apps_dir="$workdir/apps"
mkdir -p "$mockbin" "$home_dir" "$apps_dir"

cat > "$mockbin/curl" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

printf '%s\n' "$*" >> "$LOCAL_APP_TEST_CURL_LOG"

if [[ -f "$LOCAL_APP_TEST_READY_FILE" ]]; then
  exit 0
fi

exit 1
EOF
chmod +x "$mockbin/curl"

cat > "$mockbin/nohup" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
"$@"
EOF
chmod +x "$mockbin/nohup"

cat > "$mockbin/open" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> "$LOCAL_APP_TEST_OPEN_LOG"
EOF
chmod +x "$mockbin/open"

cat > "$mockbin/osacompile" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

printf '%s\n' "$*" >> "$LOCAL_APP_TEST_OSACOMPILE_LOG"

target=""
while [[ $# -gt 0 ]]; do
  if [[ "$1" == "-o" ]]; then
    target="$2"
    shift 2
    continue
  fi
  shift
done

if [[ -z "$target" ]]; then
  echo "missing -o target" >&2
  exit 91
fi

mkdir -p "$target"
EOF
chmod +x "$mockbin/osacompile"

cat > "$workdir/fake-run-server.sh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf 'started\n' >> "$LOCAL_APP_TEST_START_LOG"
touch "$LOCAL_APP_TEST_READY_FILE"
cleanup() {
  rm -f "$LOCAL_APP_TEST_READY_FILE"
  exit 0
}
trap cleanup TERM INT
printf 'ready\n'
while true; do
  sleep 1
done
EOF
chmod +x "$workdir/fake-run-server.sh"

fallback_bin="$workdir/fallback-bin"
mkdir -p "$fallback_bin"
cat > "$fallback_bin/node" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> "$LOCAL_APP_TEST_NPM_LOG"
exit 0
EOF
chmod +x "$fallback_bin/node"

cat > "$fallback_bin/npm" <<'EOF'
#!/usr/bin/env node
EOF
chmod +x "$fallback_bin/npm"

cat > "$fallback_bin/uv" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> "$LOCAL_APP_TEST_UV_LOG"
exit 0
EOF
chmod +x "$fallback_bin/uv"

assert_eq() {
  local expected="$1"
  local actual="$2"
  local message="$3"
  if [[ "$expected" != "$actual" ]]; then
    printf 'assertion failed: %s\nexpected: %s\nactual: %s\n' "$message" "$expected" "$actual" >&2
    exit 1
  fi
}

assert_file_contains() {
  local path="$1"
  local needle="$2"
  if ! grep -Fq -- "$needle" "$path"; then
    printf 'expected %s to contain %s\n' "$path" "$needle" >&2
    exit 1
  fi
}

run_open_local_app() {
  HOME="$home_dir" \
  PATH="$mockbin:$PATH" \
  LOCAL_APP_RUN_SERVER="$workdir/fake-run-server.sh" \
  LOCAL_APP_TEST_READY_FILE="$workdir/ready" \
  LOCAL_APP_TEST_START_LOG="$workdir/start.log" \
  LOCAL_APP_TEST_CURL_LOG="$workdir/curl.log" \
  LOCAL_APP_TEST_OPEN_LOG="$workdir/open.log" \
  bash "$repo_root/local-app/open-local-app"
}

run_install_local_app() {
  HOME="$home_dir" \
  PATH="$mockbin:$PATH" \
  LOCAL_APP_TEST_OSACOMPILE_LOG="$workdir/osacompile.log" \
  bash "$repo_root/local-app/install-local-app" "$apps_dir"
}

run_run_server_with_minimal_path() {
  HOME="$home_dir" \
  PATH="/usr/bin:/bin:/usr/sbin:/sbin" \
  LOCAL_APP_NPM_BIN="$fallback_bin/npm" \
  LOCAL_APP_UV_BIN="$fallback_bin/uv" \
  LOCAL_APP_SKIP_NOW_PLAYING_WAIT="1" \
  LOCAL_APP_TEST_NPM_LOG="$workdir/npm.log" \
  LOCAL_APP_TEST_UV_LOG="$workdir/uv.log" \
  bash "$repo_root/local-app/run-server"
}

first_output="$(run_open_local_app)"
assert_eq "http://127.0.0.1:5181/" "$first_output" "launcher prints app URL"
assert_eq "1" "$(wc -l < "$workdir/start.log" | tr -d ' ')" "launcher starts server once"
assert_file_contains "$workdir/open.log" "http://127.0.0.1:5181/"
assert_file_contains "$workdir/curl.log" "http://127.0.0.1:5181/"
assert_file_contains "$home_dir/Library/Logs/local-web-apps/phrase2photon.log" "ready"

second_output="$(run_open_local_app)"
assert_eq "http://127.0.0.1:5181/" "$second_output" "launcher restarts healthy server"
assert_eq "2" "$(wc -l < "$workdir/start.log" | tr -d ' ')" "launcher restarts server on every open"

run_run_server_with_minimal_path
assert_file_contains "$workdir/uv.log" "run phrase2photon now-playing-serve --host 127.0.0.1 --port 8768"
assert_file_contains "$workdir/npm.log" "run dev -- --host 127.0.0.1 --port 5181 --strictPort"

run_install_local_app
if [[ ! -d "$apps_dir/Phrase2Photon.app" ]]; then
  echo "expected installer to create Phrase2Photon.app" >&2
  exit 1
fi
assert_file_contains "$workdir/osacompile.log" "$repo_root/local-app/open-local-app"

echo "test_local_app.sh: ok"
