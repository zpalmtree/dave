# GitHub commit thread watcher

The bot polls every 60 seconds after each completed check. It watches every branch
(including the default branch), discovers new branches, and posts commit links,
first-line summaries, authors, and branch names in grouped Discord embeds.
Merge updates use purple accents; ordinary updates use blue. Large batches split
into bounded pages. Mentions are disabled. The bot needs Embed Links permission.

Merged PRs receive a prominent line such as **xaz merged branch
codex/title-harpoon-transition into main**, followed by a PR link. The actor is
GitHub's `merged_by` user, not the PR author or commit author. This includes squash
and rebase merges when the resulting SHA matches GitHub's merged PR record.
Only the PR's destination branch receives that announcement; an older merge
carried into another branch is labeled as a merge commit. Direct Git merge
commits use the branch names in the standard Git subject when available, and
otherwise receive a generic merge label.

Fast-forward updates without a PR are highlighted when the added commits include
another previously tracked branch tip. This also works if that source branch has
since advanced or been deleted. The embed names the source and destination and
labels the inference; it does not guess who performed the merge from commit
authorship. Git cannot distinguish a fast-forward merge from another ref update
that produces identical history. Previously unseen source branches, or branches
created and merged entirely between polls, cannot be reliably identified.
Rewritten history and newly created destination branches do not use this inference.

Configuration is read from `~/.config/dave-github-watch.json`, or the path in
`GITHUB_WATCH_CONFIG_FILE`:

```json
{
  "token": "GITHUB_TOKEN_WITH_REPOSITORY_READ_ACCESS",
  "botUserId": "DISCORD_BOT_USER_ID",
  "repository": "Xazware/Pooners",
  "threadId": "1544486384629452831"
}
```

Keep this file outside Git with mode 0600. Only the matching bot user starts the
watcher, so both deployment tracks can share this file without duplicate posts.
A fine-grained GitHub token needs access to this repository with Contents: read
and Pull requests: read for merge details. Without PR access, commit tracking
continues with merge-commit labels and a warning in the logs.
If the account is an outside collaborator and cannot select this repository for
a fine-grained token, use an appropriate classic token or a GitHub App installed
by the repository owner. Restart the bot after changing configuration.

The initial check saves all current branch tips without posting old commits.
State and a pending-message outbox are stored atomically beside the config in
`dave-github-watch.json.state.json`; preserve this file across deployments.
Successful sends are checkpointed individually; failed sends retry on the next
poll. A crash between Discord accepting a message and saving its checkpoint can
repeat that message. Never run two instances of the selected bot with this file.

New branches compare against the previously observed default-branch tip. Rewrites
are labeled, and missing old SHAs fall back to announcing the current tip.
Branch and comparison API results are paginated. API failures preserve progress.
A branch created and deleted entirely between polls cannot be observed; polling
also cannot recover commits force-pushed away before they were observed.

The bot must have access to the thread and permission to send messages in it.
Archived threads are reopened when there is an update; locked threads may require
additional Discord permissions. Configuration and API failures appear in PM2 logs
with the `[GitHub watch]` prefix. No webhook or public inbound endpoint is needed.

Existing text outbox entries remain deliverable after the embed migration.
