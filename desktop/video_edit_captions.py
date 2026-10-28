"""CPU detection of fixed caption glyphs for source-video compositing.

Detect text on temporally consistent colour planes, not a hard-coded colour,
rectangle, caption string or frame range. Only recognized glyphs and their thin
outline are protected; the counters and space between letters remain editable.
Text belonging to the tracked subject is not a foreground caption.
"""
from __future__ import annotations

import csv
import io
import json
import math
import os
from pathlib import Path
import shutil
import subprocess
import time

import numpy as np
from PIL import Image
from scipy.ndimage import binary_dilation, gaussian_filter, label, find_objects

MAX_COLOURS = 12
MAX_ANALYSIS_SIZE = 640
OCR_TIMEOUT = 5
ANALYSIS_SECONDS = 25
COLOUR_TOLERANCE = 36


def ocr_words(mask, timeout=OCR_TIMEOUT):
    """Read a binary colour plane. Windows uses the existing Ubuntu CPU tools."""
    executable = shutil.which('tesseract')
    command = ([executable] if executable else
               ['wsl.exe', '-d', os.environ.get('VIDEO_LIPSYNC_DISTRO', 'Ubuntu'),
                '--exec', 'env', 'OMP_THREAD_LIMIT=1', 'timeout', str(math.ceil(timeout)), 'tesseract'] if os.name == 'nt' else
               ['tesseract'])
    buffer = io.BytesIO()
    # OCR needs a quiet margin even when a caption touches the frame edge.
    padded = np.pad(np.uint8(~mask) * 255, 16, constant_values=255)
    Image.fromarray(padded).save(buffer, format='PNG')
    result = subprocess.run([*command, 'stdin', 'stdout', '--psm', '11', 'tsv'],
                            input=buffer.getvalue(), capture_output=True, timeout=timeout + 1,
                            check=True, env={**os.environ, 'OMP_THREAD_LIMIT': '1'})
    words = []
    for row in csv.DictReader(io.StringIO(result.stdout.decode('utf-8')), delimiter='\t'):
        text = row.get('text', '').strip()
        if float(row['conf']) >= 80 and sum(c.isalnum() for c in text) >= 3:
            x, y, w, h = (int(row[key]) for key in ('left', 'top', 'width', 'height'))
            if w > 0 and h >= 8:
                words.append((max(0, x-16), max(0, y-16),
                              min(mask.shape[1], x+w-16), min(mask.shape[0], y+h-16)))
    return words


def detect_layers(samples, subject_masks, recognize=None):
    """Return colour/glyph layers. State is local to one source segment."""
    recognize = recognize or ocr_words
    samples = np.asarray(samples, dtype=np.int16)
    masks = np.asarray(subject_masks)
    if samples.ndim != 4 or samples.shape[-1] != 3 or masks.shape != samples.shape[:-1]:
        raise ValueError('Caption samples and subject masks must share the same timeline and canvas.')
    if len(samples) < 3:
        return []
    median = np.median(samples, axis=0).astype(np.int16)
    quantized = median // 32
    codes = quantized[:, :, 0] * 64 + quantized[:, :, 1] * 8 + quantized[:, :, 2]
    colours, counts = np.unique(codes, return_counts=True)
    centres = []
    for code in colours[np.argsort(counts)[::-1]]:
        centre = np.median(median[codes == code], axis=0)
        if any(np.linalg.norm(centre - old) < COLOUR_TOLERANCE for old in centres):
            continue
        centres.append(centre)
        if len(centres) == MAX_COLOURS:
            break
    occupied = np.any(masks > 127, axis=0)
    layers = []
    covered = np.zeros(median.shape[:2], bool)
    deadline = time.monotonic() + ANALYSIS_SECONDS
    for centre in centres:
        if time.monotonic() >= deadline:
            raise TimeoutError('Caption analysis exceeded its budget.')
        near = np.max(abs(samples - centre), axis=3) < COLOUR_TOLERANCE
        stable = near.mean(axis=0) >= 0.85
        if stable.sum() < 32:
            continue
        # A stationary shirt label is still part of the subject, not a caption.
        evidence = stable & ~occupied
        if evidence.sum() < 32:
            continue
        components, _ = label(evidence)
        bounds = find_objects(components)
        for x, y, right, bottom in recognize(evidence, min(OCR_TIMEOUT, max(0.1, deadline-time.monotonic()))):
            height, width = stable.shape
            if not (0 <= x < right <= width and 0 <= y < bottom <= height):
                continue
            glyphs = np.zeros_like(stable)
            # A background colour can OCR as inverse text. Its component runs
            # beyond the word; reject it rather than restoring an opaque box.
            for component in np.unique(components[y:bottom, x:right]):
                if not component:
                    continue
                rows, columns = bounds[component-1]
                if (rows.start >= y-2 and rows.stop <= bottom+2 and
                        columns.start >= x-2 and columns.stop <= right+2):
                    glyphs[rows, columns] |= components[rows, columns] == component
            pixels = int(glyphs.sum())
            density = pixels / ((right-x) * (bottom-y))
            if pixels < 32 or not 0.08 <= density <= 0.8:
                continue
            if np.mean(occupied[glyphs]) > 0.05 or np.mean(covered[glyphs]) > 0.5:
                continue
            covered |= glyphs
            layers.append({'colour': centre, 'glyphs': glyphs,
                           'outline': max(1, min(3, round((bottom-y) * 0.035))),
                           'box': [x, y, right, bottom]})
    return layers


def protection_frame(frame, layers):
    """Drop a layer when its text disappears; never freeze a sampled frame."""
    height, width = frame.shape[:2]
    protection = np.zeros((height, width), np.uint8)
    for layer in layers:
        glyphs = layer['glyphs']
        if glyphs.shape != (height, width):
            raise ValueError('Caption layer belongs to a different canvas.')
        near = np.max(abs(frame.astype(np.int16) - layer['colour']), axis=2) < COLOUR_TOLERANCE
        if np.mean(near[glyphs]) < 0.8:
            continue
        hard = binary_dilation(glyphs, iterations=layer['outline'])
        soft = gaussian_filter(hard.astype(np.float32), 0.65)
        soft[hard] = 1
        soft[soft < 0.005] = 0
        protection = np.maximum(protection, np.rint(soft * 255).astype(np.uint8))
    return protection


def prepare_caption_mask(source, subject_mask, destination, frames, report=None):
    """Build lossless per-frame protection, returning None when no caption exists.

    Decode errors and missing OCR are surfaced rather than silently claiming the
    edit preserved its captions. Model padding is excluded from detection/output.
    """
    import video_edit as edit
    report = Path(report) if report else Path(destination).with_suffix('.json')
    started = time.monotonic()
    record = {'status': 'analyzing', 'source_frames': frames, 'layers': []}
    try:
        _, width, height = edit.clip_details(source)
        scale = min(1, MAX_ANALYSIS_SIZE / max(width, height))
        w, h = max(1, round(width*scale)), max(1, round(height*scale))
        indices = sorted(set(np.linspace(0, frames-1, min(7, frames), dtype=int).tolist()))
        select = '+'.join(f'eq(n\\,{index})' for index in indices)
        filters = f'select={select},setpts=N/(24*TB),scale={w}:{h}'
        samples = [np.frombuffer(data, np.uint8).reshape(h, w, 3) for data in
                   edit.decoded_frames(source, 'rgb24', w*h*3, len(indices), filters)]
        masks = [np.frombuffer(data, np.uint8).reshape(h, w) for data in
                 edit.decoded_frames(subject_mask, 'gray', w*h, len(indices), filters + ':flags=neighbor')]
        if len(samples) != len(indices) or len(masks) != len(indices):
            raise RuntimeError('Caption analysis is missing source or subject-mask frames.')
        layers = detect_layers(samples, masks)
        for layer in layers:
            record['layers'].append({'box': layer['box'], 'analysis_canvas': [w, h],
                                     'glyph_pixels': int(layer['glyphs'].sum())})
            if (w, h) != (width, height):
                layer['glyphs'] = np.array(Image.fromarray(layer['glyphs']).resize(
                    (width, height), Image.Resampling.NEAREST), dtype=bool)
                layer['outline'] = max(1, round(layer['outline'] / scale))
        if not layers:
            record['status'] = 'no_fixed_caption_detected'
            return None
        raw = Path(destination).with_suffix('.gray')
        try:
            count = 0
            with raw.open('wb') as stream:
                for data in edit.decoded_frames(source, 'rgb24', width*height*3, frames):
                    frame = np.frombuffer(data, np.uint8).reshape(height, width, 3)
                    stream.write(protection_frame(frame, layers).tobytes())
                    count += 1
            if count != frames:
                raise RuntimeError('Caption protection is shorter than the source segment.')
            edit.command('ffmpeg', '-nostdin', '-v', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', 'gray',
                         '-video_size', f'{width}x{height}', '-framerate', '24', '-i', str(raw),
                         '-an', '-c:v', 'ffv1', '-pix_fmt', 'gray', str(destination))
        finally:
            raw.unlink(missing_ok=True)
        record['status'] = 'protected'
        return Path(destination)
    except Exception as error:
        record.update(status='error', error=str(error)[:300])
        raise RuntimeError('Source caption protection failed; inspect the caption report before retrying.') from error
    finally:
        record['seconds'] = round(time.monotonic() - started, 3)
        report.write_text(json.dumps(record, indent=2), encoding='utf-8')
        print(f'Source captions: {record["status"]} ({len(record["layers"])} layers)', flush=True)
