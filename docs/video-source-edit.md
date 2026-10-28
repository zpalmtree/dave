# Generic video replacement

Use either video command with a source clip and a replacement image or description:

```text
$minimax replace the red car with the blue car in the attached image
$oalgo replace the dancer with Meximutt, keeping the same moves
$minimax replace the character with slugs
$oalgo make him a robot lol
$oalgo swap that dude
```

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
