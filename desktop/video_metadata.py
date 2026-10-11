"""Keep ComfyUI graphs when several rendered scenes become one MP4."""
import json
import os
import subprocess
import tempfile
from pathlib import Path


def read_workflows(path):
    # PyAV is already required by the generator; reading tags does not decode media.
    import av
    with av.open(str(path)) as container:
        tags = dict(container.metadata)
    try:
        collection = json.loads(tags.get('dave_workflows', 'null'))
        if isinstance(collection, list) and collection:
            return collection
        value = {key: json.loads(tags[key]) for key in ('prompt', 'workflow') if key in tags}
        return [value] if value else []
    except (ValueError, TypeError):
        return []


def preserve_joined_workflows(paths, destination, ffmpeg):
    """Carry every scene graph, with the first graph in ComfyUI's native tags.

    A metadata file avoids Windows command-line limits for large graphs. Only
    graph tags are copied, excluding machine paths and unrelated job manifests.
    """
    if len(paths) < 2:
        return
    workflows = [workflow for path in paths for workflow in read_workflows(path)]
    if not workflows:
        return
    tags = {**workflows[0], 'dave_workflows': workflows}
    def escape(value):
        return value.replace('\\', '\\\\').replace('=', '\\=').replace(';', '\\;').replace('#', '\\#').replace('\n', '\\\n')
    destination = Path(destination)
    with tempfile.TemporaryDirectory(prefix='workflow-', dir=destination.parent) as temporary:
        metadata = Path(temporary) / 'metadata.txt'
        metadata.write_text(';FFMETADATA1\n' + ''.join(
            key + '=' + escape(json.dumps(value, ensure_ascii=False)) + '\n'
            for key, value in tags.items()), encoding='utf-8')
        output = Path(temporary) / 'result.mp4'
        subprocess.run([str(ffmpeg), '-nostdin', '-v', 'error', '-y', '-i', str(destination),
                        '-f', 'ffmetadata', '-i', str(metadata), '-map', '0', '-map_metadata', '1',
                        '-c', 'copy', '-movflags', '+faststart+use_metadata_tags', str(output)],
                       capture_output=True, check=True, timeout=120,
                       creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
        os.replace(output, destination)
