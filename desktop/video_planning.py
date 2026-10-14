"""Local planning contracts and private diagnostics; no model or GPU work."""
import json
import math
import os
import re
import uuid
from pathlib import Path


PLANNING_EXHAUSTED = 'local_planning_exhausted'


def planning_exhausted(detail):
    return str(detail).startswith(PLANNING_EXHAUSTED + ':')


def runtime_constraint(prompt, explicit=None, *, number_spans=None):
    """Recognize total-runtime language, excluding quoted speech and beat timings.

    The API duration wins. A prompt range remains a range, not an exact endpoint.
    """
    if explicit is not None:
        return {'min_seconds': float(explicit), 'max_seconds': float(explicit), 'source': 'explicit'}
    text = re.sub(r'''"[^"\n]*"|“[^”\n]*”|(?<!\w)'[^'\n]*'(?!\w)''',
                  lambda m: ' ' * len(m[0]), str(prompt))
    text = re.sub('[‐‑‒–—]', '-', text)
    amount = r'(\d+(?:\.\d+)?)(?:\s*(?:-|to)\s*(\d+(?:\.\d+)?))?'
    unit = r'(seconds?|secs?|minutes?|mins?)'
    media = r'(?:video|clip|animation|timelapse|film|sequence|montage|short)'
    patterns = [
        rf'\b(?:make|keep)\s+(?:it|(?:the|this)\s+{media})\s+(?:exactly\s+)?{amount}\s*{unit}\b',
        rf'\b(?:total\s+)?(?:duration|runtime|length)\s*(?:of|=|:|is|be)?\s*{amount}\s*{unit}\b',
        rf'\b{media}\s+(?:with\s+)?(?:a\s+)?(?:total\s+)?(?:duration|runtime|length)?\s*(?:of|=|:|is|be|lasting|lasts|should\s+be|must\s+be)?\s*{amount}\s*{unit}\b',
        rf'(?<![\d.\-])\b{amount}\s*{unit}\s*(?:long|in\s+total|total|overall)\b',
        rf'(?<![\d.\-])\b{amount}\s*-?\s*{unit}\s+(?:(?:long|silent|animated)\s+)?{media}\b',
    ]
    for pattern in patterns:
        match = re.search(pattern, text, re.I)
        if match:
            scale = 60 if match[3].lower().startswith('min') else 1
            low, high = float(match[1]) * scale, float(match[2] or match[1]) * scale
            if 0 < low <= high and math.isfinite(high):
                if number_spans is not None:
                    number_spans.extend(match.span(i) for i in (1, 2) if match[i] is not None)
                return {'min_seconds': low, 'max_seconds': high, 'source': 'prompt'}
    return None


def timing_snapshot(plan, speech_estimator):
    rows = []
    for index, segment in enumerate(plan.get('segments', []) if isinstance(plan, dict) else []):
        if not isinstance(segment, dict):
            continue
        try:
            speech = speech_estimator(segment)
        except (TypeError, ValueError, AttributeError):
            speech = None
        rows.append({'segment_index': index + 1, 'target_seconds': segment.get('target_seconds'),
                     'output_seconds': segment.get('output_seconds', segment.get('target_seconds')),
                     'speech_estimate_seconds': speech})
    return rows


class PlanningDiagnostics:
    """Separate invocations, including recovery passes, never overwrite evidence.

    Stored only alongside private worker logs/plans; never uploaded to the broker.
    Windows inherits the worker directory ACL; POSIX files use mode 0600.
    """
    def __init__(self, root):
        self.root = Path(root) / uuid.uuid4().hex

    def reject(self, attempt, **record):
        try:
            self.root.mkdir(parents=True, exist_ok=True, mode=0o700)
            path = self.root / f'{attempt}.json'
            with os.fdopen(os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), 'w', encoding='utf-8') as stream:
                json.dump({'schema_version': 1, 'attempt': attempt, **record}, stream, ensure_ascii=False, indent=2)
            return True
        except (OSError, TypeError, ValueError):
            # Diagnostics must not hide the planning failure, or expose its content.
            print('WARNING: Could not save private planning diagnostics.', flush=True)
            return False


def mask_runtime_numbers(prompt, requested_duration=None):
    result = prompt
    while True:
        spans = []
        constraint = runtime_constraint(result, number_spans=spans)
        if constraint and requested_duration is not None and not (
                constraint["min_seconds"] <= requested_duration <= constraint["max_seconds"]):
            return result
        if not spans:
            return result
        for start, end in spans:
            result = result[:start] + ' ' * (end - start) + result[end:]
