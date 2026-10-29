"""Create public CPU fixtures through the installed video assembly pipeline."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
from unittest.mock import patch

parser = argparse.ArgumentParser()
parser.add_argument('--desktop-directory', type=Path, required=True)
parser.add_argument('--output', type=Path, required=True)
args = parser.parse_args()
sys.path.insert(0, str(args.desktop_directory.resolve()))
import video_gen as vg
import video_recovery as recovery

args.output.mkdir(parents=True, exist_ok=True)
clips = []
for index, color in enumerate(['orange', 'royalblue']):
    clip = args.output / f'shot-{index}.mp4'
    subprocess.run([vg.ffmpeg_executable(), '-v', 'error', '-y', '-f', 'lavfi', '-i',
        f'color={color}:s=480x270:r=24:d=2,drawbox=x={60 + index * 180}:y=60:w=120:h=150:color=white:t=fill',
        '-f', 'lavfi', '-i', f'sine=frequency={330 + index * 110}:sample_rate=48000:duration=2',
        '-c:v', 'libx264', '-threads', '1', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-ac', '2',
        str(clip)], capture_output=True, check=True)
    clips.append(clip)

cases = []
for name, transition, setting, song in [
    ('hard-cut', 'cut', '0', False), ('short-blend', 'cut', '.25', False),
    ('planned-dissolve', 'dissolve', '.25', False),
    ('continuation', 'continue', '.25', False), ('song-timeline', 'cut', '.25', True),
]:
    with patch.dict(os.environ, {'VIDEO_SHOT_BLEND_SECONDS': setting}):
        output = recovery.join_clips(clips, args.output / f'{name}.mp4',
            [{'transition': 'start'}, {'transition': transition}], source_audio=song)
    seconds = vg.validate_video(output)['duration_seconds']
    # Show the actual middle of each boundary, including the hard-cut reference.
    subprocess.run([vg.ffmpeg_executable(), '-v', 'error', '-y', '-ss', str(seconds / 2),
        '-i', str(output), '-frames:v', '1', str(args.output / f'{name}.png')],
        capture_output=True, check=True)
    cases.append({'name': name, 'seconds': seconds})

single = recovery.join_clips(clips[:1], args.output / 'single.mp4', [{'transition': 'start'}])
cases.append({'name': 'single', 'seconds': vg.validate_video(single)['duration_seconds']})
try:
    vg.assemble_segments([], [], [], args.output / 'empty.mp4')
except vg.VideoGenError as error:
    empty_error = str(error)
else:
    raise AssertionError('Empty assembly should fail before encoding.')
(args.output / 'cases.json').write_text(json.dumps({
    'cases': cases, 'empty_error': empty_error,
    'source_sha256': hashlib.sha256(Path(vg.__file__).read_bytes()).hexdigest(),
}, indent=2))
