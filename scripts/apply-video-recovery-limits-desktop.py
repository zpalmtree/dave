#!/usr/bin/env python3
"""Install the audited recovery budget and source-anatomy update."""
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
    hashes = json.loads((archive / 'video-recovery-limits-hashes.json').read_text())
    pending = {'video-recovery-limits.patch': [], 'video-recovery-limits-upgrade.patch': [], 'video-recovery-two-attempts.patch': []}
    for name, expected in hashes.items():
        actual = hashlib.sha256((args.directory / name).read_bytes()).hexdigest()
        if actual == expected['after_sha256']:
            continue
        if actual == expected['before_sha256']:
            pending['video-recovery-limits.patch'].append(name)
        elif actual == expected.get('intermediate_sha256'):
            pending['video-recovery-limits-upgrade.patch'].append(name)
        elif actual == expected.get('previous_sha256'):
            pending['video-recovery-two-attempts.patch'].append(name)
        else:
            raise SystemExit(f'Unexpected local edits in {name}; inspect before installing.')
    if not any(pending.values()):
        print('Desktop recovery limits and anatomy fixes match the audited revision.')
        return
    commands = [['git', 'apply', *[f'--include={name}' for name in names], str(archive / patch)]
                for patch, names in pending.items() if names]
    for command in commands:
        subprocess.run([*command, '--check'], cwd=args.directory, check=True)
    if args.check:
        print('Recovery limits update applies to the audited desktop files.')
        return
    for command in commands:
        subprocess.run(command, cwd=args.directory, check=True)
    for name, expected in hashes.items():
        if hashlib.sha256((args.directory / name).read_bytes()).hexdigest() != expected['after_sha256']:
            raise SystemExit(f'Post-apply verification failed: {name}')
    print('Applied and verified recovery limits and anatomy fixes.')


if __name__ == '__main__':
    main()
