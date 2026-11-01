# Purge operations

`$purge` and `$purge status` share the same explicit user allowlist in
`lib/Purge.ts`: `354701063955152898`, `901540415176597534`,
`1231731968064880692`, and `882322615346270268`. Server administrator status
alone does not grant either command. Purge deletes only the caller's messages
in the current server, wherever the bot has the required permissions.

Purge progress is persisted in `.purge-state/<guild-id>.json` inside each
bot's encrypted working directory. Pending runs resume automatically when the
Discord client is ready; failed startup lookups and unfinished scans retry
once a minute. No new Discord command is required after a restart.

Checkpoints retain the run/user/guild IDs, counters, progress-message ID, completed
channels, and each unfinished channel's last fully processed page cursor. They
contain no message content. Writes use a private temporary file, fsync, atomic
rename, and a directory fsync. A failed checkpoint write stops further deletion.
Unreadable checkpoints are retained and block replacement rather than silently
starting over. Completed jobs remove their checkpoint and will not run again.

On restart, an interrupted page is fetched again; completed channels and history
pages are skipped. Archived-thread lists are rediscovered, with saved message
cursors applied to each thread. Already-deleted messages stay deleted. A crash
between Discord accepting a deletion and the local checkpoint commit can leave
the displayed count lower by one, but will not skip remaining messages. Discord
cannot participate in the local file transaction.

`$purge status` and operator status also show jobs waiting to resume. A saved job
reserves its guild until it finishes; another user cannot replace it. Recovery
rechecks the user allowlist and channel permissions. There is no need to keep
Discord notifications working for recovery: an unavailable progress channel does
not prevent the rest of the server being scanned.

The initial migration from the old in-memory implementation uses the preceding
logged page boundary, not the in-flight oldest-message cursor, so it safely
replays a few pages. Counters taken immediately before the old process stops
may conservatively miss deletions made during that brief handoff.

## Logs

The encrypted launcher redirects stdout/stderr before starting Node. PM2's
own `/dev/null` paths do **not** mean application logs are discarded. See
[encrypted storage operations](discord-review/encrypted-storage.md).

On `dave`, watch the slugs bot without sending a Discord command:

```sh
tail -F ~/.local/share/discord-data/logs/slug-bot-out.log | grep --line-buffered '\[Purge\]'
```

Use `dave-out.log` for the master track. Existing encrypted log rotation applies.
Each JSON event includes an America/New_York timestamp labeled EST or EDT and
the process ID. Runs include a run ID, guild/user/channel IDs, counts, phase,
and history cursor. The log cursor is diagnostic; the per-channel cursor in
the checkpoint is the safe completed-page position for recovery. Events cover start, channel start/finish, permission skips,
errors, completion, and a heartbeat every 30 seconds, including when Discord
notifications fail or an API request is awaiting a response. Message bodies,
attachments, tokens, and full API error objects are not logged.

## Local operator access

From the server's bot clone, with Node 22 and PM2 on PATH:

```sh
node scripts/purge-operator.mjs status slug-bot
node scripts/purge-operator.mjs start slug-bot GUILD_ID USER_ID CHANNEL_ID
```

The CLI uses the existing local PM2 IPC channel. It opens no network listener,
does not create another bot session, and acknowledges requests from the actual
running process. Operator start requires an allowlisted user who is a member
of the guild and a text channel in that guild. It uses the same handler and
guild concurrency guard as `$purge`; duplicate starts are rejected. Progress
is posted by the bot in the specified channel and recorded in operator logs.
Use `dave` as the app name for the master track.

A successful start acknowledgment means the run was accepted, not completed.
If acknowledgment times out, inspect logs/status before retrying. Operator
access requires the service account's local PM2 access; Discord users cannot
send these IPC requests. Operator status is read-only and starts no deletion.
