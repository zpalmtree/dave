#!/usr/bin/env python3
"""Frozen, sequential post-render A/B experiment; no production/GPU mutations.

Input: JSON list with id, prompt, source, score, input_sha256 and optional cohort.
Each unique prompt gets one automatic edit and one continuous-music control.
Failed editors are recorded and excluded, never passed off as no-music decisions.
"""
import argparse
import hashlib
import json
from pathlib import Path
import random
import subprocess
import sys

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO / 'desktop'))
from video_score_cues import render
from video_sound_mix import media, mix_video


def save(path, value):
    temporary = path.with_name(path.name + '.tmp')
    temporary.write_text(json.dumps(value, indent=2) + '\n')
    temporary.replace(path)


def sha(path):
    digest = hashlib.sha256()
    with Path(path).open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(block)
    return digest.hexdigest()


def packets(path):
    return json.loads(subprocess.check_output(['ffprobe', '-v', 'error', '-select_streams', 'v:0',
        '-show_packets', '-show_data_hash', 'sha256', '-show_entries', 'packet=pts,dts,data_hash', '-of', 'json', str(path)]))


def run(manifest, root):
    root.mkdir(parents=True, exist_ok=True)
    packet_path = root / 'renders/human-review/final-videos.json'
    if packet_path.exists():
        raise ValueError('Review already published; never overwrite existing votes')
    lock = root / 'benchmark.lock'
    with lock.open('x') as stream:
        stream.write(str(__import__('os').getpid()))
    try:
        items = json.loads(manifest.read_text())
        ids = [i['id'] for i in items]
        prompts = [' '.join(i['prompt'].lower().split()) for i in items]
        if not items or len(set(ids)) != len(ids) or len(set(prompts)) != len(prompts):
            raise ValueError('Require unique IDs and deduplicated requests')
        if any(not i or any(c not in 'abcdefghijklmnopqrstuvwxyz0123456789-_' for c in i) for i in ids):
            raise ValueError('Unsafe case ID')
        # Pin both editor and mixers. Resume can only reuse exactly this experiment.
        frozen = {'manifest_sha256': sha(manifest), 'files': {str(p.relative_to(REPO)): sha(p) for p in [
            Path(__file__), REPO/'scripts/plan-video-score-edit.mjs', REPO/'desktop/video_score_cues.py', REPO/'desktop/video_sound_mix.py']}}
        frozen_path = root / 'frozen.json'
        if frozen_path.exists() and json.loads(frozen_path.read_text()) != frozen:
            raise ValueError('Experiment code or manifest changed; start a new run')
        save(frozen_path, frozen)
        rng = random.Random(20261024)
        labels = ['A'] * (len(items)//2) + ['B'] * (len(items)-len(items)//2)
        rng.shuffle(labels)
        assignments = {item['id']: {label: ('candidate' if label == candidate else 'control') for label in ['A', 'B']}
                       for item, candidate in zip(items, labels)}
        save(root/'review-key.json', assignments)
        progress = {'status': 'rendering', 'planned_pairs': len(items), 'planned_videos': 2*len(items),
                    'ready_pairs': 0, 'finished_videos': 0, 'failed_videos': 0,
                    'cases': [{'id': i['id'], 'prompt': i['prompt'], 'versions': [
                        {'status': 'pending', 'stage': 'Awaiting editing'}, {'status': 'pending', 'stage': 'Awaiting editing'}]} for i in items]}
        save(root/'progress.json', progress)
        packet = {'schema_version': 1, 'blinded': True, 'rubric': ['timing', 'restraint', 'audio'], 'pairs': []}
        audits = {}
        for index, item in enumerate(items):
            folder = root/'renders'/item['id']; folder.mkdir(parents=True, exist_ok=True)
            source, score = Path(item['source']), Path(item['score'])
            try:
                if sha(source) != item['input_sha256']['source'] or sha(score) != item['input_sha256']['score']:
                    raise ValueError('Input hash changed')
                options = {k: item[k] for k in ['source', 'score', 'prompt']}
                options.update(directory=str(folder/'editor'))
                options.update({k: item[k] for k in ['model', 'noMusic', 'preserveSourceAudio'] if k in item})
                save(folder/'options.json', options)
                progress['cases'][index]['versions'] = [{'status': 'running', 'stage': 'Automatic audiovisual edit'}] * 2
                save(root/'progress.json', progress)
                subprocess.run(['node', str(REPO/'scripts/plan-video-score-edit.mjs'), str(folder/'options.json')], check=True, timeout=480)
                receipt = json.loads((folder/'editor/edit.json').read_text())
                if receipt['status'] == 'bypassed':
                    raise ValueError('Explicit soundtrack constraint: excluded from music-placement comparison')
                if receipt['status'] != 'ready':
                    raise ValueError('Editor failed; not a valid no-music decision')
                seconds = receipt['video_seconds']
                control = mix_video(source, folder/'control.mp4', {'effects': 'preserve'}, seconds, score)
                candidate, audit = render(source, score, folder/'candidate.mp4', seconds, receipt['edit']['cues'])
                original_packets = packets(source)
                if packets(control) != original_packets or packets(candidate) != original_packets:
                    raise ValueError('Video packets or timestamps changed')
                videos = []
                for label, arm in assignments[item['id']].items():
                    output = folder/(label+'.mp4')
                    media(['-i', str(control if arm == 'control' else candidate), '-map', '0:v:0', '-map', '0:a:0',
                           '-c', 'copy', '-map_metadata', '-1', '-map_metadata:s', '-1', '-movflags', '+faststart', str(output)])
                    if packets(output) != original_packets:
                        raise ValueError('Review copy changed video')
                    media(['-xerror', '-i', str(output), '-f', 'null', '-'])
                    videos.append({'label': label, 'video_path': str(output)})
                audits[item['id']] = {**audit, 'cohort': item.get('cohort', 'held-out'), 'edit_fingerprint': receipt['fingerprint'],
                    'identical_video_packets_and_timestamps': True, 'full_decode': 'passed',
                    'control_sha256': sha(control), 'candidate_sha256': sha(candidate)}
                packet['pairs'].append({'pair_id': item['id'], 'prompt': item['prompt'], 'videos': videos,
                    'preferred': None, 'overall': {'A': None, 'B': None},
                    'dimension_preferences': {'timing': None, 'restraint': None, 'audio': None},
                    'material_failure': {'A': False, 'B': False}, 'notes': ''})
                progress['ready_pairs'] += 1; progress['finished_videos'] += 2
                progress['cases'][index]['versions'] = [{'status': 'ready', 'stage': 'Validated playback copy'}] * 2
                print('READY', item['id'], flush=True)
            except Exception as error:
                audits[item['id']] = {'failed': str(error)}
                progress['failed_videos'] += 2
                progress['cases'][index]['versions'] = [{'status': 'failed', 'error': str(error)}] * 2
                print('FAILED', item['id'], str(error), flush=True)
            save(root/'audit.json', audits); save(root/'progress.json', progress)
        packet_path.parent.mkdir(parents=True, exist_ok=True)
        save(packet_path, packet)
        progress['status'] = 'awaiting-review' if packet['pairs'] else 'failed'
        save(root/'progress.json', progress)
        return 1 if progress['failed_videos'] else 0
    finally:
        lock.unlink(missing_ok=True)


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--manifest', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    raise SystemExit(run(args.manifest.resolve(), args.output.resolve()))
