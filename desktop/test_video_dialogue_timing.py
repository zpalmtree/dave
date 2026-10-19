"""CPU-only parity check against the installed desktop generator.

Run from the desktop Python with video_gen on sys.path. The same fixture is
checked by tests/video-recovery.test.mjs before the broker approves a plan.
"""
import json
from pathlib import Path
import unittest

import video_gen


class DialogueTimingTests(unittest.TestCase):
    def test_broker_and_renderer_share_dialogue_estimates(self):
        fixture = Path(__file__).resolve().parents[1] / 'tests/fixtures/video-dialogue-timing.json'
        for case in json.loads(fixture.read_text(encoding='utf-8')):
            with self.subTest(case=case['name']):
                actual = video_gen.dialogue_floor_seconds({'shots': [{'dialogue': case['lines']}]})
                self.assertAlmostEqual(actual, case['seconds'], places=9)


if __name__ == '__main__':
    unittest.main()
