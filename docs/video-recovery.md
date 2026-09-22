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
desktop composes the opening with local Qwen Image 2.1, which receives the
source references when the contract uses them. Provider outages still wait and
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
use the previous accepted clip's final frame. New shots get their own opening
composition, without inheriting a frame-zero crop restriction. Generated openings
still pass through the image generator's own identity and composition repair.

No model reviews the rendered scenes. Model review rejected usable videos over
minor issues and added Sol, Gemini, or local Qwen calls to every scene, so it
was removed on 2026-09-21. A scene is accepted once its render produces a
decodable clip. The worker still records each scene's file hash with the broker
(the `review` call, which now makes no model request), so final approval can
require the exact rendered scenes. The worker permits two image attempts per
recovery pass. A render that produces no valid output is retried once with the
requested renderer: two render attempts total per scene, across reconnects and
recovery passes. The worker persists this count and stops before reserving more
GPU work once it is exhausted.

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
three archived patches it still needs; the installer applies those in order
and verifies the result. The third patch removes the worker's scene-review
sampling and local review mode. Reload
the supervised worker child while idle so it advertises version 3, then deploy
the broker. A broker running version 3 leases nothing to a version 2 worker,
so update the worker first to avoid a stalled queue.

## Verification

`yarn test` covers contract preservation, timing repair, refusal handling, source identity,
matching output approval, deferred recovery, and broker/delivery regressions.
`desktop/test_video_recovery.py` uses real decodable video fixtures to exercise
original-frame reuse, continuation, the single retry limit, unavailable imagery,
recording/upload retries without rerendering, and coordinator-path preflight.

The existing desktop generator suite has three pre-existing failures referring
to removed legacy keyframe graph/cache symbols. These reproduce against the
unchanged starting generator; worker/runtime and new recovery tests pass.
