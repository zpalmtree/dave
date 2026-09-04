# Local video generation

Dave and Slug Bot share one durable video queue. The bots talk to a loopback-only
broker on the server; the Windows desktop worker makes an outbound WSS connection
to that broker through Tailscale Serve. ComfyUI remains bound to
`127.0.0.1:8188` on the desktop and is never exposed to the tailnet or Internet.

## Discord commands

- `$ltx <prompt>` queues an automatic-length, maximum-quality LTX 2.5 video of up to two minutes.
- `$minimax <prompt>` queues an automatic-length, maximum-quality MiniMax H3 video of up to two minutes.
- `$oalgo <prompt>` (also `$minimutt`) runs the same MiniMax H3 pipeline with the built-in OALGO starting image and its character-specific dialogue guidance. `$meximutt <prompt>` uses that pipeline while requiring every spoken line to have an exaggerated cholo/ese-style Mexican-American Spanglish accent and hard-edged street cadence; generated dialogue aggressively code-switches and uses expressions such as “ese,” “güey,” “cabrón,” “pinche,” and “no mames.” If another image is attached or inherited from a reply, the bot first tries to AI-composite it with OALGO and falls back to the built-in image if composition fails.
- `$videoqueue` shows the caller's unfinished jobs, positions, progress, and ETA.
- `$videoqueue cancel <short-id>` cancels one of the caller's jobs.
- Each video job status has a ❌ reaction that its caller can click to cancel it.
- `$videogen status` is owner-only.
- `$videogen pause [duration]` pauses dispatch for six hours by default. Durations
  may be `30m`, `6h`, or `1d`, from one minute through seven days. An active job is
  interrupted, its VRAM is released, and it returns to the front of the queue. The
  desktop worker also enables GPUq Gaming Mode, preempting all managed GPU work and
  holding new managed jobs. GPUq remains paused until an explicit resume even when
  the timed video-dispatch pause expires.
- `$videogen resume` resumes dispatch and explicitly releases GPUq Gaming Mode.
- `$videogen cancel <short-id>` cancels any job as the owner.

Enabling GPUq Gaming Mode directly has the same dispatch effect as pausing video
generation: the broker stops issuing video leases, interrupts an active render
without losing its queue position, and labels queued jobs as dispatch-paused.
Directly disabling Gaming Mode clears the video pause and resumes dispatch unless
an independent deployment drain is still active.

Jobs can be submitted while the desktop is offline or generation is paused. Dave
always shows a rough ETA from model history and current bot queue depth, including
on the first acknowledgement. Plan-aware timing refines it later. Offline,
dispatch-paused, and desktop GPU-queue states are labeled with the assumption
behind the projection. The queue accepts at most three unfinished jobs per user
and twenty globally.

If Windows records an NVIDIA `nvlddmkm` recovery while a render fails, the
desktop worker treats it as a GPU-driver reset rather than an ordinary retry.
The failed attempt and GPU telemetry are retained, the job returns to the front
of the queue, and dispatch pauses for six hours so another queued render cannot
immediately reset the driver again. The owner can inspect the machine and use
`$videogen resume` sooner.

## Server configuration

The default configuration file is `~/.config/dave-video.json` and must be mode
`0600`:

```json
{
  "brokerUrl": "http://127.0.0.1:8765",
  "botToken": "random bot bearer token",
  "workerToken": "different random worker bearer token",
  "brokerHost": "127.0.0.1",
  "brokerPort": 8765,
  "brokerDb": "/home/beach/.local/state/dave-video/queue.sqlite3",
  "resultsDir": "/home/beach/.local/state/dave-video/results"
}
```

`scripts/deploy-bots.sh` builds both branches and restarts the `dave` and
`slug-bot` PM2 processes without draining or restarting `video-broker`, so bot-only
changes do not interrupt active renders. Use `scripts/deploy-bots.sh --with-broker`
for broker, protocol, database, or worker changes; that mode drains active video
work before restarting all three processes. Tailscale Serve proxies private
HTTPS/WSS traffic to the broker's loopback port.

## Desktop worker

The live desktop source is outside this repository at
`D:\AI\ComfyUI_windows_portable\video_gen` on Windows, mounted in WSL as
`/mnt/d/AI/ComfyUI_windows_portable/video_gen`. The launcher is
`D:\AI\ComfyUI_windows_portable\video_worker.cmd`. Copy
`video_worker.json.example` to `video_worker.json` inside that `video_gen`
directory, set
the tailnet-only `wss://.../v1/worker` URL and matching worker token, then run
the `video_worker.cmd` launcher above. The worker journals its active job, reconnects after network
loss, sends a heartbeat every 15 seconds, and retries transient render failures
at most twice. MiniMax H3 requires `comfy-aimdo` 0.4.14 or newer for the expanded
Windows NVML headroom that prevents WDDM system-memory fallback deadlocks. The
local startup path pins and verifies that runtime before starting ComfyUI. The
server asks `gpt-5.6-sol` at medium reasoning effort for one strict combined
prompt analysis and structured screenplay. The analysis separates dialogue,
requested visible wording, and conditional motion design. Exact on-screen text
is normalized and validated in render-facing shot directions; motion graphics,
loops, transformations, and brand films can declare one recurring visual spine,
while ordinary narrative and found-footage requests explicitly opt out. It
prepares the next queued job one position ahead while
the desktop is rendering, without reserving the GPU. The API key never leaves
the server, successful plans and generated frames are cached per job, and the desktop's local
uncensored HauhauCS Qwen 3.8 27B Q4_K_P planner is the automatic offline fallback.
It runs through llama.cpp with full GPU offload, 16K context, embedded MTP, and a
vision projector for supplied reference images, then releases its VRAM before
rendering. The worker optionally anchors the video with a
generated first frame and reports model stages and percentages when ComfyUI
exposes them.

For an eligible generated-frame job, the server reads that single-pass planner
response as a stream. Once both a `fulfill` decision and the complete frame-zero
contract have arrived, reference retrieval and the Flash Lite candidate start
while Sol finishes the remaining screenplay. The candidate is reusable only when
the final validated and geometry-reconciled keyframe object has the exact same
SHA-256 identity. A mismatch, rejected/fallback plan, source image, or shutdown
aborts and discards the speculative work. Full-plan validation and the existing
visual review gate still finish before any frame is accepted.

When a screenplay uses a hard cut or dissolve after an anchored first segment,
the broker uses that original frame as identity-only visual evidence to create a
new shot-specific frame zero. The generated frame matches the video's aspect
ratio, is reviewed for recurring-cast identity and motion-ready composition, and
the desktop renders that segment as I2V. Physically continuous `continue`
segments still inherit the preceding segment's final frame. If a derived frame
is unavailable or rejected by a provider, only that segment falls back to T2V.

The worker downloads any already-generated screenplay and frames before it asks
for a durable `gpuq` reservation. Cloud preparation therefore overlaps the
previous render and never occupies GPU queue time. If cloud planning is rejected
or unavailable, the worker reserves the GPU before starting the local Qwen
fallback. The reservation may wait behind other desktop GPU work and then owns
every local model process through rendering. Discord shows a rough historical
completion projection while the reservation is waiting. The desktop coordinator
adds the declared or historically estimated duration of each job currently ahead
and reports GPU queue position plus an admission window. Higher-priority future
submissions and unmanaged GPU pressure remain explicit sources of uncertainty.
Once admitted, the ETA anchors to actual GPU admission and becomes more precise.
The broker's plan-aware range remains a display estimate; it does not reject a
job. Immediately before rendering, the desktop recalculates GPU occupancy from
the current model, mode, quality, attention backend, and recent compatible
segment timings. If the conservative estimate plus its five-minute reserve
exceeds the 60-minute per-video budget, it drops later screenplay segments until
the longest safe prefix fits and records the truncation in the saved plan.

Planning and review failures degrade instead of terminating the video job. A
structurally valid semantic fallback renders as best effort even when its final
quality review is unavailable or rejects it, with that fact recorded in the plan
and delivery notice. If structured local planning itself cannot produce a plan,
the worker bypasses planning and renders a duration-safe literal continuation.
Explicit user cancellation, GPU or generator failures, missing or invalid output,
and delivery failures remain terminal or follow the existing bounded retry path.

The local path protects English, Spanish, and code-switched first-person
utterances as verbatim dialogue instead of misclassifying them as silent visual
briefs. It gives the screenplay model up to three feedback-driven attempts. If
the final quality gate still rejects every structurally valid candidate, the
worker compares the best model-authored near-pass with the deterministic semantic
fallback and renders the one with fewer reported fidelity issues.

## Optimization experiments

Production remains on Sol and uses the review-gated `fast-gated-v3` first-frame
path. Jobs first try Gemini Flash Lite at 1K and keep it only when the same GPT-5.6
visual gate accepts it; a rejection, generation error, or unavailable reviewer
runs the unchanged Pro 2K serial pipeline. Each job records its experiment, pipeline variant, planner
fingerprint, keyframe strategy, provider timings, queue wait, and end-to-end
latency so alternatives can be compared without mixing cohorts.

- `VIDEO_EXPERIMENT_ID` and `VIDEO_PIPELINE_VARIANT` label a cohort.
- `VIDEO_PLANNER_MODEL=gemini-3.7-flash` enables the Flash planner adapter.
- `VIDEO_PLANNER_ANALYSIS_EFFORT` and `VIDEO_PLANNER_SCREENPLAY_EFFORT` accept
  `low`, `medium`, or `high`. Single-pass planning defaults to the A/B-tested
  `low`; set both to `medium` for immediate quality rollback without a deploy.
- `VIDEO_OPENAI_SERVICE_TIER` accepts `fast` or `flex`. It is unset by default,
  which uses standard OpenAI processing; set it to `fast` only as an emergency
  latency rollback because priority processing costs more.
- `VIDEO_KEYFRAME_GEMINI_MODEL` accepts `gemini-3-pro-image`,
  `gemini-3.1-flash-image`, or `gemini-3.1-flash-lite-image`.
- `VIDEO_KEYFRAME_IMAGE_SIZE` accepts `1K` or `2K`; Flash Lite is always 1K.
- `VIDEO_KEYFRAME_STRATEGY` accepts `serial-v1`, `conditional-v2`, or
  `fast-gated-v3`. Without an override, the review-gated fast strategy is used.
- `VIDEO_PREPLAN_QUEUED=0` disables one-job-ahead preparation for rollback.
- `VIDEO_PROMPT_CACHE_24H=1` opts into 24-hour OpenAI prompt-cache retention;
  stable cache routing is used without extended retention by default.
- `VIDEO_H3_AUTO_LOOP_TRIM=0` disables the desktop worker's conservative natural
  cyclic trim for explicit, short, single-segment base-H3 I2V loop requests.
- `VIDEO_H3_DIALOGUE_LEAD_IN_SECONDS` controls H3's clean closed-mouth pre-roll
  before dialogue. It defaults to `0.35`; set it to `0` for rollback or A/B tests.
- `VIDEO_H3_DIALOGUE_OPENING_GUARD=0` disables the matching output-side audio
  guard. By default, planned-dialogue H3 segments mute only the first `0.35`
  seconds and apply a 50 ms fade-in while copying the encoded video stream
  unchanged. Non-dialogue H3 clips and all other models bypass the guard.

Explicit short H3 loops use output-side `natural-cyclic-trim-v1` only when a
decoded-frame scan finds a materially better natural boundary. The gate searches
small head/tail windows, preserves at least 95% of frames, requires the selected
opening to remain visually equivalent, verifies the gain again after delivery
encoding, and otherwise returns the original render unchanged. It is disabled for
speech requests and any screenplay containing dialogue because the corresponding
audio trim could cut a phoneme. It never inserts a crossfade or synthetic frame.
This avoids the quality and 2x latency regressions observed with native last-frame
conditioning and a two-pass endpoint workaround.

Run `yarn benchmark:video-planners --limit=2` for a short, render-free comparison.
It runs Sol and two Gemini Flash reasoning variants concurrently per prompt, then
uses a blinded Sol quality judge to score fidelity, creative development,
specificity, continuity, visible-text fidelity, transition logic, and
audio/dialogue. Reports and only the fast plans that
clear the teacher gate are written under `artifacts/video-planner-benchmarks/`.
Pass a prior report with `--examples=/path/to/report.json` to feed up to three
teacher-approved Sol plans to the Flash candidates. Pass it with
`--baseline=/path/to/report.json` to reuse matching successful Sol outputs,
instead of regenerating the slow baseline. Same-prompt teacher examples are
automatically excluded. `--candidates=id,id` narrows a run and
`--concurrency=2` bounds prompt-level parallelism. `--prompts=/path/to/prompts.json`
loads a JSON array for a focused regression cohort. Use `--full` only after the
quick candidate set is satisfactory.

Run `yarn benchmark:video-keyframes --plans=/path/to/planner-report.json` for a
blinded comparison of Gemini Pro 2K, Flash 2K, and Flash Lite 1K on the exact
same approved plans. Images and a scored report are saved below
`artifacts/video-keyframe-benchmarks/`. A failed judge run can be continued with
`--resume=/path/to/run-directory`; completed images are content-stable inputs
and are not regenerated. Use `--no-judge` only to export/cache plan and image
artifacts. Reports include aggregate latency, acceptance, failure, and win counts.

Run `yarn benchmark:video-keyframe-reviewers
--report=/path/to/keyframe-report.json --candidates=sol-low,gemini-flash-low
--stop-on-false-accept` to screen faster visual gates against saved, strongly
judged images without generating new images or videos. A candidate must have
zero false accepts before a larger repeatability run; false rejects and latency
are reported separately. OpenAI candidates use the same priority tier as the
production critical path.

Run `yarn benchmark:video-renders --spec=/path/to/render-comparison.json` after a
small controlled set of expensive renders completes. It transcribes each output,
measures source-to-first, first-to-last, and source-to-last similarity plus obvious
freeze/black intervals, extracts the first frame, final frame, and a 16-frame
timeline, and asks the strong judge twice with reversed candidate order. Set
`"loop_expected": true` in the spec to make exact endpoint restoration, continuous
motion into the endpoint, and identity-safe frame-zero reset part of the blinded
gate.
The report promotes nothing unless one candidate receives a majority of acceptable
votes; missing literal dialogue or another hard requirement therefore blocks an
otherwise attractive speed result.

Discord delivery copies are compressed below 49.5 MiB. Server copies expire after
24 hours; complete desktop generation directories expire after seven days.

## First-frame continuity

Adaptive first frames are planned with a motion contract shared by the image and
video prompts: subject orientation, gaze, travel vector, camera relationship, and
the exact first-second action. The opening video shot must continue those values
without a turnaround, reversal, gaze snap, camera-axis crossing, teleport, or
unexplained reframe. This is what keeps, for example, a rear chase-view kart
pointed down-track when animation begins.
