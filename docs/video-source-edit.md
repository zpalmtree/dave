# Generic video replacement

Use either video command with a source clip and a replacement image:

```text
$minimax replace the red car with the blue car in the attached image
$oalgo replace the dancer with Meximutt, keeping the same moves
```

The clip and image may be attached to the command or to the message it replies
to. The command message's attachment wins when both messages have the same kind
of input. `$oalgo` uses its built-in portrait if no replacement image is supplied.
Quote the subject if its name includes “with,” for example
`replace "the woman with a red coat" with the attached image`.

The source clip must be MP4, MOV, M4V, WebM, or MKV, 0.5–120 seconds, and no larger
than 100 MiB. MiniMax H3 generates 5–15 seconds per run. Shorter clips are padded
for generation and trimmed back to the source length. Longer clips are split
into frame-aligned segments, edited in order, and joined with the original audio.
The clip is downloaded to the broker before queueing so its Discord URL
cannot expire while it waits. The desktop normalizes it to 24 fps, tracks the
named subject with SAM3.1, and rejects an empty or nearly full-frame mask.
MiniMax H3 Ref2VA receives the replacement image. Fun ControlNet receives the
source video and inpaints an expanded box that follows the tracked subject. This
gives a differently shaped replacement room to form. The final video composites
that region over the source frames and muxes the original soundtrack. AAC source
audio is copied; other codecs are converted to AAC for Discord delivery.
Delivery may compress the result to meet the channel's upload limit.

Cuts, a target hidden for much of the clip, or large differences in body shape
can confuse automatic tracking and replacement. Each segment tracks the target
independently, so a visible seam can occur where two renders meet. A portrait
reference may produce a cropped body in a full-body
shot. The original video is retained outside the replacement region. The
underlying H3 workflow uses the separate Ref2VA diffusion checkpoint, the Fun
ControlNet Union 2.0 patch, and the SAM3.1 checkpoint on the Windows desktop.
Union 2.0 needs the compatibility patch in `desktop/minimax-h3-fun-v2-compat.patch`
on ComfyUI v0.37.1; apply it before restarting an idle ComfyUI server.
