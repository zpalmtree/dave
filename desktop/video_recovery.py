"""Durable, approved-story recovery. Imported by the desktop worker; no GPU at import."""
from __future__ import annotations

import asyncio
import base64
import copy
import hashlib
import json
import re
import shutil
import subprocess
import time
import traceback
from pathlib import Path

import aiohttp

MAX_SCENE_CYCLES = 2


class RecoveryLimitError(RuntimeError):
    pass


def digest(path: Path) -> str:
    value = hashlib.sha256()
    with path.open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            value.update(block)
    return value.hexdigest()


def ffmpeg() -> str:
    executable = shutil.which('ffmpeg')
    if executable:
        return executable
    from video_gen import ffmpeg_executable
    return ffmpeg_executable()


def media_command(args: list[str]) -> subprocess.CompletedProcess:
    return subprocess.run([ffmpeg(), '-nostdin', '-hide_banner', '-loglevel', 'error',
                           '-threads', '2', '-filter_threads', '2', '-y', *args],
                          capture_output=True, check=True, timeout=300,
                          creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))


def duration(path: Path) -> float:
    import av
    with av.open(str(path)) as container:
        if not container.streams.video or not container.duration:
            raise RuntimeError('The video has no readable duration or video stream.')
        result = container.duration / av.time_base
    media_command(['-i', str(path), '-map', '0:v:0', '-f', 'null', '-'])
    return float(result)


def data_image(path: Path) -> str:
    from PIL import Image
    import io
    with Image.open(path) as source:
        source = source.convert('RGB')
        source.thumbnail((960, 960))
        output = io.BytesIO()
        source.save(output, format='JPEG', quality=85)
    return 'data:image/jpeg;base64,' + base64.b64encode(output.getvalue()).decode('ascii')


def save_image(data: str, path: Path) -> None:
    from PIL import Image
    import io
    if not re.fullmatch(r'data:image/(?:png|jpeg|webp);base64,[A-Za-z0-9+/=]+', data):
        raise ValueError('Invalid image data.')
    raw = base64.b64decode(data.split(',', 1)[1], validate=True)
    if len(raw) > 25 * 1024 * 1024:
        raise ValueError('Image exceeds the limit.')
    with Image.open(io.BytesIO(raw)) as image:
        image.convert('RGB').save(path, format='PNG')


def review_samples(path: Path, root: Path) -> dict:
    seconds = duration(path)
    frames = []
    for index, fraction in enumerate((0, .2, .5, .8, .97)):
        frame = root / f'sample-{index}.jpg'
        media_command(['-ss', str(max(0, min(seconds * fraction, seconds - 0.15))), '-i', str(path),
                       '-frames:v', '1', '-vf', 'scale=640:-2', str(frame)])
        frames.append(data_image(frame))
    audio = root / 'review-audio.wav'
    try:
        media_command(['-i', str(path), '-vn', '-ac', '1', '-ar', '16000', str(audio)])
        encoded_audio = base64.b64encode(audio.read_bytes()).decode('ascii')
    except subprocess.CalledProcessError:
        encoded_audio = None
    from PIL import Image, ImageChops, ImageStat
    with Image.open(root / 'sample-1.jpg') as first, Image.open(root / 'sample-3.jpg') as last:
        difference = ImageStat.Stat(ImageChops.difference(first, last)).mean
    return {'frames': frames, 'audio': encoded_audio, 'frozen': max(difference) < 0.5}


def join_clips(clips: list[Path], destination: Path) -> Path:
    # All paths are generated filenames in task-owned directories, never prompt text.
    manifest = destination.with_suffix('.concat.txt')
    manifest.write_text(''.join("file '" + str(path.resolve()).replace('\\', '/').replace("'", "'\\''") + "'\n" for path in clips), encoding='utf-8')
    media_command(['-f', 'concat', '-safe', '0', '-i', str(manifest), '-c', 'copy', '-movflags', '+faststart', str(destination)])
    duration(destination)
    return destination


def normalize_clip(source: Path, destination: Path) -> Path:
    """Use a common timebase, geometry and audio layout before stream concatenation."""
    import av
    with av.open(str(source)) as container:
        has_audio = bool(container.streams.audio)
    inputs = ['-i', str(source)]
    if not has_audio:
        inputs += ['-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo']
    media_command([*inputs, '-map', '0:v:0', '-map', '0:a:0' if has_audio else '1:a:0',
        '-vf', 'scale=960:720:force_original_aspect_ratio=decrease,pad=960:720:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=24',
        '-c:v', 'libx264', '-preset', 'fast', '-crf', '20', '-pix_fmt', 'yuv420p',
        '-c:a', 'aac', '-ar', '48000', '-ac', '2', '-shortest', str(destination)])
    duration(destination)
    return destination


async def release_recovery_reservation(worker) -> None:
    await worker.finish_gpuq_reservation()
    await worker.stop_gpu_monitor()
    # The legacy worker keeps one reservation for its entire job. Recovery
    # releases it between scenes/reviews, so the next render needs a new lease.
    control = getattr(worker, 'gpuq_control_dir', None)
    worker.gpuq_job_id = None
    worker.gpuq_control_dir = None
    worker.gpuq_request_sequence = 0
    worker.gpuq_log_offset = 0
    worker.gpuq_log_pending = ''
    for key in list(worker.journal):
        if key.startswith('gpuq_'):
            worker.journal.pop(key)
    worker.save_journal()
    if control and control.is_dir():
        shutil.rmtree(control, ignore_errors=True)


async def run_recovery_job(worker, job: dict) -> None:
    from video_worker import SCRIPT_DIR, MODEL_ARGS, GENERATOR, console_python_executable, atomic_json, stable_job_seed
    root = SCRIPT_DIR / 'worker_recovery' / str(job['id'])
    root.mkdir(parents=True, exist_ok=True)
    log = SCRIPT_DIR / 'worker_logs' / f"{job['id']}.log"
    log.parent.mkdir(exist_ok=True)
    started = time.time()
    worker.begin_metrics(job, started)
    worker.save_journal(started=started, log=str(log), recovery_version=2)
    base = re.sub(r'^ws(s?)://', lambda match: 'http' + match[1] + '://', worker.broker_url)
    base = re.sub(r'/v1/worker$', f"/v1/worker/jobs/{job['id']}/recovery/", base)
    contract_hash = ''
    revision = int(job.get('recovery_revision', 0))

    async def request(operation: str, body: dict | None = None):
        if worker.cancel_reason:
            raise asyncio.CancelledError()
        async with worker.http_session.post(base + operation, json={'contract_hash': contract_hash, **(body or {})},
                headers=worker.worker_headers(), timeout=aiohttp.ClientTimeout(total=600, connect=20)) as response:
            value = await response.json(content_type=None)
            if response.status != 200:
                detail = value.get('error') if isinstance(value, dict) else None
                raise RuntimeError(detail or f'Recovery service returned {response.status}')
            if not isinstance(value, dict):
                raise RuntimeError(f'Recovery service returned invalid {operation} data')
            return value

    try:
        await worker.send({'type': 'event', 'event': 'plan', 'job_id': job['id'], 'stage': 'Preparing an approved story'})
        prepared = await request('plan')
        contract_hash = prepared['contract_hash']
        checkpoint_path = root / 'checkpoint.json'
        checkpoint = prepared.get('checkpoint') or {}
        if checkpoint_path.exists():
            local = json.loads(checkpoint_path.read_text(encoding='utf-8'))
            if local.get('contract_hash') == contract_hash:
                checkpoint = local
        if (checkpoint.get('contract_hash') != contract_hash or checkpoint.get('pipeline_version') != 2
                or checkpoint.get('revision') != revision):
            checkpoint = {'contract_hash': contract_hash, 'pipeline_version': 2, 'revision': revision, 'scenes': {}}
        async def save():
            atomic_json(checkpoint_path, checkpoint)
            await request('checkpoint', {'checkpoint': checkpoint})
        source_paths = []
        for index, source in enumerate(prepared.get('sources', [])):
            path = root / f'source-{index}.png'
            save_image(source, path)
            source_paths.append(path)
        plan = prepared['plan']
        clips, artifacts = [], []
        for index, segment in enumerate(plan['segments']):
            scene_root = root / f'scene-{index}'
            scene_root.mkdir(exist_ok=True)
            scene = checkpoint['scenes'].setdefault(str(index), {})
            if not scene.get('video_accepted') and scene.get('cycles', 0) >= MAX_SCENE_CYCLES:
                raise RecoveryLimitError(f'Scene {index + 1} exhausted {MAX_SCENE_CYCLES * 4} render attempts. '
                                         + '; '.join(scene.get('video_issues', [])))
            async def review(path: Path, kind: str, frames=None):
                try:
                    details = {'frames': frames or [data_image(path)]} if kind != 'video' else await asyncio.to_thread(review_samples, path, scene_root)
                except Exception:
                    return {'acceptable': False, 'issues': ['The output could not be fully decoded.']}
                return await request('review', {'segment_index': index, 'kind': kind,
                    'artifact_sha256': digest(path), **details})
            image = scene_root / 'opening.png'
            if scene.get('image_accepted') and (not image.is_file() or digest(image) != scene['image_accepted']):
                scene.pop('image_accepted', None)
                scene['image_attempts'] = 0
            if not scene.get('image_accepted'):
                if (index == 0 and len(source_paths) == 1 and (plan.get('keyframe') or {}).get('recommended') is False
                        and not scene.get('image_attempts')):
                    shutil.copy2(source_paths[0], image)
                    scene['pending_image'] = digest(image)
                    scene['image_attempts'] = 1
                    scene['image_source'] = 'original'
                    await save()
                elif (index > 0 and segment.get('transition') == 'continue' and not scene.get('image_attempts')
                        and not re.match(r'\s*(?:hard\s+)?cut\b', segment['shots'][0]['visual'], re.IGNORECASE)):
                    previous = Path(checkpoint['scenes'][str(index - 1)]['video_path'])
                    seconds = await asyncio.to_thread(duration, previous)
                    await asyncio.to_thread(media_command, ['-ss', str(max(0, seconds - .15)),
                        '-i', str(previous), '-frames:v', '1', str(image)])
                    scene['pending_image'] = digest(image)
                    scene['image_attempts'] = 1
                    scene['image_source'] = 'continuation'
                    await save()
                while scene.get('pending_image') or scene.get('image_attempts', 0) < 2:
                    pending = scene.get('pending_image')
                    if pending and (not image.is_file() or digest(image) != pending):
                        scene.pop('pending_image', None)
                        scene['image_attempts'] = max(0, scene.get('image_attempts', 0) - 1)
                        pending = None
                    if not pending:
                        scene['image_attempts'] = scene.get('image_attempts', 0) + 1
                        await save()
                        try:
                            value = await request('image', {'segment_index': index, 'correction': scene.get('image_issues', [])})
                            save_image(value['image'], image)
                            scene['pending_image'] = digest(image)
                            await save()
                        except Exception as error:
                            scene['image_issues'] = [str(error)]
                            traceback.print_exc()
                            await save()
                            continue
                    verdict = await review(image, 'image')
                    scene.pop('pending_image', None)
                    if verdict['acceptable']:
                        scene['image_accepted'] = digest(image)
                        await save()
                        break
                    scene['image_issues'] = verdict.get('issues', [])
                    await save()
            if not scene.get('image_accepted'):
                scene['image_attempts'] = 0
                await save()
                raise RuntimeError('Waiting to recover the opening image: ' + '; '.join(scene.get('image_issues', [])))
            if scene.get('video_accepted') and (not Path(scene['video_path']).is_file() or digest(Path(scene['video_path'])) != scene['video_accepted']):
                scene.pop('video_accepted', None)
                scene['video_attempts'] = 0
            if not scene.get('video_accepted'):
                while scene.get('pending_video') or scene.get('render_interrupted') or scene.get('video_attempts', 0) < 4:
                    pending = scene.get('pending_video')
                    if pending and Path(pending).is_file():
                        verdict = await review(Path(pending), 'video')
                        scene.pop('pending_video', None)
                        if verdict['acceptable']:
                            scene['video_accepted'] = digest(Path(pending))
                            scene['video_path'] = pending
                            scene['renderer'] = scene.get('pending_renderer', job['model'])
                            await save()
                            break
                        scene['video_issues'] = verdict.get('issues', [])
                        await save()
                    if scene.get('video_attempts', 0) >= 4 and not scene.get('render_interrupted'):
                        break
                    if scene.pop('render_interrupted', False):
                        scene['video_attempts'] = max(0, scene.get('video_attempts', 0) - 1)
                    await save()
                    one = copy.deepcopy(plan)
                    one['segments'] = [copy.deepcopy(segment)]
                    one['segments'][0]['transition'] = 'start'
                    if index > 0:
                        one['keyframe'] = {'recommended': False,
                            'reason': 'Use the accepted opening image for this scene.',
                            'prompt': segment['shots'][0]['visual'], 'reference_requirements': [],
                            'motion_contract': {
                                'subject_orientation': 'Start with the orientation in the supplied opening image.',
                                'gaze_direction': 'Start with the gaze in the supplied opening image.',
                                'travel_direction': 'Follow the action authored for this scene.',
                                'camera_relation': segment['shots'][0]['camera'],
                                'first_second_action': segment['shots'][0]['visual']}}
                    one.pop('segment_keyframes', None)
                    # The full content contract remains at the broker. The generator
                    # receives only the authorized segment, without reinterpreting it.
                    one.pop('prompt_analysis', None)
                    one.pop('semantic_analysis', None)
                    one['duration_mode'] = 'auto'
                    one['target_total_seconds'] = segment['target_seconds']
                    one['generation_total_seconds'] = segment['target_seconds']
                    one['recovery_approved'] = True
                    if scene.get('video_issues'):
                        one['segments'][0]['shots'][0]['visual'] += ' Repair these observed failures: ' + '; '.join(scene['video_issues'])
                    plan_path = scene_root / 'plan.json'
                    atomic_json(plan_path, one)
                    primary = job['model']
                    alternate = 'ltx' if primary.startswith('minimax') else 'minimax'
                    renderer = primary if scene.get('video_attempts', 0) < 2 else alternate
                    reservation_scope = f"scene-{index}-cycle-{scene.get('cycles', 0)}-attempt-{scene.get('video_attempts', 0) + 1}"
                    if not await worker.ensure_gpu_reservation({**job, 'model': renderer,
                            'gpuq_reservation_scope': reservation_scope}):
                        raise asyncio.CancelledError()
                    # Queue/admission outages must not consume a render attempt.
                    scene['video_attempts'] = scene.get('video_attempts', 0) + 1
                    worker.save_journal(run_dir=None, pid=None)
                    command = [console_python_executable(), '-s', str(GENERATOR), *MODEL_ARGS[renderer],
                        '--frontier-plan', str(plan_path), '--approved-plan-only', '--image', str(image), '--keyframe', 'never',
                        '--seed', str((stable_job_seed(job['id']) + index * 101 + scene['video_attempts'] + scene.get('cycles', 0) * 1009) % (2 ** 63)),
                        'Render the supplied approved scene.']
                    scene['render_interrupted'] = True
                    await save()
                    try:
                        code = await worker.run_reserved_command(command)
                        output = worker.find_output(renderer) if code == 0 else None
                    finally:
                        await release_recovery_reservation(worker)
                    scene.pop('render_interrupted', None)
                    await save()
                    if worker.cancel_reason:
                        raise asyncio.CancelledError()
                    if not output:
                        scene['video_issues'] = ['Render did not produce a valid output.']
                        await save()
                        continue
                    candidate = scene_root / f"attempt-{scene['video_attempts']}.mp4"
                    shutil.copy2(output, candidate)
                    scene['pending_video'] = str(candidate)
                    scene['pending_renderer'] = renderer
                    await save()
                    verdict = await review(candidate, 'video')
                    scene.pop('pending_video', None)
                    if verdict['acceptable']:
                        scene['video_accepted'] = digest(candidate)
                        scene['video_path'] = str(candidate)
                        scene['renderer'] = renderer
                        break
                    scene['video_issues'] = verdict.get('issues', [])
                    await save()
                if not scene.get('video_accepted'):
                    scene['cycles'] = scene.get('cycles', 0) + 1
                    scene['video_attempts'] = 0
                    await save()
                    if scene['cycles'] >= MAX_SCENE_CYCLES:
                        raise RecoveryLimitError(f'Scene {index + 1} exhausted {MAX_SCENE_CYCLES * 4} render attempts. '
                                                 + '; '.join(scene.get('video_issues', [])))
                    raise RuntimeError('Recovering the actual scene after both renderers missed it: ' + '; '.join(scene.get('video_issues', [])))
            await save()
        checkpoint['format'] = 'generated'
        await save()
        for index, segment in enumerate(plan['segments']):
            scene = checkpoint['scenes'][str(index)]
            scene_root = root / f'scene-{index}'
            original = Path(scene['video_path'])
            artifacts.append({'sha256': digest(original)})
            clips.append(await asyncio.to_thread(normalize_clip, original, scene_root / 'normalized.mp4'))
        final = await asyncio.to_thread(join_clips, clips, root / 'final.mp4')
        delivery = await worker.prepare_delivery(final, job['id'], duration(final))
        await asyncio.to_thread(duration, delivery)
        await request('quality', {'format': checkpoint['format'], 'result_sha256': digest(delivery), 'artifacts': artifacts})
        await worker.send({'type': 'event', 'event': 'uploading', 'job_id': job['id']})
        await worker.upload(job['id'], delivery)
        notice = prepared.get('notice', '')
        if any(scene.get('renderer') != job['model'] for scene in checkpoint['scenes'].values()):
            notice = (notice + ' An alternate video renderer recovered the scene.').strip()
        await worker.wait_and_send_terminal({'type': 'event', 'event': 'complete', 'job_id': job['id'],
            'runtime_seconds': time.time() - started, 'generation_notice': notice})
        worker.clear_journal()
        await worker.send_ready()
    except asyncio.CancelledError:
        await worker.finish_cancelled_job(job['id'])
    except Exception as error:
        traceback.print_exc()
        await worker.fail_current(str(error), not isinstance(error, RecoveryLimitError))
