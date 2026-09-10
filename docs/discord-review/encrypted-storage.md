# Encrypted storage operations

The `discord-storage` launcher in `scripts/storage/discord-storage.py` uses a
user-owned gocryptfs mount on the bot servers. It mounts before opening service
logs, selecting a working directory or starting Node. An unavailable key or
failed mount stops startup; an unmounted backing directory is mode `000`.
PM2 must use the user's home as its initial working directory and `/dev/null`
for its own output/error paths. The launcher redirects application output into
the encrypted filesystem. Do not replace it with a direct Node launch.

## Paths and credentials

Each server keeps these paths under its service account's home:

- `.local/share/discord-cipher`: encrypted filenames and file contents.
- `.local/share/discord-data`: decrypted mounted view, accessible only to the
  service account. Repositories retain their original paths through symlinks.
- `.config/discord-storage/config.json`: mount paths and service commands.
- `.config/discord-storage/unlock.key`: unattended-unlock credential, mode 600
  inside a mode-700 directory. Never commit, print or include it in tickets.
- `.local/bin/gocryptfs` and `.local/bin/discord-storage`: runtime tools.
- `.local/share/discord-data/logs`: application output/error and historical logs.
- `.config/discord-storage/logrotate.conf`: daily/25 MiB copytruncate rotation,
  retaining 30 rotated logs. Copytruncate can lose lines written during the
  copy/truncate window. Older logs retained during migration remain archived.

Runtime keys are present on the server for unattended recovery. This protects
ciphertext copies without their keys; it does not protect an unlocked server
from its administrator or an attacker controlling the service account. Keep
ciphertext backups and recovery credentials separate. The local operator's
private recovery directory is outside the Git repository.

The pinned static Linux amd64 gocryptfs release is 2.6.1, downloaded from the
[upstream release](https://github.com/rfjakob/gocryptfs/releases/tag/v2.6.1), with
SHA-256 `49b8c0eb0f6373b6ac99c394a52909d8478e74c08d0961527c1162967cc28c44`.

## Status, restart and logs

Run as the hosting service account:

```sh
~/.local/bin/discord-storage status
~/.local/bin/discord-storage ensure
pm2 restart APP_NAME
# PM2's own log stream is deliberately empty for these apps.
tail -n 50 ~/.local/share/discord-data/logs/APP_NAME-error.log
```

Load the server's configured Node version before running PM2. Routine Dave
changes still deploy both branches through `scripts/deploy-bots.sh`.
Meeting-bot's ecosystem configuration selects the launcher when the host's
storage configuration exists. Its deployment must continue to preserve the
remote `.env`, SQLite files and `tmp` directory.

## Backup and recovery

Before taking a consistent ciphertext snapshot, pause affected writers, ensure
no meeting or render is active, checkpoint/close SQLite, and unmount normally.
Never force-unmount an active database. Copy the complete cipher directory,
including `gocryptfs.conf` and directory-IV files. Mount the copy read-only in a
separate directory with the recovery credential; check SQLite integrity and
record counts. Unmount the recovery copy before restoring normal service.
Copies made while writers are active are not guaranteed consistent backups.

The initial migration records its source-to-target map and a verified
ciphertext snapshot path in `.config/discord-storage/`. It preserves the
original PM2 configuration inside the encrypted `operations` directory.
Rollback requires stopping affected services and restoring from the verified
snapshot; retain encrypted storage rather than silently restoring plaintext
runtime paths. Do not delete a snapshot merely because normal startup succeeds.
When fulfilling deletion requests, account for retained migration backups too.

Migrating and removing the original named files does not prove erasure of old
cloud snapshots, discarded filesystem blocks or other unmanaged copies. Those
are separate retention considerations. This server storage change also does
not establish encryption on a separate desktop media worker or AI provider.
