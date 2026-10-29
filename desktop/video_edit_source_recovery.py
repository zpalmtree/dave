"""Recover a lost source track within the same shot.

A camera swing can hide the target at the beginning of a segment. Tracking the
same frames backward gives SAM a second starting point without broadening the
text target, selecting a different subject group, or relaxing mask validation.
"""
import json
import math
import uuid
from pathlib import Path


def reverse_clip(source, destination, frames, output_frames=None):
    import video_edit as edit
    output_frames = frames if output_frames is None else output_frames
    if frames < 1 or output_frames < frames:
        raise ValueError('Invalid source tracking frame count.')
    # Trim BEFORE reversing: H3 padding is not evidence and must not become the
    # starting point. Only the restored, chronological mask gets model padding.
    filters = f'trim=end_frame={frames},setpts=PTS-STARTPTS,reverse'
    if output_frames > frames:
        filters += f',tpad=stop_mode=clone:stop_duration={math.ceil((output_frames-frames)/24)}'
    edit.command('ffmpeg', '-nostdin', '-v', 'error', '-y', '-i', str(source),
                 '-vf', filters, '-frames:v', str(output_frames), '-an',
                 '-c:v', 'libx264', '-crf', '0', '-pix_fmt', 'yuv420p', str(destination))


def stable_seed(coverages):
    """Use the middle of the longest sustained detection, never a one-frame hit."""
    runs, start = [], None
    for index, value in enumerate([*coverages, 0]):
        visible = 0.003 <= value <= 0.85
        if visible and start is None:
            start = index
        if not visible and start is not None:
            runs.append((start, index))
            start = None
    if not runs:
        raise RuntimeError('Could not reliably isolate the target: no stable recovery seed.')
    start, end = max(runs, key=lambda run: run[1] - run[0])
    if end - start < min(12, len(coverages)):
        raise RuntimeError('Could not reliably isolate the target: no stable recovery seed.')
    return (start + end) // 2


def seeded_graph(clip, seed, prefix):
    import video_edit as edit
    graph = edit.segmentation_graph(clip, '', prefix)
    del graph['target']
    graph['track']['inputs'].pop('conditioning')
    graph['track']['inputs']['max_objects'] = 1
    graph['seed'] = edit.node('LoadImage', image=seed)
    graph['seed_mask'] = edit.node('ImageToMask', image=['seed', 0], channel='red')
    graph['track']['inputs']['initial_mask'] = ['seed_mask', 0]
    return graph


def track_from_seed(server, clip, mask, frames, model_frames, work, index):
    import video_edit as edit
    anchor = stable_seed(edit.mask_frame_coverages(mask)[:frames])
    name = 'edit-source-seed-' + uuid.uuid4().hex
    seed = edit.INPUT / (name + '.png')
    inputs = [seed]
    result = Path(work) / f'source-seeded-{index:02d}.mp4'
    try:
        edit.extract_frame(mask, anchor, seed)
        parts = []
        for direction, start, end, reverse in [('before', 0, anchor+1, True),
                                                ('after', anchor, frames, False)]:
            source = edit.INPUT / f'{name}-{direction}.mp4'
            inputs.append(source)
            edit.command('ffmpeg', '-nostdin', '-v', 'error', '-y', '-i', str(clip), '-vf',
                f'trim=start_frame={start}:end_frame={end},setpts=PTS-STARTPTS' + (',reverse' if reverse else ''),
                '-an', '-c:v', 'libx264', '-crf', '0', str(source))
            graph = seeded_graph(source.name, seed.name, f'video/edits/{name}-{direction}')
            (Path(work)/f'source-seeded-{index:02d}-{direction}.json').write_text(json.dumps(graph, indent=2), encoding='utf-8')
            rendered = edit.run_graph(server, graph, 'save_mask', 1800)
            if len(edit.mask_frame_coverages(rendered)) != end-start:
                raise RuntimeError('Seeded source mask does not cover its timeline.')
            parts.append(rendered)
        # The anchor belongs to both passes; include it exactly once. Padding
        # follows the final source frame and never contributes to validation.
        graph = ('[0:v]reverse,setpts=PTS-STARTPTS[a];'
                 '[1:v]trim=start_frame=1,setpts=PTS-STARTPTS[b];'
                 '[a][b]concat=n=2:v=1:a=0,'
                 f'tpad=stop_mode=clone:stop_duration={max(1, math.ceil((model_frames-frames)/24))}[v]')
        edit.command('ffmpeg', '-nostdin', '-v', 'error', '-y', '-i', str(parts[0]), '-i', str(parts[1]),
            '-filter_complex', graph, '-map', '[v]', '-frames:v', str(model_frames),
            '-an', '-c:v', 'libx264', '-crf', '0', '-pix_fmt', 'yuv420p', str(result))
        return result, anchor
    finally:
        for path in inputs:
            path.unlink(missing_ok=True)


def recover_source_track(server, clip, original, target, subjects, frames, model_frames, work, index):
    import video_edit as edit
    try:
        edit.validate_tracking_mask(original, target, frames)
        return original
    except RuntimeError as error:
        # Decode errors and incomplete evidence are not a lost track.
        if not str(error).startswith('Could not reliably isolate'):
            raise
        reason = str(error)
    name = 'edit-source-recovery-' + uuid.uuid4().hex
    reversed_clip = edit.INPUT / (name + '.mp4')
    recovered = Path(work) / f'source-recovered-{index:02d}.mp4'
    audit = Path(work) / f'source-recovery-{index:02d}.json'
    record = {'method': 'reverse_tracking', 'target': target, 'subjects': subjects,
              'source_frames': frames, 'reason': reason, 'status': 'running'}
    try:
        print(f'Source track lost in segment {index}; retrying the same target backward', flush=True)
        reverse_clip(clip, reversed_clip, frames)
        result = edit.track_subject(server, reversed_clip.name, target,
                                    'video/edits/' + name, subjects, frames)
        reverse_clip(result, recovered, frames, model_frames)
        try:
            coverage = edit.validate_tracking_mask(recovered, target, frames)
        except RuntimeError as error:
            if subjects != 'primary' or not str(error).startswith('Could not reliably isolate'):
                raise
            print('Source track fragmented; tracking one stable target mask in both directions', flush=True)
            recovered, anchor = track_from_seed(server, clip, recovered, frames, model_frames, work, index)
            record.update(method='seeded_bidirectional_tracking', seed_frame=anchor)
            coverage = edit.validate_tracking_mask(recovered, target, frames)
        record.update(status='tracked', coverage=coverage)
        return recovered
    except Exception as error:
        record.update(status='failed', error=str(error)[:1000])
        raise
    finally:
        reversed_clip.unlink(missing_ok=True)
        audit.write_text(json.dumps(record, indent=2), encoding='utf-8')
