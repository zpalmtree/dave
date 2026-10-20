"""Experimental single-scene FastH3 Omni ComfyUI renderer; no bot routing changes.

References establish identity/style, not exact first/last frames or fixed audio.
The ComfyUI export is a different runtime from FastVideo's FP4/VSA recipe.
"""

MODEL = 'fasth3_omniref_qad_nvfp4_comfy.safetensors'
MODEL_REPO = 'FastVideo/FastH3-OmniRef-NVFP4-QAD-Comfy'
MODEL_REVISION = '36dbf15cd11113471114b1040c4f38646c031549'
MODEL_SHA256 = 'bf25ee58df65b4dfee349d612f7ac62a2fea0dddd1e68eb37e75c8ce8b166f5a'
TEXT_ENCODER = 'qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors'
VIDEO_VAE = 'minimax_h3_video_vae_int8_convrot.safetensors'
AUDIO_VAE = 'minimax_h3_audio_vae_fp32.safetensors'


def node(kind, **inputs):
    return {'class_type': kind, 'inputs': inputs}


def build_prompt(*, prompt, images, prefix, seed, width=832, height=480,
                 frames=124, audio=()):
    """Build an eight-step reference graph with native audio output.

    Names are Comfy input-relative filenames. Image/audio ordering matches the
    one-based <Picture n>/<Audio n> prompt tags. Audio is a reference, not a
    promise to reproduce the recording. No production LoRAs are inherited.
    """
    if not 1 <= len(images) <= 9 or len(audio) > 3 or len(images) + len(audio) > 12:
        raise ValueError('Use 1-9 image references and at most 3 audio references (12 total).')
    if not prompt.strip():
        raise ValueError('A reference-aware prompt is required.')
    if frames not in (124, 243, 362):
        raise ValueError('Omni experiment supports 124, 243 or 362 frames at 24 fps.')
    if any(not isinstance(v, int) or v < 32 or v % 32 for v in (width, height)):
        raise ValueError('Canvas dimensions must be positive multiples of 32.')
    if min(width, height) > 768 or max(width, height) > 1344:
        raise ValueError('Canvas exceeds the experimental 768p limit.')
    graph = {
        'model': node('UNETLoader', unet_name=MODEL, weight_dtype='default'),
        'shift': node('MiniMaxH3SigmaShift', model=['model', 0], shift_video=12.0, shift_audio=3.0),
        'attention': node('ModelAttentionBackend', model=['shift', 0], attention='comfy kitchen attention'),
        # Match the official OmniRef template: trained VSA selection, never SLA.
        # Kitchen attention is the dense fallback below the token threshold.
        'sparse': node('BlockSparseAttention', model=['attention', 0], selection='vsa',
                       **{'selection.keep_percent': 10.0}, start_percent=0.0, end_percent=1.0,
                       dense_blocks='', min_tokens=12288, extra_tokens=256,
                       sink_conditioning='exact_kv_and_rows', verbose=False),
        'clip': node('CLIPLoader', clip_name=TEXT_ENCODER, type='minimax', device='default'),
        'vae': node('VAELoader', vae_name=VIDEO_VAE),
        'audio_vae': node('VAELoader', vae_name=AUDIO_VAE),
        'conditioning': node('MiniMaxH3ReferenceToVideo', clip=['clip', 0], vae=['vae', 0],
                             audio_vae=['audio_vae', 0], prompt=prompt, width=width,
                             height=height, length=frames, ref_image_size='match'),
        'guider': node('BasicGuider', model=['sparse', 0], conditioning=['conditioning', 0]),
        'noise': node('RandomNoise', noise_seed=seed),
        'scheduler': node('BasicScheduler', model=['sparse', 0], scheduler='simple', steps=8, denoise=1.0),
        'sampler': node('KSamplerSelect', sampler_name='euler'),
        'sample': node('SamplerCustomAdvanced', noise=['noise', 0], guider=['guider', 0],
                       sampler=['sampler', 0], sigmas=['scheduler', 0], latent_image=['conditioning', 1]),
        'split': node('LTXVSeparateAVLatent', av_latent=['sample', 0]),
        'decode': node('VAEDecode', samples=['split', 0], vae=['vae', 0]),
        'decode_audio': node('VAEDecodeAudio', samples=['split', 1], vae=['audio_vae', 0]),
        'video': node('CreateVideo', images=['decode', 0], audio=['decode_audio', 0], fps=24.0, bit_depth=8),
        'save': node('SaveVideo', video=['video', 0], filename_prefix=prefix, format='auto', codec='auto'),
    }
    for kind, names, loader, field in [('image', images, 'LoadImage', 'image'), ('audio', audio, 'LoadAudio', 'audio')]:
        for index, name in enumerate(names):
            key = f'{kind}_{index}'
            graph[key] = node(loader, **{field: name})
            plural = 'images' if kind == 'image' else 'audios'
            graph['conditioning']['inputs'][f'ref_{plural}.ref_{kind}_{index}'] = [key, 0]
    return graph
