"""Bounded CPU-only SyncNet sampling. Never redraws a face or loads a CUDA model."""
from __future__ import annotations

import argparse
import json
import math
import os
from pathlib import Path
import signal
from statistics import median
import subprocess
import sys
import tempfile
import threading
import time

WINDOW = 2.8
MIN_CONFIDENCE = 4.0
MAX_DISTANCE = 11.0
MAX_SHIFT_MS = 80


def choose_shift(samples):
    """Require all three temporal samples; tolerate at most two 25-fps frames of spread."""
    if len(samples) != 3:
        return 0
    offsets = []
    for sample in samples:
        values = [sample.get(key) for key in ('offset_ms', 'confidence', 'distance')]
        if not all(isinstance(v, (int, float)) and math.isfinite(v) for v in values):
            return 0
        offset, confidence, distance = values
        if confidence < MIN_CONFIDENCE or distance > MAX_DISTANCE or abs(offset) > MAX_SHIFT_MS:
            return 0
        if offset % 40:
            return 0
        offsets.append(offset)
    if max(offsets) - min(offsets) > 80 or min(offsets) < 0 < max(offsets):
        return 0
    return int(median(offsets))


def sample_starts(seconds):
    if not math.isfinite(seconds) or seconds < 3 * WINDOW:
        return []
    return [0.0, min(seconds * .45, seconds - 2 * WINDOW), min(seconds * .8, seconds - WINDOW)]


def analyze(video, seconds, work):
    # Set before importing torch; this job must never acquire a GPU or evict models.
    os.environ.update(CUDA_VISIBLE_DEVICES='', HF_HUB_OFFLINE='1', OMP_NUM_THREADS='4', MKL_NUM_THREADS='4')
    import torch
    import cv2
    torch.set_num_threads(4)
    torch.set_num_interop_threads(2)
    cv2.setNumThreads(1)
    checkout = Path(os.environ.get('LATENTSYNC_ROOT', '/mnt/d/AI/latentsync'))
    sys.path.insert(0, str(checkout))
    os.chdir(checkout)
    from eval.syncnet import SyncNetEval
    from eval.syncnet_detect import SyncNetDetector

    class SparseDetector(SyncNetDetector):
        def detect_face(self, frames_dir, facedet_scale=.25):
            files = sorted(Path(frames_dir).glob('*.jpg'))
            detections = []
            for index, path in enumerate(files):
                faces = []
                if index % 5 == 0 or index == len(files) - 1:
                    frame = cv2.cvtColor(cv2.imread(str(path)), cv2.COLOR_BGR2RGB)
                    boxes = self.s3f_detector.detect_faces(frame, conf_th=.9, scales=[facedet_scale])
                    faces = [dict(frame=index, bbox=b[:-1].tolist(), conf=float(b[-1])) for b in boxes]
                detections.append(faces)
            return detections

    detector = SparseDetector(device='cpu', detect_results_dir=str(work / 'detect'))
    scorer = SyncNetEval(device='cpu')
    scorer.loadParameters(str(checkout / 'checkpoints/auxiliary/syncnet_v2.model'))

    def score(start):
        clip = work / 'sample.mp4'
        subprocess.run(['ffmpeg', '-v', 'error', '-nostdin', '-y', '-ss', str(start), '-i', str(video),
                        '-t', str(WINDOW), '-threads', '2', '-c:v', 'libx264', '-preset', 'ultrafast',
                        '-crf', '18', '-c:a', 'aac', str(clip)], check=True)
        with torch.inference_mode():
            detector(video_path=str(clip), min_track=8)
            candidates = []
            for crop in sorted((work / 'detect/crop').glob('*.mp4')):
                # Very short tracks/cut fragments cannot establish a reliable offset.
                capture = cv2.VideoCapture(str(crop))
                frames = capture.get(cv2.CAP_PROP_FRAME_COUNT)
                capture.release()
                if frames < 50:
                    continue
                offset, distance, confidence = scorer.evaluate(str(crop), temp_dir=str(work / 'eval'), batch_size=10)
                if confidence >= MIN_CONFIDENCE and distance <= MAX_DISTANCE:
                    candidates.append(dict(offset_ms=offset * 40, confidence=confidence, distance=distance))
        # Multiple plausible speakers/tracks are ambiguous; do not average them.
        return dict(start_seconds=start, **candidates[0]) if len(candidates) == 1 else None

    starts = sample_starts(seconds)
    samples = [score(start) for start in starts]
    missing = [i for i, sample in enumerate(samples) if sample is None]
    # One extra window total, not an open-ended search for a supporting result.
    if len(missing) == 1:
        index = missing[0]
        retry = min(starts[index] + 1, seconds - WINDOW)
        if retry != starts[index] and all(abs(retry - start) >= WINDOW for i, start in enumerate(starts) if i != index):
            samples[index] = score(retry)
    return samples


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--video', type=Path, required=True)
    parser.add_argument('--result', type=Path, required=True)
    parser.add_argument('--seconds', type=float, required=True)
    parser.add_argument('--timeout', type=float, default=35)
    parser.add_argument('--exit-with-stdin', action='store_true')
    args = parser.parse_args()
    started = time.monotonic()
    # Private session also contains FFmpeg children launched by the upstream detector.
    if os.getpgrp() != os.getpid():
        os.setsid()
    result = {'action': 'none', 'shift_ms': 0, 'samples': []}
    def interrupted(*_):
        raise TimeoutError('sync analysis interrupted')
    signal.signal(signal.SIGTERM, interrupted)
    def stop():
        os.killpg(os.getpgrp(), signal.SIGTERM)
    timeout = min(35, max(1, args.timeout))
    timer = threading.Timer(timeout, stop)
    timer.daemon = True
    timer.start()
    hard_stop = threading.Timer(timeout + 2, lambda: os.killpg(os.getpgrp(), signal.SIGKILL))
    hard_stop.daemon = True
    hard_stop.start()
    if args.exit_with_stdin:
        def watch_parent():
            # Buffered stdin holds a Python lock during read and aborts interpreter
            # shutdown if this daemon is still waiting when successful analysis exits.
            while os.read(sys.stdin.fileno(), 1):
                pass
            stop()
        threading.Thread(target=watch_parent, daemon=True).start()
    try:
        if not sample_starts(args.seconds):
            result['reason'] = 'too_short'
        else:
            # Frame extraction stays on Linux storage, not the Windows temp drive.
            with tempfile.TemporaryDirectory(prefix='dave-avsync-') as temporary:
                result['samples'] = analyze(args.video.resolve(), args.seconds, Path(temporary))
            usable = [sample for sample in result['samples'] if sample is not None]
            shift = choose_shift(usable)
            result.update(action='shift' if shift else 'none', shift_ms=shift)
    except Exception as error:
        result.update(action='none', shift_ms=0, reason=type(error).__name__)
    result['seconds'] = round(time.monotonic() - started, 3)
    args.result.write_text(json.dumps(result, indent=2), encoding='utf-8')
    timer.cancel()
    hard_stop.cancel()


if __name__ == '__main__':
    main()
