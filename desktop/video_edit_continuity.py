"""Source-aware exposure, dark-frame tracking and ordered motion-review evidence."""
import json
import subprocess
import tempfile
import uuid
from pathlib import Path

import numpy as np


def structure_matches(a, b, selected=None, minimum=.94):
    """Require visible texture correspondence, allowing one global exposure change."""
    a, b = np.asarray(a, np.float32), np.asarray(b, np.float32)
    if selected is not None:
        a, b = a[selected], b[selected]
    if a.size < 96 or min(a.mean(axis=-1).std(), b.mean(axis=-1).std()) < 0.75:
        return False
    a, b = a.ravel(), b.ravel()
    a, b = a - a.mean(), b - b.mean()
    correlation = float(a @ b / max(1e-8, np.linalg.norm(a) * np.linalg.norm(b)))
    return correlation >= minimum


def continuous_exposure(frames, index):
    """Veto a histogram cut only when local image evidence supports continuity."""
    before, after = frames[index - 1], frames[index]
    left, right = max(0, index - 3), min(len(frames) - 1, index + 2)
    if (structure_matches(before, after, minimum=.985)
            and structure_matches(frames[left], frames[right], minimum=.97)):
        return True
    # Textureless fades cannot supply feature correspondence. Require a gradual,
    # monotonic ramp; an abrupt solid-colour scene cut still starts a new shot.
    window = np.asarray(frames[left:right + 1], np.float32)
    if len(window) < 4 or max(frame.mean(axis=-1).std() for frame in window) > 1:
        return False
    differences = np.diff(window, axis=0)
    levels = window.mean(axis=(1, 2, 3))
    return bool(np.max(np.abs(differences)) < 16 and np.ptp(levels) >= 8
                and (np.all(np.diff(levels) >= -1) or np.all(np.diff(levels) <= 1)))


def dark_candidates(frames, masks):
    """Missing dark masks need corroboration from a nearby visible tracked subject."""
    if len(frames) != len(masks):
        raise RuntimeError('Dark tracking evidence has different timelines.')
    tracked = [index for index, mask in enumerate(masks) if np.mean(mask > 127) >= 0.003]
    fading = exposure_frames(frames)
    candidates = {}
    for index, (frame, mask) in enumerate(zip(frames, masks)):
        brightness = float(np.quantile(frame, .95))
        if np.any(mask > 127) or brightness < 2 or (brightness >= 64 and not fading[index]) or not tracked:
            continue
        anchor = min(tracked, key=lambda other: abs(other - index))
        if abs(anchor - index) > 12:
            continue
        selected = masks[anchor] > 127
        left, right = sorted((index, anchor))
        if all(structure_matches(frames[other], frames[other + 1])
               and structure_matches(frames[other], frames[other + 1], selected)
               for other in range(left, right)):
            candidates[index] = anchor
    return candidates


def brighten(frame):
    """Tracking-only exposure; completely black frames remain black."""
    level = float(np.quantile(frame, .95))
    gain = min(16., 128 / level) if 2 <= level < 128 else 1.
    return np.clip(frame.astype(np.float32) * gain, 0, 255).astype(np.uint8)


def exposure_frames(frames):
    """Mark sustained same-scene brightness ramps, including fade-in and fade-out."""
    levels = [float(np.quantile(frame, .95)) for frame in frames]
    result = np.zeros(len(frames), bool)
    start, direction = 0, 0
    def finish(end):
        values = levels[start:end]
        if len(values) >= 3 and max(values) - min(values) >= 24 and max(values) >= 1.5 * max(1, min(values)):
            result[start:end] = True
    for index in range(1, len(frames)):
        difference = levels[index] - levels[index - 1]
        sign = 1 if difference > 2 else -1 if difference < -2 else 0
        matches = structure_matches(frames[index - 1], frames[index])
        black_edge = min(levels[index - 1:index + 1]) < 2 and max(levels[index - 1:index + 1]) < 16
        if not (matches or black_edge) or (direction and sign and direction != sign):
            finish(index)
            start, direction = index, 0
        if sign:
            direction = sign
    finish(len(frames))
    return result


def encode_rgb_frames(source, destination, width, height, frames):
    from video_edit import decoded_frames
    with tempfile.TemporaryFile() as errors:
        process = subprocess.Popen(['ffmpeg', '-nostdin', '-v', 'error', '-y', '-f', 'rawvideo',
            '-pix_fmt', 'rgb24', '-video_size', f'{width}x{height}', '-framerate', '24', '-i', '-',
            '-an', '-c:v', 'libx264', '-crf', '0', '-pix_fmt', 'yuv420p', str(destination)],
            stdin=subprocess.PIPE, stderr=errors)
        count = 0
        try:
            for data in decoded_frames(source, 'rgb24', width * height * 3, frames):
                process.stdin.write(brighten(np.frombuffer(data, np.uint8).reshape(height, width, 3)).tobytes())
                count += 1
            process.stdin.close()
            code = process.wait()
            if code or count != frames:
                raise RuntimeError('Could not normalize dark tracking frames.')
        finally:
            if process.poll() is None:
                process.kill()
                process.wait()


def dark_point_masks(server, bright, original, anchors, width, height, frames, work, index):
    """One bounded retry on actual enhanced pixels; anchor masks only supply points."""
    import video_edit as edit
    from video_edit_alignment import source_point_graph
    selected = {}
    for frame, data in enumerate(edit.decoded_frames(original, 'gray', width * height, frames)):
        if frame in set(anchors.values()):
            selected[frame] = data
    if set(selected) != set(anchors.values()):
        raise RuntimeError('Dark recovery anchors are missing.')
    with tempfile.TemporaryDirectory(prefix='edit-dark-points-') as temporary:
        raw, seed = [Path(temporary) / name for name in ('seed.gray', 'seed.mkv')]
        blank = bytes(width * height)
        with raw.open('wb') as stream:
            for frame in range(frames):
                stream.write(selected[anchors[frame]] if frame in anchors else blank)
        edit.command('ffmpeg', '-nostdin', '-v', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', 'gray',
            '-video_size', f'{width}x{height}', '-framerate', '24', '-i', str(raw), '-an',
            '-c:v', 'ffv1', '-pix_fmt', 'gray', str(seed))
        graph = source_point_graph(bright.name, seed, [0, 0, width, height], width, height, frames,
                                   'video/edits/edit-dark-points-' + uuid.uuid4().hex)
        (Path(work) / f'dark-points-{index:02d}.json').write_text(json.dumps(graph, indent=2), encoding='utf-8')
        result = edit.run_graph(server, graph, 'save_mask', 1800)
    destination = Path(work) / f'dark-points-{index:02d}.mp4'
    destination.write_bytes(result.read_bytes())
    return destination


def recover_dark_source_track(server, clip, original, target, subjects, frames, model_frames, work, index):
    import video_edit as edit
    from video_edit_source_recovery import reverse_clip
    from video_edit_alignment import source_overlap
    # Small CPU evidence is enough to establish whether a missing mask is a fade
    # rather than an occlusion. Full-resolution masks are decoded only for repair.
    thumbnails = [np.frombuffer(b, np.uint8).reshape(96, 96, 3) for b in
                  edit.decoded_frames(clip, 'rgb24', 96 * 96 * 3, frames, 'scale=96:96:flags=area')]
    masks = [np.frombuffer(b, np.uint8).reshape(96, 96) for b in
             edit.decoded_frames(original, 'gray', 96 * 96, frames, 'scale=96:96:flags=neighbor')]
    if len(thumbnails) != frames or len(masks) != frames:
        raise RuntimeError('Dark tracking evidence is shorter than the source segment.')
    candidates = dark_candidates(thumbnails, masks)
    if not candidates:
        return original
    _, width, height = edit.clip_details(clip, validate_source=False)
    name = 'edit-dark-' + uuid.uuid4().hex
    bright, reverse = [edit.INPUT / (name + suffix) for suffix in ('.mp4', '-reverse.mp4')]
    candidate = Path(work) / f'dark-candidate-{index:02d}.mp4'
    destination = Path(work) / f'dark-recovered-{index:02d}.mp4'
    record = {'target': target, 'subjects': subjects, 'candidate_frames': list(candidates), 'status': 'running'}
    try:
        encode_rgb_frames(clip, bright, width, height, frames)
        reverse_clip(bright, reverse, frames)
        result = edit.track_subject(server, reverse.name, target, 'video/edits/' + name, subjects, frames)
        reverse_clip(result, candidate, frames, model_frames)
        recovered = [np.frombuffer(b, np.uint8).reshape(96, 96) for b in
                     edit.decoded_frames(candidate, 'gray', 96 * 96, frames, 'scale=96:96:flags=neighbor')]
        if len(recovered) != frames:
            raise RuntimeError('Dark recovery mask is shorter than the source segment.')
        accepted = set()
        for frame, anchor in candidates.items():
            # Retain both target placement and foreground shape, never a blanket
            # or a second subject returned by the enhanced tracking pass.
            a, b = source_overlap(masks[anchor], recovered[frame]), source_overlap(recovered[frame], masks[anchor])
            if a is not None and b is not None and min(a, b) >= .5:
                accepted.add(frame)
        point_frames = set(candidates) - accepted
        point_mask = None
        points = []
        if point_frames:
            point_mask = dark_point_masks(server, bright, original,
                {frame: candidates[frame] for frame in point_frames}, width, height, frames, work, index)
            points = [np.frombuffer(b, np.uint8).reshape(96, 96) for b in
                      edit.decoded_frames(point_mask, 'gray', 96 * 96, frames, 'scale=96:96:flags=neighbor')]
            if len(points) != frames:
                raise RuntimeError('Dark point recovery has incomplete evidence.')
            for frame in point_frames:
                anchor = candidates[frame]
                a, b = source_overlap(masks[anchor], points[frame]), source_overlap(points[frame], masks[anchor])
                if a is not None and b is not None and min(a, b) >= .5:
                    accepted.add(frame)
        # Severe 8-bit quantization can leave only the head detected in the first
        # dim frame. Bridge at most ONE adjacent frame, with independent partial
        # detection and matching subject texture. Never chain propagated masks.
        confirmed = {frame: (original, masks[frame]) for frame in range(frames) if np.any(masks[frame] > 127)}
        confirmed.update({frame: (point_mask, points[frame]) if frame in point_frames else (candidate, recovered[frame])
                          for frame in accepted})
        adjacent = {}
        for frame in set(candidates) - accepted:
            if not 2 <= float(np.quantile(thumbnails[frame], .95)) < 64:
                continue
            partial = recovered[frame]
            if np.mean(partial > 127) < .003:
                continue
            for anchor in (frame - 1, frame + 1):
                if anchor not in confirmed:
                    continue
                path, selected = confirmed[anchor]
                purity = source_overlap(partial, selected)
                if (purity is not None and purity >= .8
                        and structure_matches(thumbnails[frame], thumbnails[anchor])
                        and structure_matches(thumbnails[frame], thumbnails[anchor], selected > 127)):
                    adjacent[frame] = (anchor, path)
                    break
        accepted.update(adjacent)
        if accepted != set(candidates):
            raise RuntimeError('Could not recover the visible subject through the source fade.')
        anchor_pixels = {}
        for path in {path for _, path in adjacent.values()}:
            needed = {anchor for anchor, candidate_path in adjacent.values() if candidate_path == path}
            for frame, data in enumerate(edit.decoded_frames(path, 'gray', width * height, frames)):
                if frame in needed:
                    anchor_pixels[path, frame] = data
        with tempfile.TemporaryDirectory(prefix='edit-dark-mask-') as temporary:
            raw = Path(temporary) / 'mask.gray'
            count = 0
            point_stream = iter(edit.decoded_frames(point_mask, 'gray', width * height, frames)) if point_mask else None
            with raw.open('wb') as stream:
                from itertools import zip_longest
                for frame, (old, new) in enumerate(zip_longest(
                        edit.decoded_frames(original, 'gray', width * height, model_frames),
                        edit.decoded_frames(candidate, 'gray', width * height, model_frames))):
                    if old is None or new is None:
                        raise RuntimeError('Dark recovery masks have different timelines.')
                    point = next(point_stream, None) if point_stream and frame < frames else None
                    if frame in point_frames and frame not in adjacent and point is None:
                        raise RuntimeError('Dark point recovery ended before the repaired frame.')
                    if frame in adjacent:
                        anchor, path = adjacent[frame]
                        stream.write(anchor_pixels[path, anchor])
                    else:
                        stream.write(point if frame in point_frames else new if frame in accepted else old)
                    count += 1
            if count != model_frames:
                raise RuntimeError('Dark recovery masks are shorter than model padding.')
            edit.command('ffmpeg', '-nostdin', '-v', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', 'gray',
                '-video_size', f'{width}x{height}', '-framerate', '24', '-i', str(raw), '-an',
                '-c:v', 'libx264', '-crf', '0', '-pix_fmt', 'yuv420p', str(destination))
        edit.validate_tracking_mask(destination, target, frames)
        record.update(status='recovered', recovered_frames=sorted(accepted), point_frames=sorted(point_frames - set(adjacent)),
                      adjacent_frames={frame: anchor for frame, (anchor, _) in adjacent.items()})
        return destination
    except Exception as error:
        record.update(status='failed', error=str(error)[:500])
        raise
    finally:
        bright.unlink(missing_ok=True)
        reverse.unlink(missing_ok=True)
        (Path(work) / f'dark-recovery-{index:02d}.json').write_text(json.dumps(record, indent=2), encoding='utf-8')


def critical_frames(source, edited, masks, segments):
    """Neighboring evidence at joins, visibility changes and unexpected output jumps."""
    if not (len(source) == len(edited) == len(masks)):
        raise RuntimeError('Continuity evidence has different timelines.')
    important = set()
    for start, _, _ in segments[1:]:
        important.update(range(max(0, start - 2), min(len(source), start + 2)))
    for frame in range(1, len(source)):
        selected = (masks[frame] > 127) | (masks[frame - 1] > 127)
        changed_visibility = bool(np.any(masks[frame] > 127)) != bool(np.any(masks[frame - 1] > 127))
        if not selected.any():
            continue
        source_delta = float(np.abs(source[frame].astype(np.float32) - source[frame - 1])[selected].mean()) / 255
        edit_delta = float(np.abs(edited[frame].astype(np.float32) - edited[frame - 1])[selected].mean()) / 255
        jump = edit_delta > .06 and edit_delta > source_delta * 1.8 and edit_delta - source_delta > .04
        if changed_visibility or jump:
            important.update((frame - 1, frame))
    return important


def continuity_indices(work, output, state):
    from video_edit import decoded_frames
    total = sum(count for _, count, _ in state['segments'])
    frames = lambda path: [np.frombuffer(b, np.uint8).reshape(96, 96, 3) for b in
                          decoded_frames(path, 'rgb24', 96 * 96 * 3, total, 'scale=96:96:flags=area')]
    source, edited = frames(work / 'normalized.mp4'), frames(output)
    masks = []
    for index, (_, count, _) in enumerate(state['segments'], 1):
        part = [np.frombuffer(b, np.uint8).reshape(96, 96) for b in
                decoded_frames(work / f'mask-{index:02d}.mp4', 'gray', 96 * 96, count,
                               'scale=96:96:flags=neighbor')]
        if len(part) != count:
            raise RuntimeError('Continuity mask is shorter than its segment.')
        masks.extend(part)
    if len(source) != total or len(edited) != total:
        raise RuntimeError('Continuity video is shorter than the source timeline.')
    return critical_frames(source, edited, masks, state['segments'])
