#!/usr/bin/env bash

LOCAL_APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOCAL_APP_REPO_ROOT="$(cd "$LOCAL_APP_DIR/.." && pwd)"

APP_NAME="Phrase2Photon"
APP_SLUG="phrase2photon"
APP_PORT="5181"
APP_URL="http://127.0.0.1:5181/"
NOW_PLAYING_SERVICE_HOST="127.0.0.1"
NOW_PLAYING_SERVICE_PORT="8768"
NOW_PLAYING_STATUS_URL="http://127.0.0.1:8768/api/now-playing/status"
