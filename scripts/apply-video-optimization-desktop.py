#!/usr/bin/env python3
"""Apply the archived desktop changes only to the exact audited source revision."""
import argparse
import hashlib
import json
import subprocess
from pathlib import Path


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--directory", type=Path, default=Path("/mnt/d/AI/ComfyUI_windows_portable/video_gen"))
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    archive = Path(__file__).resolve().parents[1] / "desktop"
    hashes = json.loads((archive / "video-optimization-hashes.json").read_text())
    states = []
    for name, expected in hashes.items():
        actual = hashlib.sha256((args.directory / name).read_bytes()).hexdigest()
        if actual == expected["after_sha256"]:
            states.append("after")
        elif actual == expected["before_sha256"]:
            states.append("before")
        else:
            raise SystemExit(f"Unexpected source revision: {name}; inspect the differences before applying.")
    if set(states) == {"after"}:
        print("Desktop optimization files match the tested revision.")
        return
    if set(states) != {"before"}:
        raise SystemExit("Mixed desktop revisions; inspect before applying the patch.")
    patch = str(archive / "video-optimization.patch")
    subprocess.run(["git", "apply", "--check", patch], cwd=args.directory, check=True)
    if args.check:
        print("Desktop patch applies to the audited source revision.")
        return
    subprocess.run(["git", "apply", patch], cwd=args.directory, check=True)
    for name, expected in hashes.items():
        if hashlib.sha256((args.directory / name).read_bytes()).hexdigest() != expected["after_sha256"]:
            raise SystemExit(f"Post-apply verification failed: {name}")
    print("Applied and verified the desktop optimization patch.")


if __name__ == "__main__":
    main()
