"""Real-media regression tests; no GPU/model imports."""
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

from PIL import Image, ImageChops
from video_continuity_frame import extract_final_video_frame


@unittest.skipUnless(shutil.which('ffmpeg'), 'ffmpeg is required')
class FinalFrameTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)

    def run_ffmpeg(self, *args):
        subprocess.run(['ffmpeg', '-nostdin', '-v', 'error', '-y', *map(str, args)],
                       check=True, capture_output=True, timeout=30)

    def assert_final(self, clip):
        actual, expected = self.root/'actual.png', self.root/'expected.png'
        extract_final_video_frame(clip, actual)
        self.run_ffmpeg('-i', clip, '-vf', 'reverse', '-frames:v', '1', expected)
        with Image.open(actual) as a, Image.open(expected) as b:
            self.assertIsNone(ImageChops.difference(a.convert('RGB'), b.convert('RGB')).getbbox())

    def test_cfr_b_frames_and_audio_that_outlasts_video(self):
        clip = self.root/'long-audio.mp4'
        self.run_ffmpeg('-f', 'lavfi', '-i', 'testsrc2=size=96x64:rate=24:duration=1',
                        '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo', '-t', '2',
                        '-c:v', 'libx264', '-bf', '3', '-c:a', 'aac', clip)
        self.assert_final(clip)

    def test_variable_frame_rate_and_delayed_final_frame(self):
        clip = self.root/'variable.mp4'
        self.run_ffmpeg('-f', 'lavfi', '-i', 'testsrc2=size=96x64:rate=24:duration=1',
                        '-vf', "select='eq(n,0)+eq(n,5)+eq(n,23)'", '-fps_mode', 'vfr',
                        '-c:v', 'libx264', clip)
        self.assert_final(clip)

    def test_single_frame_clip(self):
        clip = self.root/'single.mp4'
        self.run_ffmpeg('-f', 'lavfi', '-i', 'color=red:size=96x64:rate=24',
                        '-frames:v', '1', '-c:v', 'libx264', clip)
        self.assert_final(clip)

    def test_invalid_input_does_not_replace_existing_image(self):
        clip, output = self.root/'invalid.mp4', self.root/'existing.png'
        clip.write_bytes(b'not a video')
        output.write_bytes(b'previous image')
        with self.assertRaises(Exception):
            extract_final_video_frame(clip, output)
        self.assertEqual(output.read_bytes(), b'previous image')


if __name__ == '__main__':
    unittest.main()
