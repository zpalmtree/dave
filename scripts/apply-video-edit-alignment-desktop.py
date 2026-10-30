#!/usr/bin/env python3
"""Install replacement mask alignment without overwriting unrelated desktop changes."""
import argparse
import hashlib
import json
import subprocess
from pathlib import Path


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--directory', type=Path, default=Path('/mnt/d/AI/ComfyUI_windows_portable/video_gen'))
    parser.add_argument('--check', action='store_true')
    args = parser.parse_args()
    archive = Path(__file__).resolve().parents[1] / 'desktop'
    hashes = json.loads((archive / 'video-edit-alignment-hashes.json').read_text())
    state = []
    for name, expected in hashes.items():
        digest = hashlib.sha256((args.directory / name).read_bytes()).hexdigest()
        match = next((key for key in ('before', 'after') if digest == expected[key + '_sha256']), None)
        if match is None:
            raise SystemExit(f'Unexpected desktop revision: {name}; inspect before applying.')
        state.append(match)
    if len(set(state)) != 1:
        raise SystemExit('Mixed desktop revisions; inspect before applying.')
    modules = ('video_edit_alignment.py', 'test_video_edit_alignment.py')
    for name in modules:
        target = args.directory / name
        if target.exists() and target.read_bytes() != (archive / name).read_bytes():
            raise SystemExit(f'Unexpected existing {name}; inspect before installing.')
    patch = str(archive / 'video-edit-alignment.patch')
    if state[0] == 'before':
        subprocess.run(['git', 'apply', '--check', patch], cwd=args.directory, check=True)
    if args.check:
        print('Desktop alignment patch verified:', state[0])
        return
    for name in modules:
        (args.directory / name).write_bytes((archive / name).read_bytes())
    if state[0] == 'before':
        subprocess.run(['git', 'apply', patch], cwd=args.directory, check=True)
    for name, expected in hashes.items():
        if hashlib.sha256((args.directory / name).read_bytes()).hexdigest() != expected['after_sha256']:
            raise SystemExit(f'Post-install verification failed: {name}')
    print('Replacement mask alignment installed and verified. New edit subprocesses load it automatically.')


if __name__ == '__main__':
    main()
