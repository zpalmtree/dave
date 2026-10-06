"""Fetch a named recording as bounded MP3 audio. CPU/network only; no GPU imports."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import unicodedata
from pathlib import Path
from urllib.parse import parse_qs, urlparse


def youtube_url(value: str) -> str:
    url = urlparse(value)
    video_id = url.path[1:] if url.hostname == 'youtu.be' else (
        parse_qs(url.query).get('v', [''])[0]
        if url.hostname in ('youtube.com', 'www.youtube.com', 'music.youtube.com') and url.path == '/watch' else '')
    if url.scheme != 'https' or url.username or url.password or url.port or not re.fullmatch(r'[\w-]{11}', video_id):
        raise ValueError('Use a YouTube song link.')
    return f'https://www.youtube.com/watch?v={video_id}'


def words(value):
    return set(re.findall(r'[^\W_]+', unicodedata.normalize('NFKC', str(value)).casefold()))


def recording_cache_key(spec):
    identity = {key: str(spec.get(key) or '').strip().casefold() if key != 'url' else str(spec.get(key) or '')
                for key in ('title', 'artist', 'url')}
    return hashlib.sha256(json.dumps(identity, sort_keys=True).encode()).hexdigest()


def cache_recording(spec, output, source, directory):
    directory.mkdir(parents=True, exist_ok=True)
    key = recording_cache_key(spec)
    audio = directory / (key + '.mp3')
    temporary = audio.with_suffix('.part')
    shutil.copyfile(output, temporary)
    temporary.replace(audio)
    metadata = {**source, 'audio_sha256': hashlib.sha256(audio.read_bytes()).hexdigest()}
    (directory / (key + '.json')).write_text(json.dumps(metadata), encoding='utf-8')
    # Keep at most 32 recordings; this is a reuse cache rather than a music library.
    for old in sorted(directory.glob('*.mp3'), key=lambda p: p.stat().st_mtime, reverse=True)[32:]:
        old.unlink(missing_ok=True)
        old.with_suffix('.json').unlink(missing_ok=True)


def cached_recording(spec, output, directory):
    audio = directory / (recording_cache_key(spec) + '.mp3')
    try:
        metadata = json.loads(audio.with_suffix('.json').read_text(encoding='utf-8'))
        if not 1024 <= audio.stat().st_size <= 12 * 1024 * 1024:
            return None
        if hashlib.sha256(audio.read_bytes()).hexdigest() != metadata.pop('audio_sha256'):
            return None
        youtube_url(metadata['url'])
        if not 8 <= float(metadata['duration']) <= 600:
            return None
        output.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(audio, output)
        output.with_suffix('.json').write_text(json.dumps(metadata), encoding='utf-8')
        os.utime(audio, None)
        return metadata
    except (OSError, ValueError, KeyError, TypeError):
        return None


def choose_recording(entries, title, artist):
    title_words, artist_words = words(title), words(artist)
    if not title_words or not artist_words:
        raise ValueError('Specify the song and artist, or provide its YouTube link.')
    alternatives = {'cover', 'remix', 'live', 'karaoke', 'instrumental', 'slowed', 'sped', 'nightcore', 'reaction'}
    matches = []
    for entry in entries:
        if not isinstance(entry, dict) or not re.fullmatch(r'[\w-]{11}', str(entry.get('id', ''))):
            continue
        name = words(entry.get('title', ''))
        channel = words(entry.get('channel') or entry.get('uploader') or '')
        duration = entry.get('duration')
        if entry.get('is_live') or not isinstance(duration, (float, int)) or not 8 <= duration <= 600:
            continue
        if not title_words <= name or not artist_words <= name | channel:
            continue
        if (name & alternatives) - title_words:
            continue
        # Prefer the artist's channel and official audio over unrelated uploads.
        official = bool(entry.get('channel_is_verified')) or artist_words <= channel or 'official' in name
        if not official:
            continue
        score = 4 * (artist_words <= channel) + 2 * bool(entry.get('channel_is_verified')) + ('audio' in name)
        matches.append((score, entry))
    if not matches:
        raise ValueError('Could not confidently match the original song. Attach it or provide a direct YouTube link.')
    return max(matches, key=lambda item: item[0])[1]


def fetch_recording(spec, output: Path, ffmpeg: str):
    cache = Path(__file__).with_name('worker_song_cache')
    stored = cached_recording(spec, output, cache)
    if stored:
        print(f"Using verified cached recording: {stored['title']}", flush=True)
        return stored
    bundled = Path(__file__).with_name('yt-dlp.exe')
    executable = os.environ.get('VIDEO_YTDLP') or (str(bundled) if os.name == 'nt' and bundled.exists() else shutil.which('yt-dlp'))
    if not executable:
        raise RuntimeError('yt-dlp is not installed on the video computer.')
    common = [executable, '--ignore-config', '--no-plugin-dirs', '--no-playlist', '--no-cache-dir',
              '--js-runtimes', 'node', '--socket-timeout', '20', '--retries', '1', '--extractor-retries', '1', '--no-warnings']

    def run(args, timeout=90):
        result = subprocess.run(common + args, capture_output=True, text=True, encoding='utf-8',
                                timeout=timeout, creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
        if result.returncode:
            # Do not retry a blocked or unavailable recording as a different song.
            raise RuntimeError((result.stderr.strip() or 'Song retrieval failed.')[-700:])
        return result.stdout

    explicit = spec.get('url')
    if explicit:
        url = youtube_url(str(explicit))
    else:
        query = f"{spec['artist']} {spec['title']} official audio"
        search = json.loads(run(['--flat-playlist', '--dump-single-json', '--', 'ytsearch5:' + query]))
        selected = choose_recording(search.get('entries') or [], spec['title'], spec['artist'])
        url = youtube_url('https://www.youtube.com/watch?v=' + selected['id'])
    metadata = json.loads(run(['--skip-download', '--dump-single-json', '--', url]))
    duration = float(metadata.get('duration') or 0)
    if metadata.get('is_live') or not 8 <= duration <= 600:
        raise ValueError('Use a recording between 8 seconds and 10 minutes long.')
    if not explicit:
        choose_recording([metadata], spec['title'], spec['artist'])
    output.parent.mkdir(parents=True, exist_ok=True)
    output.unlink(missing_ok=True)
    run(['--no-progress', '--max-filesize', '100M', '--match-filter', 'duration <= 600 & !is_live',
         '-f', 'bestaudio[ext=m4a]/bestaudio', '--extract-audio', '--audio-format', 'mp3', '--audio-quality', '128K',
         '--ffmpeg-location', ffmpeg, '--output', str(output.with_suffix('.%(ext)s')), '--', url], timeout=180)
    if not output.exists() or not 1024 <= output.stat().st_size <= 12 * 1024 * 1024:
        raise ValueError('The downloaded song is empty or too large.')
    source = {key: metadata.get(key) for key in ('id', 'title', 'channel', 'duration')}
    source['url'] = url
    output.with_suffix('.json').write_text(json.dumps(source), encoding='utf-8')
    cache_recording(spec, output, source, cache)
    print(f"Retrieved {source['title']} from {source['channel']} ({duration:.1f}s).", flush=True)
    return source


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--spec', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--ffmpeg', required=True)
    args = parser.parse_args()
    try:
        fetch_recording(json.loads(args.spec.read_text(encoding='utf-8')), args.output, args.ffmpeg)
    except Exception as error:
        print(str(error)[-700:], file=sys.stderr, flush=True)
        raise SystemExit(1)
