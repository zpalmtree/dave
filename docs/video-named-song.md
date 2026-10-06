# Named recordings for lip-sync

For example, reply to a cat sticker with `$minimax make this cat sing the chorus to Electric Feel`.
The soundtrack router identifies MGMT's existing song, asks the desktop to retrieve the recording,
and waits for that audio before planning. It does not ask the music generator to recreate it.
Original-song requests still compose normally; an uploaded song takes precedence over lookup.
The original recording supplies the singer's voice as well as the instrumental backing.

The downloader prefers the artist's own channel or a verified official source and rejects
unrequested covers, remixes, live performances, karaoke and altered-speed versions. A direct
YouTube song link avoids ambiguous search results. Only HTTPS YouTube video URLs are accepted;
no playlists, arbitrary hosts, browser cookies, or authentication bypasses are used. A blocked
or missing recording stops with an error asking for an upload or a more specific link.

Downloads run on the desktop as CPU/network work without a GPU reservation. Recordings are
cached by requested song identity with a verified SHA-256 digest, retaining at most 32 files.
A previously successful download can be reused when YouTube is temporarily unavailable.
Recordings are limited to ten minutes, 100 MiB downloaded media and 12 MiB uploaded MP3; subprocesses have
timeouts. The broker normalizes and transcribes the recording, chooses the requested section,
then sends only that excerpt through the existing immutable-audio H3 pipeline. The selected
recording URL/title and excerpt timing remain in the job's recovery state/database.

## Installation

1. Install the official `yt-dlp.exe` beside the desktop's `video_worker.py`, or set `VIDEO_YTDLP`
   to an installed executable. Node.js and FFmpeg must be on the worker's PATH. The audited
   smoke test used yt-dlp 2026.08.19. Download releases from https://github.com/yt-dlp/yt-dlp/releases.
2. Run `python3 scripts/apply-video-named-song-desktop.py --check`, then run without `--check`.
   The installer checks exact before/after source hashes and installs the downloader and tests.
3. Drain broker dispatch and reload only the supervised worker child while it is idle.
   Preserve its supervisor and any active render. The new worker advertises `song_download_version: 1`.
4. Deploy both branches using `scripts/deploy-bots.sh --with-broker` and resume dispatch.

The patch also makes a recovery exception finish as cancelled when a user cancellation is
pending. Previously an interrupted generator could report an ordinary exception and cause
recovery to retry the cancelled request.

## Verification

- `yarn build && node --test tests/video-named-song.test.mjs tests/video-composed-song.test.mjs`
- `PYTHONPATH=desktop python3 -m unittest desktop/test_video_named_song.py`
- Run `test_video_named_song` with the Windows embedded Python against installed sources,
  which also verifies the asynchronous worker handoff and cancellation without GPU work.
- A live CPU-only smoke test resolved and downloaded MGMT's official Electric Feel video
  (`MmZexg8sxyk`, 228 seconds) on the desktop. The server's unauthenticated request was blocked
  by YouTube, so retrieval belongs on the desktop rather than the broker host.

Regenerating a completed named-song job keeps its recording and excerpt. Regenerating an
original-song job still composes a fresh song.
