# Local video generation

Dave and Slug Bot share one durable video queue. The bots talk to a loopback-only
broker on the server; the Windows desktop worker makes an outbound WSS connection
to that broker through Tailscale Serve. ComfyUI remains bound to
`127.0.0.1:8188` on the desktop and is never exposed to the tailnet or Internet.

## Discord commands

- `$ltx <prompt>` queues an automatic-length, maximum-quality LTX 2.5 video.
- `$minimax <prompt>` queues an automatic-length, maximum-quality MiniMax H3 video.
- `$videoqueue` shows the caller's unfinished jobs, positions, progress, and ETA.
- `$videoqueue cancel <short-id>` cancels one of the caller's jobs.
- `$videogen status` is owner-only.
- `$videogen pause [duration]` pauses dispatch for six hours by default. Durations
  may be `30m`, `6h`, or `1d`, from one minute through seven days. An active job is
  interrupted, its VRAM is released, and it returns to the front of the queue.
- `$videogen resume` resumes dispatch.
- `$videogen cancel <short-id>` cancels any job as the owner.

Jobs can be submitted while the desktop is offline or generation is paused. In
those states Dave deliberately omits ETA. The queue accepts at most three
unfinished jobs per user and twenty globally.

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
structured screenplay only after the job reaches the desktop. The API key never
leaves the server, successful plans are cached per job, and the local Qwen planner
is the automatic offline fallback. The worker optionally anchors the video with a
generated first frame and reports model stages and percentages when ComfyUI
exposes them.

Discord delivery copies are compressed below 9.5 MiB. Server copies expire after
24 hours; complete desktop generation directories expire after seven days.

## First-frame continuity

Adaptive first frames are planned with a motion contract shared by the image and
video prompts: subject orientation, gaze, travel vector, camera relationship, and
the exact first-second action. The opening video shot must continue those values
without a turnaround, reversal, gaze snap, camera-axis crossing, teleport, or
unexplained reframe. This is what keeps, for example, a rear chase-view kart
pointed down-track when animation begins.
