# GitHub commit thread watcher

The bot polls every 60 seconds after each completed check. It watches every branch
(including the default branch), discovers new branches, and posts commit links,
first-line summaries, authors, and branch names. Mentions are disabled.

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
A fine-grained GitHub token needs access to this repository with Contents: read.
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
