#!/usr/bin/env python3
"""Apply the audited PDD compatibility fix to an explicitly selected ComfyUI copy."""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--directory', type=Path, required=True,
                        help='Use an isolated ComfyUI copy for this experiment.')
    parser.add_argument('--check', action='store_true')
    args = parser.parse_args()
    archive = Path(__file__).resolve().parents[1] / 'desktop'
    hashes = json.loads((archive / 'video-fasth3-omni-comfy-hashes.json').read_text())
    states = []
    for name, expected in hashes.items():
        actual = hashlib.sha256((args.directory / name).read_bytes()).hexdigest()
        if actual == expected['after_sha256']:
            states.append('after')
        elif actual == expected['before_sha256']:
            states.append('before')
        else:
            raise SystemExit(f'Unexpected ComfyUI revision: {name}; inspect before applying.')
    if set(states) == {'after'}:
        print('ComfyUI PDD files match the audited patched revision.')
        return
    if set(states) != {'before'}:
        raise SystemExit('Mixed revisions; inspect before applying.')
    patch = str(archive / 'video-fasth3-omni-comfy.patch')
    subprocess.run(['git', 'apply', '--check', patch], cwd=args.directory, check=True)
    if args.check:
        print('PDD patch applies to the audited revision.')
        return
    subprocess.run(['git', 'apply', patch], cwd=args.directory, check=True)
    for name, expected in hashes.items():
        if hashlib.sha256((args.directory / name).read_bytes()).hexdigest() != expected['after_sha256']:
            raise SystemExit(f'Post-apply verification failed: {name}')
    print('Applied and verified the PDD patch. Restart only the selected isolated server.')


if __name__ == '__main__':
    main()
