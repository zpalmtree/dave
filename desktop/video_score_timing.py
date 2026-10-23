"""Offline, opt-in music envelope experiment. Does not change worker defaults.

The score keeps its original timeline, normalization, fades and ducking. Only its
linear gain envelope changes. Speech/effects and video are read from the same dry
source as the continuous-score control. No music looping or generation.
"""
from __future__ import annotations
import math
from pathlib import Path
import numpy as np
from video_sound_mix import media

RATE = 48000


def gain_envelope(points, seconds, rate=RATE):
    if not math.isfinite(seconds) or not 0 < seconds <= 600:
        raise ValueError('Invalid duration')
    if len(points) < 2 or any(len(p) != 2 for p in points):
        raise ValueError('At least two [seconds, linear gain] points are required')
    times, gains = np.asarray(points, dtype=float).T
    if not np.isfinite(times).all() or not np.isfinite(gains).all():
        raise ValueError('Envelope must be finite')
    if times[0] != 0 or times[-1] != seconds or np.any(np.diff(times) <= 0):
        raise ValueError('Envelope must span the full duration with increasing times')
    if np.any(gains < 0) or np.any(gains > 1):
        raise ValueError('Experiment permits attenuation only (gain 0 to 1)')
    return np.interp(np.arange(round(seconds * rate)) / rate, times, gains).astype(np.float32)


def timed_bed(score: Path, output: Path, seconds: float, points):
    envelope = gain_envelope(points, seconds)
    pcm = media(['-i', str(score), '-t', '120', '-vn', '-af', 'loudnorm=I=-30:TP=-3:LRA=7',
                 '-ar', str(RATE), '-ac', '2', '-f', 'f32le', 'pipe:1']).stdout
    audio = np.frombuffer(pcm, dtype='<f4').reshape(-1, 2).copy()
    frames = len(envelope)
    if len(audio) < frames or not np.isfinite(audio).all():
        raise ValueError('Score is too short or invalid; looping is forbidden')
    audio = audio[:frames]
    fade = min(round(.6 * RATE), frames // 2)
    audio[:fade] *= np.linspace(0, 1, fade, dtype=np.float32)[:, None]
    audio[-fade:] *= np.linspace(1, 0, fade, dtype=np.float32)[:, None]
    audio *= envelope[:, None]
    raw = output.with_suffix('.f32')
    try:
        raw.write_bytes(audio.astype('<f4').tobytes())
        media(['-f', 'f32le', '-ar', str(RATE), '-ac', '2', '-i', str(raw), '-c:a', 'pcm_f32le', str(output)])
    finally:
        raw.unlink(missing_ok=True)
    return {'zero_gain_fraction': float(np.mean(envelope == 0)),
            'maximum_gain': float(envelope.max()), 'seconds': seconds,
            'looped': False, 'score_timeline_changed': False}


def render(source: Path, score: Path, output: Path, seconds: float, points):
    if output.resolve() in {source.resolve(), score.resolve()}:
        raise ValueError('Output must not overwrite an input')
    bed = output.with_suffix('.bed.wav')
    temporary = output.with_name(output.stem + '.partial.mp4')
    try:
        audit = timed_bed(score, bed, seconds, points)
        # Deliberately identical to the preserve-effects production mix graph.
        graph = ('[0:a]aformat=sample_rates=48000:channel_layouts=stereo,apad=pad_dur=0.5,anull[dry];'
                 '[dry]asplit=2[original][key];[1:a]apad=pad_dur=0.5[bed];'
                 '[bed][key]sidechaincompress=threshold=0.04:ratio=6:attack=20:release=350:makeup=1[ducked];'
                 '[original][ducked]amix=inputs=2:duration=first:normalize=0[mixed];'
                 f'[mixed]alimiter=limit=0.95:level=false:latency=true,atrim=duration={seconds:.6f},asetpts=PTS-STARTPTS[out]')
        media(['-i', str(source), '-i', str(bed), '-filter_complex', graph,
               '-map', '0:v:0', '-map', '[out]', '-map_metadata', '0', '-c:v', 'copy',
               '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart+use_metadata_tags', str(temporary)])
        temporary.replace(output)
        return audit
    finally:
        temporary.unlink(missing_ok=True)
        bed.unlink(missing_ok=True)
