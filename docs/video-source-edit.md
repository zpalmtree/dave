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
Quote the subject if its name includes “with,” for example
`replace "the woman with a red coat" with the attached image`.

The source clip must be MP4, MOV, M4V, WebM, or MKV, 0.5 seconds to 10 minutes,
and no larger than 100 MiB. A clip longer than two minutes keeps its first two
minutes, and a range in the prompt such as `0:40-1:10` or `from 1:05` keeps that
part instead (an open range runs up to two minutes). The broker re-encodes the
excerpt so it starts on the requested frame. The broker downloads the clip before
queueing so its media URL cannot expire while waiting.

Replacement edits use Character Swap when the desktop worker advertises
`video_edit_version` 6. It applies the primary Character Swap LoRA and the matching
Ref2VA DMD accelerator to the H3 Ref2VA base model. The source frames enter
`MiniMaxH3AddGuide` at frame zero; the replacement image enters native reference
conditioning as `<Picture 1>`, with a `body_swap:` prompt identifying the grounded
target and whether one subject or the whole matching group should be replaced.
Attached, preset, cloud-generated and locally generated replacement images all
use this path. No per-shot repaint or lip-sync postprocessing is required.

The approved settings are eight Euler/simple steps, CFG 1, both LoRAs at strength
1, video/audio sigma shifts 12/3, and the installed INT8 video VAE. Output stays
within 0.5 megapixels on a 32-pixel grid without enlarging the source. The desktop
normalizes to 24 fps, detects shot cuts, and partitions each shot into windows of
at most 124 source frames. Shorter windows are padded to 124 frames for H3 and
trimmed before joining, retaining every source frame. Windows render independently,
so seams can occur within a long shot. The original soundtrack is muxed after
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
