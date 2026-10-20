# FastH3 Omni experiment

`desktop/video_fasth3_omni.py` provides the experimental `fasth3_omni` renderer
used by `scripts/benchmark-video-omni.py`. It produces a single scene from
ordered image references, with optional audio references and generated stereo
audio. It is separate from automatic bot routing: main H3 remains the existing
20-step renderer and fast commands remain three-step TaoMate. See the
[October 20 comparison](../benchmarks/video-omni-results-2026-10-20.md) for
measured speed, dialogue checks and promotion blockers.

The graph follows the official
[OmniRef workflow](https://github.com/Comfy-Org/workflow_templates/blob/main/templates/video_fasth3_ominiref_r2v.json)
(template Git blob `86e9389e3ccc27e9173ddfea4398aa83ed740717`): Euler/simple,
eight steps, guidance 1, video/audio shifts 12/3, native VSA at 10% retention,
12,288-token dense fallback threshold, and exact conditioning/audio rows.
Comfy Kitchen supplies the dense attention fallback. TaoMate's SLA and its LoRA
are not used. The audio VAE participates in both conditioning and decoding.

## Checkpoint

- Repository: `FastVideo/FastH3-OmniRef-NVFP4-QAD-Comfy`
- Revision: `36dbf15cd11113471114b1040c4f38646c031549`
- Filename: `fasth3_omniref_qad_nvfp4_comfy.safetensors`
- Size: 13,773,998,700 bytes
- SHA256: `bf25ee58df65b4dfee349d612f7ac62a2fea0dddd1e68eb37e75c8ce8b166f5a`

Install it in a ComfyUI `diffusion_models` directory; this desktop uses
`C:/AI/ComfyUI_fast_models/diffusion_models`. Download to a temporary `.part`
filename, verify the hash, and rename only when complete. The runner verifies
the checksum before an Omni render. Shared components are the installed
`qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors`,
`minimax_h3_video_vae_int8_convrot.safetensors`, and
`minimax_h3_audio_vae_fp32.safetensors`.

This export is native ComfyUI NVFP4, requiring Blackwell for accelerated
execution. It is not the separate FastVideo-format checkpoint. Its metadata
explicitly says parity with FastVideo inference has not been validated; ComfyUI
also uses a different sparse tile size. Do not interpret these results as a
benchmark of FastVideo's specialized FP4 attention/decoder runtime.

## Run a comparison

The installed ComfyUI 0.37.1 has the required nodes but lacks the checkpoint's
PDD head-layout support. A first render failed before sampling with a 24-versus-
768 channel mismatch. The model's 32 prediction heads had been interpreted as
32 times as many latent channels. The release's bundled upstream code corrects
the detector and `FinalLayer` geometry. That small backport is archived in
`desktop/video-fasth3-omni-comfy.patch`, with exact before/after hashes.

Use an isolated copy of the installed ComfyUI source, preserving its existing
local changes and `sol_attn_minimax_v5.py` custom node. The prepared copy is at
`D:/AI/ComfyUI_windows_portable/video_gen/experiments/fasth3_omni_20261020/ComfyUI`.
Apply/check the archived patch against that copy:

```bash
python3 scripts/apply-video-omni-comfy.py --directory /path/to/isolated/ComfyUI --check
python3 scripts/apply-video-omni-comfy.py --directory /path/to/isolated/ComfyUI
```

Use embedded Windows Python under `gpuq --profile video-h3-isolated` with
`scripts/run-video-omni-isolated.py`. This wrapper owns a server on port 8197,
refuses an occupied port, shares model/input/output paths, and terminates its
server in `finally`. The production ComfyUI files are untouched. The runner requires
`GPUQ_LEASE_ID` for rendering; `--dry-run` compiles without GPU work. Keep the
repository's `scripts/` and `desktop/` relative layout when copying the runner
to Windows. Pass the live generator directory with `--desktop`.

Copy `benchmarks/video-omni-corpus.json` into an experiment input directory
alongside `woman.png`, `oalgo.png`, and `marbles.png`. The October 20 experiment
uses the two portraits from `experiments/taomate_ab_round2_20260927`, and frame
zero of `marbles8-9272901-taomate_sparse.mp4`. Input hashes are recorded, so
different images cannot silently reuse existing results.

Example in PowerShell, with paths adjusted to the experiment:

```powershell
gpuq status
gpuq run --source codex-dave-omni --profile video-h3-isolated --priority background `
  --when-gaming hold --on-preempt fail --evict-cache-before-run -- `
  D:\AI\ComfyUI_windows_portable\python_embeded\python.exe `
  D:\AI\ComfyUI_windows_portable\video_gen\experiments\fasth3_omni_20261020\scripts\run-video-omni-isolated.py `
  --comfy D:\AI\ComfyUI_windows_portable\video_gen\experiments\fasth3_omni_20261020\ComfyUI `
  --desktop D:\AI\ComfyUI_windows_portable\video_gen `
  --manifest D:\AI\ComfyUI_windows_portable\video_gen\experiments\fasth3_omni_20261020\inputs\corpus.json `
  --output D:\AI\ComfyUI_windows_portable\video_gen\experiments\fasth3_omni_20261020\isolated-results `
  --renderers fasth3_omni base taomate
```

The underlying benchmark runner accepts `--renderer base`, `--renderer taomate`
or `--renderer fasth3_omni` and `--case speech5`; it can target an already owned
server with `--server`. New prompts/images/canvases belong in a new manifest/output
directory. Completed runs are skipped only with matching request signatures.

The baseline graphs use the live production compiler, with only canvas geometry
overridden to match Omni. Each case uses identical prompt, image bytes, seed,
frame count and output size across renderers. First-frame conditioning remains
the baseline's behavior; Omni's image is a reference rather than an exact frame.
This is an end-to-end renderer comparison, not an isolated checkpoint ablation.

The first sample after admission or a case change has uncontrolled cache state.
The next seed is consecutive under the same case/model. Timings cover prompt
submission through completed MP4 retrieval, including conditioning, model
loading/offloading, sampling, decoding and encoding. They exclude checkpoint
download/hash checks, backend startup, planning, keyframe generation, queuing
and Discord delivery. Fresh sampler-step counts, decoded frame count, canvas,
24 fps and stereo audio are checked. Request, workflow, submission and result
files retain hashes and stage timings. Failed submissions save diagnostics;
cleanup cancels only the owned prompt ID.

## Scope and promotion

The initial compiler supports 1–9 images, up to 3 audio references, and 124,
243 or 362 frames. Prompts address inputs as `<Picture 1>` and `<Audio 1>`.
Audio references guide generation; they do not preserve an original song.
Video references, exact first/last frames, continuation joins, fixed-original
audio and character-swap LoRAs are not integrated into this experimental path.

Main-path promotion requires acceptable identity, motion, dialogue, lip-sync
and the production features above. Fast-path promotion additionally requires
beating TaoMate at matched resolution and duration. The vendor's multi-GB200
real-time results do not establish real-time performance on our RTX 5090.

Focused checks:

```bash
PYTHONPATH=desktop python3 -m unittest desktop/test_video_fasth3_omni.py desktop/test_video_omni_benchmark.py desktop/test_video_omni_isolation.py
```

`desktop/test_video_omni_comfy.py` additionally checks the real checkpoint's
head/channel detection and verifies that zero-offset PDD heads produce the
same video/audio output as a plain head at every sampling step. Set
`OMNI_COMFY_ROOT` and `OMNI_MODEL_PATH` to the isolated runtime and checkpoint
and run this test with embedded Windows Python; it explicitly uses CPU.

No production generator/worker source needs patching to use this experiment.
Rollback consists of stopping the experiment's own GPUq jobs; bot routing is
unchanged. The downloaded model can be removed when no experiment uses it.
