# Generic video replacement

Use either video command with a source clip and a replacement image:

```text
$minimax --replace "the red car" keep the route and camera movement
$oalgo --replace "the dancer" keep the same moves
```

The clip and image may be attached to the command or to the message it replies
to. The command message's attachment wins when both messages have the same kind
of input. `$oalgo` uses its built-in portrait if no replacement image is supplied.
With a clip present, `replace the red car with the attached image` also works.
The quoted `--replace` form is best when several similar subjects appear.

The source clip must be MP4, MOV, M4V, WebM, or MKV, 5–15 seconds, and no larger
than 100 MiB. It is downloaded to the broker before queueing so its Discord URL
cannot expire while it waits. The desktop normalizes it to 24 fps, tracks the
named subject with SAM3.1, and rejects an empty or nearly full-frame mask.
MiniMax H3 Ref2VA receives the video and replacement image. Fun ControlNet
inpaints the tracked area. The final video composites that area over the source
frames and muxes the original soundtrack. AAC source audio is copied; other
codecs are converted to AAC for Discord delivery. Delivery may compress the
result to meet the channel's upload limit.

This workflow edits one continuous shot. Cuts, a target hidden for much of the
clip, or large differences in body shape can confuse automatic tracking and
replacement. The original video is retained outside the tracked mask. The
underlying H3 workflow uses the separate Ref2VA diffusion checkpoint, the Fun
ControlNet patch, and the SAM3.1 checkpoint on the Windows desktop.
