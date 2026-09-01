# Local MiniMax cost/quality A/B benchmark

This benchmark is local-only. It does not allocate production traffic, change
the bot configuration, push branches, or deploy services. Paid phases call the
OpenAI API, checkpoint every completed response, and stop before the configured
spend cap would be exceeded.

## Start with the dry run

```bash
yarn benchmark:video-cost-ab --phase=dry-run --run-dir=artifacts/video-cost-ab/dry-run
```

The dry run creates `state.json`, blinded human-review packets, `report.json`,
and `report.md` without calling an external API.

## Corpora

Planner prompts are a JSON array containing strings or objects with a `prompt`
field. Use 30 stratified prompts for screening and 60 for the finalist run.
The checked-in `benchmarks/video-cost-ab-planner-corpus.json` is the canonical
60-prompt finalist corpus; its first four prompts match the screening set so
those checkpointed calls are reused.

Reviewer cases are extracted from an existing keyframe benchmark report. The
source report must retain each candidate image and its corresponding plan. Use
30 frames for screening and a roughly balanced 100-frame corpus for the
finalist run. Production identifiers are not copied into benchmark state.

## Paid phases

Use one stable run directory so completed calls are reused:

```bash
yarn benchmark:video-cost-ab --phase=tier \
  --run-dir=artifacts/video-cost-ab/2026-08-31 \
  --prompts=/absolute/path/planner-prompts.json \
  --reviewer-report=/absolute/path/keyframe-report.json \
  --budget-usd=35

yarn benchmark:video-cost-ab --phase=reviewer \
  --run-dir=artifacts/video-cost-ab/2026-08-31 \
  --reviewer-report=/absolute/path/keyframe-report.json \
  --limit=30 --budget-usd=35

yarn benchmark:video-cost-ab --phase=planner \
  --run-dir=artifacts/video-cost-ab/2026-08-31 \
  --prompts=/absolute/path/planner-prompts.json \
  --limit=30 --budget-usd=35
```

After screening, rerun only the selected finalist plus the control with
`--candidates=...` and `--limit=100` for reviewers or `--limit=60` for planners.
Existing checkpoint keys are reused.

For the selected Sol-low planner finalist, the exact expansion command is:

```bash
yarn benchmark:video-cost-ab --phase=planner \
  --run-dir=artifacts/video-cost-ab/2026-08-31-local-screen \
  --prompts=benchmarks/video-cost-ab-planner-corpus.json \
  --candidates=sol-medium-standard,sol-low-standard \
  --limit=60 --budget-usd=35
```

Generate the human tasks and report with:

```bash
yarn benchmark:video-cost-ab --phase=packets --run-dir=artifacts/video-cost-ab/2026-08-31
yarn benchmark:video-cost-ab --phase=report --run-dir=artifacts/video-cost-ab/2026-08-31
```

Complete `human-review/reviewer.json` without opening `reviewer-key.json`. The
packet contains every model disagreement plus a deterministic 10% agreement
audit. Set `human_acceptable`, `material_failure`, and optional `notes` on each
case. Planner review is diagnostic only: it contains reversed-judge
disagreements, critical-failure flags, and score gaps below 0.5. Incomplete plan
rows do not block a finalist that passes the 60-prompt automated screen; the
authoritative human safety decision is made on rendered videos. Regenerating
packets preserves completed human fields.

The local blinded review UI is the preferred way to complete both packets. It
does not serve either key file, hides automated reviewer votes until the human
decision is complete, and writes only the human fields back to the packet:

```bash
yarn review:video-cost-ab \
  --run-dir=artifacts/video-cost-ab/2026-08-31
```

Open the private localhost URL printed by the command. The server binds only to
`127.0.0.1`, requires its random per-process token, validates packet identity
before each atomic save, and can be started with `--read-only` for browser
verification.

Run the report phase again after any diagnostic adjudication. Do not expand the
plan-review packet merely because automated judges flagged many uncertain rows;
route those risks into the small rendered-video sample instead.

## Adaptive final-video gate

Prepare six risk-stratified successful pairs from the fixed 60-prompt screen:

```bash
yarn benchmark:video-cost-ab-prepare-renders \
  --state=artifacts/video-cost-ab/2026-08-31/state.json \
  --output=artifacts/video-cost-ab/2026-08-31/render-inputs.json
```

Each pair has `pair_id`, `prompt`, a fixed `seed`, and control/candidate plan
paths. Validate the complete GPU command set without rendering:

```bash
yarn benchmark:video-cost-ab-renders \
  --manifest=/absolute/path/render-inputs.json --dry-run
```

Run the initial 12 videos after the automated planner screen passes:

```bash
yarn benchmark:video-cost-ab-renders \
  --manifest=/absolute/path/render-inputs.json \
  --output=artifacts/video-cost-ab/2026-08-31/render-state.json \
  --pairs-output=artifacts/video-cost-ab/2026-08-31/render-pairs.json
```

The runner accepts 6–10 pairs, checks GPUq status, submits every base-H3 render under the
`video-h3-isolated` profile, holds under Gaming Mode, fails cleanly on
preemption, atomically evicts managed model caches before admission, fixes the
seed within each pair, and checkpoints completed MP4s.
It deliberately never passes the local H3 `--fast` flag.

Then blind the ten completed `{pair_id, prompt, control_video,
candidate_video}` pairs:

```bash
yarn benchmark:video-cost-ab --phase=render-packet \
  --run-dir=artifacts/video-cost-ab/2026-08-31 \
  --render-manifest=/absolute/path/render-pairs.json
```

The resulting packet randomizes A/B labels. Review it with:

```bash
yarn review:video-cost-ab-final \
  --run-dir=artifacts/video-cost-ab/2026-08-31
```

Six pairs pass early only when at least five prefer or tie the candidate, mean
overall delta is at least -0.5, and the candidate has no material failure. An
ambiguous first six expands by up to four risk-stratified pairs; ten pairs use
the 7-of-10 threshold. Keep `final-videos-key.json` closed until ratings are
complete.

The render runner can also export its current completed-pair snapshot while the
batch is still running. This allows progressive review; regenerated packets
preserve saved decisions by `pair_id`, while the final gate remains incomplete
until six pairs:

```bash
yarn benchmark:video-cost-ab-renders \
  --manifest=/absolute/path/render-inputs.json \
  --output=/absolute/path/render-state.json \
  --pairs-output=/absolute/path/render-pairs.json \
  --export-only
```
