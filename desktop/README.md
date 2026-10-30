# Desktop video optimization changes

## Silent mouth-motion refinement

`video-mouth-motion.patch` adds a CPU post-pass to short, silent, isolated source
edits. `video_mouth_motion.py` tracks the selected source and replacement faces
with the existing local InsightFace landmarks, measures lip aperture relative
to mouth width, and makes a small warp of the replacement's existing mouth
pixels. It adds no speech and never shifts video frames. The source subject mask
and recognized caption boxes constrain which pixels may change before encoding;
the mouth displacement is capped at six pixels. Smoothing resets at each cut.

The helper requires an unambiguous, fully tracked mouth in every frame and a
normalized 24 fps timeline. It skips clips shorter than one second, longer than
ten seconds, larger than 896×512 pixels, tiny/steep faces, nearly static mouths,
and already-close aperture motion. A fresh landmark pass must reduce mean
aperture error by at least 20%, or the original render is retained. Missing
models, analysis failures and the 90-second wrapper deadline also retain the
original. Set `VIDEO_EDIT_MOUTH_MOTION=0` to disable it. The score measures mouth
opening geometry; it does not establish that every word can be lip-read.

The actual three-second silent example improved from 0.0939 to 0.0263 mean
normalized aperture error (72% lower), retained 72 frames, and took about
22 seconds through the Windows→WSL wrapper. The model runs with the CPU provider
in the existing LatentSync venv; no new model download or GPU job is needed.
Eleven geometry/isolation/fallback tests pass in that Linux venv, and the 40
existing edit/isolated tests pass in Windows. The helper tests require the Linux
venv's OpenCV, which the embedded Windows Python does not provide.

Apply `python3 scripts/apply-video-mouth-motion-desktop.py --check`, then omit
`--check`. New edit subprocesses load the helper automatically. Sync both branches
and deploy with `scripts/deploy-bots.sh --with-broker` while the edit queue is idle.
Test the helper with `/home/zp/.venvs/latentsync/bin/python -m unittest discover
-s desktop -p test_video_mouth_motion.py`.

Showcase: <http://localhost:4364>, started with
`node scripts/serve-lipsync-showcase.mjs`. It displays the actual source, original
delivery and corrected post-pass output from `artifacts/isolated-lipsync/showcase`,
with a shared frame scrubber and muted playback. The report labels the helper
revision. `?case=loading`, `?case=empty`, and `?case=error` exercise the same media
cards and disabled controls without invoking inference.

## Repaint requests survive short broker restarts

`video-edit-repaint-retry.patch` retries the same shot after HTTP 502/503/504
or a dropped broker connection, with waits of 5, 10 and 20 seconds (four requests
maximum). Provider timeouts, content refusals and other HTTP failures remain
final. Cancellation during backoff prevents another request. These retries
occur while the tracking GPU reservation is already released.

Apply `python3 scripts/apply-video-edit-repaint-retry-desktop.py --check`, then
omit `--check`; reload the idle worker. Run `python -m unittest
test_video_edit_repaint_retry test_video_edit_backend test_video_edit_reservation
test_video_reservation` in the installed runtime. Deploy both branches with
`scripts/deploy-bots.sh --with-broker`; wait for active edit requests to finish
before planned broker restarts, then resume dispatch after worker verification.

## Source-edit backend failures

`video-edit-backend.patch` requests `--evict-cache-before-run` through gpuq for
each source-video edit admission. This starts a fresh managed ComfyUI backend
and avoids carrying cached SAM3 model weights between tracking and animation
admissions or later edits. Ordinary video generation retains its warm cache.
The tradeoff is additional backend startup time for edits. This is a workaround
for the native DynamicVRAM abort observed in `restore_loaded_backups` during
job `1d4756d0`, not a change to ComfyUI's memory manager.

History polling tolerates two consecutive transport failures while retaining
the same prompt ID and the overall render deadline. A third failed read reports
backend unavailability. Source edits now use the broker's bounded readiness
retries for that error and gpuq's ComfyUI startup timeout. Tracking, quality,
render deadline and API validation failures remain final. A failed prompt POST
is never automatically resubmitted because its acceptance may be unknown.

Apply `python3 scripts/apply-video-edit-backend-desktop.py --check`, then omit
`--check`. Reload the worker while idle or safely waiting for admission. Run
`python -m unittest test_video_edit_backend test_video_edit_reservation
test_video_reservation test_video_edit` in the desktop runtime; all 56 tests
pass. Sync both branches and deploy with `scripts/deploy-bots.sh --with-broker`.
The bot's stall monitor also preserves an existing alert through worker
disconnect/reconnect, avoiding a false recovery followed by another first alert.

## Release GPU admission during source-edit repainting

`video-edit-reservation.patch` closes and clears the tracking reservation before
waiting for remote shot repaints. Animation obtains fresh admission with a new
idempotency scope derived from the tracking reservation. Cancellation skips
readmission; a rejected admission never starts animation. Local Wan edits keep
their reservation because they have no remote repaint wait.

This fixes `GPU reservation ended in state succeeded`: the reservation child
exits after 60 seconds without another command following a completed result,
but repainting can take several minutes. In job `204552f8`, tracking completed
at 4:24:19 PM EDT on October 29, 2026; its replacement still arrived at
4:25:40 PM EDT, after that timeout. The successful reservation described the
tracking subprocess, not a completed video.

Apply `python3 scripts/apply-video-edit-reservation-desktop.py --check`, then
without `--check`; reload the supervised worker while idle. Run
`python -m unittest test_video_edit_reservation test_video_reservation` from
the installed desktop runtime. The regression fails against the previous worker
and passes with the patch. Sync both branches and deploy with
`scripts/deploy-bots.sh --with-broker`.

## Short blends between generated shots

`video-shot-blend.patch` makes ordinary `cut` boundaries between independently
generated clips use a 0.25-second picture/audio crossfade (six frames at 24 fps).
Planned `dissolve` transitions still use up to 0.5 seconds. Each overlap is
bounded by a quarter of both adjacent clips and rounded down to whole frames.
Continuations, single clips, exact external-song timelines, and source-video
edits retain their existing assembly. Cuts generated *inside* one model clip
are not postprocessed by this change.

The overlap shortens the final video by 0.25 seconds per ordinary boundary and
briefly overlaps its audio. Explicit `audio_transition=cut` or `fade` retains
the existing midpoint audio edit. Set `VIDEO_SHOT_BLEND_SECONDS=0` in the worker
environment to restore hard cuts; finite values are bounded to 0–0.5 seconds,
and invalid values fall back to 0.25 seconds.

Apply `python3 scripts/apply-video-shot-blend-desktop.py --check`, then without
`--check`. The installer verifies the audited live revision before changing it.
Reload the supervised worker while idle, sync both branches, then deploy with
`scripts/deploy-bots.sh --with-broker`. CPU tests in the Windows embedded Python:
`python -m unittest test_video_shot_blend.ShotBlendTests test_video_output_quality
test_video_canvas test_video_recovery`.

Showcase: <http://localhost:4348>, started with
`node scripts/serve-shot-blend-showcase.mjs`. Generate fixtures first with the
desktop Python and `scripts/generate-shot-blend-showcase.py --desktop-directory
<installed-video_gen> --output <repo>/artifacts/shot-blend/showcase`. It uses the
real assembler, includes the hard-cut comparison and timing exceptions, and
records the installed source hash. The player starts muted. No GPU render or
private video is used.

## Source caption protection

`video-edit-captions.patch` adds foreground caption layers to the shared subject
compositor. Seven source samples, bounded to a 640-pixel analysis canvas, expose
temporally stable colour planes. CPU Tesseract recognizes candidate words;
connected glyph components provide protection, including a thin outline. Source
subject masks reject clothing text. Background components extending beyond the
word are rejected so inverse text cannot accidentally restore a rectangular
piece of the old scene. Caption protection is subtracted from the edit alpha
after dilation and feathering. Each output frame uses its own source pixels;
the mask releases when the caption disappears. Only real source frames are
sampled and encoded, excluding model padding.

This runs automatically for both commands' default isolated edits (Viggle/Wan)
and the shared masked H3/add path. The separate legacy Character Swap backend
does not use this compositor. Fixed captions with recognizable single-colour
glyphs are supported; moving, changing, low-confidence and multicolour text can
be missed. This does not fix artifacts already present in the source animation.

Apply `python3 scripts/apply-video-edit-captions-desktop.py --check`, then omit
`--check`. This hash-checked update requires the audited halo revision. The new
helper uses existing NumPy, SciPy, Pillow and FFmpeg plus Tesseract 5 (English
data). On Windows, a native Tesseract is preferred; otherwise it invokes the
installed Ubuntu `tesseract-ocr` through WSL using `VIDEO_LIPSYNC_DISTRO` (default
`Ubuntu`). OCR uses one CPU thread, at most twelve colour planes, a five-second
per-call deadline and a 25-second recognition budget. No GPU or API call is added.
Missing OCR, decode failures and timeouts stop the edit with a retained JSON
report rather than silently bypassing protection. Successful and empty detection
are also recorded per segment. The worker loads the updated subprocess on its
next edit; no worker or ComfyUI restart is needed. Deploy both server tracks with
`scripts/deploy-bots.sh --with-broker` after syncing the commit.

All 68 tests passed in the Windows embedded Python/FFmpeg runtime:
`python -m unittest test_video_edit test_video_edit_isolated
test_video_edit_composite test_video_edit_captions test_video_edit_wan`.
Tests cover multiple caption colours/positions, frame-edge text, clothing text,
moving/disappearing text, empty scenes, missing OCR, incomplete masks, exact frame
counts, source letters, editable counters and unchanged replacement interiors
through the real compositor, both with and without mask growth/feathering.
Linux runs have two pre-existing platform differences in the older edit suite
(Windows drive mapping and the FFmpeg `gradients speed=0` fixture); the native
runtime passes both. The 25 caption/composite tests also pass under Linux.

Replaying the compositor against the cached `e02575b8` source, subject track,
replacement and alpha automatically recognized the caption and retained all 58
frames. No caption-specific coordinates, colours or wording entered detection,
and no diffusion render was rerun. The reviewed showcase uses synthetic fixtures
through this same installed compositor: <http://localhost:4347>, started with
`node scripts/serve-gif-video-showcase.mjs` after building the bot.

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

## Replacement silhouette and blending update

After installing isolated subject replacement, apply
`python3 scripts/apply-video-edit-composite-desktop.py --check`, then omit `--check`.
This incremental patch requires the audited isolated-edit revision and existing
SciPy/SAM3 nodes (already present on the desktop). It adds local spatial tracking
of the generated subject, an opaque union of both silhouettes with an outward
feather, strict crop support, and crop-aware smoothed brightness matching.

Use this newest installer's hash check after applying it; the older isolated
installer intentionally no longer matches the changed `video_edit.py`. No ComfyUI
restart is necessary. The worker starts a fresh `video_edit.py` subprocess for
each edit, so existing worker protocol 8 loads the changes on its next edit without
interrupting active work. Deploy both server tracks with `--with-broker` as usual.

Run `python -m unittest test_video_edit test_video_edit_isolated
 test_video_edit_composite test_video_edit_wan test_video_worker` with the desktop
Python/FFmpeg environment. The 126 tests and a cached-diffusion/live-compositing
integration check passed. The full original clip remains unresolved; the updated
five-second comparison addresses visible blending defects, not all motion quality.

## Source blur and edge halo correction

Apply `python3 scripts/apply-video-edit-halo-desktop.py --check`, then omit
`--check`, after the composite patch. This newest incremental installer verifies
the prior composite revision and refuses unrelated desktop edits. Use its hash
check after installation; the older composite installer is now superseded.

The compositor expands source erasure to include its blurred fringe, while
keeping the replacement interior opaque and clamping all alpha to render support.
Local RGB matching samples outside the source blur and replacement masks, bounds
and smooths colour corrections, and protects replacement facial detail. It adds
CPU processing in the existing encoding pass, without new models or API calls.
The worker loads it on the next edit without a restart. Deploy both server tracks
with `--with-broker`.

The same desktop test command above passed 133 tests. A production-path integration
check reused identical diffusion and SAM outputs and ran all changed compositing
and review-evidence extraction live. The inspected five-second comparison reduces
the brown/grey arc around the face; it does not establish full-clip success or fix
the renderer's facial performance.

## Experimental background-gap repair (not a worker default)

`video_edge_repair.py` is a reusable local evaluation tool for the remaining halo
behind replacement hair. It uses RVM to protect confident foreground, then
ProPainter to repair only the tracked background gap. It refuses missing or
partial foreground, mismatched inputs and overbroad repair masks. Final assembly
restores protected pixels from the input composite before encoding and copies its
audio. Nothing invokes this tool from the normal worker; this candidate is still
too soft in the October 28 regression to promote automatically.

Install/check the tool, pinned upstream code and ~215 MB of weights with
`python3 scripts/install-video-edge-repair.py` / `--check`. The installer refuses
unknown files. Install `desktop/video-edge-repair-requirements.txt` with the
Windows embedded interpreter using `pip install --no-deps --target
D:\AI\ComfyUI_windows_portable\video_gen\optional\matting-deps -r <requirements-path>`.
Dependencies stay outside shared ComfyUI packages. These packages assume the
existing desktop Torch, Torchvision, NumPy, SciPy, Pillow and PyYAML environment.
ProPainter uses the upstream S-Lab non-commercial license; RVM uses GPL-3.0.
See the upstream licenses linked in `video-edge-repair-models.json` before reuse.

Run a single normalized segment (at most 360 frames / 15 seconds) through GPUq, supplying its
current composite, raw generated crop, source mask, replacement SAM mask and crop
coordinates. Always use a new work directory and output file:

```text
gpuq run --source codex --profile video-h3 --priority normal --when-gaming hold --on-preempt fail -- D:\AI\ComfyUI_windows_portable\python_embeded\python.exe -s D:\AI\ComfyUI_windows_portable\video_gen\video_edge_repair.py --composite <segment.mp4> --motion <raw-crop.mp4> --source-mask <source-mask.mp4> --replacement-mask <replacement-mask.mp4> --box <left> <top> <right> <bottom> --work <new-directory> --output <candidate.mp4>
```

Check `gpuq status` first. Review the complete candidate before selecting it;
nonempty masks do not establish good hair matting. Run `python -m unittest
test_video_edge_repair` with the desktop environment for protection/validation
regressions. The existing desktop suites plus these seven tests passed 140 tests;
the generic CLI also completed the 121-frame regression with its audio intact.
See [the evaluation record](../docs/video-source-edit.md#remaining-hair-halo-evaluation).

The current refinement preserves partial-alpha edge pixels only within two pixels
of confident foreground, rather than protecting an unconditional background ring.
It keeps the strict foreground-loss check and uses no temporal mask carryover.
All 144 desktop tests pass, including four added boundary regressions. Re-running
the installer upgrades the exact audited first release; `--check` requires the
current version. Both tool files are validated before either is changed. This is
still an optional evaluation path, not an automatic worker stage.

Frame-edge repair now uses an additional local pass only when a repair mask
touches the canvas boundary. A 32-pixel reflected border provides context, and
only the outer 12 pixels of active repaired edges use its result. The accepted
interior and protected foreground are restored unchanged before encoding; output
dimensions and audio are preserved. Intermediate reflected frames and predictions
are saved under `boundary-context`, and `candidate.json` records whether the pass
ran. All 149 desktop tests pass. The installer accepts both audited earlier tool
revisions and refuses unrecognized edits.

Repair retains recurrent matting state across a complete shot segment, including
shots longer than a 124-frame motion-generation window. The bounded limit is 360
frames, matching the edit planner's 15-second segment limit. ProPainter retains
its existing 40-frame processing windows. The frame-count regression covers the
131-frame close-up from the full-video regeneration as well as the upper bound.
Internal segments can also be shorter than the 0.5-second upload minimum. For a
one-frame shot, the inpainting model receives a duplicated frame/mask as flow
context; only one output frame is retained. This does not change the source upload
rules. All 151 desktop tests pass; one-frame and 131-frame real renders completed.

Use `video_edge_repair.assemble_segments(segments, source, destination, work)` to
join repaired video segments with the source soundtrack. It rebuilds 24-fps
timestamps from decoded frame order, avoiding overlapping DTS after one-frame
cuts, and copies AAC audio. Assembly encodes video once; `destination` must be new.
The 152-test suite includes exact frame-order and timestamp checks for this case.
`indexed_frames(path, indices, width, height)` extracts exact review frames rather
than seeking to rounded milliseconds, which can accidentally sample the next shot
at a cut boundary. Use it for matched source/output evidence after assembly.

## Recovering failed replacement animation tracks

`video-edit-recovery.patch` adds one Wan-Animate-2 retry when an isolated Viggle
render cannot be tracked. It retains the accepted original still and source motion
crop. If the alternate propagated track is lost during a turn, spatial segmentation
is repeated on each frame. Validity thresholds and final motion review are retained;
the alternate is never recursively retried. Missing weights and unrelated service
errors stop the job. Existing GPUq admission covers the complete edit subprocess.

Apply after the caption patch:

```sh
python3 scripts/apply-video-edit-recovery-desktop.py --check
python3 scripts/apply-video-edit-recovery-desktop.py
```

The installer verifies the baseline or already-applied hashes and refuses concurrent
edits without writing files. The worker launches a fresh subprocess for each edit,
so no ComfyUI or supervised-worker restart is needed. Wan weights are the existing
audited optional installation from `video-edit-wan-models.json`.

`animation-recovery-NN.json` records the attempt. The generated masks and spatial
redetection workflows stay in the job's `viggle` directory. A `tracked` recovery
status means only that compositing may proceed, not that the broker approved the
video. All 74 focused desktop tests passed; the same failing clip also completed
with cached real diffusion output, live tracking/compositing and live motion review.
The final-frame seek regression was verified with native FFmpeg decoding.

## Recover source tracking after camera movement

Apply `python3 scripts/apply-video-edit-source-recovery-desktop.py --check`, then
without `--check`, after the animation-recovery update. The installer checks both
existing renderer hashes, rejects unexpected helper files and concurrent changes,
and supports repeat installs. No worker restart is needed: each edit starts a new
renderer process. Deploy both bot tracks with `scripts/deploy-bots.sh --with-broker`.

A failed source track gets one reverse pass. A still-fragmented primary track can
seed one object from a sustained detection and propagate it in both directions,
without text redetection. The original coverage checks still apply. Empty source
masks now suppress generated alpha. Source frame order, duration, padding, target
text and primary/group selection remain intact; group edits cannot use the
single-object seed fallback. JSON recovery records remain in the edit work folder.

Run `python -m unittest test_video_edit_source_recovery test_video_edit
 test_video_edit_isolated test_video_edit_composite test_video_edit_recovery` in the
Windows desktop runtime. All 74 tests passed. Fresh preparation of the full
17-second regression clip passed both shots; final replacement generation and
delivery were not replayed. See `docs/video-source-edit.md` for the evidence.

## Reject background masks and protect subject colour

Apply `python3 scripts/apply-video-edit-alignment-desktop.py --check`, then run it
without `--check`. The installer checks the exact compositor and recovery-test
revisions and existing helper contents before writing. New edit subprocesses load
the change automatically; no ComfyUI or worker restart is needed.

Replacement masks must overlap at least 25% of each visible source subject mask.
A failed alignment receives one segmentation retry per real frame, using the
source mask's deepest interior point. This retry reuses the raw generated pixels;
it does not invert the background mask or generate another animation. Empty source
frames receive empty masks. Failed recovery retains the existing bounded renderer
fallback; service failures stop the job. The retry graph and alignment JSON are
saved next to the replacement mask, with the rejected mask retained for diagnosis.

Background colour matching protects the union of source and replacement silhouettes,
including interior holes. Invalid alignment disables that correction and clears its
history. Whole-frame exposure matching, captions, source timing and final motion
review remain in place. Run the Windows `test_video_edit_alignment`, `test_video_edit`,
`test_video_edit_composite`, `test_video_edit_isolated`, `test_video_edit_recovery`,
`test_video_edit_source_recovery` and `test_video_edit_captions` suites (91 tests).

Point-recovery graphs join adjacent masks in a balanced tree, retaining source
order without quadratic cached batch storage on long shots. The installer accepts
the exact audited initial helper revision as an upgrade; unrelated edits still
stop installation. The added batch-order/storage regression brings the focused
suite to 92 tests.

## Preserve source fades and review temporal continuity

Deploy both bot tracks with `scripts/deploy-bots.sh --with-broker` first: motion
review now accepts up to 16 chronologically numbered frame pairs. Then run
`python3 scripts/apply-video-edit-continuity-desktop.py --check` and the same
command without `--check`. It requires the alignment update, verifies all four
patched desktop files and both new helper files, and refuses unrelated revisions.
New renderer subprocesses load the change automatically.

Histogram scene cuts are vetoed only with matching local scene structure or a
gradual uniform exposure ramp. Missing dark source masks get one enhanced reverse
tracking pass and one point-guided retry. Recovery requires matching subject
texture and mask overlap within 12 frames. One adjacent frame may use a confirmed
neighbor mask only when independently detected partial foreground corroborates
it; these bridges never chain. Black frames and actual occlusions are excluded.
Ambiguous candidates fail closed, with `dark-recovery-NN.json` evidence.

Exposure matching follows dark frames and sustained source fades without the
normal minimum gain, smoothing or bright-highlight bypass. Review evidence adds
neighbors around every segment join, source visibility transition and unexpected
output jump. More than 16 required samples stops the edit rather than dropping
evidence. Motion review version 4 checks pop-in, identity/pose/placement changes
and exposure against the source; existing still admission remains unchanged.

The focused Windows suites above plus `test_video_edit_continuity` cover the new
behavior, including actual FFmpeg encoding of fading highlights. See
`docs/video-source-edit.md` for real-clip validation and its remaining limitation.
