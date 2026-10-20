#!/usr/bin/env python3
"""Make native-size TaoMate/Omni A/B videos, replaying once for each audio track.

CPU-only ffmpeg composition. Run gpuq gaming check --quiet before media work.
"""
import argparse
import json
from pathlib import Path
import subprocess


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--results', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--case', action='append')
    parser.add_argument('--all-seeds', action='store_true')
    parser.add_argument('--font', default='/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf')
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    for left_path in sorted(args.results.glob('*-taomate.result.json')):
        key = left_path.name.removesuffix('-taomate.result.json')
        case_id = key.rsplit('-', 1)[0]
        if args.case and case_id not in args.case:
            continue
        left = json.loads(left_path.read_text())
        if not args.all_seeds and left['seed'] != left['case']['seeds'][-1]:
            continue
        right = json.loads((args.results / (key + '-fasth3_omni.result.json')).read_text())
        for field in ('case', 'seed', 'source_image_sha256'):
            if left[field] != right[field]:
                raise ValueError(f'{key}: unmatched {field}')
        width, height, frames = (left['case'][k] for k in ('width', 'height', 'frames'))
        seconds = frames / 24
        for result in (left, right):
            check = result['validation']
            if (check['width'], check['height'], check['decoded_video_frames'], check['fps'],
                    check['audio_channels']) != (width, height, frames, 24.0, 2):
                raise ValueError(f'{key}: invalid source media geometry/audio')
        font = f'fontfile={args.font}:fontsize=24:fontcolor=white'
        labels = [f'A - TaoMate  |  {left["elapsed_seconds"]:.2f}s render',
                  f'B - Omni  |  {right["elapsed_seconds"]:.2f}s render']
        filters = [
            f'[0:v]trim=end_frame={frames},setpts=N/(24*TB),setsar=1[a]',
            f'[1:v]trim=end_frame={frames},setpts=N/(24*TB),setsar=1[b]',
            '[a][b]hstack=inputs=2,pad=iw:ih+104:0:48:color=0x10121a,'
            f'drawtext={font}:text=\'{labels[0]}\':x=20:y=12,'
            f'drawtext={font}:text=\'{labels[1]}\':x={width+20}:y=12,split=2[p1][p2]',
            f'[p1]drawtext={font}:text=\'Pass 1 of 2 - Audio A (TaoMate)\':x=20:y=h-38[v1]',
            f'[p2]drawtext={font}:text=\'Pass 2 of 2 - Audio B (Omni)\':x=20:y=h-38[v2]',
        ]
        for index in (0, 1):
            filters.append(f'[{index}:a]asetpts=PTS-STARTPTS,apad,atrim=duration={seconds},'
                           f'aformat=sample_rates=48000:channel_layouts=stereo[a{index}]')
        filters.append('[v1][a0][v2][a1]concat=n=2:v=1:a=1[outv][outa]')
        output = args.output / (key + '-taomate-vs-omni.mp4')
        subprocess.run(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-y',
            '-i', str(args.results / (key + '-taomate.mp4')),
            '-i', str(args.results / (key + '-fasth3_omni.mp4')),
            '-filter_complex_threads', '2', '-filter_complex', ';'.join(filters),
            '-map', '[outv]', '-map', '[outa]', '-c:v', 'libx264', '-crf', '18',
            '-preset', 'fast', '-threads', '4', '-pix_fmt', 'yuv420p',
            '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', str(output)], check=True)
        probe = json.loads(subprocess.check_output(['ffprobe', '-v', 'error',
            '-count_frames', '-show_streams', '-of', 'json', str(output)]))
        video = next(s for s in probe['streams'] if s['codec_type'] == 'video')
        audio = next(s for s in probe['streams'] if s['codec_type'] == 'audio')
        if (video['width'], video['height'], int(video['nb_read_frames']), audio['channels']) != (
                width * 2, height + 104, frames * 2, 2):
            raise RuntimeError(f'{key}: unexpected composed output')
        print(output, flush=True)


if __name__ == '__main__':
    main()
