# Branch Sync Policy

This project is deployed from two branch-based server tracks. Every functional change must exist on both branches.

- `master` branch is one deployment track.
- `slugs` branch is the second deployment track.
- Any commit merged to one branch must be applied to the other branch unless explicitly stated otherwise.

# Local Working Copies

- `/home/zp/Code/js/dave` is the primary clone used for `master`.
- `/home/zp/Code/solslugs/slug-bot` is the clone used for `slugs`.

# Required Workflow For Agents

1. Make and commit the change on the current target branch.
2. Push that branch.
3. Apply the same commit to the other branch (usually via `git cherry-pick <sha>`).
4. Push the other branch.
5. Confirm both branches include the change and report both SHAs.

# Deployment

Use `scripts/deploy-bots.sh` from `/home/zp/Code/js/dave` to deploy both server tracks after both branches have been pushed.

The deploy script:

- SSHes to `dave`.
- Fast-forwards `/home/beach/dave` on `master`.
- Fast-forwards `/home/beach/slug-bot` on `slugs`.
- Builds both working copies.
- Restarts PM2 apps `dave` and `slug-bot`.
- Prints the final PM2 process list.

Default remote settings can be overridden with environment variables:

- `REMOTE_HOST` defaults to `dave`.
- `REMOTE_MASTER_DIR` defaults to `/home/beach/dave`.
- `REMOTE_SLUGS_DIR` defaults to `/home/beach/slug-bot`.
- `NODE_VERSION` defaults to `22`.
- `INSTALL_DEPS` defaults to `0`; set to `1` to force dependency installation.
- `ALLOW_DIRTY_YARN_LOCK` defaults to `1`; this allows pre-existing remote `yarn.lock` modifications.

# Notes

- If cherry-pick conflicts occur, resolve them immediately and keep behavior equivalent across branches.
- Do not leave one branch behind for follow-up unless the user explicitly approves it.
