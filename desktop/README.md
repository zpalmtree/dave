# Desktop video optimization changes

## Audio continuity

`video-audio-continuity.patch` adds shared speaker profiles, independent audio
edits, duration-correct assembly, and an opening-only default for the H3 blanket
audio mute. See [audio continuity](../docs/video-audio-continuity.md) for behavior,
limitations, regression coverage and installation. The patch changes only the
generator and its tests; new generator invocations load it without restarting
the worker or interrupting active renders.

## Continuity-frame fallback and delivery repair

`video-fallback-delivery.patch` fixes local validation of speech accidentally
placed in an audio field with empty dialogue, cleans that speech from semantic
fallbacks, and skips derived-frame requests without a confirmed screenplay ID.
Even a confirmed plan mismatch discards the derived frame and uses the configured
cut fallback instead of aborting the video. Completed renders report this
fallback to the broker for the Discord delivery notice.

The patch and `video-fallback-delivery-hashes.json` archive the live September 10
changes and regression tests. Apply only to the recorded baseline:

```bash
python3 scripts/apply-video-fallback-delivery-desktop.py --check
python3 scripts/apply-video-fallback-delivery-desktop.py
```

Reload the supervised worker child while idle after installing. Existing saved
runs with `plan_mismatch` frame-failure markers can resume using `video_gen.py
--resume RUN_DIRECTORY`; the generator reuses validated completed clips.
Launch that recovery through `gpuq` like any other render.

The live generator is outside this repository at
`D:\AI\ComfyUI_windows_portable\video_gen` (WSL:
`/mnt/d/AI/ComfyUI_windows_portable/video_gen`). This directory archives the
tested changes without copying credentials or the desktop's model files.

`video-optimization.patch` covers local planner guidance, frozen render
contracts, the guarded FastH3 canary profile, H3 named-speaker binding,
dialogue/action staging, close-up cast ownership, physically consistent reading
angles, and their tests.
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
