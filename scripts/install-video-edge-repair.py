#!/usr/bin/env python3
"""Install the experimental edge-repair tool and pinned model assets, not defaults."""
import argparse
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import urllib.request


# Audited releases 1c5a318, 02c13ec and 01565b4. Only exact files may be upgraded.
PREVIOUS_TOOL_HASHES = {
    'video_edge_repair.py': {'43348c92c4358a94af22972bba98cd77f9a9e11e10252103f926fa82c8009c13',
                             '9ed10a9d34c6b783aabe6df8cab7a8a1bdec39dbd0cffcb44c96c174bc9eaa5d',
                             '8cd1c9ba39eae751dadda731b1f055a2ae24ae6ae52169081decc91c31c78e4e'},
    'test_video_edge_repair.py': {'fdcf899632fa520a6bc19adcb6c2cce984d1f83b27ab754fadd142849369710f',
                                  '10c668b84297133f57861da1e55d4e9ba0367b728dc8b975bf02b978bc35d93d',
                                  'ae412cca24022325116d7f8f37142b081cd4547821f2ddb4ce3c36f30d293e32'},
}


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
    updates = []
    for name, previous in PREVIOUS_TOOL_HASHES.items():
        target = args.directory / name
        current = digest(target) if target.exists() else None
        if current == digest(archive / name):
            continue
        if args.check or current not in previous | {None}:
            raise RuntimeError(f'Missing or unexpected tool revision: {name}')
        updates.append((archive / name, target))
    # Validate both files before replacing either, preserving concurrent edits.
    for source, target in updates:
        shutil.copyfile(source, target)
    print('Verified experimental repair tool, upstream revision and checkpoint hashes.')
    print('Install the optional requirements separately as documented. Worker defaults are unchanged.')


if __name__ == '__main__':
    main()
