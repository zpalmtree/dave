"""Experimental local background-gap repair; never used by the default worker.

Run under GPUq. Requires the pinned local RVM and ProPainter installations in the
source-edit documentation. Inputs are a single, normalized 24-fps isolated segment.
"""
import argparse
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys

import numpy as np
from scipy.ndimage import binary_dilation


def repair_frame_count(duration):
    # Motion generation uses overlapping 124-frame windows, but a continuous
    # shot can span several windows. Keep matting state through that whole shot.
    frames = round(duration * 24)
    if frames < 1 or frames > 360:
        raise ValueError('Repair one normalized segment of 1–360 frames at a time.')
    return frames


def assemble_segments(segments, source, destination, work):
    """Join repaired shots with a continuous clock, including one-frame cuts."""
    from video_edit import command, audio_codec
    if not segments or destination.exists():
        raise ValueError('Assembly needs segments and a new output path.')
    listing = work / 'repair-segments.txt'
    listing.write_text(''.join("file '" + path.resolve().as_posix().replace("'", "'\\''")
                               + "'\n" for path in segments), encoding='utf-8')
    # Stream-copy joins can overlap DTS when a one-frame shot precedes a GOP
    # with B-frames. Rebuild timestamps from decoded frame order, not packet DTS.
    command('ffmpeg', '-nostdin', '-v', 'error', '-f', 'concat', '-safe', '0',
            '-i', str(listing), '-i', str(source), '-map', '0:v:0', '-map', '1:a:0?',
            '-vf', 'setpts=N/(24*TB)', '-r', '24', '-fps_mode', 'cfr',
            '-c:v', 'libx264', '-crf', '18', '-pix_fmt', 'yuv420p',
            '-colorspace', 'bt709', '-color_primaries', 'bt709',
            '-color_trc', 'iec61966-2-1', '-color_range', 'tv',
            '-c:a', 'copy' if audio_codec(source) == 'aac' else 'aac',
            '-b:a', '192k', '-movflags', '+faststart', str(destination))


def indexed_frames(path, indices, width, height):
    """Extract exact normalized frame indices; rounded seeks can cross a cut."""
    selected = sorted(set(indices))
    if not selected or any(not isinstance(index, int) or index < 0 for index in selected):
        raise ValueError('Review requires nonnegative frame indices.')
    expression = '+'.join(f'eq(n,{index})' for index in selected)
    result = subprocess.run(['ffmpeg', '-nostdin', '-v', 'error', '-i', str(path),
        '-vf', f"select='{expression}',scale={width}:{height}", '-fps_mode', 'passthrough',
        '-frames:v', str(len(selected)), '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'],
        capture_output=True, check=True)
    frame_bytes = width*height*3
    if len(result.stdout) != len(selected)*frame_bytes:
        raise ValueError('Review video does not cover every requested frame.')
    pixels = np.frombuffer(result.stdout, np.uint8).reshape(len(selected), height, width, 3)
    return {index: pixels[offset].copy() for offset, index in enumerate(selected)}


def repair_mask(source, replacement, alpha, box):
    """Protect confident foreground; repair only the tracked surrounding region."""
    if source.ndim != 2 or source.shape != replacement.shape or source.shape != alpha.shape:
        raise ValueError('Repair inputs must be equal-size grayscale masks.')
    if not np.isfinite(alpha).all() or np.any(alpha < 0) or np.any(alpha > 255):
        raise ValueError('Invalid foreground alpha.')
    h, w = source.shape
    x, y, right, bottom = box
    if not (0 <= x < right <= w and 0 <= y < bottom <= h):
        raise ValueError('Invalid generated crop.')
    support = np.zeros((h, w), bool); support[y:bottom, x:right] = True
    if np.any((replacement > 127) & ~support) or np.any((alpha > 0) & ~support):
        raise ValueError('Replacement evidence extends outside its crop.')
    subject = replacement > 127
    confident = alpha > 230
    # A nonempty matte alone is insufficient: it must retain most of the tracked
    # replacement. Fail the candidate instead of silently making the head vanish.
    if subject.sum() < 64 or np.count_nonzero(confident & subject) < .5 * subject.sum():
        raise ValueError('Foreground matting lost the tracked replacement.')
    radius = max(6, min(24, round(min(right-x, bottom-y) * .10)))
    region = binary_dilation(source > 127, iterations=radius) | binary_dilation(subject, iterations=3)
    # Retain a narrow antialiased edge only where the matte supports foreground.
    # An unconditional ring preserves background halo; the opaque core alone
    # cuts facial contours. Limit partial-alpha protection to two pixels from
    # the core so broad uncertain background patches cannot become foreground.
    protected = binary_dilation(confident, iterations=2) & (alpha > 128)
    repair = region & ~protected
    if repair.sum() > .35 * h * w:
        raise ValueError('Repair would affect too much of the frame.')
    return repair


def restore_protected(original, prediction, mask):
    if original.shape != prediction.shape or original.shape != (*mask.shape, 3):
        raise ValueError('Inpainted frame dimensions changed.')
    return np.where(mask[:, :, None], prediction, original)


def touches_frame_edge(mask):
    return any(np.any(edge) for edge in (mask[0], mask[-1], mask[:, 0], mask[:, -1]))


def boundary_context(work):
    """Reflect image AND repair support, moving model padding outside the canvas."""
    from PIL import Image
    masks = sorted((work / 'masks').glob('*.png'))
    if not any(touches_frame_edge(np.array(Image.open(path)) > 127) for path in masks):
        return None
    context = work / 'boundary-context'
    for name in ['frames', 'masks']:
        (context / name).mkdir(parents=True)
        for path in masks:
            pixels = np.array(Image.open(work / name / path.name))
            padding = ((32, 32), (32, 32)) + (((0, 0),) if pixels.ndim == 3 else ())
            Image.fromarray(np.pad(pixels, padding, mode='reflect')).save(context / name / path.name)
    return context


def blend_frame_boundary(prediction, padded_prediction, mask):
    """Use extra context only in repaired pixels within 12px of an active edge."""
    h, w = mask.shape
    if prediction.shape != (h, w, 3) or padded_prediction.shape != (h+64, w+64, 3):
        raise ValueError('Boundary prediction dimensions changed.')
    distance = np.full((h, w), 12, dtype=np.float32)
    for active, edge_distance in [
            (np.any(mask[:, 0]), np.arange(w)[None, :]),
            (np.any(mask[:, -1]), np.arange(w-1, -1, -1)[None, :]),
            (np.any(mask[0]), np.arange(h)[:, None]),
            (np.any(mask[-1]), np.arange(h-1, -1, -1)[:, None])]:
        if active:
            distance = np.minimum(distance, edge_distance)
    t = np.clip((distance-3)/9, 0, 1)
    weight = ((1-t*t*(3-2*t))*mask)[:, :, None]
    context = padded_prediction[32:32+h, 32:32+w]
    return np.uint8(np.clip(prediction*(1-weight) + context*weight + .5, 0, 255))


def inpaint_inputs(work):
    """A one-frame shot needs a duplicate for the video model's optical flow."""
    frames = sorted((work / 'frames').glob('*.png'))
    if len(frames) != 1:
        return work
    context = work / 'single-frame-context'
    for name in ['frames', 'masks']:
        (context / name).mkdir(parents=True)
        for index in range(2):
            shutil.copyfile(work / name / frames[0].name, context / name / f'{index:04}.png')
    return context


def inpaint_worker(root, work):
    """Isolate upstream module names from the video worker's Python packages."""
    import runpy
    import types
    repo = root / 'optional/ProPainter'
    sys.path[:0] = [str(repo), str(root / 'optional/matting-deps')]
    utils = types.ModuleType('utils'); utils.__path__ = [str(repo / 'utils')]
    sys.modules['utils'] = utils
    os.chdir(repo)
    inputs = inpaint_inputs(work)
    sys.argv = ['inference_propainter.py', '--video', str(inputs / 'frames'),
                '--mask', str(inputs / 'masks'), '--output', str(inputs / 'inpaint'),
                '--mask_dilation', '0', '--subvideo_length', '40', '--fp16', '--save_frames']
    runpy.run_path(str(repo / 'inference_propainter.py'), run_name='__main__')
    if inputs != work:
        destination = work / 'inpaint/frames/frames'
        destination.mkdir(parents=True)
        shutil.copyfile(inputs / 'inpaint/frames/frames/0000.png', destination / '0000.png')


def run(args):
    from PIL import Image
    sys.path.insert(0, str(args.root))
    import video_edit as edit
    root = args.root.resolve(); work = args.work.resolve(); output = args.output.resolve()
    if output.exists() or work.exists():
        raise ValueError('Use a new output file and work directory for each candidate.')
    required = [root / 'optional/rvm_mobilenetv3_fp32.torchscript',
                root / 'optional/ProPainter/inference_propainter.py',
                *[root / 'optional/ProPainter/weights' / name for name in
                  ['ProPainter.pth', 'raft-things.pth', 'recurrent_flow_completion.pth']]]
    if any(not path.is_file() for path in required):
        raise ValueError('Install the documented optional local models first.')
    # These are shot segments, which may be shorter than the upload minimum.
    duration, width, height = edit.clip_details(args.composite, validate_source=False)
    frames = repair_frame_count(duration)
    probe = json.loads(edit.command('ffprobe', '-v', 'error', '-select_streams', 'v:0',
                       '-show_entries', 'stream=avg_frame_rate', '-of', 'json', str(args.composite)))
    rate = probe['streams'][0]['avg_frame_rate'].split('/')
    if abs(float(rate[0]) / float(rate[1]) - 24) > .001:
        raise ValueError('Repair requires a normalized 24-fps segment.')
    for path in [args.source_mask, args.replacement_mask]:
        d, w, h = edit.clip_details(path, validate_source=False)
        if (w, h) != (width, height) or d + .5 / 24 < duration:
            raise ValueError('Mask canvas or timeline does not cover the segment.')
    motion_duration, mw, mh = edit.clip_details(args.motion, validate_source=False)
    if motion_duration + .5 / 24 < duration:
        raise ValueError('Generated motion is shorter than the composite.')
    work.mkdir(parents=True)
    for name in ['frames', 'masks', 'alpha']:
        (work / name).mkdir()
    import torch
    model = torch.jit.load(str(required[0]), map_location='cuda').eval()
    rec = [None] * 4
    x, y, right, bottom = args.box
    if not (0 <= x < right <= width and 0 <= y < bottom <= height):
        raise ValueError('Invalid generated crop.')
    streams = [edit.decoded_frames(args.composite, 'rgb24', width*height*3, frames),
               edit.decoded_frames(args.source_mask, 'gray', width*height, frames),
               edit.decoded_frames(args.replacement_mask, 'gray', width*height, frames),
               edit.decoded_frames(args.motion, 'rgb24', mw*mh*3, frames)]
    try:
        with torch.inference_mode():
            for i in range(frames):
                data = [next(stream, None) for stream in streams]
                if any(value is None for value in data):
                    raise ValueError('A repair input ended before the segment.')
                original = np.frombuffer(data[0], np.uint8).reshape(height, width, 3)
                source, replacement = [np.frombuffer(value, np.uint8).reshape(height, width) for value in data[1:3]]
                pixels = np.frombuffer(data[3], np.uint8).reshape(mh, mw, 3).copy()
                tensor = torch.from_numpy(pixels).permute(2, 0, 1).float().cuda()[None] / 255
                _, alpha, *rec = model(tensor, *rec, .5)
                crop = np.uint8(np.clip(alpha[0, 0].cpu().numpy()*255 + .5, 0, 255))
                full = np.zeros((height, width), np.uint8)
                full[y:bottom, x:right] = np.array(Image.fromarray(crop).resize((right-x, bottom-y), Image.Resampling.BILINEAR))
                mask = repair_mask(source, replacement, full, args.box)
                Image.fromarray(original).save(work / 'frames' / f'{i:04}.png')
                Image.fromarray(mask.astype(np.uint8)*255).save(work / 'masks' / f'{i:04}.png')
                Image.fromarray(full).save(work / 'alpha' / f'{i:04}.png')
    finally:
        for stream in streams:
            stream.close()
    del model, rec, tensor, alpha
    torch.cuda.empty_cache()
    subprocess.run([sys.executable, '-s', str(Path(__file__).resolve()), '--inpaint-worker',
                    '--root', str(root), '--work', str(work)], check=True)
    context = boundary_context(work)
    if context is not None:
        subprocess.run([sys.executable, '-s', str(Path(__file__).resolve()), '--inpaint-worker',
                        '--root', str(root), '--work', str(context)], check=True)
    # Restore every protected pixel from the input composite, using lossless PNG
    # predictions instead of a twice-compressed upstream preview.
    predictions = work / 'inpaint/frames/frames'
    if len(list(predictions.glob('*.png'))) != frames:
        raise ValueError('Inpainting did not return every frame.')
    context_predictions = context / 'inpaint/frames/frames' if context is not None else None
    if context_predictions is not None and len(list(context_predictions.glob('*.png'))) != frames:
        raise ValueError('Boundary inpainting did not return every frame.')
    raw = work / 'candidate.rgb'
    with raw.open('wb') as out:
        for i in range(frames):
            original = np.array(Image.open(work / 'frames' / f'{i:04}.png').convert('RGB'))
            mask = np.array(Image.open(work / 'masks' / f'{i:04}.png')) > 127
            prediction = np.array(Image.open(predictions / f'{i:04}.png').convert('RGB'))
            if context_predictions is not None:
                padded = np.array(Image.open(context_predictions / f'{i:04}.png').convert('RGB'))
                prediction = blend_frame_boundary(prediction, padded, mask)
            out.write(restore_protected(original, prediction, mask).tobytes())
    output.parent.mkdir(parents=True, exist_ok=True)
    edit.command('ffmpeg', '-nostdin', '-v', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', 'rgb24',
                 '-video_size', f'{width}x{height}', '-framerate', '24', '-i', str(raw),
                 '-i', str(args.composite), '-map', '0:v:0', '-map', '1:a?',
                 '-vf', 'scale=out_color_matrix=bt709:out_range=tv', '-colorspace', 'bt709',
                 '-color_primaries', 'bt709', '-color_trc', 'iec61966-2-1', '-color_range', 'tv',
                 '-c:v', 'libx264', '-crf', '18', '-pix_fmt', 'yuv420p', '-c:a', 'copy', str(output))
    raw.unlink()
    (work / 'candidate.json').write_text(json.dumps({'experimental': True, 'frames': frames,
        'box': args.box, 'output': str(output), 'boundary_context': context is not None,
        'default_worker_changed': False}, indent=2))
    print('Experimental candidate ready. Visual review is still required:', output)


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--root', type=Path, default=Path(__file__).resolve().parent)
    p.add_argument('--work', type=Path, required=True)
    p.add_argument('--inpaint-worker', action='store_true', help=argparse.SUPPRESS)
    for name in ['composite', 'motion', 'source-mask', 'replacement-mask', 'output']:
        p.add_argument('--' + name, type=Path)
    p.add_argument('--box', nargs=4, type=int)
    args = p.parse_args()
    if args.inpaint_worker:
        return inpaint_worker(args.root.resolve(), args.work.resolve())
    if any(getattr(args, name) is None for name in ['composite', 'motion', 'source_mask', 'replacement_mask', 'output', 'box']):
        p.error('All video paths, --output and --box are required.')
    run(args)


if __name__ == '__main__':
    main()
