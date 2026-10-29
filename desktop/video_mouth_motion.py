"""Small CPU-only mouth-opening corrections from a silent source performance.

Retains the generated mouth texture and frame timeline. No audio synthesis, face
replacement, or model download. A candidate must improve a fresh landmark pass.
"""
from __future__ import annotations
import argparse
import json
import os
from pathlib import Path
import subprocess
import threading
import time

os.environ.setdefault('CUDA_VISIBLE_DEVICES', '')
os.environ.setdefault('OMP_NUM_THREADS', '4')

import cv2
import numpy as np
from scipy.interpolate import RBFInterpolator
from scipy.ndimage import gaussian_filter1d

MAX_FRAMES = 240
MAX_PIXELS = 896 * 512


def mouth_shape(points):
    points = np.asarray(points, dtype=np.float64)
    if points.shape != (106, 2) or not np.isfinite(points).all():
        raise ValueError('Invalid face landmarks')
    tangent = points[61] - points[52]
    width = float(np.linalg.norm(tangent))
    if width < 16:
        raise ValueError('Mouth too small to correct reliably')
    tangent /= width
    normal = np.array([-tangent[1], tangent[0]])
    if normal[1] < .5:
        raise ValueError('Face angle is too steep')
    center = (points[62] + points[60]) / 2
    gap = max(0., float((points[60] - points[62]) @ normal))
    return tangent, normal, center, width, gap


def aperture(points):
    *_, width, gap = mouth_shape(points)
    return gap / width


def correction_deltas(source, edited, segments):
    if len(source) != len(edited):
        raise ValueError('Source and replacement frame counts differ')
    deltas = []
    for src, dst in zip(source, edited):
        *_, width, gap = mouth_shape(dst)
        deltas.append(float(np.clip(aperture(src) * width - gap, -width * .16, width * .16)))
    output = np.asarray(deltas)
    # Never smooth through a cut. Every real source frame must belong to one segment.
    covered = np.zeros(len(output), dtype=np.uint8)
    for start, count, *_ in segments:
        if start < 0 or count <= 0 or start + count > len(output):
            raise ValueError('Invalid source segment bounds')
        output[start:start + count] = gaussian_filter1d(output[start:start + count], .6)
        covered[start:start + count] += 1
    if not np.all(covered == 1):
        raise ValueError('Incomplete or overlapping source segments')
    return output


def warp_mouth(frame, points, delta, selected):
    """Move each lip by at most a few pixels; eyes, captions and background stay fixed."""
    if abs(delta) < .1:
        return frame.copy()
    tangent, normal, center, width, _ = mouth_shape(points)
    mouth = np.asarray(points)[52:72].copy()
    local = mouth - center
    horizontal, vertical = local @ tangent, local @ normal
    weights = np.clip(1 - (2 * horizontal / width) ** 2, 0, 1)
    desired = mouth + normal[None, :] * (
        np.where(vertical >= 0, 1., -1.) * delta / 2 * weights)[:, None]
    left, top = np.floor(mouth.min(0) - width * .4).astype(int)
    right, bottom = np.ceil(mouth.max(0) + width * .4).astype(int)
    left, top = max(0, left), max(0, top)
    right, bottom = min(frame.shape[1], right), min(frame.shape[0], bottom)
    if right - left < 4 or bottom - top < 4:
        raise ValueError('Mouth region outside frame')
    ring = np.array([[x, y] for x in np.linspace(left, right - 1, 5) for y in [top, bottom - 1]]
                    + [[x, y] for x in [left, right - 1] for y in np.linspace(top + 1, bottom - 2, 3)])
    field = RBFInterpolator(np.concatenate([desired, ring]),
        np.concatenate([mouth - desired, np.zeros_like(ring)]), kernel='thin_plate_spline', smoothing=1)
    yy, xx = np.mgrid[top:bottom, left:right]
    offset = field(np.c_[xx.ravel(), yy.ravel()]).reshape(*xx.shape, 2)
    taper = np.sin(np.linspace(0, np.pi, xx.shape[1]))[None, :] \
        * np.sin(np.linspace(0, np.pi, xx.shape[0]))[:, None]
    offset *= taper[:, :, None]
    length = np.linalg.norm(offset, axis=2)
    offset *= np.minimum(1, 6 / np.maximum(length, 1e-6))[:, :, None]
    mapped = cv2.remap(frame, (xx + offset[:, :, 0]).astype(np.float32),
                       (yy + offset[:, :, 1]).astype(np.float32), cv2.INTER_CUBIC,
                       borderMode=cv2.BORDER_REFLECT)
    result = frame.copy()
    # The original subject mask is the final authority for which pixels may change.
    inside = selected[top:bottom, left:right]
    result[top:bottom, left:right][inside] = mapped[inside]
    return result


def faces_app():
    import onnxruntime as ort
    from insightface.app import FaceAnalysis
    root = Path(os.environ.get('LATENTSYNC_ROOT', '/mnt/d/AI/latentsync')) / 'checkpoints/auxiliary'
    for name in ('det_10g.onnx', '2d106det.onnx'):
        if not (root / 'models/buffalo_l' / name).is_file():
            raise RuntimeError('Local face landmark weights unavailable')
    options = ort.SessionOptions()
    options.intra_op_num_threads, options.inter_op_num_threads = 4, 1
    app = FaceAnalysis(name='buffalo_l', root=str(root), providers=['CPUExecutionProvider'],
                       allowed_modules=['detection', 'landmark_2d_106'], sess_options=options)
    app.prepare(ctx_id=-1, det_size=(512, 512))
    return app


def caption_regions(work, state):
    """Keep every recognized caption box fixed, even when it crosses a mouth."""
    regions = []
    for index, (start, count, *_) in enumerate(state['segments'], 1):
        report = json.loads((Path(work) / f'captions-{index:02d}.json').read_text(encoding='utf-8'))
        for layer in report['layers']:
            x, y, right, bottom = layer['box']
            analysis_width, analysis_height = layer['analysis_canvas']
            sx, sy = state['width'] / analysis_width, state['height'] / analysis_height
            regions.append((start, start + count, max(0, int(x * sx) - 2), max(0, int(y * sy) - 2),
                            min(state['width'], int(np.ceil(right * sx)) + 2),
                            min(state['height'], int(np.ceil(bottom * sy)) + 2)))
    return regions


def track_faces(app, video, mask, count):
    capture, masks = cv2.VideoCapture(str(video)), cv2.VideoCapture(str(mask))
    result = []
    try:
        for frame_index in range(count):
            ok, frame = capture.read()
            mask_ok, selected = masks.read()
            if not ok or not mask_ok or frame.shape != selected.shape:
                raise ValueError('Incomplete or mismatched video/mask')
            selected = selected.max(axis=2) > 127
            candidates = []
            for face in app.get(frame):
                x0, y0, x1, y1 = face.bbox
                cx, cy = int((x0 + x1) / 2), int((y0 + y1) / 2)
                if face.det_score < .6 or not (0 <= cy < len(selected) and 0 <= cx < selected.shape[1] and selected[cy, cx]):
                    continue
                points = face.landmark_2d_106
                pixels = np.rint(points[52:72]).astype(int)
                if all(0 <= y < len(selected) and 0 <= x < selected.shape[1] and selected[y, x] for x, y in pixels):
                    candidates.append(face)
            if len(candidates) != 1:
                raise ValueError(f'No unambiguous tracked mouth in frame {frame_index}')
            points = candidates[0].landmark_2d_106
            mouth_shape(points)
            result.append(points)
        if capture.read()[0]:
            raise ValueError('Video contains unexpected extra frames')
    finally:
        capture.release()
        masks.release()
    return result


def refine(source, video, mask, state, output):
    count = sum(segment[1] for segment in state['segments'])
    width, height = state['width'], state['height']
    if not 24 <= count <= MAX_FRAMES or width * height > MAX_PIXELS:
        return {'action': 'none', 'reason': 'clip_outside_analysis_budget'}
    capture = cv2.VideoCapture(str(video))
    fps = capture.get(cv2.CAP_PROP_FPS)
    capture.release()
    if abs(fps - 24) > .01:
        raise ValueError('Expected the normalized 24 fps timeline')
    app = faces_app()
    source_points = track_faces(app, source, mask, count)
    edited_points = track_faces(app, video, mask, count)
    expected = np.array([aperture(points) for points in source_points])
    before_error = float(np.mean(np.abs(expected - [aperture(points) for points in edited_points])))
    if before_error < .025 or np.ptp(expected) < .025:
        return {'action': 'none', 'reason': 'already_close_or_little_mouth_motion', 'before_error': before_error}
    deltas = correction_deltas(source_points, edited_points, state['segments'])
    protected = caption_regions(state['_work'], state)
    capture, masks = cv2.VideoCapture(str(video)), cv2.VideoCapture(str(mask))
    try:
        with subprocess.Popen(['ffmpeg', '-v', 'error', '-nostdin', '-y', '-f', 'rawvideo', '-pix_fmt', 'bgr24',
                '-s', f'{width}x{height}', '-r', '24', '-i', '-', '-i', str(video), '-map', '0:v:0', '-map', '1:a:0?',
                '-t', str(count / 24), '-c:v', 'libx264', '-crf', '18', '-pix_fmt', 'yuv420p', '-c:a', 'copy',
                '-movflags', '+faststart', str(output)], stdin=subprocess.PIPE) as process:
            try:
                for index, (points, delta) in enumerate(zip(edited_points, deltas)):
                    ok, frame = capture.read()
                    mask_ok, selected = masks.read()
                    if not ok or not mask_ok:
                        raise ValueError('Input ended while correcting mouth motion')
                    selected = selected.max(axis=2) > 127
                    for start, end, x, y, right, bottom in protected:
                        if start <= index < end:
                            selected[y:bottom, x:right] = False
                    process.stdin.write(warp_mouth(frame, points, delta, selected).tobytes())
                process.stdin.close()
                if process.wait(timeout=15):
                    raise RuntimeError('Mouth correction encoding failed')
            finally:
                if process.poll() is None:
                    process.kill()
    finally:
        capture.release()
        masks.release()
    after = track_faces(app, output, mask, count)
    after_error = float(np.mean(np.abs(expected - [aperture(points) for points in after])))
    accepted = after_error <= before_error * .8
    if not accepted:
        output.unlink(missing_ok=True)
    return {'action': 'mouth_motion' if accepted else 'none', 'reason': 'measured_improvement' if accepted else 'no_clear_gain',
            'frames': count, 'before_error': before_error, 'after_error': after_error}


def main():
    parser = argparse.ArgumentParser()
    for name in ('source', 'video', 'mask', 'state', 'output', 'result'):
        parser.add_argument('--' + name, type=Path, required=True)
    parser.add_argument('--exit-with-stdin', action='store_true')
    args = parser.parse_args()
    if args.exit_with_stdin:
        def watch_parent():
            while os.read(sys.stdin.fileno(), 1):
                pass
            os._exit(130)
        import sys
        threading.Thread(target=watch_parent, daemon=True).start()
    cv2.setNumThreads(1)
    started = time.monotonic()
    result = {'action': 'none'}
    args.output.unlink(missing_ok=True)
    try:
        state = json.loads(args.state.read_text(encoding='utf-8'))
        state['_work'] = str(args.state.parent)
        result = refine(args.source, args.video, args.mask, state, args.output)
    except Exception as error:
        args.output.unlink(missing_ok=True)
        result['reason'] = f'{type(error).__name__}: {error}'[:500]
    finally:
        result['seconds'] = round(time.monotonic() - started, 2)
        args.result.write_text(json.dumps(result, indent=2) + '\n', encoding='utf-8')
        print('Mouth motion: ' + json.dumps(result), flush=True)


if __name__ == '__main__':
    main()
