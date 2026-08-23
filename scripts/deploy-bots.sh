#!/usr/bin/env bash
set -euo pipefail

REMOTE_HOST="${REMOTE_HOST:-dave}"
REMOTE_MASTER_DIR="${REMOTE_MASTER_DIR:-/home/beach/dave}"
REMOTE_SLUGS_DIR="${REMOTE_SLUGS_DIR:-/home/beach/slug-bot}"
NODE_VERSION="${NODE_VERSION:-22}"
INSTALL_DEPS="${INSTALL_DEPS:-0}"
ALLOW_DIRTY_YARN_LOCK="${ALLOW_DIRTY_YARN_LOCK:-1}"
VIDEO_DRAIN_TIMEOUT_SECONDS="${VIDEO_DRAIN_TIMEOUT_SECONDS:-3600}"

ssh "$REMOTE_HOST" \
    "REMOTE_MASTER_DIR='$REMOTE_MASTER_DIR' REMOTE_SLUGS_DIR='$REMOTE_SLUGS_DIR' NODE_VERSION='$NODE_VERSION' INSTALL_DEPS='$INSTALL_DEPS' ALLOW_DIRTY_YARN_LOCK='$ALLOW_DIRTY_YARN_LOCK' VIDEO_DRAIN_TIMEOUT_SECONDS='$VIDEO_DRAIN_TIMEOUT_SECONDS' bash -s" <<'REMOTE'
set -euo pipefail

load_node() {
    export NVM_DIR="$HOME/.nvm"
    if [ -s "$NVM_DIR/nvm.sh" ]; then
        # shellcheck disable=SC1091
        . "$NVM_DIR/nvm.sh"
    fi

    nvm use "$NODE_VERSION" >/dev/null
}

status_without_allowed_lockfile() {
    if [ "$ALLOW_DIRTY_YARN_LOCK" != "1" ]; then
        git status --porcelain --untracked-files=no
        return
    fi

    git status --porcelain --untracked-files=no | grep -Ev '^[ MADRCU?!]{2} yarn\.lock$' || true
}

ensure_expected_branch() {
    local expected_branch="$1"
    local current_branch
    current_branch="$(git branch --show-current)"

    if [ "$current_branch" != "$expected_branch" ]; then
        echo "Expected branch $expected_branch, but found $current_branch in $(pwd)." >&2
        exit 1
    fi
}

ensure_clean_enough() {
    local unexpected_status
    unexpected_status="$(status_without_allowed_lockfile)"

    if [ -n "$unexpected_status" ]; then
        echo "Unexpected local changes in $(pwd):" >&2
        git status --short >&2
        exit 1
    fi

    if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
        echo "Leaving existing yarn.lock modification untouched in $(pwd)."
    fi
}

install_deps_if_requested() {
    if [ "$INSTALL_DEPS" != "1" ] && [ -d node_modules ]; then
        return
    fi

    local yarn_version
    yarn_version="$(yarn --version)"

    if [[ "$yarn_version" == 1.* ]]; then
        yarn install --frozen-lockfile
    else
        yarn install --immutable
    fi
}

build_repo() {
    if [ -f node_modules/typescript/bin/tsc ]; then
        node node_modules/typescript/bin/tsc
    else
        yarn build
    fi
}

deploy_repo() {
    local dir="$1"
    local branch="$2"

    echo "Deploying $branch in $dir"
    cd "$dir"
    ensure_expected_branch "$branch"
    ensure_clean_enough

    git fetch origin "$branch"
    git pull --ff-only origin "$branch"
    install_deps_if_requested
    build_repo

    echo "$branch is at $(git rev-parse --short HEAD)"
}

restart_app() {
    local app="$1"

    echo "Restarting PM2 app $app"
    pm2 restart "$app" --update-env
}

restart_video_broker() {
    echo "Starting/restarting PM2 app video-broker"
    if pm2 describe video-broker >/dev/null 2>&1; then
        pm2 restart video-broker --update-env
    else
        pm2 start "$REMOTE_MASTER_DIR/dist/VideoBroker.js" \
            --name video-broker \
            --cwd "$REMOTE_MASTER_DIR" \
            --time
    fi
}

video_control() {
    local endpoint="$1"
    VIDEO_CONTROL_ENDPOINT="$endpoint" node --input-type=module <<'NODE'
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const configPath = process.env.VIDEO_CONFIG_FILE || join(homedir(), '.config', 'dave-video.json');
const file = existsSync(configPath) ? JSON.parse(readFileSync(configPath, 'utf8')) : {};
const base = (process.env.VIDEO_BROKER_URL || file.brokerUrl || 'http://127.0.0.1:8765').replace(/\/$/, '');
const token = process.env.VIDEO_BROKER_BOT_TOKEN || file.botToken || '';
const endpoint = process.env.VIDEO_CONTROL_ENDPOINT;
if (!token || !endpoint) throw new Error('Video broker control is not configured.');
const isRead = endpoint === '/v1/control';
const response = await fetch(base + endpoint, {
    method: isRead ? 'GET' : 'POST',
    headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
    },
    ...(isRead ? {} : { body: JSON.stringify({ actor_id: 'deploy-bots.sh' }) }),
});
if (response.status === 404) {
    console.log('unsupported');
    process.exit(0);
}
const body = await response.json().catch(() => ({}));
if (!response.ok) throw new Error(body.error || `Video broker returned HTTP ${response.status}.`);
const state = body.state || body;
if (isRead) {
    const idle = Number(state.active_jobs || 0) === 0
        && !state.worker_busy
        && !state.preparation_busy;
    console.log(idle ? 'idle' : 'busy');
} else {
    console.log('supported');
}
NODE
}

VIDEO_DISPATCH_DRAINED=0
VIDEO_LEGACY_DRAINED=0

legacy_video_dispatch_drain() {
    (
    cd "$REMOTE_MASTER_DIR"
    VIDEO_LEGACY_DRAIN_SECONDS="$VIDEO_DRAIN_TIMEOUT_SECONDS" node --input-type=module <<'NODE'
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import sqlite3 from 'sqlite3';

const configPath = process.env.VIDEO_CONFIG_FILE || join(homedir(), '.config', 'dave-video.json');
const file = existsSync(configPath) ? JSON.parse(readFileSync(configPath, 'utf8')) : {};
const dbPath = process.env.VIDEO_BROKER_DB || file.brokerDb || join(homedir(), 'video-broker.sqlite3');
const until = Math.floor(Date.now() / 1000) + Number(process.env.VIDEO_LEGACY_DRAIN_SECONDS || 3600);
const db = new sqlite3.Database(dbPath);
await new Promise((resolve, reject) => db.run(
    'UPDATE video_control SET paused_until = ?, updated_by = ?, updated_at = ? WHERE id = 1',
    [until, 'deploy-bots.sh compatibility drain', Math.floor(Date.now() / 1000)],
    error => error ? reject(error) : resolve(),
));
await new Promise((resolve, reject) => db.close(error => error ? reject(error) : resolve()));
NODE
    )
}

resume_video_dispatch() {
    if [ "$VIDEO_DISPATCH_DRAINED" != "1" ]; then
        return
    fi
    echo "Resuming video dispatch."
    if [ "$VIDEO_LEGACY_DRAINED" = "1" ]; then
        video_control /v1/control/resume >/dev/null || true
    else
        video_control /v1/control/resume-dispatch >/dev/null || true
    fi
    VIDEO_DISPATCH_DRAINED=0
    VIDEO_LEGACY_DRAINED=0
}

drain_video_dispatch() {
    local result
    result="$(video_control /v1/control/drain)"
    if [ "$result" = "unsupported" ]; then
        echo "Running broker predates dispatch drain; applying a compatibility dispatch hold without cancelling its active render."
        legacy_video_dispatch_drain
        VIDEO_DISPATCH_DRAINED=1
        VIDEO_LEGACY_DRAINED=1
    else
        VIDEO_DISPATCH_DRAINED=1
    fi
    echo "Video dispatch drained; waiting for active rendering and preparation to finish."
    local deadline=$((SECONDS + VIDEO_DRAIN_TIMEOUT_SECONDS))
    while [ "$(video_control /v1/control)" != "idle" ]; do
        if [ "$SECONDS" -ge "$deadline" ]; then
            echo "Timed out waiting for the video pipeline to become idle." >&2
            exit 1
        fi
        sleep 5
    done
    echo "Video pipeline is idle."
}

load_node
trap resume_video_dispatch EXIT
drain_video_dispatch
deploy_repo "$REMOTE_MASTER_DIR" master
deploy_repo "$REMOTE_SLUGS_DIR" slugs
restart_video_broker
restart_app dave
restart_app slug-bot
resume_video_dispatch
pm2 save
pm2 list
REMOTE
