"""Exercise the installed compositor with public synthetic fixture data only."""
import argparse
import json
import os
from pathlib import Path
import sys
from unittest.mock import patch

import numpy as np
from PIL import Image

root = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(root / 'desktop'))
sys.path.insert(0, os.environ.get('VIDEO_DESKTOP_DIR', '/mnt/d/AI/ComfyUI_windows_portable/video_gen'))
import video_edit
from test_video_edit_captions import write_fixture, encode

parser = argparse.ArgumentParser()
parser.add_argument('--output', type=Path, required=True)
args = parser.parse_args()
args.output.mkdir(parents=True, exist_ok=True)
paths, source, render, masks, glyphs = write_fixture(args.output)
output = args.output / 'caption-result.mp4'
video_edit.composite_segment(paths['source'], paths['render'], paths['alpha'], output,
                             len(source), subject_mask=paths['subject'])
frame = next(video_edit.decoded_frames(output, 'rgb24', 180*320*3, 1))
for name, pixels in [('caption-source', source[0]), ('caption-render', render[0]),
                     ('caption-result', np.frombuffer(frame, np.uint8).reshape(180, 320, 3))]:
    Image.fromarray(pixels).save(args.output / f'{name}.png')
success = json.loads(output.with_suffix('.captions.json').read_text())

blank = args.output / 'no-caption.mkv'
encode(blank, np.full_like(source, [80, 100, 140]))
empty_output = args.output / 'no-caption-result.mp4'
video_edit.composite_segment(blank, paths['render'], paths['alpha'], empty_output,
                             len(source), subject_mask=paths['subject'])
empty = json.loads(empty_output.with_suffix('.captions.json').read_text())

error_output = args.output / 'error-result.mp4'
with patch('video_edit_captions.ocr_words', side_effect=FileNotFoundError('OCR unavailable (fixture)')):
    try:
        video_edit.composite_segment(paths['source'], paths['render'], paths['alpha'], error_output,
                                     len(source), subject_mask=paths['subject'])
    except RuntimeError:
        pass
error = json.loads(error_output.with_suffix('.captions.json').read_text())
assert not error_output.exists()
for report in (success, empty, error):
    report.pop('seconds', None)
(args.output / 'caption-cases.json').write_text(json.dumps({'success': success, 'empty': empty, 'error': error}))
