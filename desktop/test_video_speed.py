"""Offline regression tests for recovery preparation and ETA startup."""
import asyncio
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))
import video_gen
from video_recovery import OpeningPrefetch


class TimingHistoryTests(unittest.TestCase):
    def test_log_avoids_the_render_tree_and_survives_interrupted_records(self):
        with tempfile.TemporaryDirectory() as tmp:
            history = Path(tmp) / 'history.jsonl'
            sample = {'model': 'h3', 'mode': 'i2v', 'quality': 'final', 'duration': 5, 'runtime': 100}
            other = {**sample, 'runtime': 110}
            history.write_text('\n'.join([json.dumps(sample), '{truncated', 'null',
                json.dumps(other), json.dumps(sample)]))
            with mock.patch.object(video_gen, 'TIMING_HISTORY', history), mock.patch.object(Path, 'rglob',
                    side_effect=AssertionError('The hot path must not scan old outputs')):
                self.assertEqual(video_gen.load_legacy_timing_samples(), [other, sample])

    def test_missing_log_retains_legacy_manifest_fallback(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            folder = root / 'video' / 'generated'
            folder.mkdir(parents=True)
            (folder / 'one.generation.json').write_text(json.dumps({'model': 'h3',
                'duration_effective': 5, 'timing': {'total_seconds': 100}}))
            with mock.patch.object(video_gen, 'TIMING_HISTORY', root / 'missing'), mock.patch.object(video_gen, 'OUTPUT_DIR', root):
                self.assertEqual(video_gen.load_legacy_timing_samples()[0]['runtime'], 100)


class PrefetchTests(unittest.IsolatedAsyncioTestCase):
    async def test_cut_opening_starts_early_and_survives_resume_without_another_call(self):
        with tempfile.TemporaryDirectory() as tmp:
            entered, finish = asyncio.Event(), asyncio.Event()
            async def request(operation, body):
                self.assertEqual(operation, 'image')
                self.assertEqual(body['identity_anchor'], 'original')
                entered.set()
                await finish.wait()
                return {'image': 'fixture'}
            root = Path(tmp)
            identity = {'identity_anchor': 'original'}
            request = mock.AsyncMock(side_effect=request)
            prefetch = OpeningPrefetch(root, 'contract', 0, request)
            segments = [{'transition': 'start'}, {'transition': 'cut'}]
            prefetch.start(1, segments, {}, identity)
            await asyncio.wait_for(entered.wait(), 1)
            self.assertFalse(prefetch.pending.done(), 'Cloud work is in flight before the next scene is consumed.')
            finish.set()
            self.assertEqual(await prefetch.take(1, identity), {'image': 'fixture'})
            resumed = OpeningPrefetch(root, 'contract', 0, request)
            self.assertEqual(await resumed.take(1, identity), {'image': 'fixture'})
            self.assertEqual(request.await_count, 1)
            self.assertIsNone(OpeningPrefetch(root, 'contract', 1, request).cached(1, identity))
            self.assertIsNone(resumed.cached(1, {'identity_anchor': 'changed'}))

    async def test_continuation_is_not_speculated_and_outages_do_not_cache_a_failure(self):
        with tempfile.TemporaryDirectory() as tmp:
            request = mock.AsyncMock(side_effect=RuntimeError('offline'))
            p = OpeningPrefetch(Path(tmp), 'contract', 0, request)
            p.start(1, [{'transition': 'start'}, {'transition': 'continue'}], {}, {})
            self.assertIsNone(p.pending)
            p.start(1, [{'transition': 'start'}, {'transition': 'cut'}], {}, {})
            with self.assertRaisesRegex(RuntimeError, 'offline'):
                await p.take(1, {})
            self.assertIsNone(p.cached(1, {}))
            await p.close()

    async def test_local_directive_is_cached_without_launching_gpu_work(self):
        with tempfile.TemporaryDirectory() as tmp:
            directive = {'local_image_required': True, 'keyframe': {'prompt': 'A duck'}}
            request = mock.AsyncMock(return_value=directive)
            p = OpeningPrefetch(Path(tmp), 'contract', 0, request)
            p.start(1, [{'transition': 'start'}, {'transition': 'cut'}], {}, {})
            self.assertEqual(await p.take(1, {}), directive)
            self.assertEqual(request.await_count, 1)

    async def test_closing_cancels_owned_preparation(self):
        with tempfile.TemporaryDirectory() as tmp:
            request = mock.AsyncMock(side_effect=lambda *_: None)
            p = OpeningPrefetch(Path(tmp), 'contract', 0, request)
            p.start(1, [{'transition': 'start'}, {'transition': 'cut'}], {}, {})
            task = p.pending
            await p.close()
            self.assertTrue(task.cancelled())


if __name__ == '__main__':
    unittest.main()
