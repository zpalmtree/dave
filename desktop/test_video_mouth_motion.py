"""CPU-only geometry, isolation, timeline and fallback contracts."""
import json
from pathlib import Path
import tempfile
import types
import unittest
from unittest import mock
import numpy as np
import video_mouth_motion as motion


def face(gap=8):
    points = np.zeros((106, 2), dtype=np.float64)
    for index, angle in enumerate(np.linspace(0, 2 * np.pi, 20, endpoint=False)):
        points[52 + index] = [50 + 20 * np.cos(angle), 45 + 12 * np.sin(angle)]
    points[52], points[61] = [30, 45], [70, 45]
    points[62], points[60] = [50, 45 - gap / 2], [50, 45 + gap / 2]
    return points


class MouthMotionTests(unittest.TestCase):
    def test_aperture_is_normalized_for_character_scale(self):
        points = face()
        self.assertAlmostEqual(motion.aperture(points), .2)
        self.assertAlmostEqual(motion.aperture(points * 2 + 20), .2)

    def test_tiny_invalid_and_steep_faces_are_rejected(self):
        for points in [face() * .1, np.full((106, 2), np.nan), face()[:, ::-1], np.zeros((5, 2))]:
            with self.subTest(shape=points.shape), self.assertRaises(ValueError):
                motion.mouth_shape(points)

    def test_source_openings_follow_original_frames_without_crossing_shot_cuts(self):
        source = [face(2)] * 4 + [face(14)] * 4
        edited = [face(8)] * 8
        delta = motion.correction_deltas(source, edited, [[0, 4, 124], [4, 4, 124]])
        np.testing.assert_allclose(delta[:4], -6)
        np.testing.assert_allclose(delta[4:], 6)
        for segments in [[[0, 7, 124]], [[0, 5, 124], [4, 4, 124]], [[-1, 8, 124]]]:
            with self.assertRaises(ValueError):
                motion.correction_deltas(source, edited, segments)

    def test_extreme_source_motions_are_bounded(self):
        delta = motion.correction_deltas([face(60)] * 3, [face(2)] * 3, [[0, 3, 124]])
        np.testing.assert_allclose(delta, 40 * .16)
        with self.assertRaises(ValueError):
            motion.correction_deltas([face()], [], [[0, 1, 124]])

    def test_warp_changes_only_the_selected_mouth_neighborhood(self):
        rng = np.random.default_rng(7)
        frame = rng.integers(0, 255, (100, 120, 3), dtype=np.uint8)
        selected = np.zeros((100, 120), dtype=bool)
        selected[35:60, 35:65] = True
        corrected = motion.warp_mouth(frame, face(), -5, selected)
        np.testing.assert_array_equal(corrected[~selected], frame[~selected])
        self.assertGreater(np.count_nonzero(corrected[selected] != frame[selected]), 0)
        np.testing.assert_array_equal(frame[:20], corrected[:20])
        np.testing.assert_array_equal(frame[80:], corrected[80:])

    def test_zero_correction_preserves_every_pixel(self):
        frame = np.full((100, 120, 3), 72, dtype=np.uint8)
        np.testing.assert_array_equal(motion.warp_mouth(frame, face(), 0, np.ones((100,120), bool)), frame)

    def test_caption_regions_scale_to_output_and_remain_local_to_their_shot(self):
        with tempfile.TemporaryDirectory() as temporary:
            work = Path(temporary)
            (work/'captions-01.json').write_text(json.dumps({'layers': [
                {'box':[10,20,30,40], 'analysis_canvas':[100,50]}]}))
            (work/'captions-02.json').write_text('{"layers": []}')
            regions = motion.caption_regions(work, {'width':200,'height':100,
                'segments':[[0,24,124],[24,24,124]]})
            self.assertEqual(regions, [(0,24,18,38,62,82)])

    def test_face_selection_requires_the_entire_mouth_inside_the_subject(self):
        frame = np.zeros((100, 120, 3), dtype=np.uint8)
        mask = frame.copy()
        mask[25:65, 25:75] = 255
        selected = types.SimpleNamespace(bbox=[30, 20, 70, 80], det_score=.75, landmark_2d_106=face())
        # Its center overlaps the track, but its mouth belongs to the other person.
        other = types.SimpleNamespace(bbox=[20, 20, 70, 80], det_score=.99, landmark_2d_106=face()+[45, 0])
        app = mock.Mock()
        app.get.return_value = [other, selected]
        video, masks = mock.Mock(), mock.Mock()
        video.read.side_effect = [(True, frame), (False, None)]
        masks.read.return_value = (True, mask)
        with mock.patch.object(motion.cv2, 'VideoCapture', side_effect=[video, masks]):
            tracked = motion.track_faces(app, 'video', 'mask', 1)
        np.testing.assert_array_equal(tracked[0], selected.landmark_2d_106)
        video.release.assert_called_once()
        masks.release.assert_called_once()

    def test_ambiguous_faces_preserve_the_existing_render(self):
        frame = np.zeros((100, 120, 3), dtype=np.uint8)
        valid = types.SimpleNamespace(bbox=[30, 20, 70, 80], det_score=.9, landmark_2d_106=face())
        app = mock.Mock()
        app.get.return_value = [valid, valid]
        video, masks = mock.Mock(), mock.Mock()
        video.read.return_value = (True, frame)
        masks.read.return_value = (True, np.full_like(frame, 255))
        with mock.patch.object(motion.cv2, 'VideoCapture', side_effect=[video, masks]), \
                self.assertRaisesRegex(ValueError, 'unambiguous'):
            motion.track_faces(app, 'video', 'mask', 1)

    def test_long_or_large_inputs_skip_before_loading_models(self):
        with mock.patch.object(motion, 'faces_app') as app:
            for frames, width, height in [(241, 448, 256), (72, 1920, 1080), (10, 448, 256)]:
                result = motion.refine(None, None, None,
                    {'segments': [[0, frames, 300]], 'width': width, 'height': height}, None)
                self.assertEqual(result['action'], 'none')
            app.assert_not_called()

    def test_cli_failure_removes_candidate_and_records_fallback(self):
        import sys
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root/'state').write_text('{}')
            output, report = root/'output.mp4', root/'report.json'
            args=['mouth']
            for name in ['source','video','mask','state']:
                args += ['--'+name,str(root/name)]
            args += ['--output',str(output),'--result',str(report)]
            def fail(*_):
                output.write_bytes(b'incomplete')
                raise ValueError('No unambiguous tracked face')
            with mock.patch.object(sys,'argv',args), mock.patch.object(motion,'refine',side_effect=fail):
                motion.main()
            self.assertFalse(output.exists())
            self.assertEqual(json.loads(report.read_text())['action'],'none')
            self.assertIn('unambiguous',json.loads(report.read_text())['reason'])


if __name__ == '__main__':
    unittest.main()
