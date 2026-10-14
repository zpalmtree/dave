"""Optional, time-bounded audio timing correction for generated video delivery."""
from __future__ import annotations

import asyncio
import json
import os
from pathlib import Path
import re
import signal
import shutil
import subprocess
import tempfile
import time

from video_sync_analyze import choose_shift, sample_starts

TOTAL_TIMEOUT = 45


def wsl_path(path):
    value = str(path)
    match = re.match(r'^([A-Za-z]):[\\/](.*)', value)
    if match:
        return '/mnt/' + match[1].lower() + '/' + match[2].replace('\\', '/')
    if value.startswith('/'):
        return value
    raise ValueError('Sync analysis needs a local drive path')


async def run_process(command, timeout, *, held_stdin=False):
    process = await asyncio.create_subprocess_exec(
        *command, stdin=asyncio.subprocess.PIPE if held_stdin else asyncio.subprocess.DEVNULL,
        stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.DEVNULL,
        **({'creationflags': subprocess.CREATE_NO_WINDOW} if os.name == 'nt' else {}))
    try:
        return await asyncio.wait_for(process.wait(), timeout)
    finally:
        if process.stdin:
            process.stdin.close()  # Ends WSL's private process group on cancellation.
            if process.returncode is None:
                try:
                    await asyncio.wait_for(process.wait(), 1)
                except asyncio.TimeoutError:
                    pass
        if process.returncode is None:
            if held_stdin and os.name != 'nt':
                try:
                    os.killpg(process.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
            process.kill()
            await process.wait()


def shift_command(ffmpeg, source, destination, shift_ms, seconds):
    if shift_ms not in (-80, -40, 40, 80):
        raise ValueError('Unsupported audio correction')
    # Negative SyncNet offset means lips lead: advance the audio, not the video.
    audio = (f'atrim=start={-shift_ms / 1000:.3f},asetpts=PTS-STARTPTS' if shift_ms < 0
             else f'adelay={shift_ms}:all=1')
    return [ffmpeg, '-nostdin', '-v', 'error', '-y', '-i', str(source),
            '-map', '0:v:0', '-map', '0:a:0', '-map_metadata', '0', '-c:v', 'copy',
            '-af', audio + ',apad', '-c:a', 'aac', '-b:a', '192k', '-t', str(seconds),
            '-movflags', '+faststart+use_metadata_tags', str(destination)]


async def correct_delivery_sync(ffmpeg, source, job_id, seconds, *, preserve_audio=False):
    source = Path(source)
    if (preserve_audio or os.environ.get('VIDEO_DELIVERY_SYNC', '1') == '0'
            or '.avsync-' in source.stem or not seconds or not sample_starts(seconds)):
        return source
    started = time.monotonic()
    destination = source.with_name(f'{source.stem}.avsync-{job_id[:8]}.mp4')
    report = source.with_name(f'{source.stem}.avsync-{job_id[:8]}.json')
    work = Path(tempfile.mkdtemp(prefix='dave-avsync-'))
    result = {'action': 'none', 'shift_ms': 0}
    kept = False
    try:
        script = Path(__file__).with_name('video_sync_analyze.py')
        python = os.environ.get('VIDEO_LIPSYNC_PYTHON', '/home/zp/.venvs/latentsync/bin/python')
        args = [python, wsl_path(script), '--video', wsl_path(source.resolve()),
                '--result', wsl_path(work / 'result.json'), '--seconds', str(seconds), '--exit-with-stdin']
        command = (['wsl.exe', '-d', os.environ.get('VIDEO_LIPSYNC_DISTRO', 'Ubuntu'), '--exec', *args]
                   if os.name == 'nt' else args)
        code = await run_process(command, 38, held_stdin=True)
        if code or not (work / 'result.json').is_file():
            result['reason'] = 'analysis_failed_or_timed_out'
            return source
        result = json.loads((work / 'result.json').read_text(encoding='utf-8'))
        shift = choose_shift([sample for sample in result.get('samples', []) if sample is not None])
        if not shift:
            result.update(action='none', shift_ms=0)
            return source
        remaining = TOTAL_TIMEOUT - (time.monotonic() - started)
        if remaining < 1:
            result.update(action='none', shift_ms=0, reason='deadline')
            return source
        code = await run_process(shift_command(ffmpeg, source, destination, shift, seconds), remaining)
        if code or not destination.is_file() or not destination.stat().st_size:
            raise RuntimeError('audio_shift_failed')
        result.update(action='shift', shift_ms=shift)
        kept = True
        return destination
    except Exception as error:
        result.update(action='none', shift_ms=0, reason=type(error).__name__)
        return source
    finally:
        if not kept:
            try:
                destination.unlink(missing_ok=True)
            except OSError:
                pass
        # Cleanup and reporting must not turn an optional check into a delivery failure.
        shutil.rmtree(work, ignore_errors=True)
        result['total_seconds'] = round(time.monotonic() - started, 3)
        try:
            report.write_text(json.dumps(result, indent=2), encoding='utf-8')
        except OSError:
            pass
        print(f'Delivery sync: {result.get("action", "none")}, {result.get("shift_ms", 0)} ms '
              f'({result["total_seconds"]:.1f}s)', flush=True)
