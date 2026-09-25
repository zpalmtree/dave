#!/usr/bin/env python3
"""Install original-song support only on the audited desktop source revision."""
import argparse
import hashlib
import json
import subprocess
from pathlib import Path


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--directory', type=Path, default=Path('/mnt/d/AI/ComfyUI_windows_portable/video_gen'))
    parser.add_argument('--check', action='store_true')
    args = parser.parse_args()
    archive = Path(__file__).resolve().parents[1] / 'desktop'
    hashes = json.loads((archive / 'video-source-audio-hashes.json').read_text())
    states = []
    for name, expected in hashes.items():
        actual = digest(args.directory / name)
        state = next((state for state in ('before', 'after') if actual == expected[state + '_sha256']), None)
        if state is None:
            raise SystemExit(f'Unexpected source revision: {name}; inspect before applying.')
        states.append(state)
    if len(set(states)) != 1:
        raise SystemExit('Mixed desktop revisions; inspect before applying.')
    for name in ('video_source_audio.py',):
        target = args.directory / name
        if target.exists() and target.read_bytes() != (archive / name).read_bytes():
            raise SystemExit(f'Unexpected local edits in {name}; inspect before installing.')
    patch = str(archive / 'video-source-audio.patch')
    if states[0] == 'before':
        subprocess.run(['git', 'apply', '--check', patch], cwd=args.directory, check=True)
    if args.check:
        print('Desktop song patch is applicable.' if states[0] == 'before' else 'Desktop song patch matches the audited revision.')
        return
    (args.directory / 'video_source_audio.py').write_bytes((archive / 'video_source_audio.py').read_bytes())
    if states[0] == 'before':
        subprocess.run(['git', 'apply', patch], cwd=args.directory, check=True)
    for name, expected in hashes.items():
        if digest(args.directory / name) != expected['after_sha256']:
            raise SystemExit(f'Post-install verification failed: {name}')
    print('Desktop original-song support is installed and verified. Reload the worker while idle.')


if __name__ == '__main__':
    main()
