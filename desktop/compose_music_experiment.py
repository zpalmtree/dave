"""Music3 experiment worker. Launch only inside a GPUq reservation.

Arguments: experiment directory, live video_gen directory. Uses the audited
runtime without modifying it. Keeps the first successful raw performance.
"""
import hashlib
import json
from pathlib import Path
import shutil
import sys
import time
import uuid


def main():
    root, live = (Path(p) for p in sys.argv[1:3])
    for name, digest in json.loads((root/'runtime-hashes.json').read_text()).items():
        if hashlib.sha256((live/name).read_bytes()).hexdigest() != digest:
            raise RuntimeError('Frozen music runtime changed: '+name)
    spec_bytes = (root/'spec.json').read_bytes()
    spec_hash = hashlib.sha256(spec_bytes).hexdigest()
    spec = json.loads(spec_bytes)
    output, receipt = root/'score.flac', root/'score-receipt.json'
    if receipt.exists():
        saved = json.loads(receipt.read_text())
        if output.exists() and saved['spec_sha256'] == spec_hash and saved['sha256'] == hashlib.sha256(output.read_bytes()).hexdigest():
            return
        raise RuntimeError('Existing successful composition differs; refusing to overwrite it')
    sys.path.insert(0, str(live))
    import video_gen as generator
    import video_song
    process = log = None
    try:
        if not generator.server_ready(generator.DEFAULT_SERVER):
            process, log = generator.start_server(generator.DEFAULT_SERVER)
        graph = video_song.song_graph(spec, 'video/music-pipeline/'+uuid.uuid4().hex)
        (root/'score-graph.json').write_text(json.dumps(graph, indent=2))
        result = video_song.api(generator.DEFAULT_SERVER, '/prompt', {'prompt': graph, 'client_id': 'music-pipeline-experiment'})
        if not result.get('prompt_id'):
            raise RuntimeError(str(result))
        (root/'score-submission.json').write_text(json.dumps(result, indent=2))
        deadline = time.monotonic()+1200
        while time.monotonic() < deadline:
            history = video_song.api(generator.DEFAULT_SERVER, '/history/'+result['prompt_id']).get(result['prompt_id'])
            if history:
                (root/'score-history.json').write_text(json.dumps(history, indent=2))
                for message in history.get('status', {}).get('messages', []):
                    if message[0] == 'execution_error':
                        raise RuntimeError(str(message[1].get('exception_message')))
                if history.get('status', {}).get('completed'):
                    audio = history.get('outputs', {}).get('save', {}).get('audio', [])
                    if not audio:
                        raise RuntimeError('Music3 completed without audio')
                    raw = video_song.OUTPUT/audio[0].get('subfolder', '')/audio[0]['filename']
                    partial = output.with_suffix('.partial.flac')
                    shutil.copy2(raw, partial); partial.replace(output)
                    receipt.write_text(json.dumps({'sha256': hashlib.sha256(output.read_bytes()).hexdigest(),
                        'spec_sha256': spec_hash, 'raw_source': str(raw), 'seconds': video_song.duration(output),
                        'prompt_id': result['prompt_id']}, indent=2))
                    print('COMPLETE', video_song.duration(output), flush=True)
                    return
            time.sleep(2)
        raise TimeoutError('Music composition timed out')
    finally:
        if process is not None:
            generator.stop_server(process, log)


if __name__ == '__main__':
    main()
