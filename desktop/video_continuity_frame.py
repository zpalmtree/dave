"""Exact decoded endpoint for continuing an accepted video; CPU only."""
from pathlib import Path
import uuid


def extract_final_video_frame(video: Path, destination: Path) -> None:
    """Decode through EOF so audio duration, VFR and B-frame delay cannot select an earlier frame.

    Scene clips are bounded by the renderer. Retain only one decoded frame and
    replace the destination after a successful decode; never silently use a
    partial decode or an old image after corrupt input.
    """
    import av
    last = None
    with av.open(str(video)) as container:
        if not container.streams.video:
            raise ValueError('Continuation source has no video stream.')
        for frame in container.decode(video=0):
            last = frame
        if last is None:
            raise ValueError('Continuation source has no decoded video frames.')
        image = last.to_image()
    temporary = destination.with_name(destination.name + '.' + uuid.uuid4().hex + '.tmp.png')
    try:
        image.save(temporary, format='PNG')
        temporary.replace(destination)
    finally:
        temporary.unlink(missing_ok=True)
