"""CPU-only regressions for edit backend availability and managed cold starts."""
import io
import json
from pathlib import Path
import tempfile
import types
import unittest
from unittest import mock
import urllib.error

import video_edit as edit
import video_worker as worker_module


class BackendPollingTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.output = self.root / 'mask.mp4'
        self.output.write_bytes(b'mask')
        self.completed = {'prompt': {'status': {'completed': True},
            'outputs': {'mask': {'videos': [{'filename': 'mask.mp4'}]}}}}
        self.now = 0
        for patcher in (mock.patch.object(edit, 'OUTPUT', self.root),
                        mock.patch.object(edit.time, 'monotonic', side_effect=lambda: self.now),
                        mock.patch.object(edit.time, 'sleep', side_effect=self.advance)):
            patcher.start()
            self.addCleanup(patcher.stop)

    def advance(self, seconds):
        self.now += seconds

    def run_graph(self, timeout=120):
        return edit.run_graph_outputs('http://comfy', {}, ['mask'], timeout)

    def test_slow_status_read_retries_same_prompt_without_resubmission(self):
        with mock.patch.object(edit, 'api', side_effect=[{'prompt_id': 'prompt'},
                edit.ComfyUnavailableError('ComfyUI unavailable: timed out'), self.completed]) as api:
            self.assertEqual(self.run_graph(), [self.output])
        self.assertEqual([c.args[1] for c in api.call_args_list],
                         ['/prompt', '/history/prompt', '/history/prompt'])

    def test_dead_backend_stops_after_three_failed_reads(self):
        with mock.patch.object(edit, 'api', side_effect=[{'prompt_id': 'prompt'}] +
                [edit.ComfyUnavailableError('ComfyUI unavailable: connection refused')] * 3) as api:
            with self.assertRaisesRegex(edit.ComfyUnavailableError, 'connection refused'):
                self.run_graph()
        self.assertEqual(api.call_count, 4)

    def test_successful_read_resets_transport_failure_budget(self):
        failed = edit.ComfyUnavailableError('ComfyUI unavailable: timed out')
        with mock.patch.object(edit, 'api', side_effect=[{'prompt_id': 'prompt'},
                failed, failed, {}, failed, self.completed]):
            self.assertEqual(self.run_graph(), [self.output])

    def test_status_request_and_sleep_cannot_extend_overall_deadline(self):
        def api(server, route, *args, **kwargs):
            if route == '/prompt':
                return {'prompt_id': 'prompt'}
            self.assertEqual(kwargs['timeout'], 2)
            self.advance(kwargs['timeout'])
            raise edit.ComfyUnavailableError('ComfyUI unavailable: timed out')
        with mock.patch.object(edit, 'api', side_effect=api):
            with self.assertRaisesRegex(TimeoutError, 'video replacement timed out'):
                self.run_graph(timeout=2)
        self.assertEqual(self.now, 2)

    def test_execution_failure_is_not_retried(self):
        failed = {'prompt': {'status': {'messages': [
            ['execution_error', {'exception_message': 'invalid model'}]]}}}
        with mock.patch.object(edit, 'api', side_effect=[{'prompt_id': 'prompt'}, failed]) as api:
            with self.assertRaisesRegex(RuntimeError, 'invalid model'):
                self.run_graph()
        self.assertEqual(api.call_count, 2)

    def test_transport_errors_are_retryable_only_for_reads(self):
        for error in (TimeoutError('timed out'), ConnectionResetError('reset'),
                      urllib.error.URLError('connection refused')):
            with self.subTest(error=error), mock.patch.object(edit.urllib.request, 'urlopen', side_effect=error):
                with self.assertRaises(edit.ComfyUnavailableError):
                    edit.api('http://comfy', '/history/prompt')
                with self.assertRaisesRegex(RuntimeError, 'submission status unknown') as caught:
                    edit.api('http://comfy', '/prompt', {})
                self.assertNotIsInstance(caught.exception, edit.ComfyUnavailableError)
                self.assertFalse(worker_module.retryable_video_edit_error(str(caught.exception)))

    def test_http_rejection_is_not_a_transient_transport_failure(self):
        error = urllib.error.HTTPError('http://comfy', 400, 'bad graph', {}, io.BytesIO(b'invalid input'))
        with mock.patch.object(edit.urllib.request, 'urlopen', side_effect=error):
            with self.assertRaisesRegex(RuntimeError, 'invalid input') as caught:
                edit.api('http://comfy', '/history/prompt')
        self.assertNotIsInstance(caught.exception, edit.ComfyUnavailableError)

    def test_retry_classification_excludes_content_and_unknown_submissions(self):
        for detail in ['ComfyUI unavailable: status request failed',
                       'Timed out waiting for http://127.0.0.1:8188/system_stats.']:
            self.assertTrue(worker_module.retryable_video_edit_error(detail), detail)
        for detail in ['Could not reliably isolate the cat', 'Replacement failed its source-performance check',
                       'ComfyUI submission status unknown for /prompt: timed out',
                       'ComfyUI video replacement timed out', 'Gaming Mode preempted the job']:
            self.assertFalse(worker_module.retryable_video_edit_error(detail), detail)


class BackendAdmissionTests(unittest.IsolatedAsyncioTestCase):
    async def test_only_source_edits_request_cold_managed_backends(self):
        with tempfile.TemporaryDirectory() as temporary:
            for source_video in (True, False):
                worker = worker_module.DesktopVideoWorker.__new__(worker_module.DesktopVideoWorker)
                worker.gpuq_job_id = None
                worker.gpuq_control_dir = None
                worker.save_journal = mock.Mock()
                worker.wait_for_gpu_reservation = mock.AsyncMock(return_value=True)
                response = types.SimpleNamespace(returncode=0, stdout=json.dumps({'id': 'gpu-lease'}))
                with mock.patch.object(worker_module, 'GPUQ_RESERVATION_DIR', Path(temporary)), \
                        mock.patch.object(worker_module.subprocess, 'run', return_value=response) as submit:
                    self.assertTrue(await worker.reserve_gpu({
                        'id': 'job', 'lease_id': 'lease', 'has_source_video': source_video}))
                argv = submit.call_args.args[0]
                self.assertEqual('--evict-cache-before-run' in argv, source_video)
                self.assertEqual(argv[argv.index('--when-gaming') + 1], 'hold')
                self.assertEqual(argv[argv.index('--on-preempt') + 1], 'fail')


if __name__ == '__main__':
    unittest.main()
