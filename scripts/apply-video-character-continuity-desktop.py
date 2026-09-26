#!/usr/bin/env python3
"""Install the audited character continuity update on the desktop worker."""
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
    hashes = json.loads((archive / 'video-character-continuity-hashes.json').read_text())
    current = {name: hashlib.sha256((args.directory / name).read_bytes()).hexdigest()
               for name in hashes}
    if all(current[name] == expected['after_sha256'] for name, expected in hashes.items()):
        print('Desktop character continuity matches the audited revision.')
        return
    if any(current[name] != expected['before_sha256'] for name, expected in hashes.items()):
        raise SystemExit('Unexpected desktop edits; inspect before installing character continuity.')
    command = ['git', 'apply', str(archive / 'video-character-continuity.patch')]
    subprocess.run([*command[:2], '--check', command[2]], cwd=args.directory, check=True)
    if args.check:
        print('Character continuity patch applies to the audited desktop files.')
        return
    subprocess.run(command, cwd=args.directory, check=True)
    for name, expected in hashes.items():
        actual = hashlib.sha256((args.directory / name).read_bytes()).hexdigest()
        if actual != expected['after_sha256']:
            raise SystemExit(f'Post-apply verification failed: {name}')
    print('Applied and verified desktop character continuity.')


if __name__ == '__main__':
    main()
