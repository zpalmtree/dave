# Measured MiniMax and OALGO optimization

The September 7 campaign compares cost, service time and prompt adherence while
keeping Sol low / single-pass / standard as the production planning control.
No candidate is enabled by running a benchmark. The authorized API budget is
$50 across all phases, retries, image generation and judges.

## Production changes

- Model capabilities explicitly allow Astra, Sol, Terra, Luna and Gemini Flash.
  Unsupported configuration fails explicitly instead of silently reverting to Sol.
- Usage keeps raw provider counters and separates cache reads, cache writes,
  reasoning and image output. Unknown prices and missing usage are marked as
  incomplete; they are not evidence of a free call.
- OALGO and meximutt keep their command identity. Submission timestamps include
  the work before enqueue, including image compositing. A duplicate enqueue race
  retains both paid composition records, even when only one job is created.
- OALGO composition uses the actual photographic preset as its visual reference.
  Local fallback receives character/delivery guidance separately from the prompt.
- Total-duration directives are checked against timing fields. For example,
  “Make it 12 seconds” no longer requires the number 12 to appear in the scene.
  Object counts, quoted words and exact finished-duration checks remain binding.
- Optional canary configuration is captured per job, including planner/reviewer
  settings and the fixed-duration FastH3 profile. Defaults stay unchanged without
  a qualified release file.

## Evidence and pricing

The read-only baseline audit is `scripts/audit-video-optimization.py`. It emits
aggregate counts and costs without prompts or Discord identities. Historical
records combine some OALGO and meximutt usage under MiniMax, so they cannot
establish an exact OALGO baseline. Costs are token-priced estimates, not invoices.
The new submission and usage fields make future attribution explicit.

The initial September 2–7 audit found image creation and review accounted for
roughly three quarters of recorded spend. Planning is only one part of latency;
desktop rendering and GPU admission are measured separately. Existing streaming
first-frame preparation, a 12-second image hedge, one-job preplanning and later
frame concurrency were already present and are not claimed as new optimizations.

Rates were checked against [OpenAI pricing](https://developers.openai.com/api/docs/pricing)
and [Gemini pricing](https://ai.google.dev/gemini-api/docs/pricing) on September 7,
2026. Per million standard input / cache-read / output tokens: Astra $10/$1/$50;
Sol $4/$0.40/$20; Terra $2/$0.20/$12; Luna $0.20/$0.02/$1.20. Cache writes cost
1.25 times input; OpenAI long-context multipliers are applied above 272k total
input tokens. Gemini 3.8 Flash introductory rates are $0.75/$0.075/$3.75 through
December 2026 and double in January 2027. Image output uses its own counters and
rates instead of a blanket per-image charge.

Capabilities and the experiment design follow the official
[Astra model reference](https://developers.openai.com/api/docs/models/gpt-6-astra),
[Gemini 3.8 Flash reference](https://ai.google.dev/gemini-api/docs/models/gemini-3.8-flash),
and [evaluation guidance](https://developers.openai.com/api/docs/guides/evaluation-best-practices).
Provider benchmarks alone do not select a production winner.

## Reproducible campaign

Use one run directory for every paid phase. The ledger locks that directory,
reserves a conservative request bound before sending it, and checkpoints usage
before parsing or validating the model response. Unresolved timeout reservations
survive restarts. The cumulative caps are $15 for screening, $25 for image/reviewer
work, $40 for holdout work and $50 for render preparation. A call that cannot fit
does not run; missing comparisons remain inconclusive. Completed generation
checkpoints include model settings, code/contract hashes and source-image bytes.
Judge checkpoints separately fingerprint the blinded evaluation procedure.

```bash
yarn build
node scripts/benchmark-video-optimization.mjs --phase=preflight --run-dir=artifacts/video-optimization/2026-09-07
node scripts/benchmark-video-optimization.mjs --phase=dry-run --run-dir=artifacts/video-optimization/2026-09-07
node scripts/benchmark-video-optimization.mjs --phase=screen --run-dir=artifacts/video-optimization/2026-09-07
node scripts/benchmark-video-optimization-images.mjs --phase=prepare --run-dir=artifacts/video-optimization/2026-09-07
node scripts/benchmark-video-optimization-images.mjs --phase=run --run-dir=artifacts/video-optimization/2026-09-07
node scripts/benchmark-video-optimization.mjs --phase=holdout --run-dir=artifacts/video-optimization/2026-09-07
```

Screen eight configurations on four prompts per command: Sol low/medium,
Astra low/medium, Terra medium, Luna medium and Flash low/medium. Select at most
one finalist per command. Compare it with the control on 20 unseen prompts per
command, with a second run on the first four fixed holdout cases. Two providers
judge plans with opposite, randomized label order. Neither model names nor
timing metadata is disclosed. Confidence intervals resample prompt-level paired
differences; repeated calls and the two judges are not independent prompts.

The first screen exposed a duration-validator defect. `screen-selection.json`
archives that screen as hypothesis-selection evidence. Subsequent reports label
its code fingerprint separately; holdout generation uses the corrected validator
for both arms. Screening results from the old validator are not qualification
results for the corrected code. An optional `--selection-report=<report.json>`
must match the corpus and is copied to the run's selection checkpoint.

The image stage uses 12 retained frames, four new later-cut frames and four
paired OALGO composites (Pro 2K versus Flash Image 1K). Old machine labels are
discarded. Compare Sol high, Sol low and Flash low on all 24 frames using the
same image and motion/reference contract. Frames share prompt families; 24
frames do not provide 24 independent prompt observations.

```bash
node scripts/serve-video-cost-ab-review.mjs --run-dir=artifacts/video-optimization/2026-09-07 --port=4327
node scripts/benchmark-video-optimization-images.mjs --phase=report --run-dir=artifacts/video-optimization/2026-09-07
```

The local review page hides provider identities and displays the reference
images. Only a human supplies its labels. Missing labels are never converted
to agreement or acceptance.

## Fixed renderer comparisons

```bash
node scripts/prepare-video-optimization-renders.mjs --run-dir=artifacts/video-optimization/2026-09-07 --control-only
node scripts/video-optimization-renders.mjs --manifest=artifacts/video-optimization/2026-09-07/render-manifest.json --dry-run
node scripts/video-optimization-renders.mjs --manifest=artifacts/video-optimization/2026-09-07/render-manifest.json
node scripts/report-video-optimization.mjs --run-dir=artifacts/video-optimization/2026-09-07
node scripts/serve-video-cost-ab-final-review.mjs --run-dir=artifacts/video-optimization/2026-09-07 --port=4329
```

The control-only preparation can run before holdout completion. Remove that flag
after component qualification to add cloud-policy comparisons. Four fixed anchor
prompts cover two MiniMax cases and two OALGO cases, including an attachment
composite. Control and FastH3 reuse the exact same compiled scenes, prompts,
frame counts, seed, aspect and assets. The desktop validates these before
inference and refuses local replanning or resume under an experiment contract.
Production-equivalent scene splitting is frozen before comparing profiles.

FastH3 is the current **4-step VSA** renderer, not the older 8-step Turbo model.
Use `--fast --no-fast-duration-aware`; duration compression would confound a
renderer speed comparison. The production canary also preserves base scene
splitting. Every render runs through GPUq with Gaming Mode hold and fail-on-
preemption policies. Reports retain both queue-inclusive wall time and renderer
service timing, plus the underlying manifests. Never infer speed from frame
count reductions or queue wait.

After both isolated components pass human video review, run the report with
`--prepare-combined` and rerun the renderer. It adds at most one combined test
per command. There are at most 10 comparisons and 14 unique videos. Full videos
with audio are the final evidence for dialogue, accent, identity and motion;
frame-zero screenshots cannot establish those properties.

## Gates and rollout

Planner qualification requires at least 98% valid plans, complete paired judging
and accounting, a prompt-cluster 95% lower quality bound above -0.5/10, no material
candidate failures and consistent repeats. Efficiency needs at least 15% cost
or service-time savings with the other measure no more than 5% worse. A quality
upgrade needs at least +0.5/10 with a positive lower bound, at most 20% extra cost
and at most 10% extra time. Reviewer/composite pilots require complete human
labels, no additional false acceptance/rejection or material failure, and the
same efficiency thresholds. Renderer pilots require at least 20% service-time
improvement at equal output duration and no material human-confirmed failure.

`report-video-optimization.mjs` writes `decision.json` and an inactive
`canary-release.json`. Unresolved campaign billing, incomplete human labels or
failed gates prevent qualification. A release file is activated only by setting
`VIDEO_OPTIMIZATION_RELEASE_FILE` on the broker. Its absent/invalid/default state
uses the control. Sampling is deterministic per job and command.

Start at 10%; require ten distinct reviewed candidate deliveries before 50%,
and thirty per command before 100%. Record those delivery reviews in the release
file. A recorded material failure or failed delivery disables candidate selection.
Setting percentage to zero or removing the environment setting rolls new jobs
back to control. Existing jobs retain their captured configuration.

Desktop source changes are archived in `desktop/video-optimization.patch`, with
before/after hashes for the live files. Both Git branches must receive the same
functional change and be deployed with `scripts/deploy-bots.sh --with-broker`.
