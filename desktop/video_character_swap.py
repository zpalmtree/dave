"""Character Swap replacement using H3 aligned guides; run under a gpuq lease."""
from __future__ import annotations

import argparse
import json
import math
import sys
import tempfile
import time
import uuid
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import video_edit as edit

INPUT = edit.INPUT
MODEL_ROOTS = (edit.COMFY / 'models', Path('C:/AI/ComfyUI_fast_models'))
SWAP_LORA = 'minimax_h3_character_swap_v1.0_ref2va_r64_gl.safetensors'
TURBO_LORA = 'minimax_h3_dmd_ref2va_8step_turbo_pruned.safetensors'
VIDEO_VAE = 'minimax_h3_video_vae_int8_convrot.safetensors'
AUDIO_VAE = 'minimax_h3_audio_vae_fp32.safetensors'
TEXT_ENCODER = 'qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors'
MODEL_FRAMES = 124


def required_models():
    for category, name in [('diffusion_models', edit.REF_MODEL), ('loras', SWAP_LORA),
                           ('loras', TURBO_LORA), ('vae', VIDEO_VAE), ('vae', AUDIO_VAE),
                           ('text_encoders', TEXT_ENCODER)]:
        if not any((root / category / name).is_file() for root in MODEL_ROOTS):
            raise RuntimeError(f'Character Swap model is missing: {category}/{name}')


def canvas(width, height):
    """Preserve source size/aspect within the tested half-megapixel budget."""
    candidates = [(w, h) for w in range(32, min(width, 1024) + 1, 32)
                  for h in range(32, min(height, 1024) + 1, 32) if w * h <= 500_000]
    error = lambda size: abs(math.log((size[0] / size[1]) / (width / height)))
    close = [size for size in candidates if error(size) <= 0.02]
    return (max(close, key=lambda size: size[0] * size[1]) if close else
            min(candidates, key=lambda size: (error(size), -(size[0] * size[1]))))


def segments_for_shots(shots):
    """Keep every 24 fps frame and never cross a detected shot boundary."""
    result = []
    for start, end in shots:
        count = math.ceil((end - start) / MODEL_FRAMES)
        common, extra = divmod(end - start, count)
        for index in range(count):
            length = common + (index < extra)
            result.append((start, length, MODEL_FRAMES))
            start += length
    return result


def swap_prompt(target, direction, subjects):
    selected = (f'the single most prominent subject matching "{target}"' if subjects == 'primary'
                else f'every subject matching "{target}"')
    return (
        'body_swap: subject_definitions: <Subject 1> is the replacement character shown in '
        '<Picture 1>, whose identity, face, head, hair or fur, skin, body shape, proportions '
        'and clothing define the character in the target video. The guide video provides '
        'the scene and the performance: its background, environment, lighting, camera, '
        'framing, body pose, hand and arm movement, head rotation, gaze direction, lip '
        f'movement and facial expression, frame by frame; only {selected} is replaced. '
        'Leave other subjects unchanged. '
        f'summary: [video generation + reference] Replace {selected} with <Subject 1>, '
        'keeping the scene, camera and the complete motion and performance of the guide video. '
        f'detailed_description: [Shot 1] <Subject 1> takes the exact place of {selected} '
        'and moves with the same timing, body pose, gestures, head motion, gaze, speech and '
        'facial expressions, while keeping the complete look from <Picture 1>. Head, face, '
        'skin, hair or fur, body shape and clothing stay stable in every frame, with no trace '
        "of the original subject's face, hair or clothing. The background, lighting, colors "
        'and camera of the guide video are preserved. Prevent identity drift, clothing '
        'changes, texture crawling and flicker. The result is a real, photographic video. '
        f'User replacement direction: {direction}')


def render_graph(clip_name, reference_name, target, direction, subjects,
                 width, height, prefix, seed=46):
    n = edit.node
    return {
        'model': n('UNETLoader', unet_name=edit.REF_MODEL, weight_dtype='default'),
        'swap': n('LoraLoaderModelOnly', model=['model', 0], lora_name=SWAP_LORA, strength_model=1.0),
        'turbo': n('LoraLoaderModelOnly', model=['swap', 0], lora_name=TURBO_LORA, strength_model=1.0),
        'shift': n('MiniMaxH3SigmaShift', model=['turbo', 0], shift_video=12.0, shift_audio=3.0),
        'clip': n('CLIPLoader', clip_name=TEXT_ENCODER, type='minimax', device='default'),
        'vae': n('VAELoader', vae_name=VIDEO_VAE),
        'audio_vae': n('VAELoader', vae_name=AUDIO_VAE),
        'reference': n('LoadImage', image=reference_name),
        'source': n('LoadVideo', file=clip_name),
        'frames': n('GetVideoComponents', video=['source', 0]),
        'cond': n('MiniMaxH3ReferenceToVideo', clip=['clip', 0], vae=['vae', 0], audio_vae=['audio_vae', 0],
                  prompt=swap_prompt(target, direction, subjects), width=width, height=height,
                  length=MODEL_FRAMES, ref_image_size='match', **{'ref_images.ref_image_0': ['reference', 0]}),
        'guide': n('MiniMaxH3AddGuide', positive=['cond', 0], latent=['cond', 1], vae=['vae', 0],
                   image=['frames', 0], frame_idx=0),
        'guider': n('CFGGuider', model=['shift', 0], positive=['guide', 0], negative=['guide', 0], cfg=1.0),
        'noise': n('RandomNoise', noise_seed=seed),
        'scheduler': n('BasicScheduler', model=['shift', 0], scheduler='simple', steps=8, denoise=1.0),
        'sampler': n('KSamplerSelect', sampler_name='euler'),
        'sample': n('SamplerCustomAdvanced', noise=['noise', 0], guider=['guider', 0], sampler=['sampler', 0],
                    sigmas=['scheduler', 0], latent_image=['cond', 1]),
        'split': n('LTXVSeparateAVLatent', av_latent=['sample', 0]),
        'decode': n('VAEDecode', samples=['split', 0], vae=['vae', 0]),
        # Source audio is muxed after segment assembly, never generated or re-synced.
        'video': n('CreateVideo', images=['decode', 0], fps=24.0, bit_depth=8),
        'save': n('SaveVideo', video=['video', 0], filename_prefix=prefix, format='auto', codec='auto'),
    }


def validate_render(path, width, height):
    info = json.loads(edit.command('ffprobe', '-v', 'error', '-select_streams', 'v:0',
                                   '-count_frames', '-show_entries',
                                   'stream=width,height,nb_read_frames,r_frame_rate', '-of', 'json', str(path)))
    stream = (info.get('streams') or [{}])[0]
    if ((stream.get('width'), stream.get('height')) != (width, height)
            or int(stream.get('nb_read_frames') or 0) != MODEL_FRAMES
            or stream.get('r_frame_rate') != '24/1'):
        raise RuntimeError(f'Character Swap returned an invalid video timeline or canvas: {stream}')


def replace_clip(args):
    required_models()
    duration, source_w, source_h = edit.clip_details(args.clip)
    width, height = canvas(source_w, source_h)
    # ffprobe rounds 124/24 to 5.166667; that must not create a 125th frame
    # and double the number of model windows for an already legal clip.
    total_frames = math.ceil(duration * 24 - 0.0001)
    run_id = uuid.uuid4().hex
    INPUT.mkdir(parents=True, exist_ok=True)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    reference = INPUT / f'character-swap-{run_id}{args.image.suffix.lower()}'
    manifest_path = args.output.with_suffix('.character-swap.json')
    manifest = {'backend': 'character_swap', 'status': 'running', 'source_seconds': duration,
                'width': width, 'height': height, 'target': args.target, 'subjects': args.subjects,
                'reference': str(args.image), 'audio': 'original source soundtrack', 'segments': []}
    started = time.monotonic()
    try:
        reference.write_bytes(args.image.read_bytes())
        with tempfile.TemporaryDirectory(prefix='character-swap-', dir=args.output.parent) as temporary:
            directory = Path(temporary)
            normalized = directory / 'normalized.mp4'
            print('Normalizing source clip for Character Swap', flush=True)
            edit.normalized_clip(args.clip, normalized, width, height, total_frames)
            shots, _ = edit.edit_plan(normalized, duration)
            shots = [(start, min(end, total_frames)) for start, end in shots if start < total_frames]
            segments = segments_for_shots(shots)
            rendered_segments = []
            for index, (start, source_frames, model_frames) in enumerate(segments, start=1):
                clip = INPUT / f'character-swap-{run_id}-{index}.mp4'
                try:
                    print(f'Generating replacement segment {index}/{len(segments)} with Character Swap', flush=True)
                    edit.segment_clip(normalized, clip, start, source_frames, model_frames)
                    graph = render_graph(clip.name, reference.name, args.target, args.prompt, args.subjects,
                                         width, height, f'video/edits/{run_id}-{index}-character-swap', args.seed + index - 1)
                    record = {'start_frame': start, 'source_frames': source_frames, 'workflow': graph}
                    manifest['segments'].append(record)
                    manifest_path.write_text(json.dumps(manifest, indent=2), encoding='utf-8')
                    rendered = edit.run_graph(args.server, graph, 'save', 7200)
                    validate_render(rendered, width, height)
                    segment = directory / f'segment-{index:02d}.mp4'
                    edit.command('ffmpeg', '-nostdin', '-v', 'error', '-y', '-i', str(rendered),
                                 '-frames:v', str(source_frames), '-an', '-c:v', 'libx264', '-crf', '18',
                                 '-pix_fmt', 'yuv420p', str(segment))
                    rendered_segments.append(segment)
                    record['rendered'] = str(rendered)
                finally:
                    clip.unlink(missing_ok=True)
            print('Joining edited segments and restoring original soundtrack', flush=True)
            assembled = directory / 'edited.mp4'
            edit.join_segments(rendered_segments, args.clip, assembled, duration, directory)
            if not assembled.is_file() or assembled.stat().st_size == 0:
                raise RuntimeError('Character Swap produced no output')
            assembled.replace(args.output)
        manifest['status'] = 'completed'
        print(f'Character Swap replacement ready: {args.output}', flush=True)
    except Exception as error:
        manifest.update(status='failed', error=str(error)[:1000])
        raise
    finally:
        reference.unlink(missing_ok=True)
        manifest['seconds'] = time.monotonic() - started
        manifest_path.write_text(json.dumps(manifest, indent=2), encoding='utf-8')


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--clip', type=Path, required=True)
    parser.add_argument('--image', type=Path, required=True)
    parser.add_argument('--target', required=True)
    parser.add_argument('--mode', choices=('replace',), default='replace')
    parser.add_argument('--subjects', choices=('primary', 'group'), default='primary')
    parser.add_argument('--prompt', required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--error-file', type=Path)
    parser.add_argument('--server', default='http://127.0.0.1:8188')
    parser.add_argument('--seed', type=int, default=46)
    args = parser.parse_args()
    try:
        replace_clip(args)
    except Exception as error:
        if args.error_file:
            args.error_file.parent.mkdir(parents=True, exist_ok=True)
            args.error_file.write_text(str(error)[:1000], encoding='utf-8')
        raise


if __name__ == '__main__':
    main()
