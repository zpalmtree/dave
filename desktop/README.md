# Desktop video optimization changes

The live generator is outside this repository at
`D:\AI\ComfyUI_windows_portable\video_gen` (WSL:
`/mnt/d/AI/ComfyUI_windows_portable/video_gen`). This directory archives the
tested changes without copying credentials or the desktop's model files.

`video-optimization.patch` covers local planner guidance, frozen render
contracts, the guarded FastH3 canary profile, and their tests.
`video-optimization-hashes.json` records the exact before/after source bytes.

```bash
python3 scripts/apply-video-optimization-desktop.py --check
python3 scripts/apply-video-optimization-desktop.py
```

The installer refuses an unexpected or mixed revision. The September 7 live
files were already updated during implementation, so the check should report
that they match. Run the desktop unit suites from that directory:
`python3 -m unittest test_video_gen test_video_worker test_worker_runtime`.

The long-running worker must reload the updated source while idle. Its supervisor
restarts a terminated worker child; preserve the supervisor and all active
generator/GPUq jobs. The new optional fields are compatible with older leases.
GPU model work always goes through GPUq, including the benchmark renderer.
