# Video queue progress

Recovery renders each approved scene with a separate generator invocation. The
generator's segment index and runtime estimate describe that invocation, not the
whole job. The broker uses the approved plan and saved recovery checkpoints to
map those samples to the current scene and the full scene count.

Overall progress weights each scene by its generated duration with an allowance
for per-clip setup and decoding. Accepted scenes retain their completed work;
new scenes and render retries reset only the current scene's sample. Heartbeats
carrying the previous scene's percentage are ignored until the next generator
announces its segment. Assembly reserves the last 2%, uploading reports 99%, and
only completion reports 100%.

Scene runtime estimates are scaled to the complete plan before calculating the
job finish time and the projected start/finish times of waiting jobs. Measured
whole-job progress still refines that estimate. These remain rough predictions,
especially when scene duration, GPU admission, or render speed changes.

Queue command replies are snapshots, with a timestamp and refresh instruction.
ETAs show estimated time remaining at the check, rather than a Discord countdown
that ages into an apparent overdue deadline. The individual job's status post
continues to refresh normally.

The broker also normalizes progress from older connected desktop workers and
existing database rows, including the erroneous 98% / segment 1/1 state. This
change needs no desktop worker restart or database schema migration. Deploy both
branches with `scripts/deploy-bots.sh --with-broker`; the deployment preserves the
active render and reconciles its worker lease.

`tests/video-progress.test.mjs` covers six-scene progress, unequal durations,
scene and retry boundaries, stale heartbeats, delivery reserve, persisted broker
restart, per-scene estimate scaling, and the waiting job's projection.
