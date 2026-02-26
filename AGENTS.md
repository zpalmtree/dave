# Branch Sync Policy

This project is deployed from two branch-based server tracks. Every functional change must exist on both branches.

- `master` branch is one deployment track.
- `slugs` branch is the second deployment track.
- Any commit merged to one branch must be applied to the other branch unless explicitly stated otherwise.

# Local Working Copies

- `/media/Code/js/dave` is the primary clone used for `master`.
- `/media/Code/solslugs/slug-bot` is the clone used for `slugs`.

# Required Workflow For Agents

1. Make and commit the change on the current target branch.
2. Push that branch.
3. Apply the same commit to the other branch (usually via `git cherry-pick <sha>`).
4. Push the other branch.
5. Confirm both branches include the change and report both SHAs.

# Notes

- If cherry-pick conflicts occur, resolve them immediately and keep behavior equivalent across branches.
- Do not leave one branch behind for follow-up unless the user explicitly approves it.
