# ComfyUI workflow metadata

Generated MP4 files retain ComfyUI `prompt` and `workflow` tags through delivery
finishing, audio normalization, Discord compression, song trimming, and recovery
assembly. FFmpeg's MP4 muxer requires `use_metadata_tags` to retain these custom
tags; its default metadata handling silently drops them.

The bot also extracts the graphs before upload and attaches `.workflow.json`
files beside the video. Download a JSON attachment and open or drop it into
ComfyUI. This provides a separate copy even when a Discord media preview or a
later re-upload loses the video's embedded metadata. Graphs still require the
referenced models, custom nodes, and input images/audio on the importing machine.

For multiple scenes, the MP4's standard tags describe the first available graph,
and `dave_workflows` holds all scene graphs in order. The bot exports each scene
separately for up to nine graphs. Larger collections use one `.workflows.json`
bundle; save a graph from its `workflows` array as a JSON file to import it.
Metadata-free videos remain deliverable without an extra attachment. Malformed
or oversized graph data is omitted; extraction failures are logged without
blocking video delivery.

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
