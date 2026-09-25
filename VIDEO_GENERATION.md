# Local video generation

Dave and Slug Bot share one durable video queue. The bots talk to a loopback-only
broker on the server; the Windows desktop worker makes an outbound WSS connection
to that broker through Tailscale Serve. ComfyUI remains bound to
`127.0.0.1:8188` on the desktop and is never exposed to the tailnet or Internet.

## Discord commands

- `$minimax <prompt>` queues an automatic-length, maximum-quality MiniMax H3 video of up to two minutes.
- `$minimax` and `$oalgo` also accept an attached or replied-to song for original-audio lip-sync. Attach one MP3, WAV, FLAC, OGG/Opus, M4A or AAC file (4–120 seconds, up to 25 MiB), optionally with an image. The song determines the duration and remains the soundtrack. See [original-song lip-sync](docs/video-source-audio.md).
- A video clip attached to the command, or to the message it replies to, supplies a frame as the starting image. The broker probes the clip with ffmpeg over HTTPS range requests and stores the middle frame as PNG. If that frame is nearly black, it tries the 25% and then the 75% points. ffmpeg may only read HTTPS and plain video containers, so an uploaded playlist cannot make the broker fetch other URLs. If ffmpeg is missing or fails, the broker falls back to Discord's media-proxy first frame. The planner is told the image came from a clip. An attached image takes precedence over a clip, and the command message's own attachment takes precedence over the replied message's.
- `$qwenimage <prompt>` makes or edits an image with the desktop's Qwen Image 2.1 (official int8 weights), and `$qwenedit <prompt>` edits or combines up to three attached or replied-to images with Qwen-Image-Edit-2511. `$qwenimage` also accepts up to three images: it keeps their subjects and follows edit instructions, and its output takes the first image's shape. `$qwenedit` runs the official template's full 40-step, CFG 4 mode by default (about 90 seconds once loaded), which follows unusual edits much better; `--fast` selects the 4-step Lightning LoRA (about 10 seconds). Both take an optional leading `--aspect 16:9` (1:1, 2:3, 3:2, 3:4, 4:3, 9:16, 16:9, 21:9) for text-only images and `$qwenedit`; otherwise text-only images are square and edits follow the first image's shape. Text from a replied-to message is prepended to the prompt, as with `$grokimage`. The prompt reaches the model unmodified. Image jobs share the desktop worker with video: they lease ahead of queued videos but wait for a render already in progress, each takes its own `gpuq` admission on the `video-h3` profile, and a job interrupted by a disconnect or failure is retried once. Each user may have three unfinished images. The finished PNG is posted as a reply to the command. The broker leases image jobs only to a worker that advertises `image_models` in its hello, so it is safe to deploy the broker before the worker. Qwen Image 2.1 edits need ComfyUI v0.37.1 or newer; the hand-ported support on v0.33.1 copied the reference instead of editing it.
- `$oalgo <prompt>` (also `$minimutt` and `$meximutt`) runs the MiniMax H3 pipeline with the built-in OALGO portrait and character dialogue guidance. With an attached or replied-to image, it first combines OALGO with that scene. Sunburst is the default image provider; use `$oalgo --image-provider grok <prompt>` to explicitly select Grok Imagine, or `--image-provider sunburst` to name the default. The option must precede the prompt and requires an attachment or reply image; it selects only the image-compositing provider, not the video renderer. Every candidate is reviewed against both originals for likeness, retained subjects/props, and coherent composition. A rejected candidate gets one corrective edit using both originals plus that candidate. The shared composition deadline is nine minutes. Moderation refusals, failed reviews, and unavailable review reject the submission without queuing a video. Provider selection never automatically retries a refused request with another provider.

The September 19 paired ten-scene comparison produced 10/10 automated passes for Sunburst (nine initially, one after repair) and 7/10 for Grok (six initially, one after repair). Grok had two composition rejections and one moderation refusal; the user gave blanket approval of the displayed images, without individual saved ratings. Grok's median submission time was 32.2 seconds; Sunburst's median generation-plus-review work was 57.2 seconds, reconstructed after a benchmark-only PNG decoder error. This small diagnostic cohort contained no Sunburst failures for Grok to rescue. It does not demonstrate a fix for the reported failures. The production reviewer was kept unchanged. Grok charges, including billed moderation refusals, are recorded from the provider's reported USD ticks; absent cost data remains explicitly unpriced in the usage ledger.

A subsequent exact-input replay of the original rejected fantasy-card request (`ee600fec`) reproduced the review failure: both Sunburst and Grok generated two images, and both ended with `identity_review`. Sunburst's repair duplicated OALGO; Grok's repair was rejected for altered likeness and foreground soldiers. The user subsequently approved that exact Grok repair, confirming a false rejection against the user's quality standard. Grok produced a usable composition but did not get it through the current gate. No user ratings are inferred for the other replay candidates. The two original moderation refusals were recovered for diagnosis but not replayed; any moderation advantage remains unmeasured.

To investigate a failed composition, separate provider refusal, transport failure, reviewer outage, and completed review rejection. The broker removes source-composition directories on failure and creates a video job only after composition succeeds, so a missing job row does not establish that the original input is irretrievable. Bot command logs can identify the channel, timestamp, and arguments; read-only retrieval of the original Discord command and its reply can recover the attachment and resolved prompt. Match timestamps, check edit timestamps, preserve hashes, and compare providers using those exact inputs with the same review gate and repair limit. Save every candidate and its review, including rejected images, before drawing conclusions about generation success or reviewer tolerance.

- A video command sent as a reply inherits the replied message's image, and its text becomes the prompt, or context for any text typed after the command, which takes priority. When the replied message was itself a reply, up to three earlier messages in that chain go to the planners as background guidance only, so their wording, quotes and numbers are never treated as literal requirements.
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
and twenty globally. The configured god user bypasses the per-user limit; the
global cap still applies.

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
server asks `gpt-6-sol` at low reasoning effort for one strict combined
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
the desktop renders that segment as I2V. Image generation and review share the
requested canvas aspect ratio: a wide shot requires a pulled-back
camera and visible surroundings even in a portrait video. Recurring identity
instructions preserve the reference haircut's height and silhouette as well as
facial anatomy; visible reference evidence overrides conflicting screenplay
identity descriptions in both generation and review. If the baseline Gemini
candidates fail review and the final GPT
Image candidate also fails without preserving identity, it gets one regeneration
using the reviewer's corrections and another review before the configured fallback
is used. Physically continuous `continue`
segments still inherit the preceding segment's final frame. If a derived frame
is unavailable, rejected by a provider, or cannot be tied to the worker's
screenplay, that segment uses the original identity anchor when available and
otherwise falls back to T2V. Missing screenplay confirmation is not treated as
evidence that the screenplay changed. Mismatched derived frames are never used,
but their failure does not abort the remaining video. Deferred-frame fallbacks
are recorded in the render manifests and disclosed in the Discord delivery notice.

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

A completed single-pass frontier response that requests local routing is not
discarded automatically. Its screenplay is retained only when the ordinary
analysis, dialogue, duration, continuity, and keyframe validators all accept it;
otherwise the request still follows the local fallback path. Actual provider
refusals contain no salvageable screenplay and always route locally.

The local path protects English, Spanish, and code-switched first-person
utterances as verbatim dialogue instead of misclassifying them as silent visual
briefs. It gives the screenplay model up to three feedback-driven attempts. If
the final quality gate still rejects every structurally valid candidate, the
worker compares the best model-authored near-pass with the deterministic semantic
fallback and renders the one with fewer reported fidelity issues.

When a user-supplied image accompanies a policy-routed request, the local
analyzer, planner, and quality gate all treat the pictured subject as the
protagonist. A requested look, persona, or archetype restyles that same person
through a visible in-shot change that starts from the immutable source frame,
instead of recasting a different subject that the frame-zero rule can never
show. The gate accepts the restyle once the pictured subject visibly acquires it
with the same face.

## Optimization experiments

Production planning uses Claude Opus 5.5 with the tuned prompt and hybrid
single-pass strategy. Invalid hybrid plans retry through the two-pass Opus path.
Provider refusals, API failures, and missing usage records do not start a second
planning route.
The review-gated `fast-gated-v3` first-frame path still tries Gemini Flash Lite
at 1K and keeps it only when the GPT-6 Sol visual gate accepts it; a rejection,
generation error, or unavailable reviewer runs the unchanged Pro 2K serial
pipeline. Each job records its experiment, pipeline variant, planner fingerprint,
keyframe strategy, provider timings, queue wait, and end-to-end latency so
alternatives can be compared without mixing cohorts. Set
`VIDEO_PLANNER_MODEL=gpt-6-sol` to return the production broker to Sol's
single-pass/low-effort planner.

### Opus 5.5 historical video experiment

`scripts/benchmark-video-opus.mjs` runs a paired minimax/oalgo comparison from
an ignored `artifacts/video-opus-ab/historical-cases.json` file. Each case names
the original delivered job ID, command, prompt, and optional source image.
The three arms are a pinned GPT-5.6 Sol control, Opus 5.5 with the existing
instructions, and Opus 5.5 with a concise provider-specific instruction
preface. Opus uses two planning passes because its structured-output grammar
cannot compile the combined single-pass schema. The experiment keeps the same
source image, renderer, quality setting, and seed across arms. Set
`experiment_duration_seconds` per case to compare videos at a common finished
length; the historical prompt itself is preserved.

After `yarn build`, run `node scripts/benchmark-video-opus.mjs --phase=plan`
and `node scripts/benchmark-video-opus.mjs --phase=render --dry-run` before
`node scripts/benchmark-video-opus.mjs --phase=render`. The render phase uses
GPUq admission and resumes completed videos. `--phase=report` writes a blinded
review packet and a separate answer key in the run directory. Planner usage,
latency, and generated videos are kept in ignored artifacts. A later six-prompt
direct MiniMax review preferred tuned Opus over GPT-6 Sol on five prompts;
the hybrid Opus route won four of six clips against two-pass Opus, including
one job where hybrid planning fell back to two-pass.

- `VIDEO_EXPERIMENT_ID` and `VIDEO_PIPELINE_VARIANT` label a cohort.
- `VIDEO_PLANNER_MODEL` overrides the Opus production default. Use
  `gpt-6-sol` for the Sol baseline or `gemini-3.8-flash` for the Flash adapter.
- `VIDEO_PLANNER_STRATEGY` accepts `hybrid-single-pass`, `two-pass`, or
  `single-pass`. By default Opus uses hybrid with two-pass fallback and Sol uses
  single-pass. Hybrid requires an Anthropic model; plain single-pass on Opus
  resolves to two-pass.
- `VIDEO_PLANNER_ANALYSIS_EFFORT` and `VIDEO_PLANNER_SCREENPLAY_EFFORT` accept
  `low`, `medium`, or `high`. Opus defaults to medium and Sol single-pass to low.
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
