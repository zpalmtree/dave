# TaoMate for the fast video commands

`$minimaxfast` and `$oalgofast` select the three-step TaoMate profile. Standard
`$minimax` and `$oalgo` retain the base H3 renderer. Command names, queue model IDs,
GPUq admission and character guidance stay compatible.

The desktop worker passes `--model h3 --quality final --fast --fast-profile taomate`.
The profile compiles to the installed H3 FL2VA pruned INT8 base,
`minimax_h3_taomate_3step_lora_avg_rank_19_bf16.safetensors` at strength 1,
Euler/simple at three steps, and SolAttnMiniMax top-k SLA retaining 25% of blocks.
All steps use exact conditioning and dense target-audio query rows; the sparse
threshold is 12,288 tokens. The adapter SHA256 is
`de9663d974a884b477556748239c6f28239f7ca1825be270f98f023ff5dab6a7`.

Saved plans record `fast_profile`, so resumed TaoMate jobs keep it. Plans created
before this change default to the legacy FastH3 profile. Legacy CLI `--fast`
also retains FastH3, including historical benchmark scripts. Generator manifests
record the actual profile, sampler, step count and attention backend. Local ETA
history separates TaoMate from FastH3 and older Turbo profiles.

## Evidence and limitation

The September 27 comparison rendered 18 clips: clear speech, marble motion/sound
effects and Oalgo speech, each with two seeds and three presets. Consecutive
TaoMate sparse runs took 38.2, 36.6 and 67.1 seconds, versus FastH3's 45.1, 45.4
and 79.8 seconds. These are individual warm observations, not throughput guarantees.
The user reported essentially equal quality except for white effects added to
Oalgo by both dense and sparse TaoMate, and approved implementation afterward.
The effect's cause remains unresolved; the reference bytes and copied outputs
were verified, and the workflow contains no compositing step.

The production compiler is checked against all six tested sparse TaoMate graphs
and all six legacy FastH3 graphs. Executable graph contents match after normalizing
the attention node ID; display labels are excluded. Regression coverage checks
T2V/I2V LoRA and step-switch wiring, CLI routing, and ETA-history separation.
No new GPU run is needed to repeat those already rendered identical graphs.

Rollout checks: all 438 bot tests and 57 tests in embedded Windows Python pass.
The full desktop suite runs 247 tests: 243 pass, one is skipped, and three stale
keyframe tests fail because `KEYFRAME_DIFFUSION_MODEL`, `keyframe_cache_key` and
`KEYFRAME_CACHE_DIR` are absent. Those same failures were reproduced against the
untouched pre-change generator; this patch does not modify that keyframe code.

## Install and rollback

The desktop already contains the required adapter, base model and sparse node.
The archive preserves only this rollout's delta over the audited live revision:

```bash
python3 scripts/apply-video-taomate-desktop.py --check
python3 scripts/apply-video-taomate-desktop.py
```

The installer verifies exact before/after hashes and refuses unexpected edits.
Reload the supervised worker child while idle, leaving its supervisor and active
GPUq jobs alone. Push the bot change to both `master` and `slugs`, then run
`scripts/deploy-bots.sh --with-broker`.

To roll back new jobs, select `--fast-profile fasth3_vsa` in both the worker's
`MODEL_ARGS.minimaxfast` and the broker protocol's `VIDEO_MODELS.minimaxfast`,
restore the display name, and repeat the idle reload and dual-branch deployment.
Keep the TaoMate compiler support while saved TaoMate jobs still need to resume.
