# Concept selection experiment

The production planner remains unchanged. The experimental candidate makes one additional Opus call to propose three distinct, concrete concepts and select one. Only the selected concept is supplied to the existing screenplay planner. It can seek amusement, beauty, curiosity, unease, or excitement; a pun is not required.

The October 24 run lives locally in `artifacts/concept-selection-20261024`. Its frozen design, source hashes, provider accounting, original prompts and first outcomes are retained there. Do not commit the private usage-history export or credentials.

## Evaluation

- Twelve distinct real-history prompts form the primary sample. Selection covers vague, copied, character, visual, and action requests; it is not a probability sample.
- Three additional pairs repeat the exact plans with new paired video seeds. Report these separately and cluster any aggregate analysis by original prompt.
- Both arms use the same renderer and current production music pipeline. Music keeps its existing job-derived seeds; video seeds are paired.
- The review asks whether each video is worth sharing independently of the A/B preference. Both can be unacceptable even when one wins.
- Retain ties, failures, cost and latency. Automated diagnosis is supporting evidence, not a substitute for human taste. A useful direction in twelve prompts needs confirmation on fresh prompts before changing defaults.

## Running and resuming

`node scripts/run-video-concept-plans.mjs <run-root>` reads the frozen `design.json` and `cases.json`, generates each first plan once, and records outcomes in `state.json`. Existing task entries are preserved. Investigate an interrupted `running` entry before attempting recovery; do not delete outcomes to reroll quality.

`node scripts/run-video-concept-renders.mjs <run-root>` requires all 24 planning tasks to be terminal. It uses an isolated broker on port 4362 and the desktop worker wrapper in `desktop/video_experiment_worker.py`. The wrapper checks the renderer hashes before each job and uses GPUq admission through the production worker. It never connects to Discord. The controller records all 30 tasks and admits at most 18 active jobs at once, replenishing slots as jobs complete. Pending admission is distinct from queued or rendering.

The current renderer runner is specific to this campaign and uses the desktop runtime `experiments/concept_selection_20261024`. Do not run another campaign concurrently with those ports or that runtime. `jobs.json`, the isolated broker database, worker journal, and `render-processes.json` preserve state. Reuse the controller launcher lock when resuming; never start two controllers. Inspect an unexpected exit and live worker before restarting.

`node scripts/serve-video-experience-review.mjs --run-dir=<run-root> --port=4363` serves the blinded review. Save its printed private URL. Progress lists every planned pair before media is available. Completed pairs are appended under the same file lock used by review saves, preserving existing votes. User playback has sound enabled and no autoplay; automated browser checks explicitly mute their own players.

The shared provider ledger reserves bounded cloud costs before requests. Its $40 cumulative cap covers the audit, planning and renderer-side cloud calls; local GPU time is separate. The initial concept calls were rejected for a provider-deprecated temperature parameter. Their records and reservations are retained; only those transport failures were resumed with the supported medium-effort request. Successful baseline plans were preserved.

## Audit limitations

Thirty historical deliveries were matched to retained artifacts by hash. They predate the latest audio rollout. Visual checks contradicted two automated claims of fully static output: both contained motion. One supporting character's appearance changed visibly across shots. See the local `audit-summary.md` for calibrated findings rather than treating all model flags as verified defects.
