#!/usr/bin/env python3
"""Own a disposable ComfyUI server under gpuq's video-h3-isolated profile."""
import argparse
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import time
import urllib.request


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--comfy', type=Path, required=True)
    parser.add_argument('--desktop', type=Path, required=True)
    parser.add_argument('--manifest', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--port', type=int, default=8197)
    parser.add_argument('--renderers', nargs='+', choices=('fasth3_omni', 'base', 'taomate'), default=['fasth3_omni'])
    args = parser.parse_args()
    if not os.environ.get('GPUQ_LEASE_ID'):
        parser.error('Use gpuq --profile video-h3-isolated.')
    for name in ('comfy', 'desktop', 'manifest', 'output'):
        setattr(args, name, getattr(args, name).resolve())
    with socket.socket() as probe:
        if probe.connect_ex(('127.0.0.1', args.port)) == 0:
            raise RuntimeError(f'Port {args.port} is occupied; do not reuse another server.')
    args.output.mkdir(parents=True, exist_ok=True)
    original = args.desktop.parent / 'ComfyUI'
    paths = args.output / 'original-model-paths.yaml'
    paths.write_text('original_models:\n  base_path: ' + (original / 'models').as_posix() + '\n'
        + ''.join(f'  {name}: {name}/\n' for name in ['diffusion_models', 'text_encoders', 'vae', 'loras']), encoding='utf-8')
    server = f'http://127.0.0.1:{args.port}'
    with (args.output / 'comfy.log').open('a', encoding='utf-8') as log:
        # Embedded Python's ._pth pins the production ComfyUI directory. Insert
        # this copy before importing main, otherwise the isolated entrypoint
        # silently imports the production comfy package.
        bootstrap = ('import runpy,sys; from pathlib import Path; '
                     'main=Path(sys.argv.pop(1)).resolve(); '
                     'sys.path.insert(0,str(main.parent)); sys.argv[0]=str(main); '
                     'runpy.run_path(str(main),run_name="__main__")')
        child = subprocess.Popen([sys.executable, '-s', '-c', bootstrap, str(args.comfy / 'main.py'),
            '--windows-standalone-build', '--disable-auto-launch', '--fast-disk', '--vram-headroom', '4',
            '--listen', '127.0.0.1', '--port', str(args.port),
            '--input-directory', str(original / 'input'), '--output-directory', str(original / 'output'),
            '--extra-model-paths-config', str(original / 'extra_model_paths.yaml'), str(paths)],
            cwd=args.comfy, stdout=log, stderr=log)
        try:
            deadline = time.monotonic() + 180
            while time.monotonic() < deadline:
                if child.poll() is not None:
                    raise RuntimeError(f'Isolated ComfyUI exited {child.returncode}; inspect comfy.log.')
                try:
                    with urllib.request.urlopen(server + '/system_stats', timeout=2) as response:
                        stats = json.load(response)
                    (args.output / 'system-stats.json').write_text(json.dumps(stats, indent=2))
                    break
                except OSError:
                    time.sleep(1)
            else:
                raise RuntimeError('Isolated ComfyUI did not become ready within 180 seconds.')
            for renderer in args.renderers:
                subprocess.run([sys.executable, str(Path(__file__).with_name('benchmark-video-omni.py')),
                    '--desktop', str(args.desktop), '--manifest', str(args.manifest),
                    '--output', str(args.output), '--server', server, '--renderer', renderer], check=True)
        finally:
            child.terminate()
            try:
                child.wait(timeout=15)
            except subprocess.TimeoutExpired:
                child.kill()
                child.wait(timeout=10)


if __name__ == '__main__':
    main()
