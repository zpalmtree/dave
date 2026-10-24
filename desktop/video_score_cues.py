"""Explicit, offline music edits against a finished video.

A cue states both destination time and source passage. Outside cues the music is
exactly silent. No loops, time stretch, or automatic production default changes.
Energy-ranked passages are audition candidates, not semantic musical highlights.
"""
from __future__ import annotations
import math
from pathlib import Path
import numpy as np
from video_sound_mix import media

RATE = 48000


def decode_score(path, normalized=True):
    args = ['-i', str(path), '-t', '120', '-vn']
    if normalized:
        args += ['-af', 'loudnorm=I=-30:TP=-3:LRA=7']
    data = media([*args, '-ar', str(RATE), '-ac', '2', '-f', 'f32le', 'pipe:1']).stdout
    audio = np.frombuffer(data, dtype='<f4').reshape(-1, 2).copy()
    if len(audio) < RATE or not np.isfinite(audio).all():
        raise ValueError('Score must contain at least one second of finite audio')
    return audio


def passage_candidates(audio, seconds, count=5):
    """Rank sustained windows, not individual transient peaks. Audition required."""
    if not math.isfinite(seconds) or seconds <= 0 or seconds > len(audio) / RATE:
        raise ValueError('Passage must fit inside the source')
    size = round(seconds * RATE)
    # 100 ms blocks bound memory while retaining useful temporal resolution.
    hop = RATE // 10
    blocks = np.array([np.mean(np.square(audio[i:i+hop], dtype=np.float64))
                       for i in range(0, len(audio), hop)])
    width = max(1, math.ceil(size / hop))
    energies = np.convolve(blocks, np.ones(width)/width, mode='valid')
    ordered = np.argsort(-energies, kind='stable')
    result = []
    for index in ordered:
        start = int(index) * hop / RATE
        if start + seconds > len(audio) / RATE + 1e-9:
            continue
        if any(abs(start - row['source_start']) < max(1, seconds / 2) for row in result):
            continue
        result.append({'source_start': start, 'seconds': seconds,
                       'mean_energy': float(energies[index]), 'method': 'sustained-energy candidate; requires scene review'})
        if len(result) >= count:
            break
    return result


def validate_cues(cues, seconds, source_seconds):
    if not math.isfinite(seconds) or not 0 < seconds <= 600:
        raise ValueError('Invalid output duration')
    if not isinstance(cues, list) or len(cues) > 32:
        raise ValueError('Cues must be a list of at most 32 items')
    previous_end = 0
    for cue in cues:
        keys = ('start', 'end', 'source_start', 'gain_db', 'fade_in', 'fade_out')
        if not isinstance(cue, dict) or any(type(cue.get(k)) not in (int, float) or not math.isfinite(cue[k]) for k in keys):
            raise ValueError('Cue times, gain and fades must be finite numbers')
        start, end = cue['start'], cue['end']
        length = end - start
        if start < previous_end or start < 0 or end > seconds or length < .1:
            raise ValueError('Cues must be ordered, non-overlapping and inside the finished video')
        if cue['source_start'] < 0 or cue['source_start'] + length > source_seconds + 1e-6:
            raise ValueError('Cue exceeds available score; looping is forbidden')
        if not -60 <= cue['gain_db'] <= 0:
            raise ValueError('Cue gain must attenuate the normalized score')
        if min(cue['fade_in'], cue['fade_out']) < 0 or cue['fade_in'] + cue['fade_out'] > length:
            raise ValueError('Cue fades must fit inside its duration')
        if not isinstance(cue.get('reason'), str) or not cue['reason'].strip():
            raise ValueError('Each cue needs a scene-specific reason')
        previous_end = end


def assemble_cues(audio, seconds, cues):
    validate_cues(cues, seconds, len(audio)/RATE)
    result = np.zeros((round(seconds * RATE), 2), dtype=np.float32)
    for cue in cues:
        start, end = round(cue['start'] * RATE), round(cue['end'] * RATE)
        source = round(cue['source_start'] * RATE)
        piece = audio[source:source + end - start].copy()
        if len(piece) != end - start:
            raise ValueError('Rounded cue exceeds available source')
        piece *= 10 ** (cue['gain_db'] / 20)
        for key, reverse in [('fade_in', False), ('fade_out', True)]:
            count = round(cue[key] * RATE)
            if count:
                curve = np.linspace(0, 1, count, dtype=np.float32)
                if reverse:
                    piece[-count:] *= curve[::-1, None]
                else:
                    piece[:count] *= curve[:, None]
        result[start:end] = piece
    return result


def render(source: Path, score: Path | None, output: Path, seconds: float, cues):
    """Preserve original dry track and video; apply ducking only to edited music."""
    if output.resolve() == source.resolve() or (score and output.resolve() == score.resolve()):
        raise ValueError('Output must not overwrite an input')
    validate_cues(cues, seconds, math.inf if cues else 0)
    if not cues:
        # Whole-video silence means no added music, not silencing dialogue/ambience.
        return source, {'music': 'none', 'cues': [], 'looped': False}
    if not score:
        raise ValueError('Nonempty cues require a score')
    audio = decode_score(score)
    result = assemble_cues(audio, seconds, cues)
    bed = output.with_suffix('.cue-bed.wav')
    raw = output.with_suffix('.cue-bed.f32')
    temporary = output.with_name(output.stem + '.partial.mp4')
    try:
        raw.write_bytes(result.astype('<f4').tobytes())
        media(['-f', 'f32le', '-ar', str(RATE), '-ac', '2', '-i', str(raw), '-c:a', 'pcm_f32le', str(bed)])
        graph = ('[0:a]aformat=sample_rates=48000:channel_layouts=stereo,apad=pad_dur=0.5,anull[dry];'
                 '[dry]asplit=2[original][key];[1:a]apad=pad_dur=0.5[bed];'
                 '[bed][key]sidechaincompress=threshold=0.04:ratio=6:attack=20:release=350:makeup=1[ducked];'
                 '[original][ducked]amix=inputs=2:duration=first:normalize=0[mixed];'
                 f'[mixed]alimiter=limit=0.95:level=false:latency=true,atrim=duration={seconds:.6f},asetpts=PTS-STARTPTS[out]')
        media(['-i', str(source), '-i', str(bed), '-filter_complex', graph,
               '-map', '0:v:0', '-map', '[out]', '-map_metadata', '0', '-c:v', 'copy',
               '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart+use_metadata_tags', str(temporary)])
        temporary.replace(output)
        return output, {'music': 'edited', 'cues': cues, 'looped': False,
                        'source_seconds': len(audio)/RATE,
                        'unscored_seconds': seconds - sum(c['end']-c['start'] for c in cues)}
    finally:
        raw.unlink(missing_ok=True)
        bed.unlink(missing_ok=True)
        temporary.unlink(missing_ok=True)
