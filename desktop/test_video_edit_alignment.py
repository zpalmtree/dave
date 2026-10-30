import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import numpy as np

import video_edit_alignment as alignment
import video_edit_composite as composite


class AlignmentTests(unittest.TestCase):
    def masks(self):
        source = np.zeros((64, 96), np.uint8)
        source[15:55, 30:65] = 255
        foreground = source.copy()
        foreground[10:55, 25:70] = 255
        background = np.full_like(source, 255)
        background[foreground > 0] = 0
        return source, foreground, background

    def validate(self, sources, replacements, frames):
        with patch('video_edit.decoded_frames', side_effect=[
                iter([s.tobytes() for s in sources]), iter([s.tobytes() for s in replacements])]):
            alignment.validate_alignment(Path('source'), Path('replacement'), 96, 64, frames)

    def test_background_mask_fails_even_with_plenty_of_selected_pixels(self):
        source, foreground, background = self.masks()
        self.validate([source], [foreground], 1)
        with self.assertRaisesRegex(alignment.ReplacementAlignmentError, 'misses the source subject'):
            self.validate([source], [background], 1)

    def test_late_bad_frame_cannot_hide_behind_good_opening(self):
        source, foreground, background = self.masks()
        with self.assertRaisesRegex(alignment.ReplacementAlignmentError, 'frame 2'):
            self.validate([source] * 3, [foreground, foreground, background], 3)

    def test_empty_source_transition_is_not_a_misalignment(self):
        source, foreground, _ = self.masks()
        blank = np.zeros_like(source)
        self.validate([blank, source], [blank, foreground], 2)

    def test_short_or_mismatched_evidence_fails(self):
        source, foreground, _ = self.masks()
        for sources, replacements in [([source], [foreground]), ([source, source], [foreground])]:
            with self.assertRaisesRegex(alignment.ReplacementAlignmentError, 'timeline|shorter'):
                self.validate(sources, replacements, 2)

    def test_point_retry_uses_source_interior_without_unioning_background_box(self):
        source, _, _ = self.masks()
        blank = np.zeros_like(source)
        with patch('video_edit.decoded_frames', return_value=iter([blank.tobytes(), source.tobytes()])):
            graph = alignment.source_point_graph('raw.mp4', Path('mask'), [0, 0, 96, 64], 96, 64, 2, 'test')
        self.assertEqual(graph['mask_image_0']['class_type'], 'EmptyImage')
        detect = graph['detect_1']['inputs']
        point, = json.loads(detect['positive_coords'])
        self.assertEqual(source[point['y'], point['x']], 255)
        self.assertNotIn('bboxes', detect)
        self.assertNotIn('conditioning', detect)
        self.assertEqual(graph['frame_1']['inputs']['batch_index'], 1)
        self.assertEqual(graph['mask_video']['inputs']['images'], ['batch_1', 0])

    def test_point_retry_is_bounded_and_rejects_incomplete_source(self):
        with self.assertRaises(ValueError):
            alignment.source_point_graph('raw.mp4', Path('mask'), [0, 0, 96, 64], 96, 64, 361, 'test')
        with patch('video_edit.decoded_frames', return_value=iter([])):
            with self.assertRaisesRegex(alignment.ReplacementAlignmentError, 'shorter'):
                alignment.source_point_graph('raw.mp4', Path('mask'), [0, 0, 96, 64], 96, 64, 1, 'test')

    def test_background_track_cannot_paint_correction_over_body(self):
        source_mask, _, background = self.masks()
        source = np.full((64, 96, 3), 150, np.float32)
        rendered = np.full_like(source, 80)
        result, state = composite.match_edge_background(source, rendered, source_mask, background,
                                                        np.full_like(rendered, 30))
        np.testing.assert_array_equal(result, rendered)
        self.assertIsNone(state)

    def test_both_silhouettes_are_protected_from_colour_correction(self):
        source, replacement, _ = self.masks()
        replacement[40:] = 0  # Valid overlap, with different lower-body shape.
        original = np.full((64, 96, 3), 120, np.float32)
        rendered = np.full_like(original, 80)
        matched, _ = composite.match_edge_background(original, rendered, source, replacement)
        np.testing.assert_array_equal(matched[(source | replacement) > 0],
                                      rendered[(source | replacement) > 0])

    def test_alignment_retry_runs_once_and_keeps_clean_render(self):
        import video_edit as edit
        source, _, _ = self.masks()
        for result in ('good', 'bad', 'service'):
            with self.subTest(result=result), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                rendered = root / 'render.mp4'; rendered.write_bytes(b'clean-animation')
                old = root / 'old.mp4'; old.write_bytes(b'background-mask')
                corrected = root / 'corrected.mp4'; corrected.write_bytes(b'foreground-mask')
                destination = root / 'replacement.mp4'
                second = RuntimeError('service unavailable') if result == 'service' else corrected
                validation = [alignment.ReplacementAlignmentError('background'),
                              alignment.ReplacementAlignmentError('still background') if result == 'bad' else None]
                with patch.object(edit, 'INPUT', root), \
                     patch.object(edit, 'decoded_frames', return_value=iter([source.tobytes()])), \
                     patch.object(edit, 'run_graph', side_effect=[old, second]) as run, \
                     patch.object(edit, 'validate_tracking_mask'), \
                     patch.object(alignment, 'validate_alignment', side_effect=validation), \
                     patch.object(alignment, 'source_point_graph', return_value={'point-retry': True}):
                    call = lambda: composite.track_replacement('server', rendered, old, [0, 0, 96, 64],
                                                                96, 64, 1, destination)
                    if result == 'good':
                        call()
                        self.assertEqual(destination.read_bytes(), b'foreground-mask')
                    elif result == 'bad':
                        with self.assertRaises(composite.ReplacementTrackingError): call()
                    else:
                        with self.assertRaisesRegex(RuntimeError, 'service unavailable') as error: call()
                        self.assertNotIsInstance(error.exception, composite.ReplacementTrackingError)
                self.assertEqual(run.call_count, 2)
                self.assertEqual(rendered.read_bytes(), b'clean-animation')
                self.assertFalse(list(root.glob('edit-matte-*.mp4')))
                record = json.loads((root / 'replacement-alignment.json').read_text())
                self.assertEqual(record['status'], 'tracked' if result == 'good' else 'failed')


if __name__ == '__main__':
    unittest.main()
