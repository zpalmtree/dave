#!/usr/bin/env python3
"""Enable the official H3 VAE optimizations on the audited portable installation."""
import argparse
import hashlib
import json
import subprocess
from pathlib import Path


MODEL = "minimax_h3_video_vae_int8_convrot.safetensors"
MODEL_SHA256 = "52a2c8c73583c86e4f41cdcce3a6ad0ea562987bc0bf3d60a0cef5f5c8e60c0e"


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--directory", type=Path, default=Path("/mnt/d/AI/ComfyUI_windows_portable"))
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    archive = Path(__file__).resolve().parents[1] / "desktop"
    hashes = json.loads((archive / "h3-vae-speed-hashes.json").read_text())
    states = []
    for name, expected in hashes.items():
        actual = hashlib.sha256((args.directory / name).read_bytes()).hexdigest()
        if actual == expected["after_sha256"]:
            states.append("after")
        elif actual == expected["before_sha256"]:
            states.append("before")
        else:
            raise SystemExit(f"Unexpected source revision: {name}; inspect before applying.")
    model = args.directory / "ComfyUI" / "models" / "vae" / MODEL
    if not model.is_file():
        raise SystemExit(f"Install the official INT8 VAE first: {model}")
    digest = hashlib.sha256()
    with model.open("rb") as handle:
        for chunk in iter(lambda: handle.read(8 * 1024 * 1024), b""):
            digest.update(chunk)
    if digest.hexdigest() != MODEL_SHA256:
        raise SystemExit("INT8 VAE checksum does not match the official model.")
    if set(states) == {"after"}:
        print("H3 VAE settings and official model match the verified revision.")
        return
    if set(states) != {"before"}:
        raise SystemExit("Mixed desktop revisions; inspect before applying.")
    patch = str(archive / "h3-vae-speed.patch")
    subprocess.run(["git", "apply", "--check", patch], cwd=args.directory, check=True)
    if args.check:
        print("H3 VAE patch applies and the official model checksum matches.")
        return
    subprocess.run(["git", "apply", patch], cwd=args.directory, check=True)
    for name, expected in hashes.items():
        if hashlib.sha256((args.directory / name).read_bytes()).hexdigest() != expected["after_sha256"]:
            raise SystemExit(f"Post-apply verification failed: {name}")
    print("Applied and verified H3 VAE settings. Refresh ComfyUI through GPUq after active work finishes.")


if __name__ == "__main__":
    main()
