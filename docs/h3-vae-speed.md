# MiniMax H3 VAE speed

The [September 22 ComfyUI announcement](https://blog.comfy.org/p/making-the-minimax-h3-video-vae-2x)
requires ComfyUI v0.36.0 or newer. The desktop's v0.37.1 (`3f767e7f`)
already includes the optimization commit `b2e31e89412a01a67be599571cc57ff74b242a82`
and has the required `comfy-kitchen==0.2.35` installed.

The portable installation uses the official
[INT8 video VAE](https://huggingface.co/Comfy-Org/MiniMax-H3/blob/main/vae/minimax_h3_video_vae_int8_convrot.safetensors)
in `video_gen/templates/h3_t2v.json` and `h3_i2v.json`. Source-video editing
also loads the latter template. The audio VAE is unchanged.

The desktop patch sets `fp16_accumulation` as the default performance option
in `ComfyUI/comfy/cli_args.py`. This is equivalent to launching with
`--fast fp16_accumulation`, including when GPUq launches ComfyUI directly.
Explicit `--fast` selections retain upstream behavior. This enables FP16
accumulation for other compatible models too; it is not confined to H3.
The setting must be reapplied after a ComfyUI upgrade if upstream replaces it.

## Install

Download `minimax_h3_video_vae_int8_convrot.safetensors` from the official link
into `ComfyUI/models/vae`. Its SHA256 is
`52a2c8c73583c86e4f41cdcce3a6ad0ea562987bc0bf3d60a0cef5f5c8e60c0e`.
The installer verifies both the model and exact source revisions before applying:

```bash
python3 scripts/apply-h3-vae-speed-desktop.py --check
python3 scripts/apply-h3-vae-speed-desktop.py
```

New workflows load the INT8 model immediately. An existing ComfyUI process
needs a refresh to pick up the FP16 accumulation default. Queue the refresh
through GPUq so it waits for active leases and respects Gaming Mode:

```bash
gpuq submit --profile generic-exclusive --priority normal \
  --when-gaming hold --on-preempt fail --evict-cache-before-run \
  --source h3-vae-refresh -- cmd.exe /c exit 0
```

This evicts idle managed backends after admission; the next render starts
ComfyUI with the updated setting. Do not manually stop an active render.

## Validation and rollback

Validate CLI defaults and explicit overrides without loading GPU models, compile
both H3 workflow modes, and run the generator and video-edit unit suites.
The announcement's timings are upstream measurements, not a local benchmark.

September 27 verification passed all four CLI cases (default, explicit FP16,
explicit FP8, all options) and compiled T2V/I2V with standard H3 and FastH3.
The generator/edit suites ran 189 tests: 186 passed; three existing keyframe
tests reference removed `KEYFRAME_DIFFUSION_MODEL`, `keyframe_cache_key`, and
`KEYFRAME_CACHE_DIR` symbols. This patch does not change generator Python code.

For rollback, reverse `desktop/h3-vae-speed.patch` from the portable root and
refresh ComfyUI through GPUq. The original FP16 model remains installed.
The September 27 source backups are under
`video_gen/backups/h3-vae-speed-20260927`.
