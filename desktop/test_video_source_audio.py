import copy
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
import wave

import video_source_audio as audio

LIVE = Path(os.environ.get('VIDEO_DESKTOP_DIR', '/mnt/d/AI/ComfyUI_windows_portable/video_gen'))


class SongTests(unittest.TestCase):
    def test_h3_masks_freeze_audio_and_preserve_image_conditioning(self):
        for name in ('h3_i2v.json', 'h3_t2v.json'):
            workflow = json.loads((LIVE / 'templates' / name).read_text())
            original = copy.deepcopy(workflow)
            result = audio.condition_h3_on_song(workflow, 'song.wav')
            self.assertEqual(workflow, original)
            sampler = next(n for n in result.values() if n['class_type'] == 'SamplerCustomAdvanced')
            self.assertEqual(sampler['inputs']['latent_image'], ['song:av', 0])
            self.assertEqual(result['song:zero']['inputs']['value'], 0)
            self.assertEqual(result['song:av']['inputs']['video_latent'],
                next(n for n in original.values() if n['class_type'] == 'SamplerCustomAdvanced')['inputs']['latent_image'])
            self.assertEqual(next(n for n in result.values() if n['class_type'] == 'CreateVideo')['inputs']['audio'], ['song:load', 0])

    def test_generator_retains_audio_timing_during_validation_and_compilation(self):
        sys.path.insert(0, str(LIVE))
        import video_gen as gen
        from test_video_gen import sample_plan
        plan = sample_plan()
        segment = plan['segments'][0]
        segment.update(source_audio_frames=99, source_audio_start_seconds=14.125,
                       target_seconds=99 / 24, output_seconds=99 / 24)
        segment['shots'][0]['duration_seconds'] = 99 / 24
        plan['source_audio'] = {'duration_seconds': 18.25, 'output_frames': 438}
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'plan.json'
            path.write_text(json.dumps(plan))
            loaded = gen.load_frontier_video_plan(path, 'Perform the approved scene', None, ('h3',))
            prepared = gen.prepare_model_segments('', loaded, 'h3', 'portrait.png', {}, True, 1)
            audio.prepare_song_segments(prepared, loaded)
            self.assertEqual(prepared[0]['source_audio_start_seconds'], 14.125)
            self.assertEqual(prepared[0]['output_seconds'], 99 / 24)
            self.assertGreaterEqual(prepared[0]['frame_count'], 99)
            self.assertEqual(prepared[0]['frame_count'] % 17, 5)
            self.assertNotIn('No speech occurs', prepared[0]['prompt'])
            self.assertNotIn('lips remain closed', prepared[0]['prompt'])
            self.assertNotIn('no human voice or mouth movement', prepared[0]['prompt'])

    def test_windows_are_sample_aligned_and_pad_only_after_song_end(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / 'song.wav'
            with wave.open(str(source), 'wb') as output:
                output.setnchannels(2); output.setsampwidth(2); output.setframerate(32000)
                output.writeframes(b'\x10\x00\x20\x00' * 32000 + b'\x30\x00\x40\x00' * 32000)
            audio.audio_window('ffmpeg', source, root / 'slice.wav', 1.0, 1.5)
            with wave.open(str(root / 'slice.wav'), 'rb') as output:
                self.assertEqual(output.getnframes(), 48000)
                data = output.readframes(48000)
                self.assertEqual(data[:32000 * 4], b'\x30\x00\x40\x00' * 32000)
                self.assertEqual(data[32000 * 4:], b'\x00' * (16000 * 4))


class SongAssemblyTests(unittest.TestCase):
    def test_non_round_scene_lengths_join_without_audio_padding_drift(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            paths = []
            for index, frames in enumerate([13, 21, 14]):
                path = root / f'scene-{index}.mp4'
                audio.run_media('ffmpeg', ['-f', 'lavfi', '-i', 'color=c=blue:s=64x64:r=24',
                    '-f', 'lavfi', '-i', 'sine=frequency=220:sample_rate=48000',
                    '-frames:v', frames + 3, '-t', str((frames + 3) / 24), '-c:v', 'libx264', '-c:a', 'aac', path])
                paths.append(path)
            video = audio.assemble_song_video('ffmpeg', paths,
                [{'source_audio_frames': frames} for frames in [13, 21, 14]], root / 'joined.mp4')
            song = root / 'song.wav'
            audio.run_media('ffmpeg', ['-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=2', song])
            final = audio.mux_original_song('ffmpeg', video, song, root / 'final.mp4', 0, 48)
            result = subprocess.check_output(['ffprobe', '-v', 'error', '-count_frames', '-show_streams', '-of', 'json', str(final)])
            streams = json.loads(result)['streams']
            video_stream = next(s for s in streams if s['codec_type'] == 'video')
            self.assertEqual(int(video_stream['nb_read_frames']), 48)
            self.assertAlmostEqual(float(video_stream['duration']), 2.0, places=5)
            self.assertTrue(any(s['codec_type'] == 'audio' for s in streams))

if __name__ == '__main__':
    unittest.main()
