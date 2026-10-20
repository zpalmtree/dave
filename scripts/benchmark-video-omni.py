#!/usr/bin/env python3
"""Run one renderer's paired-seed cases under gpuq; retain reproducible evidence.

Use the embedded Windows Python and --profile video-h3. Each invocation owns
only its submitted prompt IDs. This never edits the live generator or bot routes.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import sys
import time
import uuid

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'desktop'))
from video_fasth3_omni import build_prompt, MODEL, MODEL_REVISION, MODEL_SHA256


def sha(path):
    digest = hashlib.sha256()
    with Path(path).open('rb') as handle:
        for block in iter(lambda: handle.read(8 * 1024 * 1024), b''):
            digest.update(block)
    return digest.hexdigest()


def save(path, value):
    temp = path.with_suffix(path.suffix + '.tmp')
    temp.write_text(json.dumps(value, indent=2) + '\n', encoding='utf-8')
    temp.replace(path)


def graph_for(vg, case, renderer, seed, image, prefix):
    if renderer == 'fasth3_omni':
        return build_prompt(prompt=case['prompt'], images=[image], prefix=prefix, seed=seed,
                            width=case['width'], height=case['height'], frames=case['frames'])
    config = vg.WORKFLOWS[('h3', 'i2v')]
    graph = vg.build_prompt(model='h3', mode='i2v', text_prompt=case['prompt'], quality='final',
        duration=case['frames'] / 24, frame_count=case['frames'], seed=seed, aspect=case['aspect'],
        fast=renderer == 'taomate', fast_profile='taomate', turbo4=False, attention='kitchen',
        ltx_one_stage=False, enhance=False, input_name=image, prefix=prefix)
    # Override only canvas geometry, identically across the baseline renderers.
    conditioning = graph[config['prompt']]['inputs']
    conditioning.update(width=case['width'], height=case['height'])
    return graph


def cancel_owned(vg, server, prompt_id):
    """Never interrupt an unrelated prompt, including after queue races."""
    vg.api_json(server, '/queue', {'delete': [prompt_id]}, timeout=10)
    # The API supports targeted interruption; a global /interrupt is unsafe.
    vg.api_json(server, '/interrupt', {'prompt_id': prompt_id}, timeout=10)


def validate_output(validation, case):
    if (validation.get('decoded_video_frames') != case['frames']
            or (validation.get('width'), validation.get('height')) != (case['width'], case['height'])
            or validation.get('fps') != 24.0
            or not validation.get('decoded_audio_frames')
            or validation.get('audio_channels') != 2):
        raise RuntimeError(f'Unexpected video/audio output: {validation}')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--desktop', type=Path, required=True)
    parser.add_argument('--manifest', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--renderer', choices=('fasth3_omni', 'taomate', 'base'), required=True)
    parser.add_argument('--case', action='append', help='Restrict to named cases; otherwise run all.')
    parser.add_argument('--server', default='http://127.0.0.1:8188')
    parser.add_argument('--timeout', type=int, default=1800)
    parser.add_argument('--dry-run', action='store_true')
    args = parser.parse_args()
    if not args.dry_run and not os.environ.get('GPUQ_LEASE_ID'):
        parser.error('Render through gpuq --profile video-h3, with Gaming Mode/preemption policies.')
    sys.path.insert(0, str(args.desktop.resolve()))
    import video_gen as vg
    manifest = json.loads(args.manifest.read_text(encoding='utf-8'))
    cases = manifest['cases']
    selected = args.case or list(cases)
    if any(key not in cases for key in selected):
        parser.error('Unknown case.')
    args.output.mkdir(parents=True, exist_ok=True)
    if not args.dry_run and not vg.server_ready(args.server):
        raise RuntimeError('The gpuq-managed ComfyUI backend is not ready.')
    if args.renderer == 'fasth3_omni' and not args.dry_run:
        roots = [Path('C:/AI/ComfyUI_fast_models'), vg.COMFY_DIR / 'models']
        model_path = next((root / 'diffusion_models' / MODEL for root in roots
                           if (root / 'diffusion_models' / MODEL).is_file()), None)
        if model_path is None:
            raise RuntimeError(f'Missing pinned model: {MODEL}')
        if sha(model_path) != MODEL_SHA256:
            raise RuntimeError('Omni checkpoint checksum mismatch.')
    for case_id in selected:
        case = cases[case_id]
        source = args.manifest.parent / case['image']
        source_hash = sha(source)
        image_name = 'omni-benchmark-' + uuid.uuid4().hex + source.suffix.lower()
        if not args.dry_run:
            shutil.copy2(source, vg.INPUT_DIR / image_name)
        completed_here = 0
        try:
            for seed in case['seeds']:
                key = f'{case_id}-{seed}-{args.renderer}'
                prefix = f'video/experiments/fasth3_omni/{uuid.uuid4().hex}/{key}'
                graph = graph_for(vg, case, args.renderer, seed, image_name, prefix)
                signature = dict(case=case, renderer=args.renderer, seed=seed,
                    source_image_sha256=source_hash, generator_sha256=sha(args.desktop / 'video_gen.py'),
                    templates={p.name: sha(p) for p in (args.desktop / 'templates').glob('h3_*.json')},
                    renderer_sha256=sha(Path(build_prompt.__code__.co_filename)),
                    harness_sha256=sha(Path(__file__)), model_revision=MODEL_REVISION)
                request_path = args.output / (key + '.request.json')
                if request_path.exists() and json.loads(request_path.read_text()) != signature:
                    raise RuntimeError(f'{key}: experiment changed; use a new output directory.')
                save(request_path, signature)
                result_path = args.output / (key + '.result.json')
                video_path = args.output / (key + '.mp4')
                if result_path.exists() and video_path.exists():
                    print(f'Already complete: {key}', flush=True)
                    continue
                save(args.output / (key + '.workflow.json'), graph)
                if args.dry_run:
                    print(f'Compiled {key}', flush=True)
                    continue
                client = 'omni-benchmark-' + uuid.uuid4().hex
                progress = vg.LiveProgress(args.server, client,
                    {k: n['class_type'] for k, n in graph.items()}, (10, args.timeout))
                progress.start()
                prompt_id = None
                finished = False
                started = time.monotonic()
                try:
                    response = vg.api_json(args.server, '/prompt', {'prompt': graph, 'client_id': client}, timeout=30)
                    if not response.get('prompt_id'):
                        raise RuntimeError(str(response))
                    prompt_id = response['prompt_id']
                    save(args.output / (key + '.submitted.json'), dict(prompt_id=prompt_id,
                         gpuq_lease=os.environ['GPUQ_LEASE_ID']))
                    progress.set_prompt_id(prompt_id)
                    output = vg.wait_for_generation(args.server, prompt_id, prefix, args.timeout, progress)
                    elapsed = time.monotonic() - started
                    finished = True
                    validation = vg.validate_video(output)
                    validate_output(validation, case)
                    steps = {'fasth3_omni': 8, 'taomate': 3, 'base': 20}[args.renderer]
                    sampling = progress.sampling_summaries()
                    if sum(r['steps_observed'] for r in sampling) != steps:
                        raise RuntimeError(f'Expected {steps} fresh sampling steps: {sampling}')
                    shutil.copy2(output, video_path)
                    result = dict(signature, elapsed_seconds=round(elapsed, 3),
                        generated_seconds=case['frames'] / 24, realtime_factor=elapsed / (case['frames'] / 24),
                        cache_context='consecutive fresh seed, same case/model' if completed_here else
                                      'first run after admission or case change; cache uncontrolled',
                        stage_seconds=progress.stage_durations, node_seconds=progress.node_summaries(),
                        sampling_runs=sampling, validation=validation, prompt_id=prompt_id,
                        graph_sha256=sha(args.output / (key + '.workflow.json')),
                        model_sha256=MODEL_SHA256 if args.renderer == 'fasth3_omni' else None)
                    save(result_path, result)
                    completed_here += 1
                    print(f'COMPLETE {key}: {elapsed:.3f}s', flush=True)
                except BaseException as error:
                    save(args.output / (key + '.error.json'), dict(error=str(error), prompt_id=prompt_id))
                    raise
                finally:
                    progress.stop()
                    if prompt_id and not finished:
                        cancel_owned(vg, args.server, prompt_id)
        finally:
            # UUID input ownership makes cleanup safe across simultaneous clients.
            # Hard preemption is handled by gpuq; its backend is terminated too.
            if not args.dry_run:
                (vg.INPUT_DIR / image_name).unlink(missing_ok=True)


if __name__ == '__main__':
    main()
