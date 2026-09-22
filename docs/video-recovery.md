# Video recovery

The broker's production configuration enables recovery protocol version 2. It
leases new work only to a worker advertising that version or newer. Existing active
leases can finish normally during a broker restart.

An independently approved screenplay is the content contract for the job.
Planning can repair timing and split dialogue at clause boundaries, but cannot
remove required speech or weaken a rejected content decision. A policy refusal
stops the job with the provider's diagnostic. Recovery does not rewrite the
request, substitute another story, or discard its source images. Technical
planning failures retry the same original brief once within the job budget.
Saved plans that silently rewrote the request are rejected on resume.
For oalgo, the original Meximutt reference is mandatory. If it is missing or
excluded, the job stops before rendering. For portrait-only oalgo requests,
the original portrait is also the required opening frame; a generated
replacement keyframe is rejected. Identity reviews must receive the original
reference.

Each scene gets a reviewed opening image. When the approved plan calls for the
original portrait at frame zero, the worker uses that image directly. Continuing
scenes use the previous accepted clip's final frame. New shots get their own
opening composition, without inheriting a frame-zero crop restriction.

The worker permits two image attempts per recovery pass. Each scene gets one
video attempt and one targeted retry with the requested renderer: two render
attempts total per scene, across reconnects and recovery passes.
The worker persists this count and stops before reserving more GPU work once
it is exhausted. Video review samples five points in time, checks story/identity/action,
and compares an audio transcription with the approved speech. It judges the
user's requested story; incidental planner-invented props, camera choices, and
blocking are flexible. Speech receives sufficient time within each shot.
Speech review judges meaning: small paraphrases, extra words, filler, and brief
creative flourishes are allowed when the intended message and key points remain.
Silence, missing essential points, contradictions, or material changes to names
and facts still fail. Exact wording is required only when the user explicitly
requests it; quoted dialogue and planner verbatim flags alone do not require it.
Word similarity is a review hint, not an automatic rejection. Comparisons accept
Spanish vowel accents (á, é, í, ó, ú, ü), while preserving distinct letters such as
ñ. Authored dialogue text remains unchanged. Previously rejected video artifacts
are reviewed again under the current rules when resubmitted; accepted artifacts
remain reusable.

Only actual generated video can pass final approval. Storyboards, slideshows,
and caption cards are never substitutes for requested action. Exhausted render
attempts stop the job, retaining accepted scenes and actionable review feedback.
Exhausted jobs stop with a diagnostic
failure instead of retrying forever; a placeholder is never delivered.

The broker persists the approved contract, checksummed scene reviews, worker
checkpoints, and final approval. The worker persists accepted artifacts and
pending review locally. Review/upload interruptions reuse rendered media;
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
Recovery never sends a policy-rejected request to a less restricted local model.

## Verification

`yarn test` covers contract preservation, timing repair, refusal handling, source identity,
matching output approval, deferred recovery, and broker/delivery regressions.
`desktop/test_video_recovery.py` uses real decodable video fixtures to exercise
original-frame reuse, continuation, the single retry limit, unavailable imagery,
review/upload retries without rerendering, and coordinator-path preflight.

The existing desktop generator suite has three pre-existing failures referring
to removed legacy keyframe graph/cache symbols. These reproduce against the
unchanged starting generator; worker/runtime and new recovery tests pass.
