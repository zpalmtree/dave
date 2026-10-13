#!/usr/bin/env python3
"""Install the Character Swap renderer and audited worker changes while idle."""
import argparse
import hashlib
import json
import subprocess
from pathlib import Path


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--directory', type=Path,
                        default=Path('/mnt/d/AI/ComfyUI_windows_portable/video_gen'))
    parser.add_argument('--check', action='store_true')
    args = parser.parse_args()
    archive = Path(__file__).resolve().parents[1] / 'desktop'
    hashes = json.loads((archive / 'video-character-swap-hashes.json').read_text())
    states = []
    for name, expected in hashes['patched'].items():
        actual = digest(args.directory / name)
        state = next((s for s in ('before', 'after') if actual == expected[s + '_sha256']), None)
        if state is None:
            raise SystemExit(f'Unexpected source revision: {name}; inspect before applying.')
        states.append(state)
    if len(set(states)) != 1:
        raise SystemExit('Mixed desktop revisions; inspect before applying.')
    for name, expected in hashes['added'].items():
        if digest(archive / name) != expected:
            raise SystemExit(f'Archive checksum mismatch: {name}')
        target = args.directory / name
        if target.exists() and digest(target) != expected:
            raise SystemExit(f'Unexpected existing file: {name}; inspect before replacing.')
    patch = str(archive / 'video-character-swap.patch')
    if states[0] == 'before':
        subprocess.run(['git', 'apply', '--check', patch], cwd=args.directory, check=True)
    if args.check:
        print('Character Swap desktop install is applicable; models are installed separately.')
        return
    for name in hashes['added']:
        (args.directory / name).write_bytes((archive / name).read_bytes())
    if states[0] == 'before':
        subprocess.run(['git', 'apply', patch], cwd=args.directory, check=True)
    for name, expected in hashes['patched'].items():
        if digest(args.directory / name) != expected['after_sha256']:
            raise SystemExit(f'Post-install checksum mismatch: {name}')
    print('Character Swap desktop code installed and verified. Reload the worker while idle.')


if __name__ == '__main__':
    main()
