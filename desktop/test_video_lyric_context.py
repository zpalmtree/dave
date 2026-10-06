"""Verify broker-resolved song context reaches local fallback after leasing."""
from pathlib import Path
import tempfile
import unittest
from unittest import mock

import video_recovery as recovery


@unittest.skipUnless(hasattr(recovery, 'plan_locally'), 'Run against the installed desktop recovery implementation.')
class LyricContextTests(unittest.IsolatedAsyncioTestCase):
    async def test_current_context_replaces_stale_lease_guidance_without_mutating_the_job(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            original = {'id': 'fixture', 'prompt': 'Sing this song', 'planner_guidance': 'old persona'}
            current = 'persona\nresolved title and artist\nvocal timeline'
            for routed, expected in [({'planner_guidance': current}, current), ({}, 'old persona')]:
                worker = mock.Mock(cancel_reason=None)
                worker.ensure_gpu_reservation = mock.AsyncMock(return_value=True)
                worker.create_local_plan = mock.AsyncMock(return_value=(root / 'plan.json', {'intent': 'song'}))
                with mock.patch.object(recovery, 'release_recovery_reservation', mock.AsyncMock()) as release:
                    result = await recovery.plan_locally(worker, original, root,
                        {**routed, 'prompt_analysis': {'evidence': 'source'}}, root / 'log')
                self.assertEqual(result, {'intent': 'song'})
                passed = worker.create_local_plan.await_args.args
                self.assertEqual(passed[0]['planner_guidance'], expected)
                self.assertEqual(passed[0]['prompt'], original['prompt'])
                self.assertEqual(passed[3], {'evidence': 'source'})
                worker.ensure_gpu_reservation.assert_awaited_once()
                release.assert_awaited_once()
                self.assertEqual(original['planner_guidance'], 'old persona')


if __name__ == '__main__':
    unittest.main()
