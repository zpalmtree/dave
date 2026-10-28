#!/usr/bin/env python3
"""Install pinned local Wan edit weights; never overwrite an unknown installed model.

Run with the Windows embedded Python for native model-disk I/O, or pass --directory
when installing elsewhere. Inference is separate and always requires GPUq.
"""
import argparse
import hashlib
import json
import os
import urllib.request
from pathlib import Path


def digest(path):
    checksum = hashlib.sha256()
    with path.open('rb') as stream:
        for chunk in iter(lambda: stream.read(8 * 1024 * 1024), b''):
            checksum.update(chunk)
    return checksum.hexdigest()


def install(record, directory, check=False):
    path = directory / record['installed']
    if path.exists():
        if path.stat().st_size != record['bytes'] or digest(path) != record['sha256']:
            raise RuntimeError(f'Unexpected existing model: {path}; inspect it before replacing.')
        print(f'Verified {path.name}', flush=True)
        return
    if check:
        raise RuntimeError(f'Missing model: {path}')
    path.parent.mkdir(parents=True, exist_ok=True)
    partial = path.with_suffix(path.suffix + '.part')
    url = f"https://huggingface.co/{record['repository']}/resolve/{record['revision']}/{record['file']}"
    for attempt in range(3):
        offset = partial.stat().st_size if partial.exists() else 0
        if offset == record['bytes']:
            break
        if offset > record['bytes']:
            raise RuntimeError(f'Unexpected partial model: {partial}')
        try:
            request = urllib.request.Request(url, headers={'Range': f'bytes={offset}-'} if offset else {})
            with urllib.request.urlopen(request, timeout=60) as response:
                append = bool(offset and response.status == 206)
                with partial.open('ab' if append else 'wb') as output:
                    while chunk := response.read(8 * 1024 * 1024):
                        output.write(chunk)
            break
        except (OSError, TimeoutError):
            if attempt == 2:
                raise
    if partial.stat().st_size != record['bytes'] or digest(partial) != record['sha256']:
        raise RuntimeError(f'Integrity check failed: {partial}')
    partial.replace(path)
    print(f'Installed and verified {path.name}', flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--directory', type=Path, default=Path(
        r'D:\AI\ComfyUI_windows_portable\ComfyUI\models' if os.name == 'nt'
        else '/mnt/d/AI/ComfyUI_windows_portable/ComfyUI/models'))
    parser.add_argument('--manifest', type=Path, default=Path(__file__).resolve().parents[1] / 'desktop/video-edit-wan-models.json')
    parser.add_argument('--check', action='store_true')
    args = parser.parse_args()
    records = json.loads(args.manifest.read_text())
    # Sequential validation avoids competing full-file scans on the model disk.
    for record in records:
        install(record, args.directory, args.check)


if __name__ == '__main__':
    main()
