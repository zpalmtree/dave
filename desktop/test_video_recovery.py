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

    def test_one_targeted_retry_can_succeed(self):
        self.exercise(render_failures=1)

    def test_second_failed_render_stops_without_uploading_a_storyboard(self):
        self.exercise(render_failures=2)

    def test_render_budget_survives_restart_and_stops_before_more_gpu_work(self):
        self.exercise(render_failures=2, restart_exhausted=True)

    def test_final_attempt_review_outage_does_not_rerender(self):
        self.exercise(render_failures=1, review_outage=True)

    def test_mouthless_h3_prompt_preserves_robot_anatomy_with_full_speech(self):
        if not (Path(__file__).resolve().parent / 'video_gen.py').is_file():
            self.skipTest('Run on installed desktop sources.')
        from video_gen import compile_h3_prompt
        line = {'speaker_id': 'John', 'language': 'Spanish', 'delivery': 'electronic speaker',
                'text': 'mae Luis libereme, necesito cotizar mae, saqueme de aqui'}
        segment = {'music': 'N/A', 'shots': [
            {'visual': 'The mouthless robot walks to the closed bars.', 'camera': 'Wide',
             'audio': 'Footsteps', 'duration_seconds': 5, 'dialogue': []},
            {'visual': 'John remains mouthless and speaks through the neck speaker.', 'camera': 'Close-up',
             'audio': 'Room tone', 'duration_seconds': 8, 'dialogue': [line]}]}
        prompt = compile_h3_prompt(segment, True)
        self.assertIn(line['text'], prompt)
        self.assertIn('rigid mouthless face', prompt)
        self.assertNotIn('natural lip and jaw articulation', prompt)
        self.assertNotIn('Natural speech articulation retains', prompt)
        self.assertNotIn('every speaker keeps their mouth closed', prompt)
        self.assertIn('At 00:05.000', prompt)
        speaking_shot = segment['shots'][1]
        for visual in ['No mouth movement until the line begins.', 'Wait without mouth animation, then speak.']:
            segment['shots'] = [{**speaking_shot, 'visual': visual}]
            human = compile_h3_prompt(segment, True)
            self.assertIn('natural lip and jaw articulation', human)
            self.assertNotIn('rigid mouthless face', human)

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

    def test_frontier_rejection_is_planned_and_composed_locally(self):
        calls, commands, scopes = self.exercise_local()
        operations = [operation for operation, _ in calls]
        self.assertEqual(operations[:2], ['plan', 'local-plan'])
        self.assertEqual(calls[1][1]['plan']['intent'], 'local plan')
        self.assertIn('image', operations)
        recorded = [body for operation, body in calls if operation == 'review']
        self.assertEqual(sorted(body['kind'] for body in recorded), ['image', 'video'])
        self.assertTrue(all(set(body) == {'contract_hash', 'segment_index', 'kind', 'artifact_sha256'} for body in recorded),
                        'Scene recording sends no frames or audio for review.')
        self.assertTrue(any('--recovery-keyframe-input' in command for command in commands))
        self.assertEqual(len(scopes), len(set(scopes)), 'Every local step needs its own reservation.')
        self.assertTrue(any(scope.startswith('local-plan-') for scope in scopes))

    def exercise_local(self):
        from PIL import Image
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            candidate = root / 'candidate.mp4'
            recovery.media_command(['-f', 'lavfi', '-i', 'testsrc2=size=256x144:rate=12',
                '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo', '-t', '1',
                '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', str(candidate)])
            segment = {'title': 'Wave', 'transition': 'start', 'target_seconds': 5,
                'shots': [{'visual': 'A duck turns toward the camera.', 'camera': 'Wide',
                           'audio': 'Wind', 'duration_seconds': 5, 'dialogue': []}]}
            local_plan = {'intent': 'local plan', 'keyframe': {'recommended': True}, 'segments': [segment]}
            analysis = {'dialogue_contract': {'mode': 'none', 'lines': []}}
            state, calls, commands, scopes = {}, [], [], []

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
                    prepared = {'contract_hash': 'a' * 64, 'notice': 'Planned locally.', 'plan': local_plan,
                                'sources': [], 'checkpoint': copy.deepcopy(state)}
                    if operation == 'plan':
                        result.value = prepared if any(name == 'local-plan' for name, _ in calls[:-1]) else {
                            'local_plan_required': True, 'reason_code': 'provider_policy',
                            'prompt_analysis': analysis, 'sources': [], 'checkpoint': {}}
                    elif operation == 'local-plan': result.value = prepared
                    elif operation == 'checkpoint': state.update(copy.deepcopy(json['checkpoint'])); result.value = {'ok': True}
                    elif operation == 'image':
                        result.value = {'local_image_required': True, 'use_references': False,
                                        'keyframe': {'prompt': 'A duck on a table.', 'motion_contract': {}}}
                    elif operation == 'review': result.value = {'acceptable': True, 'permitted': True, 'issues': []}
                    else: result.value = {'ok': True}
                    return result

            async def run(command):
                commands.append(command)
                if '--recovery-keyframe-output' in command:
                    Image.new('RGB', (256, 144), 'green').save(command[command.index('--recovery-keyframe-output') + 1])
                return 0
            async def create_local_plan(job, log, source, frontier_analysis):
                self.assertEqual(frontier_analysis, analysis)
                self.assertIsNotNone(worker.gpuq_job_id, 'Local planning needs a GPU reservation.')
                return root / 'plan.json', copy.deepcopy(local_plan)
            async def admit(job):
                self.assertIsNone(getattr(worker, 'gpuq_job_id', None), 'Completed reservation reused')
                scopes.append(job['gpuq_reservation_scope'])
                worker.gpuq_job_id = 'fresh-reservation'
                return True
            worker = types.SimpleNamespace(broker_url='wss://test/v1/worker', http_session=Session(),
                cancel_reason=None, journal={}, worker_headers=lambda: {}, begin_metrics=mock.Mock(),
                save_journal=mock.Mock(), send=mock.AsyncMock(), ensure_gpu_reservation=mock.AsyncMock(side_effect=admit),
                run_reserved_command=mock.AsyncMock(side_effect=run), create_local_plan=create_local_plan,
                find_output=mock.Mock(return_value=candidate), finish_gpuq_reservation=mock.AsyncMock(),
                stop_gpu_monitor=mock.AsyncMock(), prepare_delivery=mock.AsyncMock(side_effect=lambda path, *_args: path),
                upload=mock.AsyncMock(), wait_and_send_terminal=mock.AsyncMock(), clear_journal=mock.Mock(),
                send_ready=mock.AsyncMock(), fail_current=mock.AsyncMock(), finish_cancelled_job=mock.AsyncMock())
            fake = types.SimpleNamespace(SCRIPT_DIR=root, MODEL_ARGS={'minimax': ['--model', 'h3']},
                GENERATOR=root / 'generator.py', console_python_executable=lambda: sys.executable,
                atomic_json=lambda path, value: path.write_text(json.dumps(value, ensure_ascii=False), encoding='utf-8'), stable_job_seed=lambda _: 1)
            with mock.patch.dict(sys.modules, {'video_worker': fake}):
                job = {'id': 'test-job', 'model': 'minimax', 'recovery_revision': 0}
                asyncio.run(recovery.run_recovery_job(worker, job))
                worker.wait_and_send_terminal.assert_awaited_once()
                self.assertEqual(worker.wait_and_send_terminal.await_args.args[0]['generation_notice'], 'Planned locally.')
                worker.upload.assert_awaited_once()
            return calls, commands, scopes

    def test_generator_local_opening_mode(self):
        if not (Path(__file__).resolve().parent / 'video_gen.py').is_file():
            self.skipTest('Run on installed desktop sources.')
        import video_gen
        self.assertFalse(hasattr(video_gen, 'review_recovery_artifact'))
        self.assertGreaterEqual(video_gen.LLAMA_CPP_STARTUP_SECONDS, 240)
        with tempfile.TemporaryDirectory() as temporary:
            from PIL import Image
            portrait = Path(temporary) / 'portrait.png'
            Image.new('RGB', (100, 150), 'red').save(portrait)
            with mock.patch.object(video_gen, 'generate_keyframe', return_value=portrait) as generate:
                video_gen.generate_recovery_keyframe('http://server', {'prompt': 'A duck.', 'references': [str(portrait)],
                    'motion_contract': {'gaze_direction': 'left'}, 'aspect_image': str(portrait)}, 7, 60, 25)
            args = generate.call_args
            self.assertEqual(args.args[2], {}, 'An incomplete motion contract is dropped instead of crashing.')
            self.assertEqual(args.args[3], '2:3')
            self.assertEqual(args.kwargs['references'], [portrait])
        with mock.patch.object(sys, 'argv', ['video_gen.py', '--recovery-keyframe-input', 'in.json', 'x']):
            with self.assertRaises(SystemExit):
                video_gen.parse_args()

    def exercise(self, original=False, render_failures=0, image_outage=False,
                 review_outage=False, upload_outage=False, admission_outage=False, invalid_response=False, continuation=False, authored_cut=False, restart_exhausted=False):
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
                if restart_exhausted:
                    self.assertEqual(worker.run_reserved_command.await_count, 2)
                    self.assertFalse(worker.fail_current.await_args.args[1])
                    asyncio.run(recovery.run_recovery_job(worker, job))
                    self.assertEqual(worker.run_reserved_command.await_count, 2)
                    self.assertFalse(worker.fail_current.await_args.args[1])
                    worker.upload.assert_not_awaited()
                    return
                if image_outage or render_failures == 2:
                    worker.fail_current.assert_awaited_once()
                    worker.upload.assert_not_awaited()
                    worker.wait_and_send_terminal.assert_not_awaited()
                    self.assertFalse(any(body.get('format') == 'storyboard' for _, body in calls))
                    if invalid_response: self.assertIn('503', worker.fail_current.await_args.args[0])
                    if render_failures == 2:
                        self.assertEqual(renderers, ['minimax', 'minimax'])
                        self.assertFalse(worker.fail_current.await_args.args[1])
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
                if original:
                    self.assertEqual(sum(operation == 'image' for operation, _ in calls), int(authored_cut))
                    self.assertFalse(any(operation == 'review' and body['kind'] == 'image' and body['segment_index'] == 0
                                         for operation, body in calls), 'The original portrait is never reviewed away.')
                if continuation:
                    if not authored_cut: self.assertEqual(state['scenes']['1']['image_source'], 'continuation')
                    self.assertEqual(worker.run_reserved_command.await_count, 2)
                if render_failures == 1: self.assertEqual(renderers, ['minimax', 'minimax'])
                self.assertGreater(recovery.duration(root / 'worker_recovery/test-job/final.mp4'), 0)


if __name__ == '__main__':
    unittest.main()
