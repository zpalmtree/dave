"""Download a linked YouTube video as a bounded MP4 edit source. CPU/network only; no GPU imports."""
from __future__ import annotations

import argparse
import os
import shutil
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from video_named_song import youtube_url  # noqa: E402

MAX_BYTES = 100 * 1024 * 1024


def fetch_source_video(url: str, output: Path, ffmpeg: str):
    url = youtube_url(url)
    bundled = Path(__file__).with_name('yt-dlp.exe')
    executable = os.environ.get('VIDEO_YTDLP') or (str(bundled) if os.name == 'nt' and bundled.exists() else shutil.which('yt-dlp'))
    if not executable:
        raise RuntimeError('yt-dlp is not installed on the video computer.')
    output.parent.mkdir(parents=True, exist_ok=True)
    output.unlink(missing_ok=True)
    # The broker cuts long sources itself, so the limits here match what it accepts.
    result = subprocess.run([
        executable, '--ignore-config', '--no-plugin-dirs', '--no-playlist', '--no-cache-dir', '--js-runtimes', 'node',
        '--socket-timeout', '20', '--retries', '1', '--extractor-retries', '1', '--no-warnings', '--no-progress',
        '--max-filesize', '100M', '--match-filter', 'duration <= 600 & !is_live',
        '-S', 'res:1080,vcodec:h264,acodec:m4a', '--merge-output-format', 'mp4', '--remux-video', 'mp4',
        '--ffmpeg-location', ffmpeg, '--output', str(output.with_suffix('.%(ext)s')), '--', url,
    ], capture_output=True, text=True, encoding='utf-8', timeout=180,
        creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
    if result.returncode:
        raise RuntimeError((result.stderr.strip() or 'Video retrieval failed.')[-300:])
    if not output.exists():
        raise ValueError('Use a video no longer than 10 minutes that is not a live stream.')
    if not 1024 <= output.stat().st_size <= MAX_BYTES:
        raise ValueError('The downloaded video is empty or larger than 100 MiB.')
    return output


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--url', required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--ffmpeg', required=True)
    args = parser.parse_args()
    try:
        fetch_source_video(args.url, args.output, args.ffmpeg)
    except Exception as error:
        print(str(error)[-300:], file=sys.stderr, flush=True)
        raise SystemExit(1)
