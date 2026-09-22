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
    pending = []
    for name, expected in hashes.items():
        actual = hashlib.sha256((args.directory / name).read_bytes()).hexdigest()
        if actual == expected['after_sha256']:
            continue
        if actual != expected['before_sha256']:
            raise SystemExit(f'Unexpected local edits in {name}; inspect before installing.')
        pending.append(name)
    if not pending:
        print('Desktop local Qwen fallback matches the audited revision.')
        return
    command = ['git', 'apply', *[f'--include={name}' for name in pending], str(archive / 'video-local-fallback.patch')]
    subprocess.run([*command, '--check'], cwd=args.directory, check=True)
    if args.check:
        print(f"Local Qwen fallback applies to the audited desktop files: {', '.join(pending)}.")
        return
    subprocess.run(command, cwd=args.directory, check=True)
    for name, expected in hashes.items():
        if hashlib.sha256((args.directory / name).read_bytes()).hexdigest() != expected['after_sha256']:
            raise SystemExit(f'Post-apply verification failed: {name}')
    print('Applied and verified the local Qwen fallback. Reload the idle worker child to advertise protocol 3.')


if __name__ == '__main__':
    main()
