# Omni versus TaoMate at production resolution

The earlier 480p run was a compatibility pilot. Both production H3 and
`$fast`/TaoMate request `--quality final`; 480p does not match that setting.
Its timing ratios should not have been used as the main replacement verdict.
This comparison corrects the resolution while retaining the same prompts,
images and seeds.
The landscape reference images are already 1344×768; the portrait reference is
1024×1536. This is not an upscale of the pilot's rendered videos.

## Actual production geometry

`lib/VideoProtocol.ts` supplies final quality to both H3 command variants.
The desktop compiler sets the aspect-dependent megapixel target, and ComfyUI's
`ResolutionSelector` computes and rounds dimensions to multiples of 32:

| Cases | Production selector | Output |
| --- | --- | --- |
| Coffee and marbles | 16:9, 0.98 MP, multiple 32 | 1344×768 |
| Oalgo | 2:3, 0.79 MP, multiple 32 | 736×1120 |

The portrait is 736 pixels on the short edge, not exactly 768. These values were
verified by executing the installed selector on the generated production
graphs. TaoMate's conditioning retains its width/height connections to that
selector; the benchmark no longer substitutes smaller constants. Omni uses the
same resolved dimensions. Every completed clip is validated against them.

## A/B videos

Each A/B shows TaoMate on the left and Omni on the right at original pixel
dimensions. It plays the same pair twice: first with TaoMate audio, then with
Omni audio. The labels identify the active audio and each original render time.
There is no blended audio or interpolated motion. The added title/footer bars
increase the comparison canvas but do not resize the generated images.

| Case | Seed 1 | Seed 2, consecutive render |
| --- | --- | --- |
| Coffee | [1020001](../artifacts/video-omni/production-ab/speech5-1020001-taomate-vs-omni.mp4) | [1020002](../artifacts/video-omni/production-ab/speech5-1020002-taomate-vs-omni.mp4) |
| Oalgo | [1020011](../artifacts/video-omni/production-ab/oalgo5-1020011-taomate-vs-omni.mp4) | [1020012](../artifacts/video-omni/production-ab/oalgo5-1020012-taomate-vs-omni.mp4) |
| Marbles | [1020021](../artifacts/video-omni/production-ab/motion5-1020021-taomate-vs-omni.mp4) | [1020022](../artifacts/video-omni/production-ab/motion5-1020022-taomate-vs-omni.mp4) |

These MP4s are local ignored artifacts, not Git-hosted attachments. Both seeds
are supplied so the comparison does not depend on selecting one favorable clip.

## Measurements

Consecutive fresh-seed render times (second seed per case):

| Case | TaoMate | Omni | Omni / TaoMate |
| --- | ---: | ---: | ---: |
| Coffee, 1344×768 | 24.954 s | 43.988 s | 1.76× |
| Oalgo, 736×1120 | 18.603 s | 35.104 s | 1.89× |
| Marbles, 1344×768 | 23.459 s | 42.514 s | 1.81× |
| Median of three observations | 23.459 s | 42.514 s | 1.81× |

Omni takes about 1.8 times as long as TaoMate on these production-size samples.
Its consecutive renders take 35.1–44.0 seconds for 5.167 seconds of output;
this ComfyUI path is not real-time on the 5090. The pilot's 8.9/15.9-second
medians substantially understated the absolute production-size render times.

First samples are also retained: coffee 52.939/55.509 seconds, Oalgo
43.332/39.819 seconds, and marbles 48.875/48.883 seconds (TaoMate/Omni).
Their load/cache state is uncontrolled, so do not interpret them as a matched
cold-start benchmark.

Twelve renders: three cases × two seeds × two renderers, each 124 frames at
24 fps (5.167 seconds) with stereo 32 kHz source audio. Order was all six
TaoMate renders, then all six Omni renders, in the same isolated ComfyUI process
on the RTX 5090. First samples have uncontrolled cache state. Second samples
follow immediately under the same case/model and reuse prompt conditioning
where available, with fresh sampling verified at three versus eight steps.

Times include submission, conditioning/model loads, sampling, decoding and
MP4 retrieval. They exclude backend startup, checkpoint hash verification,
queuing, keyframe generation, planning and Discord delivery. CPU composition
of the A/B files happened after the timed GPU work completed. These few samples
are not a production latency distribution.

Both renderers passed **4/4** exact-dialogue checks, using one `gpt-transcribe`
observation per speech clip and the existing strict phrase contract. Omni's
extra-word failures from the 480p pilot did not recur in these four native-size
samples. The earlier dialogue result therefore should not be generalized to
production resolution. ASR does not establish voice quality or precise lip-sync;
the A/B files include both generated audio tracks for direct review.

The [raw measurements](video-omni-production-results-2026-10-20.json) archive
all timings, ASR observations, media checks, selector execution results,
compiler/input hashes, runtime versions and the GPUq job ID. Original clips
and graphs remain under
`D:/AI/ComfyUI_windows_portable/video_gen/experiments/fasth3_omni_20261020/production-results`.

## Scope

Both variants use the production compiler's shared text encoder and VAEs.
TaoMate uses its existing three-step LoRA/SLA recipe; Omni uses the pinned
eight-step NVFP4/VSA reference recipe. TaoMate anchors the exact initial frame;
Omni conditions on an image reference. That difference is part of the candidate
renderer behavior, not an equivalent conditioning implementation.

No native-resolution main-H3 run was made here, so the pilot's claimed main
speedup is not a measured production speedup. Likewise, these results do not
benchmark FastVideo's separate specialized runtime. Continuations, exact end
frames, original-audio preservation, multi-reference inputs, longer clips and
production queue/delivery latency remain outside this A/B.

All twelve original outputs passed decoded frame-count, resolution, frame-rate
and stereo-audio checks. Five benchmark harness tests passed on both Linux and
embedded Windows Python, including retention of production resolution links.
The GPUq job succeeded, and the owned experiment server closed port 8197.
All six A/B outputs passed their doubled frame-count, combined-canvas and
stereo-audio checks. The two audio-pass labels were also visually inspected.

The experiment stays isolated from automatic command routing. See
[setup and commands](../docs/video-fasth3-omni.md) for reproduction.
