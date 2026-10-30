# Generic video replacement

Use either video command with a source clip and a replacement image or description:

```text
$minimax replace the red car with the blue car in the attached image
$oalgo replace the dancer with Meximutt, keeping the same moves
$minimax replace the character with slugs
$oalgo make him a robot lol
$oalgo swap that dude
```

Source links are not limited to a provider list. Public HTTP/HTTPS links on
standard ports can supply MP4, MOV, M4V, WebM, MKV or GIF files, including
extensionless downloads identified by their content type. Discord video embeds,
Open Graph video metadata, Twitter player stream metadata and HTML video/source
tags can supply media from any public host. Relative page media URLs are resolved.
Existing YouTube/Twitter extractors and GIF-provider shortcuts remain available.
A GIF provider's playable MP4 still requests GIF output even on a new CDN.

Downloads validate DNS and every redirect, pin the validated address for the
socket, reject private/reserved addresses and credentials, and retain the 100 MiB
clip limit. Page reads have a 3 MiB/15-second budget; downloads have a 120-second
budget and at most four redirects. FFmpeg receives local files with only plain
video demuxers and local protocols enabled. Source links are removed from the
edit prompt. Login-only pages, script-only players, streaming playlists and DRM
are not general-purpose inputs; use a direct downloadable media URL or attachment.
The resolver/showcase is at <http://localhost:4347> (`node
scripts/serve-gif-video-showcase.mjs`).

Replacement-frame preparation prefers GPT Image, with one retry after a refusal,
then tries Gemini if the preferred editor cannot produce a frame. Gemini receives
the original source and replacement images and the same edit instructions through
its native editing path. Its normal provider safeguards apply. If neither editor
produces a usable image, the edit stops before animation.

Alternate frames always pass a still-usability review, including for older workers
that do not request isolated crops. A recognizable, coherent replacement can
proceed with differences in expression, hand gesture, local pose, clothing or body
shape: the source clip supplies motion in the following animation step. Unchanged
or wrong subjects, severe corruption, unrelated scenes and major viewpoint/crop
changes still stop the edit. Finished isolated animations receive their separate
source-performance review; still acceptance does not bypass it. Each shot reserves three
separate provider-attempt numbers; cancellation and accounting failures stop
further requests. Generation is bounded to 270 seconds, leaving time for review
within the worker's existing request timeout. JPEG replies are converted to PNG so
subject-effect metadata is retained.

If an isolated Viggle animation cannot be tracked for compositing, the worker
retries that segment once with the installed Wan-Animate-2 renderer, retaining the
accepted still, source motion crop, timing and final motion review. The alternate
renderer can recover a lost propagated track by segmenting each generated frame
inside the same source-selected spatial box. Mask validity thresholds remain
unchanged. Missing alternate weights, failed recovery and unrelated service errors
still stop the edit. This adds local GPU time only when this tracking failure occurs.

The `a3b75a0e` regression lost tracking on the distorted Viggle output. Increasing
Viggle sampling steps did not restore its turn. Wan followed the turn, but its
propagated track covered only 32% of frames; spatial redetection recovered 96%.
An integrated replay of both real diffusion outputs ran the new fallback routing,
SAM segmentation, compositing, caption protection and review-frame extraction.
The final result passed a live motion review and exported as a GIF. Some clothing,
leg and boundary distortion remains; sampled acceptance does not establish perfect
motion or edge fidelity. No test output was posted to Discord.

Final-frame review now seeks at microsecond precision, just before the desired
timestamp, so rounding `70/24` to `2.917` cannot skip the last frame. The 74 focused
desktop tests passed, including actual last-frame decoding, bounded recovery,
failure propagation and preservation of source selection and the accepted still.
Install/check with `python3 scripts/apply-video-edit-recovery-desktop.py --check`;
the supervised worker loads the module in a fresh subprocess on its next edit.

The editor-routing showcase uses the real shared editor and message formatters
with synthetic provider responses: run `yarn build && node
scripts/serve-edit-fallback-showcase.mjs` and open <http://localhost:4348>.
Desktop/mobile captures and verification notes are in `docs/showcases/edit-fallback/`.

GIF attachments and Tenor/Giphy/Klipy share links also work, including a reply to a
Discord GIF-picker message. Reply with:

```text
$oalgo replace the referee with meximutt
```

GIFs are clip sources, not replacement portraits. You can attach a separate PNG,
JPEG or WebP replacement image to `$minimax`. Tenor/Giphy/Klipy embeds use their playable
media; if the embed is missing, the bot reads the public share page's media metadata.
Only the providers' media CDNs are accepted, with bounded downloads and no redirects.
Unavailable links ask for a direct GIF upload. GIF attachments are converted to
H.264 MP4 on the broker before grounding and dispatch, keeping one full animation
cycle (not the GIF's infinite loop), padding odd dimensions when needed. The usual
half-second minimum, 100 MiB input limit and source time-range rules apply.
GIF inputs, including Tenor/Giphy/Klipy MP4 renditions, now receive a looping GIF.
The broker persists that choice before normalizing the source, so retries and
restarts retain it. Rendering remains MP4; delivery converts with an adaptive
palette and reduces resolution/frame rate if needed to fit Discord's upload
limit, without shortening the animation. If GIF conversion fails or remains too
large, the bot sends the MP4 with an explanation. The original MP4, audio and
private workflow download remain intact. Ordinary video inputs and existing jobs
continue to deliver MP4. Requests for new videos still use a representative
starting frame, with GIF delivery when that starting frame came from a GIF.

The default subject-edit compositor also detects fixed source captions and keeps
their glyphs and outlines above the replacement. It excludes this protection
from the final alpha **after** subject-mask growth and feathering, so generated
feet cannot paint over detected letters. It does not restore whole text boxes:
letter counters and gaps remain editable. Detection uses source frames and the
original subject track, excluding clothing text; no caption wording, colour,
position or ending frame is supplied by the user. It applies to both commands'
default isolated edits and the shared masked H3/add compositing paths.

This is conservative fixed-caption detection, not a guarantee for animated,
changing, low-confidence or multicolour text. A disappearing caption releases
its protection rather than freezing earlier source pixels. OCR or decode errors
stop that edit and produce a caption report. Timing, audio restoration and GIF
delivery remain unchanged. Installation and tests are documented in
`desktop/README.md` under “Source caption protection”.

The showcase runs the actual shared source resolver, GIF delivery converter and
installed desktop compositor with synthetic fixtures; it does not start a GPU render. Run
`yarn build && node scripts/serve-gif-video-showcase.mjs`, then open
<http://localhost:4347>. Captures and revision details live in
`docs/showcases/gif-video/`.

Discord wording does not need to match a command grammar. For a source clip,
a Gemini Flash interpretation pass separates subject replacement from requests
for a new video, continuation, or reaction. It uses the current message and reply
context, tolerates pronouns and nicknames, and keeps the source target separate
from the replacement. A bare `$oalgo` on a clip defaults to replacing its main
subject with Meximutt; an attached replacement image takes precedence. A bare
`$minimax` clip retains the starting-frame generation behavior. Requests for
unsupported edits, such as whole-video restyling, ask for clarification.

Every replacement, including explicit `replace ... with ...` commands, is
visually grounded before queueing. The broker samples five frames across the
downloaded source and converts the intended target into a concrete visible
description for SAM3. A vague target such as a bare `$oalgo`, “him” or “the
character” never asks: grounding picks the most prominent fitting subject, and
in a compilation that cuts between people it describes each shot's main subject
by what they share, such as “the woman in the foreground”. Grounding also
records whether the edit covers one subject or an explicit group (“the dancers”,
"everyone"); Character Swap is prompted to replace only the most prominent
matching subject when the request is singular. The legacy SAM3 path selects one
tracked match per shot. Names are resolved using visible appearance and supplied
context before being passed to the renderer or tracker. If several subjects fit
an explicit description, or a named subject is
absent, the bot asks a short question using visible alternatives. Reissue the
command on the source video with that distinction. Provider failures do not fall back to the original
ungrounded target. No replacement reference or diffusion render is started for
an unresolved target.

The broker retains the original target, context, sample times, and resolved
description in `video-edit-grounding.json` beside the downloaded clip. Visual
grounding usage is recorded with the job's provider metrics. Each interpretation
call is bounded to 45 seconds; source sampling adds a small amount of CPU work.
This resolves user wording, but does not guarantee that the replacement model will
select the right subject. Character Swap uses the grounded description in its prompt;
the legacy backends additionally validate SAM3 tracking.

The clip and image may be attached to the command or to the message it replies
to. The command message's attachment wins when both messages have the same kind
of input. A source clip can also come from a public Twitter/X, fxtwitter,
fixupx, or vxtwitter post link in the command or the message it replies to.
For example, reply to `https://fxtwitter.com/juhrafftrades/status/2103886182404772256`
with `$minimax replace the character with slugs` or
`$oalgo replace the character with slugs`. Attach a slug image to control its
appearance, or omit it to have the bot generate a replacement reference from
your description before queueing the edit. Reference generation uses the existing
cloud image service and adds preparation time and image-generation cost.

`$oalgo replace the character with Meximutt` uses its built-in portrait when no
image is supplied. An explicit different replacement such as “slugs” generates
that subject instead. `$oalgo --replace "the character"` retains the portrait default.
An attached image always takes precedence over a generated reference or portrait.

Link resolution uses the public [FxTwitter API](https://docs.fxembed.com/api/twitter/operations/2statusid/)
and downloads an MP4 from Twitter's media CDN; no Twitter API key is needed.
Use one post per message; for posts with multiple videos, select the desired
media using `/video/1`, `/video/2`, etc. Private/deleted posts and API failures
return an error asking you to retry or attach the video. For requests classified
as new-video generation, a linked video supplies a representative starting frame,
just like an attached clip.

A YouTube video or Short link (`youtube.com/watch`, `/shorts/`, `youtu.be`) works
the same way for edits: reply to a message containing one with
`$oalgo replace this character with meximutt`. YouTube refuses the broker host's
address, so the broker asks the desktop worker to download the video with `yt-dlp`
(up to 1080p, ten minutes and 100 MiB; no playlists, live streams, cookies or
authentication) and upload it when the edit is submitted. This is CPU/network work
that runs beside a render. The usual length limits and time ranges then apply.
The worker must be online and advertise `source_video_download_version: 1`;
otherwise the request stops with an error asking for an attachment. A YouTube link
is never used as a starting frame, so requests to sing a linked song are unchanged.
Install the worker side with `python3 scripts/apply-video-youtube-source-desktop.py`
(it reuses the `yt-dlp.exe` from [named-song setup](video-named-song.md)), reload
the worker child while idle, then deploy the broker and bots.
Quote the subject if its name includes “with,” for example
`replace "the woman with a red coat" with the attached image`.

The source clip must be MP4, MOV, M4V, WebM, or MKV, 0.5 seconds to 10 minutes,
and no larger than 100 MiB. A clip longer than two minutes keeps its first two
minutes, and a range in the prompt such as `0:40-1:10` or `from 1:05` keeps that
part instead (an open range runs up to two minutes). The broker re-encodes the
excerpt so it starts on the requested frame. The broker downloads the clip before
queueing so its media URL cannot expire while waiting.

Replacement edits use Character Swap when the desktop worker advertises
`video_edit_version` 7. Before rendering, the worker sends the actual replacement
image to the broker for a bounded visual-description call. Its concrete face,
hair/fur, proportions, colors and clothing description accompanies `<Picture 1>`
in every segment's prompt. A character name alone is insufficient: job `71683bd7`
retained the source man in three of four windows when this description was absent.
The same opening window with the same seed and a concrete reference description
established the replacement from its opening frame. Descriptions are cached by
image hash and saved as `video-edit-reference.json` on the broker and
`replacement-description.json` on the worker. Locally drawn references are
described after generation. A failed description stops before Character Swap;
it does not silently render with the old generic prompt.

Reference captions describe stable appearance, excluding the portrait's expression,
emotion, gaze and mouth state. Caption cache version 2 invalidates older captions
even when the image hash is unchanged. Job `8a743884` exposed the distinction:
its caption included furrowed brows and downturned lips while the source man was
laughing. Removing those conflicting cues does not establish faithful facial
animation. That job also replaced the man despite a correctly grounded orangutan
target and lost the source scene after a real cut at frame 122 (about 5.1 seconds).
Those are renderer failures, not evidence that target grounding or cut detection
chose incorrectly; this caption correction alone does not fix them.

It applies the primary Character Swap LoRA and the matching
Ref2VA DMD accelerator to the H3 Ref2VA base model. The source frames enter
`MiniMaxH3AddGuide` at frame zero; the replacement image enters native reference
conditioning as `<Picture 1>`, with a `body_swap:` prompt identifying the grounded
target and whether one subject or the whole matching group should be replaced.
Attached, preset, cloud-generated and locally generated replacement images all
use this path. No per-shot repaint is required. Speech performance needs separate
validation: the source guide alone does not guarantee accurate lip-sync or keep
the replacement silent during another speaker's lines.

The approved settings are eight Euler/simple steps, CFG 1, both LoRAs at strength
1, video/audio sigma shifts 12/3, and the installed INT8 video VAE. Output stays
within 0.5 megapixels on a 32-pixel grid without enlarging the source. The desktop
normalizes to 24 fps, detects shot cuts, and partitions each shot into windows of
at most 124 source frames. Shorter windows are padded to 124 frames for H3 and
trimmed before joining, retaining every source frame. After the performance patch,
each continuation carries the preceding 22 rendered frames as frozen video
latents and generates at most 102 new frames. The overlap is discarded from
delivery, and context resets at shot cuts. The original soundtrack is muxed after
assembly; it is not regenerated. AAC audio is copied, while other codecs are
converted to AAC for delivery. Silent sources remain silent. Delivery may compress
the result to meet the channel upload limit.

This is the raw replacement behavior approved in the October 13, 2026 comparison:
no SAM mask or source-background composite is applied. Facial performance improved
in the reviewed close-ups, but the model can widen framing and redraw backgrounds.
Target selection, especially with multiple people, is prompt-based rather than
pixel-exact. Animal, object and long-clip replacements have not been validated by
that two-clip comparison. Both tested clips retained the character and original
soundtrack; the initial 544×640 render took 220 seconds including model loading,
and the following 640×768 render took 145 seconds. These are observed run times,
not a guaranteed latency or a matched speed comparison with the old renderer.

The generator writes `edited.character-swap.json` next to the worker output with
its backend, timings, segment frame ranges, workflow graphs and failure details.
If Character Swap is unavailable, fails, or produces no usable output, the worker
runs the existing Viggle/H3 path below. Cancellation never starts a fallback.
Add-to-video edits continue to use H3 Fun ControlNet. Set
`VIDEO_EDIT_CHARACTER_SWAP=0` on the desktop worker and reload it while idle to
restore the legacy replacement flow. `VIDEO_EDIT_REPAINT=0` on the broker controls
only whether the legacy fallback uses Viggle or goes directly to H3.

Install the version-checked desktop changes with
`python scripts/apply-video-character-swap-desktop.py --check`, then the same
command without `--check`, and reload the supervised worker while idle. Required
models and pinned download hashes are recorded in
`desktop/video-character-swap-models.json`. The primary Character Swap LoRA is
about 620 MB and the matching Ref2VA accelerator about 2.29 GB; the existing
Ref2VA base, text encoder and VAEs are reused. Model files belong in ComfyUI's
configured model directories, including `C:/AI/ComfyUI_fast_models` on this desktop.
The installer does not download models.

For desktops already running Character Swap and YouTube source downloads, apply
the description fix with `python3 scripts/apply-video-swap-description-desktop.py --check`,
then without `--check`. Deploy the matching broker and reload the worker
while idle. The renderer now requires `--reference-description`; an older worker
cannot silently invoke it with the known failing generic prompt.

For desktops with the description fix installed, apply
`python3 scripts/apply-video-swap-performance-desktop.py --check`, then without
`--check`. The renderer is a per-job subprocess, so new replacements pick up its
continuation changes without reloading the worker. Existing renders are unaffected.

The renderer also accepts `--speech-plan PATH` with source-relative intervals:

```json
{"source_seconds": 8.1, "target_speech": [{"start": 0.0, "end": 1.2}, {"start": 2.5, "end": 5.6}]}
```

Use intervals checked against the source speaker turns. The conditioning waveform
retains only the selected subject's speech; all other times are silent. Each model
window receives the aligned waveform as frozen audio latents and instructions to
listen outside those intervals. The final output still uses the complete original
soundtrack, including the other speakers. Empty intervals describe a silent target.
Invalid, overlapping or out-of-range intervals, and a mismatched source duration,
are rejected before rendering. The worker does not yet generate this optional
speech plan automatically; an absent plan retains guide-only mouth animation.

The 71683bd7 regression exposed an appearance jump at output frame 112. A bounded
continuation test removed that visible jump and kept the replacement's mouth
closed during the following off-screen reply. These observations do not establish
perfect phoneme timing. Tests exercise real FFmpeg overlap trimming, source frame
counts, shot-cut resets, original AAC preservation, and source-relative speech
gating; run `python -m unittest test_video_character_swap` in the desktop environment.

The [BFS Character Swap license](https://huggingface.co/Alissonerdx/Minimax-H3-ComfyUI/blob/main/LICENSE_CHARACTER_SWAP.md)
restricts remote inference services. The operator confirmed separate author
permission for this deployment. Other operators must obtain their own applicable
permission; installing this integration does not grant rights to the model weights.

## Legacy fallback

The legacy H3 path tracks the named subject with SAM3.1 and rejects an empty or
nearly full-frame mask. The selection must cover 0.3%–85% of the frame on average,
with a usable track in at least half the source frames per segment. H3 Ref2VA and
Fun ControlNet inpaint an expanded box around the subject. The result is composited
over the source and joined with the original soundtrack. A tracking failure stops
before diffusion.

The legacy path uses Viggle-Animate for replacement images when the worker
supports repainting (version 5 or later). Viggle-Animate is a finetune of the Ref2VA
transformer that animates one repainted frame of the clip through the source
motion. The worker tracks the target in every segment and sends the broker the
frame where it is largest. The broker repaints the target in that frame with
the replacement image using gpt-image. The repaint keeps the frame's pose, size,
crop and expression, which the animation depends on. Gemini pulled the camera
back in testing, and the animation then froze or broke apart. Each segment then
renders in 124-frame windows that carry 22 frames forward, sampled against the
frozen source soundtrack. The result is composited over the tracked region like
the H3 path. Both the frame and the repaint are kept beside the clip as
`video-edit-frame.png` and `video-edit-still.png`, and the repaint's usage is
recorded with the job. A clip that cuts between shots is edited shot by shot:
segments never span a cut, each shot is tracked afresh, and each is animated
from a repaint of its own clearest frame (`video-edit-frame-2.png`,
`video-edit-still-2.png` and so on), since a still framed for one shot breaks the
animation of another. Each repaint costs about $0.07. A shot without the subject,
or one whose repaint is refused, stays source footage; the edit falls back to
H3 only when every repaint fails. The repaint keeps anything the subject wears
on its head, so a clip that cuts to its subjects in hijabs still shows the
replacement in one. Naming garments in that rule got frames of bareheaded real
people refused, so it names none. The desktop README describes the cut detection. A refused or failed repaint, or a failed Viggle render,
falls back to the H3 replacement. A tracking failure is final, since H3 would
fail the same way. Add edits and locally drawn references use H3 within this fallback. Set
`VIDEO_EDIT_REPAINT=0` on the broker to send legacy replacement attempts directly
to H3. The worker needs `minimax_h3_ref2va_viggle_pruned_int8_convrot`,
`viggle_animate_dmd_lora_r64`, `models/text_cond/fixed_embed_fwd_anyframe`, and
the `viggle_animate_h3` custom node pack in ComfyUI.

Gradual transitions, a target hidden for much of the clip, or large differences
in body shape can confuse automatic tracking and replacement. Each segment tracks
the target independently, so a visible seam can occur where two renders meet
within one shot. A portrait
reference may produce a cropped body in a full-body
shot. The legacy paths retain the original video outside the replacement region. Their
underlying H3 workflow uses the separate Ref2VA diffusion checkpoint, the Fun
ControlNet Union 2.0 patch, and the SAM3.1 checkpoint on the Windows desktop.
Union 2.0 needs the compatibility patch in `desktop/minimax-h3-fun-v2-compat.patch`
on ComfyUI v0.37.1; apply it before restarting an idle ComfyUI server.

## Isolated replacements (worker protocol 8)

New replacements require a protocol-8 desktop worker. Additions keep their existing
route. The replacement path tracks the named subject before rendering, retains
all detected shot boundaries (including very short opening/return shots), and
builds a fixed crop from the tracked bounds for each shot. When a clip has more
than 24 detected shots, it fails explicitly rather than merging unrelated shots.
The selected reference frame favors detail inside the subject's mask instead of
simply choosing the frame with the largest mask. It inspects every frame of short
shots and up to 25 samples per longer segment. Motion crops are enlarged to a
512-pixel short edge, capped at 896 pixels on the long edge; tiny native crops
previously caused dark artifacts.

Only the target crop enters motion generation. Generated pixels are mapped back
to source coordinates and composited through the tracked mask over the normalized
source footage. The source soundtrack is restored afterward. The mixed soundtrack
does not drive the target's mouth, and automatic whole-track lip sync is disabled
for this path: another person's laughter or speech must not animate the target.

`VIDEO_EDIT_ISOLATED_RENDERER` selects the desktop renderer:

- `viggle` (default): repaint each tracked crop, check its identity and source pose, then
  transfer motion from that shot's source crop. Every shot needs a usable still.
- `wan` (experimental, opt-in): Wan-Animate-2 takes the replacement reference directly, with the tracked
  source crop as its driving video. It avoids per-shot image-repainting calls.
  Windows contain at most 49 frames with one frame of carried motion inside a
  shot. Continuation resets at every shot boundary.

The broker's narrow edit review compares matched source/output/mask samples from
**every segment**, including its first and last frame. It checks the selected
subject, replacement identity, source pose/expression, and surrounding scene.
Reviews are bounded and cached by evidence, target, reference and review version.
Missing evidence, review outages, rejected output and failed shots stop delivery.
There is no automatic fallback to an unreviewed full-frame edit or silent delivery
of an untouched shot. These sampled checks are useful failure detection, not a
guarantee that every frame is artifact-free.

Local references are registered through the existing lease-authenticated reference
endpoint so that repainting and review use the exact same replacement. Review
requests are also lease-authenticated, image-count/size limited and metered.
Audit files remain in the job's `viggle` directory, including source masks, crop
coordinates, shot/segment boundaries, chosen frames and paired review images.

For the `8a743884` regression, the new reviewer rejected the original wrong-man
edit and subsequent scene replacement. The first isolated Viggle run preserved
the other man but produced artifacts with undersized inputs. After correcting
crop resolution and the opening cut, its five-second main-shot test passed the
sampled motion review. This is **not a passing full-clip result**: the four-shot
run still stopped on refused or unusable reference stills. The source performance,
including laughter, has not been validated across the complete replacement.

Local Wan tests rendered successfully. Direct portrait conditioning had framing
problems; a source-aligned still improved the short test but has not qualified
Wan as the default. No hosted video API is configured. The existing image-repaint
and caption/review APIs still incur usage; GPU motion generation remains local.

Install the versioned desktop patch using
`python3 scripts/apply-video-edit-isolated-desktop.py --check`, then without
`--check`. Reload the supervised worker while idle and deploy both tracks with
`scripts/deploy-bots.sh --with-broker`. See `desktop/README.md` for the optional
local Wan weight installer and verification commands.

Validation on October 28, 2026: the desktop suites passed 116 tests. The full
bot suite with `--test-concurrency=1` passed 706 of 708 tests; the planner-prompt
wording assertion and regenerated-workflow attachment assertion also fail on
unchanged `7de3452`. The unconstrained parallel run additionally exhausted test
process resources. All changed-area tests passed in the serial run. Installer
checks covered the expected baseline, already-applied files and concurrent edits.

## Covering the replacement outline

The follow-up `video-edit-composite.patch` addresses human feedback about blending,
flicker and leftover source anatomy. The isolated renderer now also segments its
own output, using a spatial SAM prompt derived from the source track. This avoids
asking a text detector to choose another performer. The composite alpha covers
the union of the original and generated silhouettes, fills small cracks and
interior holes, and feathers outward. Source foreground stays opaque instead of
being blended back into the replacement. An original subject outside the generated
crop is an error; alpha is clamped after filtering so padded black pixels cannot
leak across crop boundaries. Alpha files use lossless grayscale FFV1.

Brightness matching is restored for isolated edits. It fits shared background
only inside the generated crop, excludes both subjects' silhouettes, and smooths
the gain/offset over time. Full-frame black padding and untouched people cannot
bias the fit. Masks, tracking workflows and final review pairs remain available
beside each job. This adds local SAM tracking and CPU compositing, with no new
hosted API call. It does not fix facial motion, identity drift or flicker already
present inside the generated subject.

For the same five-second `8a743884` Viggle render, the old track had 11 empty
frames; the corrected source track had none. About 14.6% of the generated-person
mask lay outside the unpadded source silhouette. The new composite removes the
obvious remaining orangutan outline in the inspected comparisons. This is a
controlled comparison of identical diffusion output, not a new full-clip success.
The earlier automated acceptance did not establish acceptable visual quality.

Validation: 126 desktop tests passed, including coverage of both silhouettes,
interior holes, crop-edge black padding, empty/short tracks, lossless masks,
spatial tracking and crop-limited exposure fitting. The integrated renderer was
also run with the cached diffusion output and live SAM/compositing/review-evidence
extraction. No additional image repaint or video generation was needed for that
comparison. Apply this patch after the isolated-edit patch; verify the latest
revision with `python3 scripts/apply-video-edit-composite-desktop.py --check`.

## Blurred source fringe and coloured halos

Further human review found a halo after the silhouette update. Comparing the raw
Viggle output with its composite showed a brown/grey arc introduced by blending:
the original orangutan's blurred fringe extended beyond its hard SAM mask. A
tighter feather alone exposed more of it. The `video-edit-halo.patch` therefore
expands original-subject erasure by 5.5% of the shorter crop dimension, bounded
to 3–12 source pixels, before applying the outward feather. Generated facial
detail remains opaque, and alpha is still clipped to the generated crop.

The existing brightness-matching encode pass also fits a local RGB residual from
clean nearby background outside both silhouettes and the expanded source blur.
Correction is capped at 38/255 per channel, smoothed within each shot, and faded
away inside the replacement boundary to preserve facial detail. Insufficient
background evidence skips correction and clears its history. This addresses
background tint without requiring another video render or hosted service. The
constants are conservative defaults validated on this case, not a guarantee for
every blur width, occlusion or background.

Validation on October 28, 2026: 133 desktop tests passed. New regressions cover
blur erasure, colour contamination, facial-interior preservation, correction
bounds, temporal smoothing, absent evidence and invalid crop history. An
integration run through the production renderer reused the same cached diffusion
and SAM outputs while running changed compositing and review-frame extraction
live. Inspection at 0.1, 1, 3 and 4.8 seconds showed a reduced halo, particularly
around the mouth and chin. No new image/video generation or API review was used
for this comparison. The full original clip and faithful laughter remain
unresolved; this is a compositing improvement to the five-second test.

Apply after the composite patch and verify the current desktop revision with
`python3 scripts/apply-video-edit-halo-desktop.py --check`. The supervised worker
uses a new edit subprocess per job, so the next edit loads this correction.

## Remaining hair halo evaluation

Further feedback identified the soft patch behind the hair where the orangutan
used to be. Hard SAM masks include some generated background as foreground; the
old-subject erasure area is also larger than the new head. More feathering or
colour correction alone does not separate those layers reliably.

Local controlled tests on the same 121 generated frames, October 28, 2026:

| Candidate | Observed result | Decision |
| --- | --- | --- |
| Harmonic background-colour fit | Patch becomes more obvious | Reject |
| Temporal median background plus hard SAM outline | Sharp cutout and incorrect inferred background | Reject |
| MatAnyone 2, first-frame seed | Empty foreground in 18/121 frames | Reject |
| MatAnyone 2, later seed and bidirectional propagation | Empty foreground in 52/121 frames | Reject |
| RVM matte plus full ProPainter source removal | No empty mattes, but a new pale background patch | Reject |
| RVM-protected background-gap inpainting | Some halo reduction; residual softness behind hair | Experimental only |

The final approach is preserved as the generic `desktop/video_edge_repair.py`
tool, not hardcoded to this job. It takes existing normalized segment assets,
protects confident replacement pixels, limits repair to the original/generated
track region, runs local inpainting, and restores every protected pixel from the
input composite before encoding. It checks foreground overlap with the tracked
replacement rather than accepting a merely nonempty matte. Missing inputs or
incomplete predictions stop the candidate instead of producing a partial result.
It never overwrites existing outputs or work directories. Source audio is copied.

Seven new regression tests cover foreground loss, mismatched evidence, invalid
alpha, overbroad repair and protected-pixel preservation. All 140 desktop tests
passed, and the actual generic CLI processed all 121 frames with the audio track
preserved. The comparison uses the same cached diffusion output; matting and
inpainting ran locally under GPUq. No hosted API calls or Discord sends were made.
The normal worker remains on the earlier halo correction. This experiment does
not fix facial performance or establish success on the full original clip.

The next controlled refinement replaces unconditional two-pixel protection with
a matte-supported edge: opaque foreground (alpha > 230) remains protected, and
partial foreground (alpha > 128) is protected only within two pixels of that
core. This allows repair of low-alpha background previously preserved as a halo.
The stricter opaque-core overlap check remains independent. No frame history is
used, so protection cannot trail a moving head. The scope is boundary cleanup,
not stabilization of flicker already inside the generated subject.

Two alternatives were rejected: protecting only opaque pixels softened facial
contours; protecting all half-opacity pixels preserved a broad uncertain patch
in early frames. The bounded edge gives a modest improvement in the inspected
comparison, with residual background softness. Four additional regression tests
cover partial edges, broad uncertain halos, foreground loss and moving subjects.
All 144 desktop tests passed. The installer upgrades only the exact audited first
release or already-current files and validates both files before changing either;
unknown concurrent edits are preserved. The tool remains experimental.
The updated generic CLI completed all 121 frames at 608×512/24 fps; its masks
matched the controlled prototype. Every confident foreground pixel was excluded
from repair, protected pixels were restored exactly before encoding, and copied
audio packet hashes matched the input. Only 67–190 extra boundary pixels per
frame became eligible for repair compared with the previous candidate.

### Frame-edge seam

The next review isolated a thin light line at the left canvas edge. Comparing
the source, placed render, composite and repaired frames located it in ProPainter
output; it was absent from the input composite. The optional repair tool now
detects repair masks touching any canvas edge. For those segments it runs a second
local inpainting pass with 32 pixels of reflected image and mask context on each
side. Model-edge artifacts then fall outside the delivered canvas.

Only masked pixels in a 12-pixel strip at an affected edge use that extra pass:
the outer four pixels use the contextual prediction, with a smooth transition
back to the accepted prediction by pixel 12. Protected foreground and the interior
remain exact before final video encoding. Nonedge repairs skip the extra pass.
This keeps the approved hair/background result while correcting the frame border;
it does not crop or enlarge the delivered video. Missing or wrong-sized contextual
predictions fail the candidate. The additional local pass has no API cost but
adds inference time for segments whose repair reaches an edge.

All 149 desktop tests passed, including all four borders, partial transitions,
protected pixels, unchanged interiors, reflected mask alignment, invalid output
dimensions and skipping unnecessary context. The optional tool is still separate
from the normal worker.
The real CLI completed all 121 frames with unchanged dimensions and copied audio
packet hashes. Comparing lossless assembly against the previous candidate found
exact matches for protected foreground and the interior beyond the 12-pixel
border. Across repaired left-edge rows, mean outer-column brightness excess over
column four fell from 20.16 to -0.44 on the 0–255 RGB scale. Enlarged comparisons
at the beginning, middle and end no longer show the thin bright line.

Full-video regeneration exposed a separate duration constraint: the close-up is
131 frames, longer than the evaluation tool's original 124-frame cap. Repair now
accepts one continuous normalized segment up to 360 frames (the planner's
15-second limit), keeping recurrent matting state throughout the shot. Inpainting
still processes 40-frame subvideos; shot boundaries remain separate repair jobs.
Internal shot segments also bypass the upload-only 0.5-second minimum. A one-frame
shot gets a duplicate frame and mask solely as optical-flow context, then keeps
only the original frame in its output. The opening cut is neither dropped nor
lengthened. The desktop suite now passes 151 tests, and real one-frame and
131-frame segments completed matting, both inpainting passes and final encoding.
The repaired-shot assembler also rebuilds a continuous 24-fps clock from decoded
frame order. Stream-copy concatenation after a one-frame shot can overlap B-frame
timestamps despite retaining the frame count. The new assembler preserves each
decoded frame and copies source AAC audio, with a regression checking frame
colours and every timestamp across a one-frame cut. All 152 desktop tests pass.
Review evidence uses decoded frame indices: rounding a boundary timestamp to
milliseconds can sample the adjacent shot. The same regression checks exact
sampled frame content and rejects evidence extending beyond the video.

The full `8a743884` candidate now contains all four shots (1, 121, 131 and 15
frames), 268 frames total at exactly 24 fps. Its 11.166667-second video retains
the original 11.136-second audio packets unchanged. The accepted five-second
section is reused. Existing approved stills supply the opening and close-up;
the ending uses a source-coordinate crop from the accepted motion. An upright
ending reference was rejected. Tracking the small ending at native crop resolution
resolved an empty full-canvas replacement mask before mapping it back to source.

This is not a clean automated quality pass. Exact-frame review accepts the new
close-up, flags a rectangular blend in the one-frame opening and unclear identity
in the blurred ending, and also rejects the middle section already accepted by
the user. Those flags are retained with the full-length preview for visual review.
There was no automatic Discord delivery. Local motion/repair used GPUq; evaluation
used the existing image-review service, with no hosted video editor.

Upstream implementations: [MatAnyone 2](https://github.com/pq-yang/MatAnyone2),
[RVM](https://github.com/PeterL1n/RobustVideoMatting), and
[ProPainter](https://github.com/sczhou/ProPainter). Only RVM and ProPainter are
needed for the reusable experimental tool; model hashes and the ProPainter source
revision are pinned in `desktop/video-edge-repair-models.json`.

## Recovering source tracks after a camera swing

For isolated edits, a failed source track now gets one reverse tracking pass with
exactly the same target description and primary/group selection. When a primary
track is still fragmented, the worker takes a mask from the middle of its longest
sustained detection (at least 12 frames for normal-length segments), then tracks
that one mask outward in both directions. These seeded passes disable text
redetection and allow only one object, so they cannot add another detected person.
The source segment is trimmed before reversal; model padding is added only after
restoring chronological order, with the shared seed frame included once.

Recovered masks must pass the existing source coverage and duration checks. No
stable seed, unreadable evidence, or a failed recovery stops preparation. Group
requests never enter single-object seed recovery. Compositing now produces zero
alpha when the source target mask is empty, preserving offscreen footage even if
the motion model invents a person there. Still identity and finished-motion review
remain required. The recovery is bounded to one reversed pass and, for primary
subjects only, two passes from one seed; it does not loop or call hosted models.

Validation on October 29, 2026: 74 focused desktop tests passed in the Windows
runtime, the TypeScript build passed, and 53 editor/reviewer/broker tests passed.
A fresh GPU-admitted preparation of the original 17-second `8c6f8f57` source passed
both shots. The failed second shot improved from 4% usable frames to 94/182 (52%);
the remaining frames include the camera swing away from the subject. Sampled mask
inspection confirmed the returning man was selected while shelves and the other
man stayed outside the mask. This establishes source preparation, not a finished
replacement render or Discord delivery. Private source images remain untracked.

Install with `python3 scripts/apply-video-edit-source-recovery-desktop.py --check`,
then without `--check`. New edit subprocesses load it automatically. The updated
fixture showcase is <http://localhost:4348>, started with
`node scripts/serve-edit-fallback-showcase.mjs`; desktop/mobile captures are in
`docs/showcases/edit-fallback/`.

## Preserved black frames in motion review

The `f8551b5a` replacement was rejected because its first review sample contained
black source, edited and mask images. Inspection of the saved evidence confirmed
that the source fades in from black; the output correctly preserved that frame.
Motion review version 3 explicitly treats matching blank source/output frames
with an empty mask as preserved transitions and evaluates the visible samples.
Black output over a visible subject, an empty track over a visible subject, and
evidence containing only blank frames remain grounds for rejection. Still review
is unchanged. The version bump invalidates cached decisions under the older rule.

The saved 1.5-second, 36-frame render was reviewed without regenerating video.
The corrected live reviewer accepted the original opening segment and its reversed
fade-out fixture. It separately rejected the second segment for blending and
transparency artifacts. Fixing the black-frame false rejection therefore does not
establish that the complete old render is suitable for delivery; it was not sent
to Discord. Private evidence remains under `artifacts/edit-review-f8551b5a/`.
