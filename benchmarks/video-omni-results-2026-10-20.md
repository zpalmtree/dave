# FastH3 Omni: RTX 5090 evaluation, October 20, 2026

This is the archived **480p pilot**, below production resolution. Use the later
[production-resolution TaoMate/Omni A/B](video-omni-production-results-2026-10-20.md)
for the relevant speed comparison. The ratios below do not establish a
production speedup over main H3 or TaoMate.

Keep main H3 and `$fast`/TaoMate as the production defaults. The experimental
Omni renderer works and is substantially quicker than main H3 on this corpus,
but it does not establish real-time generation, fast-path superiority or
main-path quality parity. Exact-dialogue failures block promotion.

## Experiment

Three cases, two seeds each, three renderers: 18 completed clips on one RTX
5090 (32 GB). Each clip contains 124 frames at 24 fps (5.167 seconds), stereo
32 kHz audio, and either an 832×480 landscape or 480×704 portrait canvas.
All three renderers share prompt text, reference-image bytes, seed and canvas.
Main and TaoMate use the production first-frame compiler; Omni uses native
image-reference conditioning. These are complete renderer comparisons, not a
checkpoint-only ablation. This is a small 480p corpus, not a 768p benchmark.

The final run used the same isolated ComfyUI process for all renderers, in the
order Omni, main, TaoMate, after the model download finished. Model/cache state
for the first sample of each case is uncontrolled. The second seed follows
immediately under the same case/model; prompt conditioning can be cached but
fresh sampling is required and verified. These are individual observations,
not confidence intervals or production latency estimates.

Timing starts at prompt submission and ends when the completed MP4 is retrieved.
It includes model loading/offloading, conditioning, sampling, decoding and
encoding. It excludes checkpoint download/hash verification, backend startup,
queuing, planning, keyframe generation and Discord delivery.

## Timing

Consecutive fresh-seed render times, in seconds:

| Case | Main H3 | `$fast` TaoMate | Omni |
| --- | ---: | ---: | ---: |
| Coffee dialogue, 832×480 | 42.314 | 8.922 | 15.935 |
| Oalgo dialogue, 480×704 | 35.707 | 8.088 | 14.124 |
| Marble motion, 832×480 | 42.347 | 10.160 | 16.990 |
| Median of these three observations | 42.314 | 8.922 | 15.935 |

The ratio of medians is 2.66× in Omni's favor versus main, but Omni takes 1.79×
as long as TaoMate. Omni's consecutive renders take 2.73–3.29 seconds per second
of generated video. Even excluding startup and downstream delivery, this path
is not real-time on this machine. Omni's first samples per case took
24.086, 18.398 and 20.967 seconds, respectively.

The machine-readable [measurements](video-omni-results-2026-10-20.json) retain
all 18 timings, first/consecutive cache labels, observed sampling steps, stage
timings, media validation, input/compiler hashes and runtime provenance.

## Quality

All 18 outputs passed decoded frame count, resolution, frame rate and stereo
audio checks. Main, TaoMate and Omni performed 20, 3 and 8 fresh sampling steps,
respectively.

| Renderer | Exact-dialogue passes | Extra-speech failures |
| --- | ---: | ---: |
| Main H3 | 4/4 | 0/4 |
| `$fast` TaoMate | 4/4 | 0/4 |
| Omni | 2/4 | 2/4 |

Dialogue checks use one `gpt-transcribe` observation per clip and the existing
strict phrase contract, which rejects additional speech. Both Omni coffee
clips passed. Both Omni Oalgo clips contained the requested sentence, but ASR
reported added prefixes: “There is Stridict.” and “Band,” respectively.
These are ASR findings, not a listening-based certification of the exact
extra words. Transcription alone does not establish lip-sync or audio quality.

Contact-sheet inspection found recognizable reference identities and coherent
portrait composition in the Omni samples. In the second Omni marble sample,
more than the requested three marbles accumulate in the bowl. Sparse frame
inspection cannot establish physically correct motion or precise lip-sync.

A single blinded model review of each case's second seed, using reference
images, sampled video frames and ASR, preferred Omni on coffee dialogue and
TaoMate on Oalgo. It rejected all three marble outputs for duplication/count
errors. This is exploratory evidence, not a human preference study; the marble
problem is not unique to Omni. Review judgments and model identity are archived
in the measurement JSON. A second transcription of Omni's second Oalgo sample
again reported the added “Band” prefix.

## Implementation and reproducibility

The pinned model is
[`FastVideo/FastH3-OmniRef-NVFP4-QAD-Comfy`](https://huggingface.co/FastVideo/FastH3-OmniRef-NVFP4-QAD-Comfy),
revision `36dbf15cd11113471114b1040c4f38646c031549`. The SHA256-verified 13.77 GB
checkpoint uses the official eight-step Euler/simple reference workflow,
video/audio shifts 12/3 and VSA at 10% retention. It is the native ComfyUI NVFP4
export, not the specialized FastVideo inference runtime. Export metadata says
inference parity with FastVideo has not been validated, and sparse tile sizes
differ. This local result does not confirm or refute every vendor hardware and
runtime configuration advertised as real-time.

Installed ComfyUI initially misread the model's 32 prediction heads as extra
latent channels and failed before sampling. The experiment includes a small,
hash-guarded compatibility patch based on the release's bundled source. It was
applied only to an isolated ComfyUI copy. CPU checks verify actual checkpoint
channel detection and preserve plain-head output behavior. The embedded Python
launcher explicitly selects the isolated import path; otherwise its `._pth`
file silently selects production ComfyUI. Server ownership, occupied-port
refusal and cleanup on benchmark failure are tested.

Ten focused renderer/harness/isolation tests passed on Linux and embedded
Windows Python, and two additional ComfyUI checkpoint/PDD semantic tests passed
on CPU. The 18-render GPUq job succeeded, its owned server exited, and port 8197
was verified closed. Production ComfyUI source hashes still match their
pre-experiment values.

See [setup and usage](../docs/video-fasth3-omni.md),
[the corpus](video-omni-corpus.json), and the measurement JSON. The local evidence
directory is
`D:/AI/ComfyUI_windows_portable/video_gen/experiments/fasth3_omni_20261020/isolated-results`.
Each `<case>-<seed>-<renderer>` has an MP4, request signature, submitted prompt
ID, graph and result record. Earlier production-runtime pilots and failed
compatibility attempts are retained separately and excluded from this report.

## Promotion decision

- Keep `$fast` on TaoMate; Omni has not demonstrated a speed or dialogue win.
- Keep main on H3; Omni is promising for optional native reference generation,
  but exact dialogue and motion need improvement before replacing main.
- The compiler supports ordered image/audio references, but this evaluation
  tested one image only. Multi-reference behavior, audio references, 10/15-second
  clips and 768p remain unvalidated. Exact first/last frames, continuation joins,
  original-audio preservation and character LoRAs are not integrated.
- A further experiment should first verify and correct the Oalgo dialogue
  failure, then compare native 768p quality and latency on a broader corpus.
  Do not extrapolate these six Omni outputs into a general quality claim.

The production generator, worker, broker and bot routing are unchanged.
