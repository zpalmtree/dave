"""CPU-only coverage for shared scene reservations and bounded idle release."""
import asyncio
from pathlib import Path
import sys
import tempfile
import types
import unittest
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))
from video_recovery import SceneGpuReservation


class ReservationTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.worker = types.SimpleNamespace(cancel_reason=None, journal={}, gpuq_job_id=None,
            gpuq_control_dir=None, save_journal=mock.Mock(), stop_gpu_monitor=mock.AsyncMock(),
            finish_gpuq_reservation=mock.AsyncMock())
        self.submissions = []

        async def admit(job):
            if self.worker.gpuq_job_id is None:
                self.submissions.append(job['scope'])
                self.worker.gpuq_job_id = f'lease-{len(self.submissions)}'
            return True
        self.worker.ensure_gpu_reservation = mock.AsyncMock(side_effect=admit)
        self.reservation = SceneGpuReservation(self.worker, idle_seconds=0.02)

    async def asyncTearDown(self):
        await self.reservation.stop_idle()

    async def test_ready_scenes_share_one_reservation_and_release_before_delivery(self):
        await self.reservation.acquire({'scope': 'first'})
        first = self.worker.gpuq_job_id
        self.reservation.idle()
        await self.reservation.acquire({'scope': 'second'})
        self.assertEqual(self.worker.gpuq_job_id, first)
        # The old idle timer must not release a new render, even a long one.
        await asyncio.sleep(0.04)
        self.worker.finish_gpuq_reservation.assert_not_awaited()
        await self.reservation.release()
        self.assertIsNone(self.worker.gpuq_job_id)
        self.assertEqual(self.submissions, ['first'])
        self.worker.finish_gpuq_reservation.assert_awaited_once()

    async def test_stalled_preparation_releases_then_requeues_with_new_scope(self):
        await self.reservation.acquire({'scope': 'first'})
        self.reservation.idle()
        await self.reservation.idle_task
        self.assertIsNone(self.worker.gpuq_job_id)
        await self.reservation.acquire({'scope': 'second'})
        self.assertEqual(self.submissions, ['first', 'second'])
        await self.reservation.release()

    async def test_expiring_release_finishes_before_next_admission(self):
        releasing, finish = asyncio.Event(), asyncio.Event()
        async def slow_release():
            releasing.set()
            await finish.wait()
        self.worker.finish_gpuq_reservation.side_effect = slow_release
        await self.reservation.acquire({'scope': 'first'})
        self.reservation.idle()
        await asyncio.wait_for(releasing.wait(), 1)
        next_scene = asyncio.create_task(self.reservation.acquire({'scope': 'second'}))
        await asyncio.sleep(0)
        self.assertFalse(next_scene.done())
        finish.set()
        self.assertTrue(await next_scene)
        self.assertEqual(self.submissions, ['first', 'second'])
        await self.reservation.release()

    async def test_idle_release_failure_is_observed_before_reuse_or_delivery(self):
        self.worker.finish_gpuq_reservation.side_effect = RuntimeError('gpuq unavailable')
        await self.reservation.acquire({'scope': 'first'})
        self.reservation.idle()
        await self.reservation.idle_task
        with self.assertRaisesRegex(RuntimeError, 'idle GPU reservation'):
            await self.reservation.acquire({'scope': 'second'})
        with self.assertRaisesRegex(RuntimeError, 'idle GPU reservation'):
            await self.reservation.release()
        self.assertEqual(self.submissions, ['first'])

    async def test_failure_cleanup_stops_timer_before_worker_cancels_lease(self):
        await self.reservation.acquire({'scope': 'first'})
        self.reservation.idle()
        await self.reservation.stop_idle()
        self.worker.gpuq_job_id = None  # normal worker failure/cancel cleanup
        await asyncio.sleep(0.04)
        self.worker.finish_gpuq_reservation.assert_not_awaited()

    async def test_local_fallback_releases_grace_before_acquiring_its_own_lease(self):
        await self.reservation.acquire({'scope': 'first'})
        self.reservation.idle()
        await self.reservation.release()
        await self.worker.ensure_gpu_reservation({'scope': 'local-opening'})
        await asyncio.sleep(0.04)
        self.assertEqual(self.worker.gpuq_job_id, 'lease-2')
        self.worker.finish_gpuq_reservation.assert_awaited_once()

    async def test_user_cancellation_does_not_acquire_again(self):
        await self.reservation.acquire({'scope': 'first'})
        self.reservation.idle()
        self.worker.cancel_reason = 'user'
        with self.assertRaises(asyncio.CancelledError):
            await self.reservation.acquire({'scope': 'second'})
        self.worker.ensure_gpu_reservation.assert_awaited_once()
        self.assertIsNone(self.reservation.idle_task)

    async def test_preempted_lease_cannot_be_reused(self):
        await self.reservation.acquire({'scope': 'first'})
        self.reservation.idle()
        self.worker.ensure_gpu_reservation.side_effect = RuntimeError('Gaming Mode preempted the job')
        with self.assertRaisesRegex(RuntimeError, 'Gaming Mode'):
            await self.reservation.acquire({'scope': 'second'})
        self.assertIsNone(self.reservation.idle_task)

    async def test_queue_wait_is_recorded_once_per_admission(self):
        from video_worker import DesktopVideoWorker
        worker = DesktopVideoWorker.__new__(DesktopVideoWorker)
        with tempfile.TemporaryDirectory() as temporary:
            worker.gpuq_control_dir = Path(temporary)
            (worker.gpuq_control_dir / 'ready.json').write_text('{}')
            worker.gpuq_job_id = 'lease'
            worker.cancel_reason = None
            worker.journal = {'gpuq_submitted_at': 100}
            worker.save_journal = lambda **fields: worker.journal.update(fields)
            worker.gpuq_json = mock.AsyncMock(return_value={
                'state': 'running', 'startedAtUnixMs': 120000})
            worker.add_span = mock.Mock()
            worker.gpu_task = None
            worker.start_gpu_monitor = mock.Mock(side_effect=lambda: setattr(worker, 'gpu_task', object()))
            worker.send = mock.AsyncMock()
            self.assertTrue(await worker.wait_for_gpu_reservation({'id': 'job'}))
            self.assertTrue(await worker.wait_for_gpu_reservation({'id': 'job'}))
            worker.add_span.assert_called_once_with('worker', 'gpu_queue_wait', 20)
            worker.send.assert_awaited_once()
            worker.start_gpu_monitor.assert_called_once()
            worker.gpuq_json.return_value = {'state': 'failed', 'detail': 'Gaming Mode'}
            with self.assertRaisesRegex(RuntimeError, 'Gaming Mode'):
                await worker.wait_for_gpu_reservation({'id': 'job'})


if __name__ == '__main__':
    unittest.main()
