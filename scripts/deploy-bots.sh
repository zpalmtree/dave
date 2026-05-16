#!/usr/bin/env bash
set -euo pipefail

REMOTE_HOST="${REMOTE_HOST:-dave}"
REMOTE_MASTER_DIR="${REMOTE_MASTER_DIR:-/home/beach/dave}"
REMOTE_SLUGS_DIR="${REMOTE_SLUGS_DIR:-/home/beach/slug-bot}"
NODE_VERSION="${NODE_VERSION:-22}"
INSTALL_DEPS="${INSTALL_DEPS:-0}"
ALLOW_DIRTY_YARN_LOCK="${ALLOW_DIRTY_YARN_LOCK:-1}"

ssh "$REMOTE_HOST" \
    "REMOTE_MASTER_DIR='$REMOTE_MASTER_DIR' REMOTE_SLUGS_DIR='$REMOTE_SLUGS_DIR' NODE_VERSION='$NODE_VERSION' INSTALL_DEPS='$INSTALL_DEPS' ALLOW_DIRTY_YARN_LOCK='$ALLOW_DIRTY_YARN_LOCK' bash -s" <<'REMOTE'
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

load_node
deploy_repo "$REMOTE_MASTER_DIR" master
deploy_repo "$REMOTE_SLUGS_DIR" slugs
restart_app dave
restart_app slug-bot
pm2 list
REMOTE
