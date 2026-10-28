# Desktop video optimization changes

## Bounded delivery audio/video sync

`video-delivery-sync.patch` checks generated videos before loudness normalization
and Discord compression. The CPU-only SyncNet helper samples three 2.8-second
windows, detects faces every fifth frame, and permits one replacement window
when tracking fails. Three unambiguous samples must each have confidence >= 4
and distance <= 11. Corrections use their median in 40 ms steps, at most 80 ms;
conflicting directions, a spread over 80 ms, missing samples, and clips shorter
than 8.4 seconds retain their original timing. This shifts only audio, preserving
encoded video and workflow metadata. Advancing trims a short audio prefix;
delaying trims the corresponding tail to retain the video's duration.

The analysis deadline is 35 seconds and the delivery wrapper has a 45-second
budget including audio muxing. Failure or timeout keeps the input; cancellation
propagates and stops analysis. Source-video edits preserve their soundtrack and
skip this pass. Set `VIDEO_DELIVERY_SYNC=0` to disable it. The helper uses the
existing `VIDEO_LIPSYNC_PYTHON`, `VIDEO_LIPSYNC_DISTRO`, and `LATENTSYNC_ROOT`
settings and local SyncNet/S3FD checkpoints; it uses no GPU or model downloads.
Per-delivery `.avsync-<job>.json` files record samples, decisions, and elapsed time.

Install with `python3 scripts/apply-video-delivery-sync-desktop.py --check`, then
without `--check`; reload the idle supervised worker and deploy both tracks with
`scripts/deploy-bots.sh --with-broker`. Run
`python3 -m unittest discover -s desktop -p test_video_sync_delivery.py` for
policy, cancellation, fallback, actual audio timing, video-byte preservation,
and metadata regressions. The short-sample prototype took 23 seconds plus one
second to mux on job `66c4a27e`; runtime varies, and the deadline takes precedence
over obtaining a correction.

## Horizontal delivery without the old resolution cap

`video-landscape-delivery.patch` corrects the orientation regression introduced
by native-canvas delivery. The renderer follows the starting image's aspect,
so preserving its canvas made portrait references produce vertical deliveries.
Recovery assembly now widens portrait and square canvases to approximately
16:9 (rounded to even pixels), retaining their native height and full picture
with side padding. Existing landscape canvases retain their native dimensions.
For example, a 736×1120 render delivers at 1992×1120; a 1344×768 render stays
1344×768. Discord's upload-size compression can still resize large files.

This changes assembly, not generation: source identity, framing, render budgets,
and source-video edits retain their behavior. Accepted scenes, including resumed
jobs, use the same horizontal canvas without rerendering. Audio, transitions,
and exact song timing remain intact.

Install with `python3 scripts/apply-video-landscape-delivery-desktop.py --check`,
then without `--check`. The hash-checked delta includes the updated canvas tests
and preserves other desktop changes. Reload the supervised worker while idle
and deploy both bot tracks with `scripts/deploy-bots.sh --with-broker`.
Run `python -m unittest test_video_canvas test_video_output_quality test_video_recovery`
in the desktop Python environment. Tests use CPU media fixtures and verify
full-picture padding, native landscape detail, odd sizes, cuts, dissolves, and
resumed regular/song uploads; no GPU render is needed.

## Native canvas foundation (superseded delivery orientation)

`video-native-canvas.patch` removes the fixed 960×720 recovery canvas. Assembly
originally used the first accepted render's native width and height for the whole video,
rounding odd dimensions up to the next even pixel for H.264 compatibility.
Later clips fit that canvas without cropping or stretching; padding appears
only where their aspect ratios differ. Frame rate and audio normalization,
picture/audio transitions, and exact song frame counts retain their behavior.
Discord's existing upload-size compression can still resize an oversized video.

The canvas is derived from the accepted original on each assembly attempt, so
an upload retry makes the same choice without regenerating any scene. Old jobs
can resume from their existing accepted originals; no checkpoint migration or
new render rejection rule is required.

Apply after the output-quality patch with
`python3 scripts/apply-video-native-canvas-desktop.py --check`, then without
`--check`. Reload the supervised worker while idle and deploy both bot tracks
with `scripts/deploy-bots.sh --with-broker`.

Run `python -m unittest test_video_canvas test_video_output_quality test_video_recovery`
in the desktop Python environment. The canvas tests use real CPU FFmpeg output
to cover native portrait/landscape/square sizes, mixed-aspect cuts and dissolves,
odd dimensions, missing audio, and resumed regular/song delivery after an upload
outage. They do not generate GPU video.

## Approved timing and final edits

`video-output-quality.patch` preserves the action time in approved recovery
screenplays instead of treating time beyond a short line as dead air. It adds
no render rejection or retry policy. Unapproved local drafts retain their
existing timing normalization.

Recovery assembly now honors picture dissolves and the independent audio
transition setting, using the existing assembler. Dissolves overlap adjacent
clips by up to half a second; ordinary cuts retain their full duration. Song
clips keep their exact external audio timeline. The later native-canvas patch
above replaces this patch's original 960×720 delivery canvas.

The planner supplies `shot.camera_transition`: `continuous` times another beat
inside the same take, and `cut` starts another camera shot. Old plans remain
valid, including explicit no-cut camera directions. Non-speaking characters
can perform the requested mouth actions while retaining their reference face;
mouthless characters retain their existing anatomy rule.

Apply with `python3 scripts/apply-video-output-quality-desktop.py --check`, then
without `--check`. The hash-checked delta preserves the live desktop's prior
changes. Reload the supervised worker while idle and deploy both bot tracks
with `scripts/deploy-bots.sh --with-broker`.

`test_video_output_quality.py` covers approved timing through loading and
compilation, continuous-camera beats, silent mouth actions, real blended
dissolve frames, audio seam attenuation, and song/single-clip assembly. Run it
with the desktop Python environment, which supplies PyAV and FFmpeg.

## Recovery latency and timing

`video-speed.patch` overlaps the next independent cut/dissolve opening with the
current render, caches its response against the approved contract and regeneration
revision, and records recovery HTTP timings. Continuations still wait for the
previous video's frame; local image inference still takes its own GPUq lease.
Only one opening is prefetched at a time. The broker also plans the next queued
recovery job while the worker renders, sharing any in-flight planning call with
the worker. Song composition and local planning remain worker operations.

The generator reads `timing_history.jsonl` before falling back to a recursive
manifest scan. On October 6, the old scan took 59.985 seconds across 2,354
observations; the log path took 0.013 seconds across 1,820 observations. This is
one CPU/I/O measurement, not an end-to-end render benchmark. H3 graphs, sampling
steps, resolution and quality are unchanged.

Apply with `python3 scripts/apply-video-speed-desktop.py --check`, then without
`--check`. Reload the supervised desktop worker while idle and deploy both bot
tracks with `scripts/deploy-bots.sh --with-broker`. The broker migration retains
old provider timings and gives each new provider invocation a separate key.
Worker snapshots aggregate repeated GPU waits before their idempotent database
upsert; repeated uploads do not add the same wait twice. The completed job's
queue-wait field is also updated with that aggregate. Historical overwritten
values cannot be reconstructed by this migration.

Validation: all 478 bot tests passed, followed by a fifth focused latency test
covering migration of populated old timing tables. All 41 desktop speed/recovery
tests passed. The generator suite passed 187 of 190 tests; its three missing
legacy keyframe-symbol errors were reproduced against the untouched baseline.
The desktop changes are archived as a delta over the live source, preserving
unrelated changes already installed there.

## TaoMate fast renderer

`video-taomate.patch` adds the tested three-step TaoMate SLA 25% profile and selects
it for `minimaxfast` (including `oalgofast`). Install with
`python3 scripts/apply-video-taomate-desktop.py --check`, then without `--check`.
Reload the worker child while idle and deploy both server tracks with
`scripts/deploy-bots.sh --with-broker`. Saved FastH3 jobs retain their original
renderer on resume. See [validation and rollback](../docs/video-taomate.md).

## Bounded opening identity checks

`video-opening-identity.patch` assigns identity and scene references separate
roles, checks unreviewed local openings before animation, and allows at most one
corrective local image per video. Cached decisions and persisted limits prevent
reconnects from resetting the budget; cloud-reviewed openings and rendered clips
add no review calls. See [video recovery](../docs/video-recovery.md#bounded-identity-check-for-local-openings).
Install with `python3 scripts/apply-video-opening-identity-desktop.py --check`,
then without `--check`; deploy the broker and reload the idle desktop worker.

## H3 VAE speed update

See [H3 VAE speed](../docs/h3-vae-speed.md). ComfyUI v0.37.1 already includes
the upstream optimization. `h3-vae-speed.patch` selects the official INT8 video
VAE in both H3 templates and enables FP16 accumulation by default in this
portable installation, including GPUq launches. Install with
`python3 scripts/apply-h3-vae-speed-desktop.py`, then refresh ComfyUI through
GPUq after active work finishes.

## Source-video replacement

See [generic video replacement](../docs/video-source-edit.md). `video_edit.py`
and `test_video_edit.py` archive the live desktop files. The worker integration is
recorded in `video-source-edit-worker.patch` against the desktop Git baseline;
the live worker also contains unrelated local changes. Copy the two Python files
to `video_gen`, apply the worker patch to a compatible checkout, install the three
model files named in `video_edit.py`, and reload the worker while idle. Apply
`minimax-h3-fun-v2-compat.patch` to ComfyUI v0.37.1 and restart ComfyUI while
idle before using the Union 2.0 model. This
feature requires the broker's `video_edit_version` lease gate.

## Original-song lip-sync

See [original-song lip-sync](../docs/video-source-audio.md) for command usage, audio
conditioning, fixed scene timing, installation and verification. Apply with
`python3 scripts/apply-video-source-audio-desktop.py` and reload the worker while idle.

## Durable video recovery

See [video recovery](../docs/video-recovery.md) for the approved-story pipeline,
quality checks, alternate video renderers, resumable delivery, and shared Qwen paths.
Install with `python3 scripts/apply-video-recovery-desktop.py`; the hash-checked
patch targets the audited desktop baseline and preserves unrelated local edits.

## Local Qwen fallback

See [local planning diagnostics](../docs/video-planning-diagnostics.md) for private
rejected-candidate evidence, prompt runtime ranges, and terminal planning
exhaustion. Install with `scripts/apply-video-planning-diagnostics-desktop.py`.

`video-local-fallback.patch` lets recovery protocol 3 plan, compose opening images,
and review scenes with local Qwen when GPT-5.6 Sol or the image providers reject a
request. See [video recovery](../docs/video-recovery.md#local-qwen-fallback).
Install with `python3 scripts/apply-video-local-fallback-desktop.py --check`, then
without `--check`, and reload the idle worker child before deploying the broker.
Patches 5 and 6 add the `$qwenimage` and `$qwenedit` image jobs; patch 6 expects
ComfyUI v0.37.1 or newer and the official Qwen Image 2.1 int8 weights
(`qwen_image_2.1_int8_convrot.safetensors` in `models/diffusion_models`,
`qwen3vl_8b_int8_convrot.safetensors` in `models/text_encoders`).

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

## Supporting cast continuity

`video-cast-continuity.patch` and its hash manifest archive the candidate desktop
update for supporting characters introduced after frame zero. The broker accepts
an optional `scene_reference` only after the preceding video is accepted. The
worker extracts that video's last usable frame when composing a new opening.
Later openings wait for that accepted clip rather than prefetching from the
portrait alone; the prefetch cache key includes the cast reference. This can add
boundary preparation time. Existing desktop canvas, audio and GPU lease handling
are preserved by the hash-checked delta.
Original references remain first and authoritative; the extra frame supplies only
returning supporting characters absent from those originals. Local image fallback
uses the same ordered references. H3 instructions bind appearance and voice to
each individual, including characters introduced after the opening.

The installer is intentionally separate from server deployment. The desktop
candidate is being evaluated on three historical requests before activation;
deploying broker support alone leaves older workers' requests unchanged. After
evaluation, check with
`python3 scripts/apply-video-cast-continuity-desktop.py --check`, apply without
`--check`, and reload the supervised worker while idle. Deploy both server tracks
with `scripts/deploy-bots.sh --with-broker` before using the updated worker.

Run `node --test tests/video-character-continuity.test.mjs` after building, and
`python -m unittest test_video_recovery` with the installed desktop dependencies.
The latter covers cut/reanchor references, retry budgets, outage recovery and
multi-character H3 compilation. Accepted openings and videos are not regenerated.
This is a boundary reference, not a complete character tracker: it cannot recover
a supporting character absent from the preceding frame, and that frame can itself
contain identity drift. Creative planning and audio mixing are unchanged.

## Continuous instrumental background and proportional effects

`video-sound-mix.patch` installs the optional `sound_mix` policy on the current
Windows worker without replacing unrelated desktop changes. The planner can
choose one instrumental background score for the full timeline, including under
dialogue, or intentional quiet. Explicit no-music requests and supplied audio take
precedence. Legacy plans retain their audio. Per-scene music instructions are
cleared when a continuous score is chosen.

Music3 composition runs through the worker's GPUq reservation, once per cached
specification. Upload retries reuse the score; failed composition falls back to
the generated soundtrack. The wrapper starts ComfyUI when necessary and stops
only a server it owns. Mixing runs on CPU **after** existing delivery loudness
normalization: the original audio stays underneath a quiet, ducked score. A short
score loops with overlapping fades, independently of picture cuts. The mixer
copies video packets unchanged; later upload-size conversion may still re-encode.
`soften_transients` reduces peaks only on quiet dialogue-free mixes, with a
lookahead ceiling near -24 dBFS to catch brief clicks that escape compression.
It cannot isolate an odd leaf sound from ambience or fix the timbre of a generated
effect. H3 instructions also avoid amplifying incidental foley or repeating each
shot's effect description in the overall soundscape.

```bash
python3 scripts/apply-video-sound-mix-desktop.py --check
python3 scripts/apply-video-sound-mix-desktop.py
```

Install and reload the supervised worker while idle, and deploy both server tracks
with `scripts/deploy-bots.sh --with-broker`. Set `VIDEO_SOUND_MIX=0` in the worker's
environment and reload it to bypass optional composition and mixing. The installer
checks exact before/after hashes and refuses concurrent edits. The supporting-cast
continuity candidate above remains separate and is not activated by this patch.

Verification: build and run `tests/video-sound-mix.test.mjs` alongside existing
audio/recovery tests. On the desktop, run `test_video_sound_mix`,
`test_video_recovery`, and the audio/compiler cases in `test_video_gen`. The media
tests measure speech amplitude, ducking, transients, timeline length and identical
video packet hashes. Human review is still needed for musical fit, unwanted
vocals, and whether sound-generation guidance improves rendered results.

For fixed-footage audio reviews use `scripts/serve-video-audio-review.mjs` with
`--run-dir=<directory containing human-review/final-videos.json> --port=4334`.
Its Listen A/B controls switch at the same playback position, with one soundtrack
audible. Rating and note changes preserve the existing players. The October 22
four-pair review contains three distinct historical requests plus the synthetic
leaf regression; its manually chosen scores evaluate mixing, not planner taste.

## Experimental creative direction and rendered review

`VideoFrontierCallOptions.plannerPromptVariant = 'opus-experience'` selects the
opt-in creative guidance. It chooses the intended viewing experience, makes
wordplay and invented speech optional, repeats each participant's identity across
shots, and asks for a concrete reason to use music. Explicit user requirements
remain binding. The configured Opus default is still `opus-tuned`; this candidate
has not earned a production rollout.

Compare first outcomes on distinct requests from actual usage. Freeze both
prompts, provider settings and renderer versions, preserve failures and production
recovery retries, and record cost and runtime alongside the rendered videos.
A small hand-picked diagnostic set can find problems but cannot establish a
population-wide improvement or isolate each part of this guidance bundle.

Use `scripts/serve-video-experience-review.mjs --run-dir=<experiment> --port=4335`
for these comparisons. It expects `renders/human-review/final-videos.json` and a
public `progress.json` listing every planned request, including queued and failed
versions. The packet's optional rubric is `['creative', 'identity', 'audio']`.
Reviewers choose A, B or tie for each dimension and overall; identity also permits
not applicable. Numeric scores remain required for older packets without this
rubric. Private paths and arm names stay off the review API. Append ready pairs
under `renders/review.lock` to preserve concurrent ratings.

Videos keep separate playback positions because their scripts may differ.
Choosing ratings, entering notes and receiving newly completed pairs preserve
playback. Test with `node --test tests/video-creative-direction.test.mjs
 tests/video-experience-review.test.mjs tests/video-cost-ab.test.mjs` after building.

## Exact continuation frame candidate

`video-continuity-frame.patch` replaces approximate end-time seeks with the last
successfully decoded video frame in both recovery and standalone generation.
The previous recovery seek selected a frame before the clip ended; in the
reviewed cigarette scene it rolled back two frames. The new helper decodes the
video stream through EOF, independently of audio duration, and atomically writes
its final frame. It does not promise that H3 reproduces the conditioning image
exactly or solve longer-range character drift.

This desktop candidate is evaluated separately from planner changes. Check with
`python3 scripts/apply-video-continuity-frame-desktop.py --check`; apply without
`--check` and reload the supervised worker while idle only after evaluation.
The hash-checked installer preserves unrelated desktop work. Run
`python -m unittest test_video_continuity_frame` with the desktop dependencies
and FFmpeg. Tests compare against independently reversed video and cover VFR,
B-frames, audio extending beyond the video, single-frame clips and invalid input.

`plannerPromptVariant = 'opus-specificity'` is a separate opt-in planner candidate.
It appends scene-logic and recognizable-theme checks to `opus-tuned`, without
changing its comedy, dialogue or music policy. The configured default remains
`opus-tuned`. Evaluate two reviewed regressions and fresh historical requests
with the same renderer for both arms; keep the fixed-script frame-selection
comparison separate when interpreting the results.

## Isolated subject replacement (protocol 8)

`video-edit-isolated.patch` contains the worker, crop/compositing helpers, optional
local Wan renderer, and their regression tests. Install with
`python3 scripts/apply-video-edit-isolated-desktop.py --check`, then omit `--check`.
The installer checks exact before/after hashes, supports newly added modules, and
refuses unrelated or mixed desktop revisions. Reload only the idle supervised
worker child, preserve its supervisor, and deploy both branches with
`scripts/deploy-bots.sh --with-broker`.

New replacements use target-only source crops, retain short shots, enlarge tiny
crops for motion generation, preserve the source soundtrack, and require still
and per-segment motion reviews before delivery. Failed shots stop the job. Old
workers cannot lease new replacements. Add operations keep their existing path.
See [source editing](../docs/video-source-edit.md) for the evidence and limits.

Viggle is the default. `VIDEO_EDIT_ISOLATED_RENDERER=wan` explicitly opts into the
experimental Wan-Animate-2 backend; its portrait framing is not yet reliable.
The pinned model manifest is `desktop/video-edit-wan-models.json` (~25 GB).
`scripts/install-video-edit-wan-models.py` downloads and verifies those weights;
`--check` verifies without downloading. Prefer Windows embedded Python for native
model-disk I/O; pass `--manifest` when copying the installer outside this checkout.
Run `gpuq gaming check --quiet` before model installation or validation, and run
all inference through GPUq. The existing worker reservation covers both renderers.
No hosted video API is required; existing still-image and review API usage remains.

Verify the broker with `yarn test`. With the desktop environment and FFmpeg, run
`python -m unittest test_video_edit test_video_edit_isolated test_video_edit_wan test_video_worker`.
The October 28 regression has a passing five-second isolated motion test, but no
passing full-clip edit. Failed still generation must not be mistaken for a usable
replacement, and a sampled review cannot guarantee every frame is artifact-free.
