"""CPU/media regressions for native-size normalization and horizontal delivery."""
import asyncio
import copy
import json
from pathlib import Path
import sys
import tempfile
import types
import unittest
from unittest import mock

import av
from PIL import Image
import video_recovery as recovery


class NativeCanvasTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)

    def clip(self, name, size, audio=True, fps=24, odd=False):
        path = self.root / (name + ('.mkv' if odd else '.mp4'))
        # The three vertical bands let us verify that both edges survive fitting.
        image = Image.new('RGB', size, 'lime')
        image.paste('red', (0, 0, size[0] // 3, size[1]))
        image.paste('blue', (size[0] * 2 // 3, 0, size[0], size[1]))
        png = self.root / (name + '.png')
        image.save(png)
        recovery.media_command(['-loop', '1', '-framerate', str(fps), '-i', str(png),
            *(['-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100'] if audio else []),
            '-t', '1', '-c:v', 'ffv1' if odd else 'libx264', '-pix_fmt', 'yuv444p' if odd else 'yuv420p',
            *(['-c:a', 'aac'] if audio else ['-an']), str(path)])
        return path

    def inspect(self, path, size, frames=None, audio=True):
        with av.open(str(path)) as container:
            video = container.streams.video[0]
            self.assertEqual((video.width, video.height), size)
            self.assertEqual(video.sample_aspect_ratio, 1)
            self.assertEqual(video.average_rate, 24)
            self.assertEqual(video.format.name, 'yuv420p')
            self.assertEqual(bool(container.streams.audio), audio)
            if audio:
                self.assertEqual(container.streams.audio[0].sample_rate, 48000)
                self.assertEqual(container.streams.audio[0].layout.name, 'stereo')
            decoded = list(container.decode(video))
            if frames is not None:
                self.assertEqual(len(decoded), frames)
            return decoded[0].to_image()

    def assert_bands(self, image, y):
        width = image.width
        for x, channel in [(width // 6, 0), (width // 2, 1), (width * 5 // 6, 2)]:
            pixel = image.getpixel((x, y))
            self.assertGreater(pixel[channel], 180)
            self.assertLess(max(pixel[(channel + 1) % 3], pixel[(channel + 2) % 3]), 50)

    def test_single_scene_preserves_native_portrait_landscape_and_square_sizes(self):
        for size in [(736, 1120), (1120, 736), (832, 832)]:
            with self.subTest(size=size):
                source = self.clip(str(size[0]), size, audio=False, fps=12)
                output = recovery.normalize_clip(source, self.root / 'normalized.mp4')
                output = recovery.join_clips([output], self.root / 'final.mp4')
                image = self.inspect(output, size, frames=24)
                self.assert_bands(image, 4)
                self.assert_bands(image, size[1] - 5)

    def test_mixed_scenes_fit_full_picture_and_join_on_the_first_canvas(self):
        first = self.clip('portrait', (144, 256))
        second = self.clip('wide', (256, 144))
        canvas = recovery.delivery_canvas(first)
        self.assertEqual(canvas, (456, 256))
        clips = [recovery.normalize_clip(path, self.root / f'normalized-{index}.mp4', canvas=canvas)
                 for index, path in enumerate([first, second])]
        fitted = self.inspect(clips[1], canvas, frames=24)
        self.assert_bands(fitted, fitted.height // 2)
        portrait = self.inspect(clips[0], canvas, frames=24)
        left = (portrait.width - 144) // 2
        self.assert_bands(portrait.crop((left, 0, left + 144, 256)), 4)
        self.assertLess(max(portrait.getpixel((4, 128))), 10)
        self.assertLess(max(portrait.getpixel((451, 128))), 10)
        for transition, frames in [('cut', 48), ('dissolve', 42)]:
            output = recovery.join_clips(clips, self.root / f'{transition}.mp4',
                [{'transition': 'start'}, {'transition': transition, 'audio_transition': 'auto'}])
            self.inspect(output, canvas, frames=frames)
            with av.open(str(output)) as container:
                for stream in container.streams:
                    self.assertAlmostEqual(float(stream.duration * stream.time_base), frames / 24, delta=.05)

    def test_odd_dimensions_remain_encodable_without_a_fixed_canvas(self):
        source = self.clip('odd', (145, 257), audio=False, odd=True)
        self.assertEqual(recovery.video_canvas(source), (146, 258))
        output = recovery.normalize_clip(source, self.root / 'even.mp4')
        self.inspect(output, (146, 258), frames=24)

    def test_delivery_keeps_native_detail_and_adds_only_side_padding(self):
        for size, expected in [((736, 1120), (1992, 1120)),
                               ((832, 832), (1480, 832)),
                               ((1120, 736), (1120, 736)),
                               ((1344, 768), (1344, 768))]:
            with self.subTest(size=size):
                source = self.clip('delivery-source', size, audio=False)
                canvas = recovery.delivery_canvas(source)
                self.assertEqual(canvas, expected)
                output = recovery.normalize_clip(source, self.root / 'delivery.mp4', canvas=canvas)
                image = self.inspect(output, expected, frames=24)
                left = (image.width - size[0]) // 2
                picture = image.crop((left, 0, left + size[0], size[1]))
                self.assert_bands(picture, 4)
                self.assert_bands(picture, size[1] - 5)
                if left:
                    self.assertLess(max(image.getpixel((4, size[1] // 2))), 10)
                    self.assertLess(max(image.getpixel((image.width - 5, size[1] // 2))), 10)

    def test_odd_portrait_delivery_is_horizontal_and_encodable(self):
        source = self.clip('odd-delivery', (145, 257), audio=False, odd=True)
        canvas = recovery.delivery_canvas(source)
        self.assertEqual(canvas, (460, 258))
        output = recovery.normalize_clip(source, self.root / 'even-delivery.mp4', canvas=canvas)
        self.inspect(output, canvas, frames=24)

    def exercise_recovery(self, song=False):
        """Resume accepted scenes through the real normalization, join and upload path."""
        job_root = self.root / 'worker_recovery' / 'test-job'
        scenes = {}
        originals = [self.clip('first', (144, 256)), self.clip('second', (256, 144))]
        for index, original in enumerate(originals):
            scene_root = job_root / f'scene-{index}'
            scene_root.mkdir(parents=True)
            opening = scene_root / 'opening.png'
            Image.new('RGB', (144, 256), 'green').save(opening)
            scenes[str(index)] = {'image_accepted': recovery.digest(opening),
                'video_path': str(original), 'video_accepted': recovery.digest(original), 'renderer': 'minimax'}
        state = {'contract_hash': 'a' * 64, 'pipeline_version': 2, 'revision': 0, 'scenes': scenes}
        segment = {'target_seconds': 1, 'source_audio_frames': 24, 'shots': [{'visual': 'Three bands.'}]}
        prepared = {'contract_hash': state['contract_hash'], 'plan': {'segments': [
            {**segment, 'transition': 'start'}, {**segment, 'transition': 'cut'}],
            'source_audio': {'output_frames': 48}}}
        soundtrack = self.root / 'song.wav'
        if song:
            recovery.media_command(['-f', 'lavfi', '-i', 'sine=frequency=880:sample_rate=48000',
                                    '-t', '2', '-ac', '2', str(soundtrack)])

        class Response:
            status = 200
            async def __aenter__(self): return self
            async def __aexit__(self, *_): pass
            async def json(self, **_): return self.value

        class Session:
            def post(self, url, json, **_):
                operation = url.rsplit('/', 1)[-1]
                response = Response()
                if operation == 'plan':
                    response.value = {**prepared, 'checkpoint': copy.deepcopy(state)}
                elif operation == 'checkpoint':
                    state.update(copy.deepcopy(json['checkpoint']))
                    response.value = {'ok': True}
                elif operation == 'quality':
                    response.value = {'ok': True}
                else:
                    raise AssertionError(f'Accepted scenes must not regenerate: {operation}')
                return response

        worker = types.SimpleNamespace(broker_url='wss://test/v1/worker', http_session=Session(),
            cancel_reason=None, journal={}, worker_headers=lambda: {}, begin_metrics=mock.Mock(),
            job_metrics=None, add_span=mock.Mock(), save_journal=mock.Mock(), send=mock.AsyncMock(),
            request_job_source_audio=mock.AsyncMock(return_value=soundtrack),
            prepare_delivery=mock.AsyncMock(side_effect=lambda path, *_: path),
            upload=mock.AsyncMock(side_effect=[RuntimeError('temporary upload outage'), None]),
            wait_and_send_terminal=mock.AsyncMock(), clear_journal=mock.Mock(), send_ready=mock.AsyncMock(),
            fail_current=mock.AsyncMock(), finish_cancelled_job=mock.AsyncMock())
        fake = types.SimpleNamespace(SCRIPT_DIR=self.root, MODEL_ARGS={}, GENERATOR=self.root / 'unused.py',
            console_python_executable=lambda: sys.executable, stable_job_seed=lambda _: 1,
            atomic_json=lambda path, value: path.write_text(json.dumps(value), encoding='utf-8'),
            manifest_metrics=mock.Mock())
        job = {'id': 'test-job', 'model': 'minimax', 'has_source_audio': song}
        with mock.patch.dict(sys.modules, {'video_worker': fake}):
            for attempt in range(2):
                asyncio.run(recovery.run_recovery_job(worker, job))
                self.assertEqual(worker.upload.await_count, attempt + 1)
                delivered = worker.upload.await_args.args[1]
                self.inspect(delivered, (456, 256), frames=48)
        worker.fail_current.assert_awaited_once_with('temporary upload outage', True)
        worker.wait_and_send_terminal.assert_awaited_once()
        for index, original in enumerate(originals):
            self.assertEqual(recovery.digest(original), state['scenes'][str(index)]['video_accepted'])
        if song:
            # Two exact silent scene clips become one two-second source soundtrack.
            for index in range(2):
                self.inspect(job_root / f'scene-{index}' / 'normalized.mp4', (456, 256), frames=24, audio=False)
            with av.open(str(delivered)) as container:
                audio = container.streams.audio[0]
                self.assertAlmostEqual(float(audio.duration * audio.time_base), 2, delta=.05)

    def test_resumed_video_delivers_horizontal_without_rendering_again(self):
        self.exercise_recovery()

    def test_resumed_song_delivers_horizontal_with_exact_audio_timeline(self):
        self.exercise_recovery(song=True)


if __name__ == '__main__':
    unittest.main()
