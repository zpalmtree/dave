"""Original-song conditioning and frame-exact delivery for the desktop H3 worker."""
import copy
import math
import subprocess
from pathlib import Path


def run_media(ffmpeg, args):
    result = subprocess.run([str(ffmpeg), '-nostdin', '-v', 'error', '-y', *map(str, args)],
                            capture_output=True, text=True, timeout=120)
    if result.returncode:
        raise RuntimeError(f'Song processing failed: {result.stderr[-1500:]}')


def audio_window(ffmpeg, source, destination, start, seconds):
    if not math.isfinite(start) or start < 0 or not math.isfinite(seconds) or not 0 < seconds <= 16:
        raise ValueError('Invalid song window')
    destination = Path(destination)
    destination.parent.mkdir(parents=True, exist_ok=True)
    run_media(ffmpeg, ['-ss', f'{start:.9f}', '-i', source, '-map', '0:a:0', '-af', 'apad',
                      '-t', f'{seconds:.9f}', '-ac', '2', '-ar', '32000', '-c:a', 'pcm_s16le', destination])
    return destination


def condition_h3_on_song(workflow, input_name):
    """Freeze encoded audio while sampling video; the H3 model receives both noise masks."""
    workflow = copy.deepcopy(workflow)
    samplers = [node for node in workflow.values() if node.get('class_type') == 'SamplerCustomAdvanced']
    if len(samplers) != 1:
        raise ValueError('Song conditioning requires the single-stage H3 sampler')
    sampler = samplers[0]
    audio_decoders = [n for n in workflow.values() if n.get('class_type') == 'VAEDecodeAudio']
    if len(audio_decoders) != 1:
        raise ValueError('H3 audio VAE is missing')
    vae = audio_decoders[0]['inputs']['vae']
    nodes = {
        'song:load': {'class_type': 'LoadAudio', 'inputs': {'audio': input_name}},
        'song:encode': {'class_type': 'VAEEncodeAudio', 'inputs': {'audio': ['song:load', 0], 'vae': vae}},
        'song:zero': {'class_type': 'SolidMask', 'inputs': {'value': 0.0, 'width': 1, 'height': 1}},
        'song:freeze': {'class_type': 'SetLatentNoiseMask', 'inputs': {
            'samples': ['song:encode', 0], 'mask': ['song:zero', 0]}},
        'song:av': {'class_type': 'LTXVConcatAVLatent', 'inputs': {
            'video_latent': sampler['inputs']['latent_image'], 'audio_latent': ['song:freeze', 0]}},
    }
    sampler['inputs']['latent_image'] = ['song:av', 0]
    # Output the original waveform, avoiding audio VAE reconstruction or newly generated sound.
    for node in workflow.values():
        if node.get('class_type') == 'CreateVideo':
            node['inputs']['audio'] = ['song:load', 0]
    workflow.update(nodes)
    return workflow


def prepare_song_segments(prepared, plan):
    if len(prepared) != len(plan['segments']):
        raise ValueError('Song scene count changed after planning')
    for item, authored in zip(prepared, plan['segments']):
        frames = int(authored['source_audio_frames'])
        if not 12 <= frames <= 360:
            raise ValueError('Invalid song scene length')
        # H3 requires 17k+5 frames. Its extra tail is discarded, never accumulated.
        generated = frames + (5 - frames % 17) % 17
        item.update(source_audio_start_seconds=float(authored['source_audio_start_seconds']),
                    source_audio_frames=frames, frame_count=generated, effective_seconds=generated / 24,
                    target_seconds=frames / 24, output_seconds=frames / 24,
                    transition=authored['transition'], audio_transition='cut', shots=authored['shots'])
        item['prompt'] += ('\nThe original song is supplied as immutable audio conditioning. The visible performer '
            'lip-syncs precisely to its vocals, with natural performance gestures following its rhythm. '
            'Begin performing immediately at time zero. No silent lead-in, new speech, invented lyrics, or slow motion.')
    return prepared


def mux_original_song(ffmpeg, video, song, destination, start, frames):
    """Replace segment AAC joins with one continuous source track in final delivery."""
    run_media(ffmpeg, ['-i', video, '-ss', f'{start:.9f}', '-i', song,
                      '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'copy', '-af', 'apad',
                      '-c:a', 'aac', '-b:a', '192k', '-t', f'{frames / 24:.9f}',
                      '-movflags', '+faststart', destination])
    return Path(destination)


def assemble_song_video(ffmpeg, paths, prepared, destination):
    inputs, filters, labels = [], [], []
    for index, (path, segment) in enumerate(zip(paths, prepared)):
        inputs += ['-i', path]
        filters.append(f"[{index}:v]trim=end_frame={segment['source_audio_frames']},setpts=PTS-STARTPTS[v{index}]")
        labels.append(f"[v{index}]")
    filters.append(''.join(labels) + f'concat=n={len(paths)}:v=1:a=0[video]')
    run_media(ffmpeg, [*inputs, '-filter_complex', ';'.join(filters), '-map', '[video]',
                      '-an', '-c:v', 'libx264', '-preset', 'fast', '-crf', '18', '-pix_fmt', 'yuv420p', destination])
    return Path(destination)
