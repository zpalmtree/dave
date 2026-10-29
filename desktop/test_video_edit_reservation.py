"""CPU-only worker regression: remote repaint must not retain GPU admission."""
import asyncio
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest import mock

from video_worker import DesktopVideoWorker, gpuq_reservation_identity


class EditReservationTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.job = {'id': 'edit', 'lease_id': 'broker-lease', 'video_edit_target': 'right',
                    'video_edit_isolated': True}
        self.worker = DesktopVideoWorker.__new__(DesktopVideoWorker)
        self.worker.gpuq_job_id = 'tracking-lease'
        self.worker.gpuq_control_dir = self.root / 'tracking'
        self.worker.gpuq_control_dir.mkdir()
        self.worker.gpuq_request_sequence = 1
        self.worker.journal = {'gpuq_job_id': 'tracking-lease', 'other': 'retained'}
        self.worker.cancel_reason = None
        self.worker.send = mock.AsyncMock()
        self.worker.add_span = mock.Mock()
        self.worker.save_journal = mock.Mock()
        self.worker.finish_gpuq_reservation = mock.AsyncMock()
        self.worker.stop_gpu_monitor = mock.AsyncMock()
        self.worker.request_video_edit_review = mock.AsyncMock()
        self.events = []

        async def command(argv):
            self.assertIsNotNone(self.worker.gpuq_job_id)
            work = self.root / 'viggle'
            if '--viggle-prepare' in argv:
                self.events.append('track')
                work.mkdir()
                (work / 'viggle.json').write_text(json.dumps({
                    'isolated': True, 'stills': [{'frame': 'frame-01.png'}],
                    'segments': [[0, 24, 24]],
                }))
            else:
                self.events.append('render')
                self.assertEqual(self.worker.gpuq_job_id, self.render_lease)
                (self.root / 'edited.mp4').write_bytes(b'fixture')
                (work / 'reviews.json').write_text('["review.json"]')
            return 0

        async def repaint(*args):
            self.events.append('repaint')
            # The previous successful result may expire after 60 seconds; it
            # must already be closed and forgotten before any remote wait.
            self.worker.finish_gpuq_reservation.assert_awaited_once()
            self.worker.stop_gpu_monitor.assert_awaited_once()
            self.assertIsNone(self.worker.gpuq_job_id)
            self.assertIsNone(self.worker.gpuq_control_dir)
            self.assertNotIn('gpuq_job_id', self.worker.journal)
            self.assertEqual(self.worker.journal['other'], 'retained')
            await asyncio.sleep(0)
            return self.root / 'still.png'

        async def admit(job):
            self.events.append('admit')
            self.assertNotEqual(gpuq_reservation_identity(job), gpuq_reservation_identity(self.job))
            self.assertIn('tracking-lease', job['gpuq_reservation_scope'])
            self.worker.gpuq_job_id = self.render_lease
            return True

        self.render_lease = 'new-render-lease'
        self.worker.run_reserved_command = mock.AsyncMock(side_effect=command)
        self.worker.request_video_edit_still = mock.AsyncMock(side_effect=repaint)
        self.worker.ensure_gpu_reservation = mock.AsyncMock(side_effect=admit)
        self.backend = mock.patch.dict(os.environ, {'VIDEO_EDIT_ISOLATED_RENDERER': 'viggle'})
        self.backend.start()
        self.addCleanup(self.backend.stop)

    async def run_edit(self):
        return await self.worker.run_viggle_edit(self.job, self.root / 'source.mp4',
            self.root / 'edited.mp4', self.root / 'error.txt', self.root,
            self.root / 'replacement.png', 'reference')

    async def test_repaint_yields_tracking_lease_and_render_uses_fresh_admission(self):
        self.assertEqual(await self.run_edit(), 0)
        self.assertEqual(self.events, ['track', 'repaint', 'admit', 'render'])
        self.worker.request_video_edit_review.assert_awaited_once()

    async def test_cancellation_during_repaint_does_not_reacquire_or_render(self):
        async def cancel(*args):
            self.worker.cancel_reason = 'user'
            return self.root / 'still.png'
        self.worker.request_video_edit_still.side_effect = cancel
        self.assertEqual(await self.run_edit(), 1)
        self.worker.ensure_gpu_reservation.assert_not_awaited()
        self.assertEqual(self.worker.run_reserved_command.await_count, 1)

    async def test_cancelled_queue_admission_does_not_render(self):
        self.worker.ensure_gpu_reservation.side_effect = None
        self.worker.ensure_gpu_reservation.return_value = False
        self.assertEqual(await self.run_edit(), 1)
        self.assertEqual(self.worker.run_reserved_command.await_count, 1)

    async def test_repaint_error_stays_visible_and_never_renders(self):
        self.worker.request_video_edit_still.side_effect = RuntimeError('repaint failed')
        self.assertEqual(await self.run_edit(), 1)
        self.assertIn('repaint failed', (self.root / 'error.txt').read_text())
        self.assertEqual(self.worker.run_reserved_command.await_count, 1)

    async def test_admission_failure_is_not_treated_as_render_success(self):
        self.worker.ensure_gpu_reservation.side_effect = RuntimeError('admission rejected')
        with self.assertRaisesRegex(RuntimeError, 'admission rejected'):
            await self.run_edit()
        self.assertEqual(self.worker.run_reserved_command.await_count, 1)

    async def test_local_wan_path_keeps_admission_without_a_remote_wait(self):
        os.environ['VIDEO_EDIT_ISOLATED_RENDERER'] = 'wan'
        self.render_lease = 'tracking-lease'
        self.assertEqual(await self.run_edit(), 0)
        self.assertEqual(self.events, ['track', 'render'])
        self.worker.finish_gpuq_reservation.assert_not_awaited()
        self.worker.ensure_gpu_reservation.assert_not_awaited()
        self.worker.request_video_edit_still.assert_not_awaited()


if __name__ == '__main__':
    unittest.main()
