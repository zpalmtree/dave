"""Real CPU assembly checks for the default short picture/audio blend."""
import os
import unittest
from unittest import mock

import video_gen as vg
import video_recovery as recovery
from test_video_output_quality import RecoveryAssemblyTests


class ShotBlendTests(RecoveryAssemblyTests):
    def join(self, transition='cut', audio='auto', clips=None):
        return recovery.join_clips(clips or self.clips, self.root / 'joined.mp4',
            [{'transition': 'start'}, {'transition': transition, 'audio_transition': audio}])

    def assert_duration(self, path, expected):
        for stream in self.probe(path):
            self.assertAlmostEqual(float(stream['duration']), expected, delta=.05)

    @mock.patch.dict(os.environ, {'VIDEO_SHOT_BLEND_SECONDS': '.25'})
    def test_default_cut_blends_real_pixels_and_preserves_av_alignment(self):
        import subprocess
        output = self.join()
        self.assert_duration(output, 1.75)
        frame = subprocess.run([vg.ffmpeg_executable(), '-v', 'error', '-ss', '0.875',
            '-i', str(output), '-frames:v', '1', '-vf', 'scale=1:1',
            '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], capture_output=True, check=True).stdout
        self.assertGreater(frame[0], 30)
        self.assertGreater(frame[2], 30)

    def test_continuation_keeps_all_frames(self):
        self.assert_duration(self.join('continue'), 2)

    @mock.patch.dict(os.environ, {'VIDEO_SHOT_BLEND_SECONDS': '0'})
    def test_disabled_blend_keeps_original_cut_duration(self):
        self.assert_duration(self.join(), 2)

    def test_audio_modes_remain_aligned_with_the_short_blend(self):
        for mode in ['cut', 'fade']:
            with self.subTest(mode=mode):
                self.assert_duration(self.join(audio=mode), 1.75)

    def test_multiple_blends_account_for_each_overlap(self):
        output = recovery.join_clips(self.clips + self.clips[:1], self.root / 'three.mp4',
            [{'transition': 'start'}, {'transition': 'cut'}, {'transition': 'cut'}])
        self.assert_duration(output, 2.5)

    def test_short_clips_never_overlap_more_than_a_quarter(self):
        self.assertEqual(vg.shot_blend_seconds('cut', 10, .2), 1 / 24)
        self.assertEqual(vg.shot_blend_seconds('cut', .2, 10), 1 / 24)
        self.assertEqual(vg.shot_blend_seconds('cut', .1, 10), 0)

    def test_defaults_invalid_settings_and_explicit_dissolves(self):
        with mock.patch.dict(os.environ, {}, clear=True):
            self.assertEqual(vg.shot_blend_seconds('cut', 5, 5), .25)
        for setting in ['bad', 'nan', 'inf']:
            with mock.patch.dict(os.environ, {'VIDEO_SHOT_BLEND_SECONDS': setting}):
                self.assertEqual(vg.shot_blend_seconds('cut', 5, 5), .25)
        with mock.patch.dict(os.environ, {'VIDEO_SHOT_BLEND_SECONDS': '99'}):
            self.assertEqual(vg.shot_blend_seconds('cut', 5, 5), .5)
        with mock.patch.dict(os.environ, {'VIDEO_SHOT_BLEND_SECONDS': '-1'}):
            self.assertEqual(vg.shot_blend_seconds('cut', 5, 5), 0)
        with mock.patch.dict(os.environ, {'VIDEO_SHOT_BLEND_SECONDS': '0'}):
            self.assertEqual(vg.shot_blend_seconds('dissolve', 5, 5), .5)


if __name__ == '__main__':
    unittest.main()
