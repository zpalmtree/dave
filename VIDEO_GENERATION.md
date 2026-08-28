# Local video generation

Dave and Slug Bot share one durable video queue. The bots talk to a loopback-only
broker on the server; the Windows desktop worker makes an outbound WSS connection
to that broker through Tailscale Serve. ComfyUI remains bound to
`127.0.0.1:8188` on the desktop and is never exposed to the tailnet or Internet.

## Discord commands

- `$ltx <prompt>` queues an automatic-length, maximum-quality LTX 2.5 video of up to two minutes.
- `$minimax <prompt>` queues an automatic-length, maximum-quality MiniMax H3 video of up to two minutes.
- `$videoqueue` shows the caller's unfinished jobs, positions, progress, and ETA.
- `$videoqueue cancel <short-id>` cancels one of the caller's jobs.
- `$videogen status` is owner-only.
- `$videogen pause [duration]` pauses dispatch for six hours by default. Durations
  may be `30m`, `6h`, or `1d`, from one minute through seven days. An active job is
  interrupted, its VRAM is released, and it returns to the front of the queue.
- `$videogen resume` resumes dispatch.
- `$videogen cancel <short-id>` cancels any job as the owner.

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

`scripts/deploy-bots.sh` builds both branches and starts or restarts the
`video-broker`, `dave`, and `slug-bot` PM2 processes. Tailscale Serve proxies
private HTTPS/WSS traffic to the broker's loopback port.

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
server asks `gpt-5.6-sol` at high reasoning effort for a strict
structured screenplay. It prepares the next queued job one position ahead while
the desktop is rendering, without reserving the GPU. The API key never leaves
the server, successful plans and generated frames are cached per job, and the desktop's local
uncensored HauhauCS Qwen 3.8 27B Q4_K_P planner is the automatic offline fallback.
It runs through llama.cpp with full GPU offload, 16K context, embedded MTP, and a
vision projector for supplied reference images, then releases its VRAM before
rendering. The worker optionally anchors the video with a
generated first frame and reports model stages and percentages when ComfyUI
exposes them.

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

## Optimization experiments

Production remains on Sol, Gemini 3 Pro Image at 2K, and the established serial
visual review path outside the configured canary channels. Canary jobs first try
Gemini Flash Lite at 1K and keep it only when the same GPT-5.6 visual gate accepts
it; a rejection, generation error, or unavailable reviewer runs the unchanged Pro
2K serial pipeline. Each job records its experiment, pipeline variant, planner
fingerprint, keyframe strategy, provider timings, queue wait, and end-to-end
latency so alternatives can be compared without mixing cohorts.

- `VIDEO_EXPERIMENT_ID` and `VIDEO_PIPELINE_VARIANT` label a cohort.
- `VIDEO_PLANNER_MODEL=gemini-3.7-flash` enables the Flash planner adapter.
- `VIDEO_PLANNER_ANALYSIS_EFFORT` and `VIDEO_PLANNER_SCREENPLAY_EFFORT` accept
  `low`, `medium`, or `high`.
- `VIDEO_KEYFRAME_GEMINI_MODEL` accepts `gemini-3-pro-image`,
  `gemini-3.1-flash-image`, or `gemini-3.1-flash-lite-image`.
- `VIDEO_KEYFRAME_IMAGE_SIZE` accepts `1K` or `2K`; Flash Lite is always 1K.
- `VIDEO_KEYFRAME_STRATEGY` accepts `serial-v1`, `conditional-v2`, or
  `fast-gated-v3`. Without an override, configured canary channels use the fast
  gate and other channels use `serial-v1`.
- `VIDEO_PREPLAN_QUEUED=0` disables one-job-ahead preparation for rollback.
- `VIDEO_PROMPT_CACHE_24H=1` opts into 24-hour OpenAI prompt-cache retention;
  stable cache routing is used without extended retention by default.

Run `yarn benchmark:video-planners --limit=2` for a short, render-free comparison.
It runs Sol and two Gemini Flash reasoning variants concurrently per prompt, then
uses a blinded Sol quality judge to score fidelity, creative development,
specificity, continuity, and audio/dialogue. Reports and only the fast plans that
clear the teacher gate are written under `artifacts/video-planner-benchmarks/`.
Pass a prior report with `--examples=/path/to/report.json` to feed up to three
teacher-approved Sol plans to the Flash candidates. Pass it with
`--baseline=/path/to/report.json` to reuse matching successful Sol outputs,
instead of regenerating the slow baseline. Same-prompt teacher examples are
automatically excluded. `--candidates=id,id` narrows a run and
`--concurrency=2` bounds prompt-level parallelism. Use `--full` only after the
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
measures frame-zero similarity and obvious freeze/black intervals, extracts a
16-frame timeline, and asks the strong judge twice with reversed candidate order.
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
