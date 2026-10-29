"""CPU-only coverage for broker restarts during source-edit repaint requests."""
import asyncio
from pathlib import Path
import tempfile
import unittest
from unittest import mock
import aiohttp
import video_worker as module


class RepaintRetryTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.worker = module.DesktopVideoWorker.__new__(module.DesktopVideoWorker)
        self.worker.cancel_reason = None
        self.worker.request_video_edit_still_once = mock.AsyncMock()
        self.args = ({'id': 'job'}, Path('frame.png'), Path('still.png'), 2)

    async def test_restart_retries_same_shot_and_recovers_after_backoff(self):
        self.worker.request_video_edit_still_once.side_effect = [
            module.VideoEditServiceUnavailable('HTTP 502'), aiohttp.ServerDisconnectedError(),
            module.VideoEditServiceUnavailable('HTTP 503'), Path('still.png')]
        with mock.patch.object(module.asyncio, 'sleep', new_callable=mock.AsyncMock) as sleep:
            self.assertEqual(await self.worker.request_video_edit_still(*self.args), Path('still.png'))
        self.assertEqual(sleep.await_args_list, [mock.call(5), mock.call(10), mock.call(20)])
        self.assertEqual(self.worker.request_video_edit_still_once.await_args_list, [mock.call(*self.args)] * 4)

    async def test_persistent_outage_is_bounded(self):
        self.worker.request_video_edit_still_once.side_effect = module.VideoEditServiceUnavailable('HTTP 502')
        with mock.patch.object(module.asyncio, 'sleep', new_callable=mock.AsyncMock), \
                self.assertRaises(module.VideoEditServiceUnavailable):
            await self.worker.request_video_edit_still(*self.args)
        self.assertEqual(self.worker.request_video_edit_still_once.await_count, 4)

    async def test_content_errors_and_provider_timeouts_are_not_retried(self):
        for error in [RuntimeError('provider refused this image'), asyncio.TimeoutError(),
                      aiohttp.ServerTimeoutError('timed out')]:
            self.worker.request_video_edit_still_once.reset_mock()
            self.worker.request_video_edit_still_once.side_effect = error
            with self.assertRaises(type(error)):
                await self.worker.request_video_edit_still(*self.args)
            self.worker.request_video_edit_still_once.assert_awaited_once()

    async def test_cancellation_during_backoff_prevents_next_request(self):
        self.worker.request_video_edit_still_once.side_effect = module.VideoEditServiceUnavailable('HTTP 502')
        async def cancel(_):
            self.worker.cancel_reason = 'user'
        with mock.patch.object(module.asyncio, 'sleep', side_effect=cancel), \
                self.assertRaisesRegex(RuntimeError, 'cancelled'):
            await self.worker.request_video_edit_still(*self.args)
        self.worker.request_video_edit_still_once.assert_awaited_once()

    async def test_gateway_errors_are_distinct_from_content_rejections(self):
        with tempfile.TemporaryDirectory() as temporary:
            frame = Path(temporary) / 'frame.png'
            frame.write_bytes(b'frame')
            self.worker.broker_url = 'wss://broker/v1/worker'
            self.worker.worker_headers = mock.Mock(return_value={})
            for status in (502, 503, 504, 400, 403):
                response = mock.AsyncMock(status=status)
                response.text.return_value = ''
                context = mock.MagicMock()
                context.__aenter__ = mock.AsyncMock(return_value=response)
                context.__aexit__ = mock.AsyncMock(return_value=False)
                self.worker.http_session = mock.Mock()
                self.worker.http_session.post.return_value = context
                with self.assertRaises(RuntimeError) as caught:
                    await module.DesktopVideoWorker.request_video_edit_still_once(
                        self.worker, {'id': 'job'}, frame, frame.with_name('still.png'))
                self.assertEqual(isinstance(caught.exception, module.VideoEditServiceUnavailable),
                                 status in (502, 503, 504))


if __name__ == '__main__':
    unittest.main()
