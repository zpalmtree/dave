import asyncio
import copy
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import types
import unittest
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))
import gpuq_settings
import video_recovery as recovery


class RecoveryTests(unittest.TestCase):
    def test_generator_imports_with_isolated_windows_python(self):
        generator = Path(__file__).resolve().parent / 'video_gen.py'
        if not generator.is_file():
            self.skipTest('Run on installed desktop sources.')
        source = ('import importlib.util,sys; '
                  f's=importlib.util.spec_from_file_location("isolated_video_gen", {str(generator)!r}); '
                  'm=importlib.util.module_from_spec(s); sys.modules[s.name]=m; s.loader.exec_module(m); '
                  'assert m.LLAMA_CPP_MODEL.is_file()')
        subprocess.run([sys.executable, '-s', '-c', source], check=True, capture_output=True, timeout=30)

    def test_qwen_preflight_checks_shared_paths(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            config = root / 'config.json'
            paths = {key: str(root / key) for key in ['QwenExecutable', 'QwenModel', 'QwenVisionProjector']}
            config.write_text(json.dumps(paths))
            self.assertFalse(gpuq_settings.qwen_preflight(config)['available'])
            for path in paths.values(): Path(path).write_bytes(b'fixture')
            self.assertTrue(gpuq_settings.qwen_preflight(config)['available'])

    def test_original_portrait_is_reused_without_generating_a_replacement(self):
        self.exercise(original=True)

    def test_continuation_uses_previous_video_frame(self):
        self.exercise(original=True, continuation=True)

    def test_authored_cut_gets_a_new_opening_instead_of_inheriting_a_closeup_of_other_subjects(self):
        self.exercise(original=True, continuation=True, authored_cut=True)

    def test_gpu_reservation_is_idempotent_per_attempt_but_distinct_across_attempts(self):
        if not (Path(__file__).resolve().parent / 'video_worker.py').is_file():
            self.skipTest('Run on installed desktop sources.')
        from video_worker import gpuq_reservation_identity
        job = {'id': 'job', 'lease_id': 'lease', 'gpuq_reservation_scope': 'scene-0-attempt-1'}
        self.assertEqual(gpuq_reservation_identity(job), gpuq_reservation_identity(dict(job)))
        self.assertNotEqual(gpuq_reservation_identity(job), gpuq_reservation_identity({**job,
            'gpuq_reservation_scope': 'scene-0-attempt-2'}))

    def test_one_targeted_retry_then_alternate_renderer(self):
        self.exercise(render_failures=2)

    def test_all_renderers_failing_defers_without_uploading_a_storyboard(self):
        self.exercise(render_failures=4)

    def test_image_service_outage_defers_without_a_placeholder(self):
        self.exercise(image_outage=True)

    def test_review_outage_preserves_rendered_video(self):
        self.exercise(review_outage=True)

    def test_upload_outage_preserves_rendered_video(self):
        self.exercise(upload_outage=True)

    def test_admission_outage_does_not_consume_an_attempt(self):
        self.exercise(admission_outage=True)

    def test_bad_response_is_diagnostic_instead_of_none_attribute_error(self):
        self.exercise(image_outage=True, invalid_response=True)

    def exercise(self, original=False, render_failures=0, image_outage=False,
                 review_outage=False, upload_outage=False, admission_outage=False, invalid_response=False, continuation=False, authored_cut=False):
        from PIL import Image
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / 'source.png'
            Image.new('RGB', (256, 144), 'blue').save(source)
            encoded = recovery.data_image(source)
            candidate = root / 'candidate.mp4'
            recovery.media_command(['-f', 'lavfi', '-i', 'testsrc2=size=256x144:rate=12',
                '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo', '-t', '1',
                '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', str(candidate)])
            segment = {'title': 'Wave', 'transition': 'start', 'target_seconds': 5,
                'shots': [{'visual': 'A duck turns toward the camera.', 'camera': 'Wide',
                           'audio': 'Wind', 'duration_seconds': 5, 'dialogue': []}]}
            prepared = {'contract_hash': 'a' * 64, 'notice': '', 'plan': {
                'keyframe': {'recommended': not original}, 'segments': [segment]},
                'sources': [encoded] if original else []}
            if continuation:
                prepared['plan']['segments'].append({**copy.deepcopy(segment), 'transition': 'continue'})
                if authored_cut: prepared['plan']['segments'][1]['shots'][0]['visual'] = 'Cut to a closeup of the duck waving.'
            state, calls, renderers, reservation_scopes = {}, [], [], set()
            outages = {'review': review_outage, 'admission': admission_outage}

            class Response:
                status = 200
                async def __aenter__(self): return self
                async def __aexit__(self, *args): pass
                async def json(self, **kwargs): return self.value

            class Session:
                def post(self, url, json, **kwargs):
                    operation = url.rsplit('/', 1)[-1]
                    calls.append((operation, copy.deepcopy(json)))
                    result = Response()
                    if operation == 'plan': result.value = {**prepared, 'checkpoint': copy.deepcopy(state)}
                    elif operation == 'checkpoint': state.update(copy.deepcopy(json['checkpoint'])); result.value = {'ok': True}
                    elif operation == 'image':
                        result.status = 503 if image_outage else 200
                        result.value = (None if invalid_response else {'error': 'provider offline'}) if image_outage else {'image': encoded}
                    elif operation == 'review':
                        if json['kind'] == 'video' and outages['review']:
                            outages['review'] = False
                            result.status = 503
                            result.value = {'error': 'review offline'}
                        else: result.value = {'acceptable': True, 'permitted': True, 'issues': []}
                    else: result.value = {'ok': True}
                    return result

            worker = types.SimpleNamespace(broker_url='wss://test/v1/worker', http_session=Session(),
                cancel_reason=None, journal={}, worker_headers=lambda: {}, begin_metrics=mock.Mock(),
                save_journal=mock.Mock(), send=mock.AsyncMock(), ensure_gpu_reservation=mock.AsyncMock(),
                run_reserved_command=mock.AsyncMock(side_effect=[1] * render_failures + [0] * 4),
                find_output=mock.Mock(return_value=candidate), finish_gpuq_reservation=mock.AsyncMock(),
                stop_gpu_monitor=mock.AsyncMock(), prepare_delivery=mock.AsyncMock(side_effect=lambda path, *_args: path),
                upload=mock.AsyncMock(side_effect=RuntimeError('upload offline') if upload_outage else None),
                wait_and_send_terminal=mock.AsyncMock(), clear_journal=mock.Mock(), send_ready=mock.AsyncMock(),
                fail_current=mock.AsyncMock(), finish_cancelled_job=mock.AsyncMock())
            async def admit(job):
                if outages['admission']:
                    outages['admission'] = False
                    raise RuntimeError('admission temporarily unavailable')
                self.assertIsNone(getattr(worker, 'gpuq_job_id', None), 'Completed reservation reused')
                scope = job['gpuq_reservation_scope']
                self.assertNotIn(scope, reservation_scopes, 'Completed idempotency key reused')
                reservation_scopes.add(scope)
                worker.gpuq_job_id = 'fresh-reservation'
                worker.journal['gpuq_job_id'] = worker.gpuq_job_id
                renderers.append(job['model'])
                return True
            worker.ensure_gpu_reservation.side_effect = admit
            fake = types.SimpleNamespace(SCRIPT_DIR=root, MODEL_ARGS={'minimax': ['--model', 'h3'], 'ltx': ['--model', 'ltx']},
                GENERATOR=root / 'generator.py', console_python_executable=lambda: sys.executable,
                atomic_json=lambda path, value: path.write_text(json.dumps(value, ensure_ascii=False), encoding='utf-8'), stable_job_seed=lambda _: 1)
            with mock.patch.dict(sys.modules, {'video_worker': fake}):
                job = {'id': 'test-job', 'model': 'minimax', 'recovery_revision': 0}
                asyncio.run(recovery.run_recovery_job(worker, job))
                if image_outage or render_failures == 4:
                    worker.fail_current.assert_awaited_once()
                    worker.upload.assert_not_awaited()
                    worker.wait_and_send_terminal.assert_not_awaited()
                    self.assertFalse(any(body.get('format') == 'storyboard' for _, body in calls))
                    if invalid_response: self.assertIn('503', worker.fail_current.await_args.args[0])
                    if render_failures == 4: self.assertEqual(renderers, ['minimax', 'minimax', 'ltx', 'ltx'])
                    return
                if review_outage or upload_outage or admission_outage:
                    worker.fail_current.assert_awaited_once()
                    before = worker.run_reserved_command.await_count
                    if admission_outage:
                        self.assertEqual(state['scenes']['0'].get('video_attempts', 0), 0)
                    worker.upload.side_effect = None
                    if review_outage:
                        checkpoint = root / 'worker_recovery/test-job/checkpoint.json'
                        stored = json.loads(checkpoint.read_text(encoding='utf-8'))
                        stored['feedback_note'] = '\u201cUnicode feedback\u201d'
                        checkpoint.write_text(json.dumps(stored, ensure_ascii=False), encoding='utf-8')
                    asyncio.run(recovery.run_recovery_job(worker, job))
                    self.assertEqual(worker.run_reserved_command.await_count, before + int(admission_outage))
                worker.wait_and_send_terminal.assert_awaited_once()
                self.assertEqual(state['format'], 'generated')
                if original: self.assertEqual(sum(operation == 'image' for operation, _ in calls), int(authored_cut))
                if continuation:
                    if not authored_cut: self.assertEqual(state['scenes']['1']['image_source'], 'continuation')
                    self.assertEqual(worker.run_reserved_command.await_count, 2)
                if render_failures == 2: self.assertEqual(renderers, ['minimax', 'minimax', 'ltx'])
                self.assertGreater(recovery.duration(root / 'worker_recovery/test-job/final.mp4'), 0)


if __name__ == '__main__':
    unittest.main()
