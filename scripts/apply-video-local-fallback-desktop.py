#!/usr/bin/env python3
"""Install the audited local Qwen fallback for rejected recovery jobs (protocol 3)."""
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
    hashes = json.loads((archive / 'video-local-fallback-hashes.json').read_text())
    # A file at its original baseline needs both patches; one at the first revision needs only the second.
    pending = {'video-local-fallback.patch': [], 'video-local-fallback-2.patch': []}
    for name, expected in hashes.items():
        actual = hashlib.sha256((args.directory / name).read_bytes()).hexdigest()
        if actual == expected['after_sha256']:
            continue
        if actual == expected['before_sha256']:
            pending['video-local-fallback.patch'].append(name)
            if 'intermediate_sha256' in expected:
                pending['video-local-fallback-2.patch'].append(name)
        elif actual == expected.get('intermediate_sha256'):
            pending['video-local-fallback-2.patch'].append(name)
        else:
            raise SystemExit(f'Unexpected local edits in {name}; inspect before installing.')
    if not any(pending.values()):
        print('Desktop local Qwen fallback matches the audited revision.')
        return
    commands = [['git', 'apply', *[f'--include={name}' for name in names], str(archive / patch)]
                for patch, names in pending.items() if names]
    if args.check:
        # The second patch applies on top of the first, so only the first step can be checked in place.
        subprocess.run([*commands[0], '--check'], cwd=args.directory, check=True)
        print('Local Qwen fallback applies to the audited desktop files: '
              + '; '.join(f"{patch}: {', '.join(names)}" for patch, names in pending.items() if names) + '.')
        return
    for command in commands:
        subprocess.run([*command, '--check'], cwd=args.directory, check=True)
        subprocess.run(command, cwd=args.directory, check=True)
    for name, expected in hashes.items():
        if hashlib.sha256((args.directory / name).read_bytes()).hexdigest() != expected['after_sha256']:
            raise SystemExit(f'Post-apply verification failed: {name}')
    print('Applied and verified the local Qwen fallback. Reload the idle worker child to advertise protocol 3.')


if __name__ == '__main__':
    main()
