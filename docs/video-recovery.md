# Video recovery

The broker's production configuration enables recovery protocol version 3. It
leases new work only to a worker advertising that version or newer. Existing active
leases can finish normally during a broker restart.

An approved screenplay is the content contract for the job. Planning can repair
timing and split dialogue at clause boundaries, but cannot remove required
speech. Recovery does not rewrite the request, substitute another story, or
discard its source images. Technical planning failures retry the same original
brief once within the job budget.

## Local Qwen fallback

When GPT-5.6 Sol rejects the request, whether through its `frontier_handling`
decision, an API refusal, or an OpenAI moderation block, the broker answers the
worker's `plan` call with `local_plan_required` instead of stopping or retrying.
The broker persists that routing decision, so a resumed job never asks Sol
again. The desktop worker then plans the original request with the local
abliterated model (`hauhaucs-qwen3.8:27b-q4kp-mtp`), passing Sol's prompt
analysis so both planners agree on what is spoken. It uploads the screenplay to
`recovery/local-plan`, and that screenplay becomes the approved contract
(`contract.planner = 'local'`). The one exception is `minor_sexualization`:
sexual content involving minors stops the job and is never planned locally.

New scene openings always try the frontier image providers first, even for a
story Sol rejected: they draw far better frames, and a single scene of a
rejected story is often unobjectionable. When they refuse (a moderation block,
an unavailable identity review, or a failed identity or composition review), the
desktop composes the opening locally with Qwen-Image-Edit-2511 and its 4-step
Lightning LoRA, which receives up to three source references when the contract
uses them. Qwen Image 2.1 was replaced on 2026-09-21: its reference path gave a
supplied face crusty, over-sharpened skin with the 4-bit GGUF and the official
int8 build alike, and at every CFG, step count, and reference resolution tested,
and it tended to re-render the reference instead of the requested scene. On
2026-09-23 that turned out to be the hand-ported 2.1 support on ComfyUI v0.33.1,
which copied references even in the official template example. ComfyUI v0.37.1
edits correctly with natural skin, so 2.1 is again a candidate for openings.
Edit-2511 kept the identity, followed the scene, and was faster (about 10 s per
frame once loaded). The benchmark frames are on the desktop in
`video_gen/benchmark_outputs/qwen_image_skin_ab_20260921`. Provider outages still wait and
retry. The local planner sometimes marks a segment that keeps the same shot
("Meximutt remains in the medium close-up") as a hard cut; the broker turns such
a segment into a continuation, so it opens on the previous clip's last frame
instead of a newly generated image. Every local step (planning and each opening image) takes
its own `gpuq` reservation on the `video-h3` profile and releases it afterward,
like a scene render.
Saved plans that silently rewrote the request are rejected on resume.
For oalgo, the original Meximutt reference is mandatory. If it is missing or
excluded, the job stops before rendering. For portrait-only oalgo requests,
the original portrait is also the required opening frame; a generated
replacement keyframe is rejected.

Each scene gets an opening image. When the approved plan calls for the original
portrait at frame zero, the worker uses that image directly. Continuing scenes
check the previous accepted clip's final frame before using it. New shots get their own opening
composition, without inheriting a frame-zero crop restriction. Cloud-generated openings
pass through the image generator's own identity and composition repair. Local fallback
openings with identity references use the bounded check described below.

No model reviews complete rendered scenes. Model review rejected usable videos over
minor issues and added Sol, Gemini, or local Qwen calls to every scene, so it
was removed on 2026-09-21. A scene is accepted once its render produces a
decodable clip. The worker still records each scene's file hash with the broker
(the video `review` call makes no model request), so final approval can
require the exact rendered scenes. The worker permits two image attempts per
recovery pass. A render that produces no valid output is retried once with the
requested renderer: two render attempts total per scene, across reconnects and
recovery passes. The worker persists this count and stops before reserving more
GPU work once it is exhausted.

### Character continuity at clip boundaries

Before a continuation, a focused Gemini Flash vision check compares the candidate
frame against the permanent original references and the next scene's cast. It
does not grade acting, effects, audio, or general quality. If the next scene needs
a returning character whose identity is hidden, absent, unreadable, or clearly
changed, the worker requests a new opening composed from the originals. The
opening stages the earliest recognizable instant of the return, retaining the
planned setting and requested transformations. MiniMax H3 still renders the clip.

The original references never become the previous generated face. Text-only jobs
use their first accepted opening as the permanent reference for this check and
for replacement openings. New cast that does not recur from those references is
not forced to resemble it. Recognizable continuations keep the previous frame.
The check's character descriptions are repeated in the next clip's visual prompts.

Decisions are cached by contract, segment, original reference bytes, and candidate
frame bytes. Reconnects reuse them; a changed frame requires a fresh check. An
unavailable or malformed check defers the job without consuming a render attempt
or discarding completed clips. Existing accepted clips are not regenerated. This
reduces drift at clip boundaries; it does not guarantee identity within a clip or
add a final-video identity review.

Install the desktop update with
`python3 scripts/apply-video-character-continuity-desktop.py --check`, followed by
the same command without `--check`. The hash-checked patch preserves the installed
source-audio and telemetry updates. Deploy the broker first, then reload an idle
desktop worker. Older workers can finish their current leases.

### Bounded identity check for local openings

Recovery references now have explicit roles: Picture 1 defines the original
identity; the optional attached scene supplies context and only the additional
subjects assigned to it by the screenplay. A scene's stand-in protagonist cannot
replace the original person. The local prompt preserves the requested recurring
cast rather than every person in every reference, and preserves facial identity
across requested stylization. Text-only jobs retain their first accepted opening
as the identity reference on cuts as well as repaired continuations.

Only a newly composed local opening with an identity reference adds a Gemini Flash
check. Cloud-reviewed openings, original portraits, accepted continuations and
finished clips add no new review call. The check examines clear identity/cast
substitutions and tolerates ordinary expression, pose and rendering changes. It
uses medium image resolution, the opening shot and bounded continuity text, with
a 768-token output ceiling. It does not inspect audio or the full video.

Decisions are cached by contract, scene, original references and candidate bytes.
There is at most **one corrective local image attempt per video**, shared across
scenes and reconnects. The correction reuses the saved local directive instead of
retrying the cloud image providers. Each scene can spend at most two identity
calls, including failed/unavailable calls; counts are persisted before requests.
An unresolved identity failure stops the job before animating that opening. A
restart cannot reset the correction budget, and completed clips are retained.

Install with `python3 scripts/apply-video-opening-identity-desktop.py --check`,
then without `--check`. Deploy both branches with `scripts/deploy-bots.sh
--with-broker`, then reload the supervised desktop worker child while idle.

Saved-frame replay on job `2a50451d` (2026-09-27): the check rejected the wrong
cartoon opening and animal substitution and accepted the recognizable final
opening. The three calls used 2,134–2,254 input tokens and 16–238 output tokens,
took 7.5–12.5 seconds each, and cost an estimated $0.00174–$0.00249 each using
the repository pricing table. This validates detection on those saved frames,
not newly rendered video quality.

Only actual generated video can pass final approval. Storyboards, slideshows,
and caption cards are never substitutes for requested action. Exhausted render
attempts stop the job with a diagnostic failure instead of retrying forever; a
placeholder is never delivered.

The broker persists the approved contract, recorded scene hashes, worker
checkpoints, and final approval. The worker persists accepted artifacts
locally. Recording/upload interruptions reuse rendered media;
unfinished interrupted renders may resume as a new attempt. Temporary service
failures return the same job to the queue with exponential backoff, preserving
its checkpoint and releasing the worker. Three failed recovery passes per job,
or any non-retryable worker failure, stop the job with its last diagnostic.
Both broker and worker enforce persisted limits across restarts. Explicit
regeneration creates a new revision and budget, including for old queued jobs
already over the limit. A service outage can therefore prevent completion; this is not
a guarantee of immediate delivery during an outage.

Speaking characters retain their source anatomy. A mouthless robot uses its
established voice mechanism instead of acquiring human lips, teeth, or a jaw.
Actions explicitly preceding speech get their own timing so the remaining
speaking window can hold the complete line.

Completion requires approval for every scene and the exact uploaded file hash.
Generated clips are normalized before concatenation and the final MP4 is fully
decoded before upload. Discord delivery records the posted message ID before
editing the progress message, so a cosmetic edit failure cannot trigger a render.
Authorized regeneration increments a delivery revision and replaces attachments
on the existing Discord message; stale delivery acknowledgments cannot complete
the new revision.

Recovery performance telemetry records one span per scene render attempt, H3
sampling and other ComfyUI stages, GPU admission wait, final upload, output
duration, and completed-job service time.
Telemetry upload is best effort and cannot prevent delivery. The desktop change
is archived in `desktop/video-recovery-telemetry.patch` with exact before/after
hashes; `scripts/apply-video-recovery-telemetry-desktop.py --check` verifies it
against an installed worker. The live desktop source was updated on September 25,
2026. A running worker must restart before it loads the change.

## Desktop installation and Qwen

Run `python3 scripts/apply-video-recovery-desktop.py --check`, then run it without
`--check` to install on the recorded desktop baseline. The archive includes only
the recovery hooks plus the new helper modules. Reload the supervised worker
child while idle, preserving its supervisor and any active GPU work. Deploy both
bot branches with `scripts/deploy-bots.sh --with-broker`.

For an existing recovery installation, apply the bounded-retry and robot-anatomy
update with `python3 scripts/apply-video-recovery-limits-desktop.py --check`, then
run it without `--check`. It checks the baseline hashes before changing files.

`gpuq_settings.py` reads the coordinator's `%LOCALAPPDATA%\GpuQ\config.json`
(`GPUQ_CONFIG` can override it). The generator no longer maintains separate
hardcoded model paths. The worker checks file availability at startup without
loading a model. Qwen's model and vision projector live under
`D:\AI\llama.cpp\models`; the stale `C:` paths were the missing-model cause.
The coordinator config and source defaults have been corrected. Reload an idle
coordinator after changing its config; it caches configuration in memory.

GPU work, including validation, still uses `gpuq` and respects Gaming Mode.

Install the local-fallback update (protocol version 3) with
`python3 scripts/apply-video-local-fallback-desktop.py --check`, then run it
without `--check`. Each desktop file's recorded hash chain shows which of the
six archived patches it still needs; the installer applies those in order
and verifies the result. The third patch removes the worker's scene-review
sampling and local review mode. The fifth adds the standalone `$qwenimage` and
`$qwenedit` image jobs (see [local video generation](../VIDEO_GENERATION.md)).
The sixth moves Qwen Image 2.1 to its official int8 weights, samples its edits on
the reference-shaped latent, and adds Edit-2511's full 40-step mode for `$qwenedit`. Reload
the supervised worker child while idle so it advertises version 3, then deploy
the broker. A broker running version 3 leases nothing to a version 2 worker,
so update the worker first to avoid a stalled queue.

## Verification

### Source-image vocal performances

For a request that only asks the pictured subject to speak, sing, rap, or
lip-sync, frontier planning and desktop fallback preserve the source composition
and individual features throughout. Mouth articulation, blinks, and modest head
motion carry the performance. Song lyrics do not independently authorize body
reveals, new props, confetti, or camera pullbacks. Explicit additional staging,
music-video treatment, transformations, and narrative adaptations retain their
own direction.

Job `3ed9783e` exposed both over-staging and an overly permissive boundary check:
the source dog acquired different eyes, muzzle proportions, and facial markings,
but matching breed and coat color were accepted as identity. Opening and
continuation checks now explicitly compare individual animal features, using
the original image above screenplay descriptions. The continuation check uses
high image resolution and medium reasoning, and must explain concrete facial
matches or differences. This remains a boundary check; it does not review or
repair drift within an already-rendered segment.

The desktop-only prompt addition is archived in
`desktop/source-image-performance.patch` and applied to the live `video_gen.py`.
From the generator directory, use `git apply --check` before applying that patch;
an updated copy passes `git apply --reverse --check`. New generator subprocesses
load it without a worker restart. Deploy the frontier and continuity changes
on both tracks with `scripts/deploy-bots.sh --with-broker`.

For cutout performances, background design is now separate from subject identity.
A transparent or empty flat backdrop may develop into a restrained setting
grounded in the supplied lyrics, while the performer's crop, facial features,
and visible body remain fixed. Meaningful photographed settings and explicit
requests for unchanged backgrounds remain protected. The video starts from the
supplied composition and develops the new setting continuously behind it.
The follow-up desktop instruction is `desktop/source-performance-background.patch`,
applied after `desktop/source-image-performance.patch`.

Recovery image decoding now composites alpha over a neutral white matte before
converting to RGB, including palette transparency. Previously it discarded alpha,
exposing hidden black pixels and hardening antialiased cutout edges. Review JPEGs
use the same blend; opaque backgrounds and subject pixels retain their colors.
This fixes transparency handling, not missing detail in a tiny source photograph.
Apply `desktop/video-transparent-source.patch` to the installed `video_recovery.py`
and reload the supervised worker child while idle; do not overwrite newer live
recovery code with the older repository snapshot. Verify with
`python3 -m unittest discover -s desktop -p test_video_transparent_source.py`.

Lyric-driven scenery must now come from the contextual meaning of the whole
passage. Frontier analysis records the reading in `tone` and `resolved_intent`,
explains inferred visual choices in `inferred_staging`, and records likely
misreadings in `prohibited_substitutions`. The screenplay carries that reading
into its actual visual directions. Inferred staging separates the environment's
material conditions from the speaker's attitude before choosing lighting or
activity: pride must not automatically upgrade the setting, nor grief ruin it.
Source-audio guidance no longer tells it to
literalize each passage automatically. This is general planning guidance, not
a song-specific setting template, decoration blacklist, or new rejection gate.
Explicit visual direction still wins, and the source-performance identity and
framing rules still apply. An established background should persist across
vocal phrases rather than reset with each line. For song performances on empty
cutouts, background inference is the normal path when the passage supports it;
background-only design must not be misclassified as forbidden performer restaging.
Unclear context calls for restraint, and meaningful photographed settings remain
protected.

Named-song planning receives the already-resolved title and artist alongside the
transcript. URL-only downloads fall back to the returned track title; an uploader
channel is never treated as the artist. Metadata is bounded, serialized, and
marked as untrusted descriptive data. Older jobs without it still plan normally.
Local fallback receives the current broker guidance, including song identity and
timing resolved after the initial worker lease, rather than stale lease guidance.

`desktop/video-lyric-context.patch` applies the same interpretation rule to the
local analyzer, screenplay planner, and semantic fidelity check using their
existing `chosen_interpretation`, `important_terms`, `visible_proof`, and
`scene_beats` fields. Apply with `git apply --check` and `git apply` in the live
generator directory. It also updates `video_recovery.py` to forward current
guidance; reload the supervised worker child while idle. The generator-only
instructions load on each new subprocess. Run `test_video_lyric_context` against
the installed desktop sources to verify current and legacy broker responses.

For a live, planning-only comparison, build first, then run
`node scripts/benchmark-video-lyric-context.mjs --source cutout.png --output results`.
Optionally supply `--job exported-job.json` containing the original `prompt`,
`lyrics`, and `plan.source_audio.duration_seconds` to include an unchanged real
request and its explicit-background control. When present, `recovery.song` supplies
the same resolved recording metadata used in production. `--cases id,id` selects a subset.
The original synthetic lyrics in `tests/fixtures/video-lyric-context.json` cover
a literal gathering, bitter celebration, metaphorical fire, pride under material
hardship, and grief in luxury. Review rubrics
are saved alongside results and are never sent to the planner. The harness checks
timing, unchanged prompts, source openings, and empty added dialogue; semantic
fit still needs inspection of the saved analysis and shot directions. It never
enqueues or renders videos. Keep before/after outputs to distinguish a general
improvement from a single favorable stochastic plan.

Validation for the initial source-identity change: all 502 Node tests passed, followed by all eight
continuity/opening tests after the final checker adjustment. A live comparison
accepted the original image and requested reanchoring for the job's drifted
boundary frame. Live GPT and production-configured Claude replans retained the
close-up without the invented body reveal or confetti; Claude used its existing
two-pass fallback after an initial duration conflict. The desktop suite retained
the same three legacy errors on both baseline and updated code. No new video was
rendered, so these checks establish planning and boundary decisions, not final
rendered fidelity.

`yarn test` covers contract preservation, timing repair, refusal handling, source identity,
matching output approval, deferred recovery, and broker/delivery regressions.
`desktop/test_video_recovery.py` uses real decodable video fixtures to exercise
original-frame reuse, continuation, the single retry limit, unavailable imagery,
recording/upload retries without rerendering, and coordinator-path preflight.

The existing desktop generator suite has three pre-existing failures referring
to removed legacy keyframe graph/cache symbols. These reproduce against the
unchanged starting generator; worker/runtime and new recovery tests pass.

## Planning duration and coverage policy

Planning preserves every requested scene and required line within the explicit
finished runtime. Normalization may shorten optional timing slack across all
scenes; it must not delete later scenes, truncate speech, or silently increase
the requested runtime. Six concise scenes can fit in 30 seconds. If the current
screenplay's timing floors cannot fit, the planner receives a duration conflict
and can replan. Exhausted drafts and an invalid fallback stop before rendering
with the specific validation or quality failure. A longer runtime requires a
new authorized request. Automatic planning retains its existing desktop cap.

Runtime directives, outline numbers, scene counts, and timestamp ranges are
instruction metadata, not numbers that must appear on screen or in speech.
Quoted numbers and actual story quantities remain binding. Runtime and coverage
are still checked by the timing validator and story review respectively.

Fallback candidates go through the same duration and quality checks as model
drafts. Planning logs never claim a candidate has rendered. Terminal errors
report the actual local screenplay attempt count and identify recovery passes
as a separate counter. Legacy quality-bypassed plans remain rejected, now with
their recorded quality diagnostics.

The desktop generator and changed regression expectations are archived in
`desktop/video-planning-policy.patch`. Install or verify the exact audited
revision with `python3 scripts/apply-video-planning-policy-desktop.py --check`
and then without `--check`. Existing unrelated desktop edits are included only
in baseline hashes and are not overwritten. The generator runs in a new child
process for each local planning request, so this generator-only update needs no
worker restart. Deploy both server branches with `scripts/deploy-bots.sh --with-broker`.

Neutral offline cases in `desktop/test_video_planning_policy.py` and
`tests/video-planning-policy.test.mjs` cover six-scene timing, retained endings,
over-budget speech, metadata versus content numbers, validated fallback success,
and diagnostic fallback failure. These tests do not establish rendered quality.
