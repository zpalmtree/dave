"""A continuous, ducked instrumental bed; original dialogue/effects stay in the mix.

CPU mixing only. The recovery worker separately admits optional Music3 generation
through GPUq. Source-song and source-video edits bypass this module.
"""
from __future__ import annotations
import asyncio
import hashlib
import json
import math
import os
from pathlib import Path
import shutil
import subprocess


def enabled():
    return os.environ.get('VIDEO_SOUND_MIX', '1').lower() not in {'0', 'false', 'no', 'off'}


def directive(plan, source_audio=False):
    value = plan.get('sound_mix') or {}
    if source_audio or not enabled():
        return {'music': 'none', 'effects': 'preserve', 'caption': ''}
    music = value.get('music', 'none')
    effects = value.get('effects', 'preserve')
    caption = str(value.get('caption', '')).strip()[:2000]
    if music not in {'none', 'instrumental'} or effects not in {'preserve', 'soften_transients'}:
        raise ValueError('Invalid sound mix policy')
    if music == 'instrumental' and len(caption) < 20:
        raise ValueError('Missing instrumental description')
    if any(shot.get('dialogue') for segment in plan.get('segments', []) for shot in segment.get('shots', [])):
        effects = 'preserve'
    return {'music': music, 'effects': effects, 'caption': caption}


def media(command):
    ffmpeg = shutil.which('ffmpeg')
    if not ffmpeg:
        raise RuntimeError('FFmpeg is required for sound mixing')
    return subprocess.run([ffmpeg, '-nostdin', '-hide_banner', '-loglevel', 'error', '-y',
                           '-threads', '2', '-filter_complex_threads', '2', *command],
                          capture_output=True, check=True, timeout=180,
                          creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))


def continuous_bed(source: Path, output: Path, seconds: float):
    """Fit one normalized performance to the actual timeline with overlapping loops.

    Loop only if Music3 returned too little audio; never restart at scene cuts.
    Equal-power overlaps and whole-video fades avoid abrupt loop endpoints.
    """
    import numpy as np
    if not math.isfinite(seconds) or not 0 < seconds <= 600:
        raise ValueError('Invalid mix duration')
    rate = 48000
    pcm = media(['-i', str(source), '-t', '120', '-vn', '-af', 'loudnorm=I=-30:TP=-3:LRA=7',
                 '-ar', str(rate), '-ac', '2', '-f', 'f32le', 'pipe:1']).stdout
    audio = np.frombuffer(pcm, dtype='<f4').reshape(-1, 2).copy()
    if len(audio) < rate or not np.isfinite(audio).all():
        raise ValueError('Music bed is invalid or too short')
    frames = round(seconds * rate)
    overlap = min(round(.75 * rate), len(audio) // 4)
    result = audio.copy()
    curve = np.linspace(0, math.pi / 2, overlap, dtype=np.float32)[:, None]
    while len(result) < frames:
        seam = result[-overlap:] * np.cos(curve) + audio[:overlap] * np.sin(curve)
        result = np.concatenate((result[:-overlap], seam, audio[overlap:]))
    result = result[:frames].copy()
    fade = min(round(.6 * rate), frames // 2)
    result[:fade] *= np.linspace(0, 1, fade, dtype=np.float32)[:, None]
    result[-fade:] *= np.linspace(1, 0, fade, dtype=np.float32)[:, None]
    # Floating-point WAV keeps the measured bed level intact.
    raw = output.with_suffix('.f32')
    try:
        raw.write_bytes(result.astype('<f4').tobytes())
        media(['-f', 'f32le', '-ar', str(rate), '-ac', '2', '-i', str(raw), '-c:a', 'pcm_f32le', str(output)])
    finally:
        raw.unlink(missing_ok=True)


def mix_video(source: Path, output: Path, policy: dict, seconds: float, score: Path | None = None) -> Path:
    """Stream-copy video; preserve dry audio underneath a level-controlled score."""
    if not math.isfinite(seconds) or not 0 < seconds <= 600:
        raise ValueError('Invalid mix duration')
    soft = policy.get('effects') == 'soften_transients'
    if not score and not soft:
        return source
    # No makeup gain: quiet detail stays quiet. This acts on the complete mix,
    # so directive() excludes dialogue and externally supplied soundtracks.
    dry = ('acompressor=threshold=0.126:ratio=3:attack=3:release=120:makeup=1:knee=2.828:detection=peak'
           if soft else 'anull')
    bed = output.with_suffix('.bed.wav')
    temporary = output.with_name(output.stem + '.partial.mp4')
    inputs = ['-i', str(source)]
    graph = f'[0:a]aformat=sample_rates=48000:channel_layouts=stereo,apad=pad_dur=0.5,{dry}[dry];'
    try:
        if score:
            continuous_bed(score, bed, seconds)
            inputs += ['-i', str(bed)]
            graph += ('[dry]asplit=2[original][key];'
                      '[1:a]apad=pad_dur=0.5[bed];[bed][key]sidechaincompress=threshold=0.04:ratio=6:attack=20:release=350:makeup=1[ducked];'
                      '[original][ducked]amix=inputs=2:duration=first:normalize=0[mixed];')
        else:
            graph += '[dry]anull[mixed];'
        graph += f'[mixed]alimiter=limit=0.95:level=false:latency=true,atrim=duration={seconds:.6f},asetpts=PTS-STARTPTS[out]'
        media([*inputs, '-filter_complex', graph, '-map', '0:v:0', '-map', '[out]',
               '-map_metadata', '0', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k',
               '-movflags', '+faststart+use_metadata_tags', str(temporary)])
        temporary.replace(output)
        return output
    finally:
        temporary.unlink(missing_ok=True)
        bed.unlink(missing_ok=True)


async def prepare_score(worker, job, plan, root: Path, seconds: float):
    """One admitted composition per spec; reuse it on upload/recovery retries."""
    policy = directive(plan, bool(job.get('has_source_audio') or job.get('has_source_video')))
    if policy['music'] != 'instrumental':
        return policy, None
    from video_worker import SCRIPT_DIR, console_python_executable, stable_job_seed, atomic_json
    from video_recovery import run_local_step
    spec = {'caption': 'Instrumental background score, no singing or spoken words. ' + policy['caption'],
            'lyrics': '[Instrumental]', 'seconds': min(60, max(8, seconds + 2)),
            'seed': stable_job_seed(job['id']) % (2 ** 32)}
    key = hashlib.sha256(json.dumps(spec, sort_keys=True).encode()).hexdigest()[:16]
    score, receipt, spec_path = (root / f'background-{key}{suffix}' for suffix in ('.flac', '.json', '-spec.json'))
    if receipt.exists():
        saved = json.loads(receipt.read_text(encoding='utf-8'))
        if saved.get('failed'):
            return policy, None
        if score.is_file() and hashlib.sha256(score.read_bytes()).hexdigest() == saved.get('sha256'):
            return policy, score
    atomic_json(spec_path, spec)
    score.unlink(missing_ok=True)
    try:
        await worker.send({'type': 'event', 'event': 'progress', 'job_id': job['id'],
                           'progress': None, 'stage': 'Composing one continuous background score'})
        await run_local_step(worker, job, f'background-{key}',
            [console_python_executable(), '-s', str(SCRIPT_DIR / 'video_sound_mix.py'),
             '--spec', str(spec_path), '--output', str(score)], 'background score')
        if not score.is_file():
            raise RuntimeError('No background score was produced')
        atomic_json(receipt, {'sha256': hashlib.sha256(score.read_bytes()).hexdigest()})
        return policy, score
    except asyncio.CancelledError:
        raise
    except Exception as error:
        atomic_json(receipt, {'failed': str(error)[:500]})
        print(f'WARNING: Background music unavailable; preserving original audio: {error}', flush=True)
        return policy, None


def compose_main():
    """Run only inside the worker's GPUq reservation; own only a server we start."""
    import video_gen as generator
    import video_song
    process = log = None
    try:
        if not generator.server_ready(generator.DEFAULT_SERVER):
            process, log = generator.start_server(generator.DEFAULT_SERVER)
        return video_song.main()
    finally:
        if process is not None:
            generator.stop_server(process, log)


if __name__ == '__main__':
    raise SystemExit(compose_main())
