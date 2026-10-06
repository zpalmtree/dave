"""Controlled H3 full-mix/vocals comparison. Launch through gpuq's video-h3 profile.

Requires the desktop generator and its torch/torchaudio environment. Separation
runs on CPU so it can coexist with the resident ComfyUI model. Both renders use
the same image, prompt, seed, frames and original soundtrack; only the audio
latent used to condition H3 changes. This does not enable production separation.
"""
import argparse
import hashlib
import json
import shutil
import subprocess
import sys
import time
from pathlib import Path


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--desktop', type=Path, required=True)
    parser.add_argument('--audio', type=Path, required=True)
    parser.add_argument('--image', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--start', type=float, default=0)
    parser.add_argument('--seconds', type=float, default=6)
    parser.add_argument('--seed', type=int, default=61423)
    parser.add_argument('--renderer', choices=('base', 'taomate'), default='base')
    parser.add_argument('--prompt', required=True)
    args = parser.parse_args()
    if not 0 <= args.start or not 1 <= args.seconds <= 12:
        parser.error('Use a nonnegative start and 1-12 seconds.')
    args.output.mkdir(parents=True, exist_ok=True)
    signature = {key: value for key, value in vars(args).items() if key not in ('desktop', 'output', 'audio', 'image')}
    for key in ('audio', 'image'):
        signature[key + '_sha256'] = hashlib.sha256(getattr(args, key).read_bytes()).hexdigest()
    request_path = args.output / 'request.json'
    if request_path.exists():
        if json.loads(request_path.read_text()) != signature:
            raise ValueError('Use a new output directory for different benchmark inputs.')
    elif any(args.output.glob('*.wav')) or any(args.output.glob('*.mp4')):
        raise ValueError('Existing media has no matching request manifest; use a new output directory.')
    request_path.write_text(json.dumps(signature, indent=2))
    sys.path.insert(0, str(args.desktop))
    import video_gen as vg
    from video_source_audio import audio_window, condition_h3_on_song, assemble_song_video, mux_original_song
    import numpy as np
    import torch
    from torchaudio.pipelines import HDEMUCS_HIGH_MUSDB_PLUS

    ffmpeg = vg.ffmpeg_executable()
    frames = round(args.seconds * 24)
    generated_frames = frames + (5 - frames % 17) % 17
    seconds = generated_frames / 24
    mix = audio_window(ffmpeg, args.audio, args.output / 'mix.wav', args.start, seconds)
    vocals = args.output / 'vocals.wav'
    if not vocals.exists():
        print('Separating vocals with Hybrid Demucs on CPU...', flush=True)
        torch.set_num_threads(4)
        bundle = HDEMUCS_HIGH_MUSDB_PLUS
        model = bundle.get_model().eval()
        # Add context on each side, then discard it to avoid separator edge artifacts.
        context_start = max(0, args.start - 2)
        offset = round((args.start - context_start) * bundle.sample_rate)
        raw = subprocess.check_output([ffmpeg, '-v', 'error', '-ss', str(context_start), '-i', str(args.audio),
            '-t', str(seconds + 4), '-ac', '2', '-ar', str(bundle.sample_rate), '-f', 'f32le', '-'])
        wave = torch.from_numpy(np.frombuffer(raw, dtype=np.float32).copy().reshape(-1, 2).T)
        ref = wave.mean(0)
        mean, std = ref.mean(), ref.std().clamp_min(1e-8)
        with torch.inference_mode():
            separated = model(((wave - mean) / std)[None])[0, model.sources.index('vocals')] * std + mean
        samples = round(seconds * bundle.sample_rate)
        result = separated[:, offset:offset + samples].T.contiguous().numpy()
        subprocess.run([ffmpeg, '-v', 'error', '-y', '-f', 'f32le', '-ar', str(bundle.sample_rate), '-ac', '2',
            '-i', '-', '-c:a', 'pcm_s16le', str(vocals)], input=result.tobytes(), check=True)
        del model, separated
    image_name = 'vocal_ab_' + args.output.name + args.image.suffix
    shutil.copyfile(args.image, vg.INPUT_DIR / image_name)
    report = {'seed': args.seed, 'renderer': args.renderer, 'start': args.start, 'seconds': frames / 24,
              'generated_frames': generated_frames, 'prompt': args.prompt, 'variants': {}}
    for name, conditioning in [('mix', mix), ('vocals', vocals)]:
        destination = args.output / (name + '.mp4')
        prefix = 'video/vocal_ab/' + args.output.name + '/' + name
        audio_name = 'vocal_ab_' + args.output.name + '_' + name + '.wav'
        audio_window(ffmpeg, conditioning, vg.INPUT_DIR / audio_name, 0, seconds)
        workflow = vg.build_prompt(model='h3', mode='i2v', text_prompt=args.prompt,
            quality='final', duration=seconds, frame_count=generated_frames, seed=args.seed,
            aspect='1:1', fast=args.renderer == 'taomate', turbo4=False, attention='kitchen', ltx_one_stage=False,
            enhance=False, input_name=image_name, prefix=prefix, fast_profile='taomate')
        workflow = condition_h3_on_song(workflow, audio_name)
        (args.output / (name + '-workflow.json')).write_text(json.dumps(workflow, indent=2))
        started = time.monotonic()
        if not destination.exists():
            response = vg.api_json(vg.DEFAULT_SERVER, '/prompt', {'prompt': workflow}, timeout=30)
            if not response.get('prompt_id'):
                raise RuntimeError(str(response))
            print(f'Rendering {name}: {response["prompt_id"]}', flush=True)
            output = vg.wait_for_generation(vg.DEFAULT_SERVER, response['prompt_id'], prefix, 1800)
            # Match production assembly: trim decoded frames before stream-copying
            # audio onto them. A packet-level -t cut can retain extra B-frames.
            trimmed = args.output / (name + '-trimmed.mp4')
            assemble_song_video(ffmpeg, [output], [{'source_audio_frames': frames}], trimmed)
            mux_original_song(ffmpeg, trimmed, mix, destination, 0, frames)
            trimmed.unlink()
        report['variants'][name] = {'path': str(destination), 'seconds': round(time.monotonic() - started, 2)}
        (args.output / 'report.json').write_text(json.dumps(report, indent=2))
    print(json.dumps(report), flush=True)


if __name__ == '__main__':
    main()
