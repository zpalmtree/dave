"""Timing-policy, cancellation, and real-media regressions; no model/GPU required."""
import asyncio
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

from video_sync_analyze import choose_shift, sample_starts
import video_sync_delivery as delivery


def sample(offset, confidence=6, distance=8):
    return dict(offset_ms=offset, confidence=confidence, distance=distance)


class PolicyTests(unittest.TestCase):
    def test_user_validated_offset_and_opposite_direction(self):
        self.assertEqual(choose_shift([sample(0), sample(-40), sample(-80)]), -40)
        self.assertEqual(choose_shift([sample(40), sample(80), sample(40)]), 40)
        self.assertEqual(choose_shift([sample(0)] * 3), 0)

    def test_uncertain_conflicting_and_large_offsets_stay_untouched(self):
        for values in ([sample(-40)] * 2, [sample(-40)] * 4,
                       [sample(-40), sample(-40, 2), sample(-40)],
                       [sample(-40), sample(-40, distance=14), sample(-40)],
                       [sample(-80), sample(40), sample(-40)],
                       [sample(-120)] * 3, [sample(-20)] * 3,
                       [sample(float('nan'))] * 3, [{}, {}, {}]):
            with self.subTest(values=values):
                self.assertEqual(choose_shift(values), 0)

    def test_short_clips_and_nonoverlapping_windows(self):
        self.assertEqual(sample_starts(5), [])
        self.assertEqual(sample_starts(float('nan')), [])
        for seconds in (8.4, 10, 28.9, 120):
            starts = sample_starts(seconds)
            self.assertEqual(len(starts), 3)
            self.assertGreaterEqual(starts[1] - starts[0], 2.8 - 1e-8)
            self.assertGreaterEqual(starts[2] - starts[1], 2.8 - 1e-8)
            self.assertLessEqual(starts[-1] + 2.8, seconds + 1e-8)

    def test_windows_paths_preserve_spaces_without_shell_interpolation(self):
        self.assertEqual(delivery.wsl_path(Path(r'D:\AI files\clip.mp4')), '/mnt/d/AI files/clip.mp4')


class DeliveryTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.source = self.root / 'original.mp4'
        self.source.write_bytes(b'original')

    async def test_preserved_audio_short_and_disabled_skip_process(self):
        with mock.patch.object(delivery, 'run_process', new_callable=mock.AsyncMock) as process:
            self.assertEqual(await delivery.correct_delivery_sync('ffmpeg', self.source, 'job', 30, preserve_audio=True), self.source)
            self.assertEqual(await delivery.correct_delivery_sync('ffmpeg', self.source, 'job', 3), self.source)
            with mock.patch.dict(os.environ, VIDEO_DELIVERY_SYNC='0'):
                self.assertEqual(await delivery.correct_delivery_sync('ffmpeg', self.source, 'job', 30), self.source)
            process.assert_not_called()

    async def fake_analysis(self, command, timeout, **kwargs):
        if '--result' in command:
            value = command[command.index('--result') + 1]
            if os.name == 'nt' and value.startswith('/mnt/'):
                value = value[5].upper() + ':/' + value[7:]
            result = Path(value)
            result.write_text(json.dumps(dict(samples=[sample(0), sample(-40), sample(-80)])))
        else:
            Path(command[-1]).write_bytes(b'corrected')
        return 0

    async def test_success_uses_measured_direction_and_retains_source(self):
        with mock.patch.object(delivery, 'run_process', side_effect=self.fake_analysis) as process:
            out = await delivery.correct_delivery_sync('ffmpeg', self.source, 'job', 30)
        self.assertNotEqual(out, self.source)
        self.assertEqual(self.source.read_bytes(), b'original')
        self.assertIn('atrim=start=0.040,asetpts=PTS-STARTPTS,apad', process.call_args.args[0])
        self.assertEqual(json.loads(out.with_suffix('.json').read_text())['shift_ms'], -40)

    async def test_analysis_and_remux_failure_return_original(self):
        for stage in ('analysis', 'remux'):
            async def run(command, timeout, **kwargs):
                if stage == 'remux' and '--result' in command:
                    return await self.fake_analysis(command, timeout, **kwargs)
                if '--result' not in command:
                    Path(command[-1]).write_bytes(b'partial')
                raise asyncio.TimeoutError()
            with mock.patch.object(delivery, 'run_process', side_effect=run):
                self.assertEqual(await delivery.correct_delivery_sync('ffmpeg', self.source, 'job', 30), self.source)
            self.assertFalse(self.source.with_name('original.avsync-job.mp4').exists())

    async def test_cancellation_propagates_instead_of_delivering(self):
        with mock.patch.object(delivery, 'run_process', side_effect=asyncio.CancelledError()):
            with self.assertRaises(asyncio.CancelledError):
                await delivery.correct_delivery_sync('ffmpeg', self.source, 'job', 30)

    async def test_actual_child_is_reaped_on_timeout(self):
        with self.assertRaises(asyncio.TimeoutError):
            await delivery.run_process([sys.executable, '-c', 'import time; time.sleep(30)'], .1)

    @unittest.skipIf(os.name == 'nt', 'Analyzer CLI runs under WSL')
    async def test_analyzer_exits_cleanly_while_parent_holds_stdin(self):
        result = self.root / 'result.json'
        code = await delivery.run_process([sys.executable, str(Path(delivery.__file__).with_name('video_sync_analyze.py')),
            '--video', str(self.source), '--result', str(result), '--seconds', '3', '--exit-with-stdin'],
            5, held_stdin=True)
        self.assertEqual(code, 0)
        self.assertEqual(json.loads(result.read_text())['reason'], 'too_short')


@unittest.skipUnless(importlib.util.find_spec('video_worker'), 'Desktop worker lives outside the repository')
class WorkerIntegrationTests(unittest.IsolatedAsyncioTestCase):
    async def test_generated_delivery_uses_corrected_audio_and_edits_preserve_source(self):
        import video_worker
        with tempfile.TemporaryDirectory() as temporary:
            source = Path(temporary) / 'source.mp4'
            corrected = Path(temporary) / 'corrected.mp4'
            source.write_bytes(b'original')
            corrected.write_bytes(b'corrected')
            worker = video_worker.DesktopVideoWorker.__new__(video_worker.DesktopVideoWorker)
            worker.current_job = {}
            worker.add_span = mock.Mock()
            worker.delivery_video_is_compatible = mock.AsyncMock(return_value=True)
            worker.normalize_delivery_audio = mock.AsyncMock(side_effect=lambda _, path, *args: path)
            with mock.patch.object(delivery, 'correct_delivery_sync', new_callable=mock.AsyncMock, return_value=corrected) as sync:
                self.assertEqual(await worker.prepare_delivery(source, 'job', 30), corrected)
                sync.assert_awaited_once_with(shutil.which('ffmpeg'), source, 'job', 30, preserve_audio=False)
                worker.normalize_delivery_audio.assert_awaited_once_with(shutil.which('ffmpeg'), corrected, 'job')
            worker.normalize_delivery_audio.reset_mock()
            with mock.patch.object(delivery, 'correct_delivery_sync', new_callable=mock.AsyncMock, return_value=source) as sync:
                self.assertEqual(await worker.prepare_delivery(source, 'job', 30, preserve_audio=True), source)
                self.assertTrue(sync.call_args.kwargs['preserve_audio'])
                worker.normalize_delivery_audio.assert_not_awaited()


@unittest.skipUnless(shutil.which('ffmpeg'), 'FFmpeg required')
class MediaTests(unittest.TestCase):
    def test_shift_preserves_video_metadata_duration_and_audio_direction(self):
        # Sparse impulses make an accidental sign reversal obvious without ML.
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / 'source.mp4'
            subprocess.run(['ffmpeg', '-nostdin', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=96x64:r=24:d=2',
                            '-f', 'lavfi', '-i', 'aevalsrc=if(between(t\\,0.7\\,0.71)\\,0.5\\,0):s=48000:d=2',
                            '-c:v', 'libx264', '-c:a', 'aac', '-metadata', 'prompt={"test":"sync"}',
                            '-movflags', '+use_metadata_tags', str(source)], check=True)
            def video_hash(path):
                return subprocess.check_output(['ffmpeg', '-v', 'error', '-i', str(path), '-map', '0:v:0',
                                                '-c:v', 'copy', '-f', 'hash', '-'])
            def peak_time(path):
                import array
                pcm = array.array('f')
                pcm.frombytes(subprocess.check_output(['ffmpeg', '-v', 'error', '-i', str(path), '-vn',
                               '-ac', '1', '-ar', '48000', '-f', 'f32le', '-']))
                # Center of energy is robust to AAC ringing around the impulse.
                energy = [x*x for x in pcm]
                return sum(i*x for i, x in enumerate(energy))/sum(energy)/48000
            original_peak = peak_time(source)
            for shift in (-40, 80):
                out = root / f'{shift}.mp4'
                subprocess.run(delivery.shift_command('ffmpeg', source, out, shift, 2), check=True)
                self.assertEqual(video_hash(out), video_hash(source))
                self.assertAlmostEqual(peak_time(out)-original_peak, shift/1000, delta=.003)
                probe = json.loads(subprocess.check_output(['ffprobe', '-v', 'error', '-show_format',
                                                           '-show_streams', '-of', 'json', str(out)]))
                self.assertEqual(probe['format']['tags']['prompt'], '{"test":"sync"}')
                self.assertEqual(int(probe['streams'][0]['nb_frames']), 48)
                self.assertAlmostEqual(float(probe['format']['duration']), 2, delta=.03)


if __name__ == '__main__':
    unittest.main()
