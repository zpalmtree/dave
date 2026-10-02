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
description for SAM3. An obvious main subject can resolve “him” or “the
character”; names are linked using visible appearance and supplied context,
not passed straight to the tracker. If several subjects fit, the bot asks a
short question using visible alternatives. Reissue the command on the source
video with that distinction. Provider failures do not fall back to the original
ungrounded target. No replacement reference or diffusion render is started for
an unresolved target.

The broker retains the original target, context, sample times, and resolved
description in `video-edit-grounding.json` beside the downloaded clip. Visual
grounding usage is recorded with the job's provider metrics. Each interpretation
call is bounded to 45 seconds; source sampling adds a small amount of CPU work.
This resolves user wording, but does not guarantee that the segmentation or
replacement model will succeed; tracking validation remains mandatory.

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

The source clip must be MP4, MOV, M4V, WebM, or MKV, 0.5–120 seconds, and no larger
than 100 MiB. MiniMax H3 generates 5–15 seconds per run. Shorter clips are padded
for generation and trimmed back to the source length. Longer clips are split
into frame-aligned segments, edited in order, and joined with the original audio.
The clip is downloaded to the broker before queueing so its media URL
cannot expire while it waits. The desktop normalizes it to 24 fps, tracks the
named subject with SAM3.1, and rejects an empty or nearly full-frame mask.
Tracking validation counts selected pixels after decoding the mask, excluding
padding frames. The subject must occupy at least 0.3% and no more than 85% of
the frame on average, with a usable selection in at least half the source frames
of each segment. Empty or mostly lost tracks stop before diffusion and return an
error instead of delivering an effectively unchanged clip. The visual grounding
pass describes the target's appearance and position for SAM3; a failed track
still requires a clearer target or a more suitable source clip.
MiniMax H3 Ref2VA receives the replacement image. Fun ControlNet receives the
source video and inpaints an expanded box that follows the tracked subject. This
gives a differently shaped replacement room to form. The final video composites
that region over the source frames and muxes the original soundtrack. AAC source
audio is copied; other codecs are converted to AAC for Discord delivery.
Delivery may compress the result to meet the channel's upload limit.

Replace edits with a replacement image use Viggle-Animate when the desktop worker
reports `video_edit_version` 5. Viggle-Animate is a finetune of the Ref2VA
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
recorded with the job. A refused or failed repaint, or a failed Viggle render,
falls back to the H3 replacement. A tracking failure is final, since H3 would
fail the same way. Add edits and replacements drawn locally by Qwen Image
always use H3. Set `VIDEO_EDIT_REPAINT=0` on the broker to keep every replace
edit on H3. The worker needs `minimax_h3_ref2va_viggle_pruned_int8_convrot`,
`viggle_animate_dmd_lora_r64`, `models/text_cond/fixed_embed_fwd_anyframe`, and
the `viggle_animate_h3` custom node pack in ComfyUI.

Cuts, a target hidden for much of the clip, or large differences in body shape
can confuse automatic tracking and replacement. Each segment tracks the target
independently, so a visible seam can occur where two renders meet. A portrait
reference may produce a cropped body in a full-body
shot. The original video is retained outside the replacement region. The
underlying H3 workflow uses the separate Ref2VA diffusion checkpoint, the Fun
ControlNet Union 2.0 patch, and the SAM3.1 checkpoint on the Windows desktop.
Union 2.0 needs the compatibility patch in `desktop/minimax-h3-fun-v2-compat.patch`
on ComfyUI v0.37.1; apply it before restarting an idle ComfyUI server.
