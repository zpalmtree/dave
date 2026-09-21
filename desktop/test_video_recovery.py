import asyncio
import base64
import copy
import importlib.util
import json
from pathlib import Path
import shutil
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
    def test_generator_imports_with_the_isolated_windows_python_path(self):
        generator = Path(__file__).resolve().parent / 'video_gen.py'
        if not generator.is_file():
            self.skipTest('Run this check on the installed desktop sources.')
        source = ('import importlib.util,sys; '
                  f's=importlib.util.spec_from_file_location("isolated_video_gen", {str(generator)!r}); '
                  'm=importlib.util.module_from_spec(s); sys.modules[s.name]=m; s.loader.exec_module(m); '
                  'assert m.LLAMA_CPP_MODEL.is_file()')
        subprocess.run([sys.executable, '-s', '-c', source], check=True, capture_output=True, timeout=30)

    def test_preflight_uses_coordinator_paths_and_reports_missing_files(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            config = root / 'config.json'
            paths = {key: str(root / key) for key in ['QwenExecutable', 'QwenModel', 'QwenVisionProjector']}
            config.write_text(json.dumps(paths))
            self.assertFalse(gpuq_settings.qwen_preflight(config)['available'])
            for path in paths.values():
                Path(path).write_bytes(b'model-fixture')
            self.assertEqual(gpuq_settings.qwen_preflight(config), {'available': True, 'missing': []})

    def test_storyboard_is_a_decodable_video_with_readable_caption_pages(self):
        from PIL import Image
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / 'source.png'
            Image.new('RGB', (640, 480), 'green').save(source)
            segment = {'title': 'Home', 'shots': [{'visual': 'Two explorers wave.',
                'dialogue': [{'text': 'We made it home.'}]}]}
            panels = recovery.storyboard_panels([source], segment, root)
            video = recovery.assemble_storyboard(panels, root)
            self.assertGreaterEqual(recovery.duration(video), 3)
            observations = recovery.review_samples(video, root)
            self.assertEqual(len(observations['frames']), 5)
            self.assertGreater(video.stat().st_size, 1000)

    def test_two_failed_renders_become_storyboard_and_completed_work_is_reused_after_upload_failure(self):
        self.exercise_recovery()

    def test_unavailable_images_still_produce_a_captioned_storyboard_without_gpu_work(self):
        self.exercise_recovery(image_available=False)

    def test_corrupted_video_is_retried_then_becomes_storyboard(self):
        self.exercise_recovery(corrupt_video=True)

    def test_review_outage_resumes_the_rendered_artifact_without_new_gpu_work(self):
        self.exercise_recovery(review_outage=True)

    def exercise_recovery(self, image_available=True, corrupt_video=False, review_outage=False):
        from PIL import Image
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            image = root / 'fixture.png'
            Image.new('RGB', (640, 480), 'blue').save(image)
            image_data = recovery.data_image(image)
            segment = {'title': 'Home', 'transition': 'start', 'target_seconds': 5,
                'shots': [{'visual': 'The explorers arrive home.', 'camera': 'Wide', 'audio': 'Wind',
                    'duration_seconds': 5, 'dialogue': [{'text': 'We made it home.'}]}]}
            prepared = {'contract_hash': 'a' * 64, 'prompt': 'Explorers return home.', 'notice': '',
                'contract': {'use_source_images': True}, 'plan': {'segments': [segment]}, 'sources': [image_data] if image_available else []}
            candidate = root / 'candidate.mp4'
            if review_outage:
                panels = recovery.storyboard_panels([image], segment, root)
                shutil.copy2(recovery.assemble_storyboard(panels, root), candidate)
            elif corrupt_video:
                candidate.write_bytes(b'not a video')
            calls = []
            outage = [review_outage]
            state = {}

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
                        result.status = 200 if image_available else 503
                        result.value = {'image': image_data} if image_available else {'error': 'provider offline'}
                    elif operation == 'review':
                        if json['kind'] == 'video' and outage[0]:
                            outage[0] = False
                            result.status = 503
                            result.value = {'error': 'review temporarily offline'}
                        else:
                            result.value = {'acceptable': True, 'permitted': True, 'issues': []}
                    else: result.value = {'ok': True}
                    return result

            worker = types.SimpleNamespace(broker_url='wss://test/v1/worker', http_session=Session(),
                cancel_reason=None, journal={}, worker_headers=lambda: {}, begin_metrics=mock.Mock(),
                save_journal=mock.Mock(), send=mock.AsyncMock(), ensure_gpu_reservation=mock.AsyncMock(return_value=True),
                run_reserved_command=mock.AsyncMock(return_value=0 if candidate.exists() else 1), find_output=mock.Mock(return_value=candidate if candidate.exists() else None),
                finish_gpuq_reservation=mock.AsyncMock(), stop_gpu_monitor=mock.AsyncMock(),
                prepare_delivery=mock.AsyncMock(side_effect=lambda path, *_args: path),
                upload=mock.AsyncMock(side_effect=RuntimeError('network down')), wait_and_send_terminal=mock.AsyncMock(),
                clear_journal=mock.Mock(), send_ready=mock.AsyncMock(), fail_current=mock.AsyncMock(),
                finish_cancelled_job=mock.AsyncMock())
            fake_module = types.SimpleNamespace(SCRIPT_DIR=root, MODEL_ARGS={'minimax': ['--model', 'h3']},
                GENERATOR=root / 'generator.py', console_python_executable=lambda: sys.executable,
                atomic_json=lambda path, value: path.write_text(json_module.dumps(value)), stable_job_seed=lambda _: 1)
            json_module = json
            with mock.patch.dict(sys.modules, {'video_worker': fake_module}):
                asyncio.run(recovery.run_recovery_job(worker, {'id': 'test-job', 'model': 'minimax'}))
                render_count = 1 if review_outage else 2 if image_available else 0
                self.assertEqual(worker.run_reserved_command.await_count, render_count)
                if not review_outage:
                    self.assertEqual(state['format'], 'storyboard')
                worker.fail_current.assert_awaited_once()
                worker.upload.side_effect = None
                asyncio.run(recovery.run_recovery_job(worker, {'id': 'test-job', 'model': 'minimax'}))
                self.assertEqual(worker.run_reserved_command.await_count, render_count)
                terminal = worker.wait_and_send_terminal.await_args.args[0]
                self.assertEqual(terminal['event'], 'complete')
                if not review_outage:
                    self.assertIn('animated storyboard', terminal['generation_notice'])
                self.assertEqual(len([c for c in calls if c[0] == 'image']), 1 if image_available else 2)
                if not image_available:
                    self.assertTrue(any(body.get('caption_only') for operation, body in calls if operation == 'review'))


if __name__ == '__main__':
    unittest.main()
