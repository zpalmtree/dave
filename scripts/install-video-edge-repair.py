#!/usr/bin/env python3
"""Install the experimental edge-repair tool and pinned model assets, not defaults."""
import argparse
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import urllib.request


def digest(path):
    value = hashlib.sha256()
    with path.open('rb') as stream:
        for block in iter(lambda: stream.read(8*1024*1024), b''):
            value.update(block)
    return value.hexdigest()


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--directory', type=Path, default=Path('/mnt/d/AI/ComfyUI_windows_portable/video_gen'))
    p.add_argument('--check', action='store_true')
    args = p.parse_args()
    archive = Path(__file__).resolve().parents[1] / 'desktop'
    manifest = json.loads((archive / 'video-edge-repair-models.json').read_text())
    repo = args.directory / 'optional/ProPainter'
    if not repo.exists() and not args.check:
        repo.parent.mkdir(parents=True, exist_ok=True)
        subprocess.run(['git', 'clone', manifest['propainter']['repository'], str(repo)], check=True)
        subprocess.run(['git', '-C', str(repo), 'checkout', '--detach', manifest['propainter']['revision']], check=True)
    if not repo.exists() or subprocess.check_output(['git', '-C', str(repo), 'rev-parse', 'HEAD'], text=True).strip() != manifest['propainter']['revision']:
        raise RuntimeError('Missing or unexpected ProPainter revision.')
    if subprocess.check_output(['git', '-C', str(repo), 'status', '--porcelain', '--untracked-files=no'], text=True).strip():
        raise RuntimeError('ProPainter has unreviewed tracked edits.')
    for record in manifest['models']:
        target = args.directory / record['path']
        if not target.exists() and not args.check:
            target.parent.mkdir(parents=True, exist_ok=True)
            partial = target.with_suffix(target.suffix + '.download')
            if partial.exists():
                raise RuntimeError(f'Inspect previous download first: {partial}')
            urllib.request.urlretrieve(record['url'], partial)
            if partial.stat().st_size != record['size'] or digest(partial) != record['sha256']:
                raise RuntimeError('Downloaded checkpoint failed integrity validation.')
            partial.replace(target)
        if not target.exists() or target.stat().st_size != record['size'] or digest(target) != record['sha256']:
            raise RuntimeError(f'Missing or unexpected checkpoint: {target.name}')
    for name in ['video_edge_repair.py', 'test_video_edge_repair.py']:
        target = args.directory / name
        if not target.exists() and not args.check:
            shutil.copyfile(archive / name, target)
        if not target.exists() or digest(target) != digest(archive / name):
            raise RuntimeError(f'Missing or unexpected tool revision: {name}')
    print('Verified experimental repair tool, upstream revision and checkpoint hashes.')
    print('Install the optional requirements separately as documented. Worker defaults are unchanged.')


if __name__ == '__main__':
    main()
