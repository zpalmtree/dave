#!/usr/bin/env bash
set -euo pipefail

REMOTE_HOST="${REMOTE_HOST:-dave}"
REMOTE_MASTER_DIR="${REMOTE_MASTER_DIR:-/home/beach/dave}"
REMOTE_SLUGS_DIR="${REMOTE_SLUGS_DIR:-/home/beach/slug-bot}"
NODE_VERSION="${NODE_VERSION:-22}"
INSTALL_DEPS="${INSTALL_DEPS:-0}"
ALLOW_DIRTY_YARN_LOCK="${ALLOW_DIRTY_YARN_LOCK:-1}"
VIDEO_DRAIN_TIMEOUT_SECONDS="${VIDEO_DRAIN_TIMEOUT_SECONDS:-3600}"
VIDEO_BROKER_RECOVERY_TIMEOUT_SECONDS="${VIDEO_BROKER_RECOVERY_TIMEOUT_SECONDS:-120}"
DEPLOY_VIDEO_BROKER="${DEPLOY_VIDEO_BROKER:-0}"

usage() {
    echo "Usage: $0 [--bots-only|--with-broker]"
    echo "  --bots-only    Restart dave and slug-bot only (default)."
    echo "  --with-broker  Pause new video dispatch, restart video-broker, and preserve an active render."
}

if [ "$#" -gt 1 ]; then
    usage >&2
    exit 2
fi
case "${1:-}" in
    '') ;;
    --bots-only) DEPLOY_VIDEO_BROKER=0 ;;
    --with-broker) DEPLOY_VIDEO_BROKER=1 ;;
    --help|-h)
        usage
        exit 0
        ;;
    *)
        usage >&2
        exit 2
        ;;
esac
if [ "$DEPLOY_VIDEO_BROKER" != "0" ] && [ "$DEPLOY_VIDEO_BROKER" != "1" ]; then
    echo "DEPLOY_VIDEO_BROKER must be 0 or 1." >&2
    exit 2
fi

ssh "$REMOTE_HOST" \
    "REMOTE_MASTER_DIR='$REMOTE_MASTER_DIR' REMOTE_SLUGS_DIR='$REMOTE_SLUGS_DIR' NODE_VERSION='$NODE_VERSION' INSTALL_DEPS='$INSTALL_DEPS' ALLOW_DIRTY_YARN_LOCK='$ALLOW_DIRTY_YARN_LOCK' VIDEO_DRAIN_TIMEOUT_SECONDS='$VIDEO_DRAIN_TIMEOUT_SECONDS' VIDEO_BROKER_RECOVERY_TIMEOUT_SECONDS='$VIDEO_BROKER_RECOVERY_TIMEOUT_SECONDS' DEPLOY_VIDEO_BROKER='$DEPLOY_VIDEO_BROKER' bash -s" <<'REMOTE'
set -euo pipefail

SSH_SESSION_PID="$PPID"
exec 9>"/tmp/dave-deploy-bots.lock"
if ! flock -n 9; then
    echo "Another bot deployment is already running on this server." >&2
    exit 1
fi

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
    git merge --ff-only "origin/$branch"
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
    local output_mode="${2:-default}"
    VIDEO_CONTROL_ENDPOINT="$endpoint" \
        VIDEO_CONTROL_OUTPUT_MODE="$output_mode" \
        VIDEO_EXPECT_WORKER_ONLINE="${VIDEO_EXPECT_WORKER_ONLINE:-0}" \
        VIDEO_EXPECT_CURRENT_JOB="${VIDEO_EXPECT_CURRENT_JOB:-}" \
        node --input-type=module <<'NODE'
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const configPath = process.env.VIDEO_CONFIG_FILE || join(homedir(), '.config', 'dave-video.json');
const file = existsSync(configPath) ? JSON.parse(readFileSync(configPath, 'utf8')) : {};
const base = (process.env.VIDEO_BROKER_URL || file.brokerUrl || 'http://127.0.0.1:8765').replace(/\/$/, '');
const token = process.env.VIDEO_BROKER_BOT_TOKEN || file.botToken || '';
const endpoint = process.env.VIDEO_CONTROL_ENDPOINT;
const outputMode = process.env.VIDEO_CONTROL_OUTPUT_MODE || 'default';
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
    if (outputMode === 'snapshot') {
        console.log([
            state.worker_online ? '1' : '0',
            state.current_job || '-',
        ].join(' '));
    } else if (outputMode === 'recovery') {
        const expectedOnline = process.env.VIDEO_EXPECT_WORKER_ONLINE === '1';
        const expectedJob = process.env.VIDEO_EXPECT_CURRENT_JOB || '';
        const activeJobs = Number(state.active_jobs || 0);
        const workerRecovered = !expectedOnline || Boolean(state.worker_online);
        const leaseRecovered = !expectedJob || activeJobs === 0 || state.current_job === expectedJob;
        console.log(workerRecovered && leaseRecovered ? 'ready' : 'waiting');
    } else {
        console.log('ready');
    }
} else {
    console.log('supported');
}
NODE
}

VIDEO_DISPATCH_DRAINED=0
VIDEO_LEGACY_DRAINED=0
VIDEO_EXPECT_WORKER_ONLINE=0
VIDEO_EXPECT_CURRENT_JOB=

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

pause_video_dispatch() {
    local result snapshot
    VIDEO_DISPATCH_DRAINED=1
    result="$(video_control /v1/control/drain)"
    if [ "$result" = "unsupported" ]; then
        echo "Running broker predates dispatch drain; applying a compatibility dispatch hold without cancelling its active render."
        legacy_video_dispatch_drain
        VIDEO_LEGACY_DRAINED=1
    fi
    snapshot="$(video_control /v1/control snapshot)"
    read -r VIDEO_EXPECT_WORKER_ONLINE VIDEO_EXPECT_CURRENT_JOB <<<"$snapshot"
    if [ "$VIDEO_EXPECT_CURRENT_JOB" = "-" ]; then
        VIDEO_EXPECT_CURRENT_JOB=
    fi
    if [ -n "$VIDEO_EXPECT_CURRENT_JOB" ]; then
        echo "Video dispatch paused; active render $VIDEO_EXPECT_CURRENT_JOB will continue during the broker restart."
    else
        echo "Video dispatch paused; no active render lease needs reconciliation."
    fi
}

wait_for_video_broker_recovery() {
    local deadline=$((SECONDS + VIDEO_BROKER_RECOVERY_TIMEOUT_SECONDS))
    local result
    echo "Waiting for video-broker recovery and worker lease reconciliation."
    while true; do
        if ! kill -0 "$SSH_SESSION_PID" 2>/dev/null; then
            echo "SSH session ended while waiting for video-broker recovery; cancelling deployment." >&2
            exit 1
        fi
        result="$(video_control /v1/control recovery 2>/dev/null)" || result=waiting
        if [ "$result" = "ready" ]; then
            break
        fi
        if [ "$SECONDS" -ge "$deadline" ]; then
            echo "Timed out waiting for video-broker recovery and worker lease reconciliation." >&2
            exit 1
        fi
        sleep 2
    done
    if [ -n "$VIDEO_EXPECT_CURRENT_JOB" ]; then
        echo "Active render lease reconciled after broker restart."
    else
        echo "Video broker is ready after restart."
    fi
}

load_node
trap resume_video_dispatch EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
if [ "$DEPLOY_VIDEO_BROKER" = "1" ]; then
    pause_video_dispatch
else
    echo "Bot-only deployment; video-broker and active renders will not be touched."
fi
deploy_repo "$REMOTE_MASTER_DIR" master
deploy_repo "$REMOTE_SLUGS_DIR" slugs
if [ "$DEPLOY_VIDEO_BROKER" = "1" ]; then
    restart_video_broker
    wait_for_video_broker_recovery
fi
restart_app dave
restart_app slug-bot
resume_video_dispatch
pm2 save
pm2 list
REMOTE
