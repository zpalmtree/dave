# ComfyUI workflow metadata

Generated MP4 files retain ComfyUI `prompt` and `workflow` tags through delivery
finishing, audio normalization, Discord compression, song trimming, and recovery
assembly. FFmpeg's MP4 muxer requires `use_metadata_tags` to retain these custom
tags; its default metadata handling silently drops them.

The bot uploads only the video, without automatic JSON attachments or their
large Discord previews. The workflows remain embedded in the MP4. Graphs still
require the referenced models, custom nodes, and input images/audio on the
importing machine.

For multiple scenes, the MP4's standard tags describe the first available graph,
and `dave_workflows` holds all scene graphs in order. ComfyUI's standard import
uses the first graph; the custom collection is an archive, not one combined
workflow that renders the entire movie. To import another scene, extract its
`workflow` (or API `prompt`) object from the collection and save it as JSON.
The `videoWorkflowAttachments` utility in `lib/VideoWorkflow.ts` remains available
for explicit extraction, but is not called during Discord delivery. For example,
inspect the embedded collection locally with:

```sh
ffprobe -v error -show_entries format_tags=prompt,workflow,dave_workflows -of json video.mp4
```

Download the original attachment to retain its metadata; a processed preview or
later re-upload may not retain it. Previously posted JSON attachments are not
automatically removed by this change.

This affects new deliveries. Already uploaded videos with missing metadata do
not gain it retroactively; recovering those requires the original render.

The desktop patch is archived as `desktop/video-metadata.patch`, with audited
source hashes. Install or verify it using:

```sh
python3 scripts/apply-video-metadata-desktop.py --check
python3 scripts/apply-video-metadata-desktop.py
```

Restart the desktop worker while dispatch is held and the worker is idle, so it
loads the updated delivery flags. The generator starts fresh for each render.
Run `desktop/test_video_metadata.py` using the desktop embedded Python after
installation. Its fixtures use real FFmpeg processing without GPU inference.
