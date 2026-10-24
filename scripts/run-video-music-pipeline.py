#!/usr/bin/env python3
"""Experimental brief -> GPUq composition -> audiovisual edit -> blinded review.

Usage: --manifest cases.json --output run --runtime D:-mounted-directory
The manifest pins source, score, control and preview SHA256s for each unique case.
The control is an already-rendered baseline; this measures the complete pipeline.
"""
import argparse
import fcntl
import hashlib
import json
from pathlib import Path
import random
import shutil
import subprocess
import sys
import time

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO/'desktop'))
from video_score_cues import render
from video_sound_mix import media


def sha(path):
    h = hashlib.sha256()
    with Path(path).open('rb') as f:
        for chunk in iter(lambda: f.read(1024*1024), b''):
            h.update(chunk)
    return h.hexdigest()


def save(path, value):
    p = path.with_name(path.name+'.tmp')
    p.write_text(json.dumps(value, indent=2)+'\n'); p.replace(path)


def packets(path):
    return json.loads(subprocess.check_output(['ffprobe', '-v', 'error', '-select_streams', 'v:0',
        '-show_packets', '-show_data_hash', 'sha256', '-show_entries', 'packet=pts,dts,data_hash', '-of', 'json', str(path)]))


def run(args):
    root, runtime = args.output.resolve(), args.runtime.resolve()
    root.mkdir(parents=True, exist_ok=True); runtime.mkdir(parents=True, exist_ok=True)
    lock = (root/'pipeline.lock').open('a'); fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    packet_path = root/'renders/human-review/final-videos.json'
    if packet_path.exists() and json.loads(packet_path.read_text())['pairs']:
        raise RuntimeError('Already published; do not overwrite votes')
    items = json.loads(args.manifest.read_text())
    ids = [i['id'] for i in items]
    if not items or len(set(ids)) != len(ids) or len({' '.join(i['prompt'].lower().split()) for i in items}) != len(items):
        raise ValueError('Require unique IDs and deduplicated prompts')
    if any(not id or any(c not in 'abcdefghijklmnopqrstuvwxyz0123456789-_' for c in id) for id in ids):
        raise ValueError('Unsafe case ID')
    files = [Path(__file__), REPO/'scripts/plan-video-music-brief.mjs', REPO/'scripts/plan-video-score-edit.mjs',
             REPO/'desktop/compose_music_experiment.py', REPO/'desktop/video_score_cues.py', REPO/'desktop/video_sound_mix.py']
    frozen = {'manifest': sha(args.manifest), 'runtime': sha(root/'runtime-hashes.json'),
              'files': {str(p.relative_to(REPO)): sha(p) for p in files}}
    if (root/'frozen.json').exists() and json.loads((root/'frozen.json').read_text()) != frozen:
        raise RuntimeError('Frozen experiment changed; use a new directory')
    save(root/'frozen.json', frozen)
    candidate_labels = ['A']*(len(items)//2)+['B']*(len(items)-len(items)//2)
    random.Random(2026102412).shuffle(candidate_labels)
    key = {i['id']: {label: 'candidate' if label == chosen else 'control' for label in ['A', 'B']} for i, chosen in zip(items, candidate_labels)}
    save(root/'review-key.json', key)
    packet = {'schema_version': 1, 'blinded': True, 'rubric': ['timing', 'restraint', 'audio'],
              'require_acceptability': True, 'pairs': []}
    packet_path.parent.mkdir(parents=True, exist_ok=True); save(packet_path, packet)
    progress = {'status': 'running', 'started_at': time.time(), 'planned_pairs': len(items), 'planned_videos': 2*len(items),
                'ready_pairs': 0, 'finished_videos': 0, 'failed_videos': 0,
                'cases': [{'id': i['id'], 'prompt': i['prompt'], 'versions': [{'status': 'ready', 'stage': 'Existing baseline'}, {'status': 'pending', 'stage': 'Scheduled'}]} for i in items]}
    save(root/'progress.json', progress); audits = {}
    for index, item in enumerate(items):
        folder = root/'renders'/item['id']; folder.mkdir(parents=True, exist_ok=True)
        work = runtime/item['id']; work.mkdir(parents=True, exist_ok=True)
        def stage(text):
            progress['cases'][index]['versions'][1] = {'status': 'running', 'stage': text}
            save(root/'progress.json', progress); print(item['id'], text, flush=True)
        try:
            for field, digest in item['input_sha256'].items():
                if sha(item[field]) != digest:
                    raise RuntimeError('Changed input: '+field)
            if subprocess.run(['gpuq', 'gaming', 'check', '--quiet']).returncode not in (0, 75):
                raise RuntimeError('CPU admission state unavailable')
            stage('Writing concrete musical brief')
            options = {k: item[k] for k in ['prompt', 'preview', 'seed', 'seconds', 'model']}
            options['directory'] = str(folder/'brief'); save(folder/'brief-options.json', options)
            subprocess.run(['node', str(REPO/'scripts/plan-video-music-brief.mjs'), str(folder/'brief-options.json')], check=True, timeout=480)
            brief = json.loads((folder/'brief/brief.json').read_text())
            if brief['status'] != 'ready':
                raise RuntimeError('Explicit no-music/source-audio constraint; exclude from generation comparison')
            save(work/'spec.json', brief['spec'])
            shutil.copy2(root/'runtime-hashes.json', work/'runtime-hashes.json')
            shutil.copy2(REPO/'desktop/compose_music_experiment.py', work/'compose.py')
            win = lambda p: subprocess.check_output(['wslpath', '-w', str(p)], text=True).strip()
            live = Path('/mnt/d/AI/ComfyUI_windows_portable/video_gen')
            stage('Submitted to GPUq; awaiting admission or composing')
            command = ['gpuq', 'run', '--profile', 'video-h3-isolated', '--priority', 'background',
                       '--when-gaming', 'hold', '--on-preempt', 'requeue', '--idempotent', '--max-attempts', '3',
                       '--expected-duration-low-seconds', '30', '--expected-duration-high-seconds', '900', '--',
                       r'D:\AI\ComfyUI_windows_portable\python_embeded\python.exe', '-s', win(work/'compose.py'), win(work), win(live)]
            with (folder/'composition.log').open('a') as log:
                subprocess.run(command, stdout=log, stderr=subprocess.STDOUT, check=True)
            score = work/'score.flac'; receipt = json.loads((work/'score-receipt.json').read_text())
            if sha(score) != receipt['sha256'] or receipt['spec_sha256'] != sha(work/'spec.json'):
                raise RuntimeError('Generated score provenance mismatch')
            if subprocess.run(['gpuq', 'gaming', 'check', '--quiet']).returncode not in (0, 75):
                raise RuntimeError('CPU admission state unavailable')
            stage('Editing the new track against finished footage')
            edit_options = {'model': item['model'], 'prompt': item['prompt'], 'source': item['source'],
                            'score': str(score), 'directory': str(folder/'editor')}
            save(folder/'edit-options.json', edit_options)
            subprocess.run(['node', str(REPO/'scripts/plan-video-score-edit.mjs'), str(folder/'edit-options.json')], check=True, timeout=480)
            edit = json.loads((folder/'editor/edit.json').read_text())
            if edit['status'] != 'ready':
                raise RuntimeError('Editor failed, not a valid silence choice')
            stage('Mixing and validating finished comparison')
            source, control = Path(item['source']), Path(item['control'])
            candidate, audit = render(source, score, folder/'candidate.mp4', edit['video_seconds'], edit['edit']['cues'])
            original_packets = packets(source)
            if packets(control) != original_packets or packets(candidate) != original_packets:
                raise RuntimeError('Video packets or timestamps changed')
            videos = []
            for label, arm in key[item['id']].items():
                out = folder/(label+'.mp4')
                media(['-i', str(candidate if arm == 'candidate' else control), '-map', '0:v:0', '-map', '0:a:0', '-c', 'copy',
                       '-map_metadata', '-1', '-map_metadata:s', '-1', '-movflags', '+faststart', str(out)])
                if packets(out) != original_packets:
                    raise RuntimeError('Review copy changed video')
                media(['-xerror', '-i', str(out), '-f', 'null', '-'])
                videos.append({'label': label, 'video_path': str(out)})
            audits[item['id']] = {**audit, 'brief_fingerprint': brief['fingerprint'], 'edit_fingerprint': edit['fingerprint'],
                'new_score_sha256': sha(score), 'control_sha256': sha(control), 'candidate_sha256': sha(candidate),
                'identical_outputs': sha(control) == sha(candidate), 'identical_video_packets_and_timestamps': True, 'full_decode': 'passed'}
            if audits[item['id']]['identical_outputs']:
                progress.setdefault('identical_cases_excluded', []).append(item['id'])
                progress['planned_pairs'] -= 1
            else:
                packet['pairs'].append({'pair_id': item['id'], 'prompt': item['prompt'], 'videos': videos, 'preferred': None,
                    'acceptability': {'A': None, 'B': None}, 'overall': {'A': None, 'B': None},
                    'dimension_preferences': {'timing': None, 'restraint': None, 'audio': None},
                    'material_failure': {'A': False, 'B': False}, 'notes': ''})
                progress['ready_pairs'] += 1
            progress['finished_videos'] += 2
            progress['cases'][index]['versions'] = [{'status': 'ready', 'stage': 'Validated playback copy'}]*2
            print('READY', item['id'], flush=True)
        except Exception as error:
            audits[item['id']] = {'failed': str(error)}
            progress['failed_videos'] += 1; progress['finished_videos'] += 1
            progress['cases'][index]['versions'][1] = {'status': 'failed', 'error': str(error)}
            print('FAILED', item['id'], str(error), flush=True)
        save(root/'audit.json', audits); save(root/'progress.json', progress)
    save(packet_path, packet)
    progress['status'] = 'awaiting-review' if packet['pairs'] else ('failed' if progress['failed_videos'] else 'no-differences'); progress['finished_at'] = time.time()
    save(root/'progress.json', progress)
    return 1 if progress['failed_videos'] else 0


if __name__ == '__main__':
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--manifest', type=Path, required=True); p.add_argument('--output', type=Path, required=True)
    p.add_argument('--runtime', type=Path, required=True)
    raise SystemExit(run(p.parse_args()))
