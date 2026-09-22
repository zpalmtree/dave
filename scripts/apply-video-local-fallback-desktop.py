#!/usr/bin/env python3
"""Install the audited local Qwen fallback for recovery jobs (protocol 3).

Each file's hashes list its revision before the first patch and after each patch
in order, so a desktop at any recorded revision receives only the patches it lacks.
"""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--directory', type=Path, default=Path('/mnt/d/AI/ComfyUI_windows_portable/video_gen'))
    parser.add_argument('--check', action='store_true')
    args = parser.parse_args()
    archive = Path(__file__).resolve().parents[1] / 'desktop'
    manifest = json.loads((archive / 'video-local-fallback-hashes.json').read_text())
    patches = manifest['patches']
    pending = {patch: [] for patch in patches}
    for name, chain in manifest['files'].items():
        actual = hashlib.sha256((args.directory / name).read_bytes()).hexdigest()
        if actual not in chain:
            raise SystemExit(f'Unexpected local edits in {name}; inspect before installing.')
        # Search from the end: an unchanged file repeats its hash across revisions.
        revision = len(chain) - 1 - chain[::-1].index(actual)
        for step in range(revision, len(patches)):
            if chain[step] != chain[step + 1]:
                pending[patches[step]].append(name)
    commands = [['git', 'apply', *[f'--include={name}' for name in names], str(archive / patch)]
                for patch, names in pending.items() if names]
    if not commands:
        print('Desktop local Qwen fallback matches the audited revision.')
        return
    if args.check:
        # Later patches build on earlier ones, so only the first step can be checked in place.
        subprocess.run([*commands[0], '--check'], cwd=args.directory, check=True)
        print('Local Qwen fallback applies to the audited desktop files: '
              + '; '.join(f"{patch}: {', '.join(names)}" for patch, names in pending.items() if names) + '.')
        return
    for command in commands:
        subprocess.run([*command, '--check'], cwd=args.directory, check=True)
        subprocess.run(command, cwd=args.directory, check=True)
    for name, chain in manifest['files'].items():
        if hashlib.sha256((args.directory / name).read_bytes()).hexdigest() != chain[-1]:
            raise SystemExit(f'Post-apply verification failed: {name}')
    print('Applied and verified the local Qwen fallback. Reload the idle worker child to load it.')


if __name__ == '__main__':
    main()
