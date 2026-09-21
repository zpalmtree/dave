# Video recovery

The broker's production configuration enables recovery protocol version 1. It
leases new work only to a worker advertising that version. Existing active
leases can finish normally during a broker restart.

An independently approved screenplay is the content contract for the job.
Planning can repair timing and split dialogue at clause boundaries, but cannot
remove required speech or weaken a rejected content decision. A policy refusal
first produces a permitted adaptation with an audience-facing notice; that
adaptation must independently pass planning before any images or video render.
Source images that cannot safely be retained are excluded from subsequent calls.

Each scene gets an opening image and a review against the original references
and approved scene. The worker permits two image attempts and two video attempts,
using the previous review's feedback. Video review samples five points in time,
checks story/identity/action, and compares an audio transcription with the
approved speech. Decoding failures also consume a render attempt. Minor visual
differences and intentionally still scenes do not fail review.

If rendering or imagery remains unusable, the worker assembles an animated
storyboard on the CPU. Captions carry **both action and dialogue**. It uses
approved scene images or separate reference panels where available. If those
cannot pass review, explicitly labeled typographic story cards convey the
approved scene without pretending that an unrelated portrait depicts it.
The delivery notice identifies the storyboard format. All storyboard pages
undergo review too; unsafe or unreadable content is never marked successful.

The broker persists the approved contract, checksummed scene reviews, worker
checkpoints, and final approval. The worker persists accepted artifacts and
pending review locally. Review/upload interruptions reuse rendered media;
unfinished interrupted renders may resume as a new attempt. Temporary service
failures return the same job to the queue with 30-second to 15-minute backoff,
preserving its checkpoint and releasing the worker. They do not send a terminal
error to Discord. A service outage can therefore delay completion; this is not
a guarantee of immediate delivery during an outage.

Completion requires approval for every scene and the exact uploaded file hash.
Generated clips are normalized before concatenation and the final MP4 is fully
decoded before upload. Discord delivery records the posted message ID before
editing the progress message, so a cosmetic edit failure cannot trigger a render.

## Desktop installation and Qwen

Run `python3 scripts/apply-video-recovery-desktop.py --check`, then run it without
`--check` to install on the recorded desktop baseline. The archive includes only
the recovery hooks plus the new helper modules. Reload the supervised worker
child while idle, preserving its supervisor and any active GPU work. Deploy both
bot branches with `scripts/deploy-bots.sh --with-broker`.

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

`yarn test` covers contract preservation, timing repair, policy adaptation,
matching output approval, deferred recovery, and broker/delivery regressions.
`desktop/test_video_recovery.py` exercises real FFmpeg storyboard output,
unavailable imagery, two failed renders, corrupt video, review outages, upload
retry without rerendering, and coordinator-path preflight.

The existing desktop generator suite has three pre-existing failures referring
to removed legacy keyframe graph/cache symbols. These reproduce against the
unchanged starting generator; worker/runtime and new recovery tests pass.
