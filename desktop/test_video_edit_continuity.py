import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import numpy as np
from PIL import Image

import video_edit as edit
import video_edit_continuity as continuity


class ContinuityTests(unittest.TestCase):
    def fixture(self):
        y, x = np.mgrid[:96, :96]
        gray = (30 + (x * 3 + y * 5) % 190).astype(np.uint8)
        rgb = np.repeat(gray[:, :, None], 3, axis=2)
        mask = np.zeros((96, 96), np.uint8)
        mask[20:80, 25:75] = 255
        return rgb, mask

    def test_fades_and_exposure_changes_do_not_create_scene_cuts(self):
        frame, _ = self.fixture()
        for values in [np.linspace(0, 1, 36), np.linspace(1, 0, 36), [1] * 12 + [.4] * 12 + [1] * 12]:
            frames = [np.uint8(frame * value) for value in values]
            self.assertTrue(continuity.continuous_exposure(frames, 13))
            with patch.object(edit, 'decoded_frames', return_value=iter([
                    np.asarray(Image.fromarray(f).resize((64, 36))).tobytes() for f in frames])):
                self.assertEqual(edit.shot_cuts(Path('source'), len(frames)), [])

    def test_real_cuts_and_short_shots_survive_exposure_veto(self):
        frame, _ = self.fixture()
        other = np.flip(frame, axis=1).copy()
        frames = [frame] * 12 + [other] * 12
        self.assertFalse(continuity.continuous_exposure(frames, 12))
        solid = [np.zeros_like(frame)] * 12 + [np.full_like(frame, 255)] * 12
        self.assertFalse(continuity.continuous_exposure(solid, 12))
        self.assertEqual(edit.shot_ranges([1, 12], 24, min_frames=1), [(0, 1), (1, 12), (12, 24)])

    def test_flat_fade_is_continuous_but_not_an_abrupt_colour_cut(self):
        frames = [np.full((36, 64, 3), i * 7, np.uint8) for i in range(36)]
        self.assertTrue(continuity.continuous_exposure(frames, 13))

    def test_exposure_curve_marks_both_ramps_without_marking_steady_shots(self):
        frame, _ = self.fixture()
        for values in (np.linspace(0, 1, 36), np.linspace(1, 0, 36)):
            self.assertTrue(continuity.exposure_frames([np.uint8(frame * v) for v in values]).all())
        self.assertFalse(continuity.exposure_frames([frame] * 36).any())

    def test_dark_gap_requires_same_visible_subject_not_blackness_or_occlusion(self):
        frame, mask = self.fixture()
        dim = np.uint8(frame * .04)
        blank = np.zeros_like(mask)
        frames = [np.zeros_like(frame), dim, frame]
        self.assertEqual(continuity.dark_candidates(frames, [blank, blank, mask]), {1: 2})
        occluded = dim.copy(); occluded[mask > 0] = 0
        self.assertEqual(continuity.dark_candidates([occluded, frame], [blank, mask]), {})
        bright = frame.copy()
        self.assertEqual(continuity.dark_candidates([bright, frame], [blank, mask]), {})

    def test_dark_recovery_does_not_reach_across_a_long_missing_track(self):
        frame, mask = self.fixture(); blank = np.zeros_like(mask)
        candidates = continuity.dark_candidates([np.uint8(frame * .04)] * 20 + [frame], [blank] * 20 + [mask])
        self.assertNotIn(0, candidates)
        self.assertIn(19, candidates)

    def test_tracking_exposure_changes_brightness_without_inventing_black_content(self):
        frame, _ = self.fixture()
        dim = np.uint8(frame * .04)
        self.assertGreater(continuity.brighten(dim).mean(), dim.mean() * 10)
        self.assertFalse(continuity.brighten(np.zeros_like(frame)).any())
        np.testing.assert_array_equal(continuity.brighten(frame), frame)

    def test_review_contains_both_sides_of_join_and_missing_mask_transition(self):
        frame, mask = self.fixture(); blank = np.zeros_like(mask)
        source = [frame] * 8
        points = continuity.critical_frames(source, source, [blank, blank] + [mask] * 6, [(0, 4, 124), (4, 4, 124)])
        self.assertTrue({1, 2, 3, 4, 5}.issubset(points))

    def test_unexpected_output_pop_is_reviewed_while_source_cut_is_not_a_false_error(self):
        frame, mask = self.fixture()
        changed = frame.copy(); changed[mask > 0] = 255 - changed[mask > 0]
        source = [frame] * 8
        output = [frame] * 4 + [changed] * 4
        self.assertTrue({3, 4}.issubset(continuity.critical_frames(source, output, [mask] * 8, [(0, 8, 124)])))
        self.assertEqual(continuity.critical_frames(output, output, [mask] * 8, [(0, 8, 124)]), set())

    def test_dark_level_fit_can_follow_fade_instead_of_using_the_bright_render(self):
        rendered = np.linspace(.1, .9, 100, dtype=np.float32)
        gain, offset = edit.fit_levels(rendered * .03, rendered, prior=0)
        np.testing.assert_allclose(gain * rendered + offset, rendered * .03, atol=1e-6)
        gain, offset = edit.fit_levels(np.zeros(100), np.ones(100), prior=0)
        self.assertEqual(gain + offset, 0)

    def test_encoded_replacement_preserves_fade_and_dims_white_highlights(self):
        frame, _ = self.fixture()
        frame[30:55, 30:55] = 255
        source = [np.uint8(frame * value) for value in np.linspace(0, 1, 12)]
        original_decoder = edit.decoded_frames
        def decode(path, fmt, size, count, filters=None):
            values = source if path.name == 'source' else [frame] * 12 if path.name == 'render' else [np.zeros((96,96),np.uint8)] * 12
            return iter(value.tobytes() for value in values[:count])
        with tempfile.TemporaryDirectory() as directory:
            destination = Path(directory) / 'faded.mp4'
            with patch.object(edit, 'decoded_frames', side_effect=decode):
                edit.match_render_levels(Path('source'), Path('render'), Path('mask'), destination,
                                         12, 96, 96, region=[0,0,96,96])
            actual = [np.frombuffer(data,np.uint8).reshape(96,96,3) for data in
                      original_decoder(destination,'rgb24',96*96*3,12)]
            self.assertEqual(len(actual),12)
            self.assertLess(actual[0].max(),3)
            for expected, observed in zip(source,actual):
                self.assertLess(abs(float(observed.mean())-float(expected.mean())),3)
                self.assertLess(abs(float(observed[35:50,35:50].mean())-float(expected[35:50,35:50].mean())),4)

    def test_dark_recovery_keeps_target_selection_and_only_patches_confirmed_gap(self):
        frame, mask = self.fixture(); blank = np.zeros_like(mask)
        frames = [np.zeros_like(frame), np.uint8(frame * .04)] + [frame] * 10
        originals = [blank, blank] + [mask] * 122
        candidates = [blank] + [mask] * 123
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            clip, original = root / 'source.mp4', root / 'mask.mp4'
            def decode(path, fmt, size, count, filters=None):
                array = frames if path == clip else originals if path == original else candidates
                return iter([value.tobytes() for value in array[:count]])
            with patch.object(edit, 'INPUT', root), patch.object(edit, 'decoded_frames', side_effect=decode), \
                 patch.object(edit, 'clip_details', return_value=(.5, 96, 96)), \
                 patch.object(continuity, 'encode_rgb_frames'), patch('video_edit_source_recovery.reverse_clip'), \
                 patch.object(edit, 'track_subject', return_value=root / 'tracked.mp4') as track:
                result = continuity.recover_dark_source_track('server', clip, original, 'the kitten', 'group',
                                                               12, 124, root, 1)
            decoded = list(edit.decoded_frames(result, 'gray', 96 * 96, 124))
            self.assertEqual(len(decoded), 124)
            self.assertFalse(np.frombuffer(decoded[0], np.uint8).any())
            self.assertTrue(np.array_equal(np.frombuffer(decoded[1], np.uint8).reshape(96, 96), mask))
            self.assertEqual(track.call_args.args[2], 'the kitten')
            self.assertEqual(track.call_args.args[4], 'group')
            self.assertEqual(json.loads((root / 'dark-recovery-01.json').read_text())['recovered_frames'], [1])
            self.assertFalse(list(root.glob('edit-dark-*.mp4')))

    def test_quantized_frame_needs_partial_detection_and_an_independent_adjacent_anchor(self):
        frame, mask = self.fixture(); blank = np.zeros_like(mask)
        partial = blank.copy(); partial[40:55, 40:55] = 255
        for missing, detected, succeeds in [(1, partial, True), (1, blank, False), (2, partial, False)]:
            with self.subTest(missing=missing, detected=bool(detected.any())), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                clip, original, point_path = root/'source.mp4', root/'mask.mp4', root/'points.mp4'
                frames = [np.zeros_like(frame)] + [np.uint8(frame * .04)] * missing + [frame] * (11-missing)
                originals = [blank] * (missing+1) + [mask] * (123-missing)
                candidates = [blank] + [detected] * missing + [mask] * (123-missing)
                def decode(path, fmt, size, count, filters=None):
                    array = frames if path == clip else originals if path == original else [blank]*124 if path == point_path else candidates
                    return iter([value.tobytes() for value in array[:count]])
                with patch.object(edit, 'INPUT', root), patch.object(edit, 'decoded_frames', side_effect=decode), \
                     patch.object(edit, 'clip_details', return_value=(.5,96,96)), \
                     patch.object(continuity, 'encode_rgb_frames'), patch('video_edit_source_recovery.reverse_clip'), \
                     patch.object(edit, 'track_subject', return_value=root/'tracked.mp4'), \
                     patch.object(continuity, 'dark_point_masks', return_value=point_path) as points:
                    call = lambda: continuity.recover_dark_source_track('server',clip,original,'cat','primary',12,124,root,1)
                    if succeeds:
                        result = call()
                    else:
                        with self.assertRaisesRegex(RuntimeError, 'Could not recover'): call()
                    self.assertEqual(points.call_count,1)
                if succeeds:
                    decoded = list(edit.decoded_frames(result,'gray',96*96,124))
                    np.testing.assert_array_equal(np.frombuffer(decoded[1],np.uint8).reshape(96,96),mask)
                    self.assertEqual(json.loads((root/'dark-recovery-01.json').read_text())['adjacent_frames'],{'1':2})

    def test_tracking_backend_failure_stops_and_cleans_temporary_inputs(self):
        frame, mask = self.fixture(); blank=np.zeros_like(mask)
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);clip=root/'clip.mp4';original=root/'mask.mp4'
            def decode(path, fmt, size, count, filters=None):
                values=[np.uint8(frame*.04),frame] if path==clip else [blank,mask]
                return iter([value.tobytes() for value in values])
            with patch.object(edit,'INPUT',root), patch.object(edit,'decoded_frames',side_effect=decode), \
                 patch.object(edit,'clip_details',return_value=(.5,96,96)), \
                 patch.object(continuity,'encode_rgb_frames',side_effect=lambda _,p,*args:p.write_bytes(b'fixture')), \
                 patch('video_edit_source_recovery.reverse_clip',side_effect=lambda _,p,*args:p.write_bytes(b'fixture')), \
                 patch.object(edit,'track_subject',side_effect=RuntimeError('backend unavailable')):
                with self.assertRaisesRegex(RuntimeError,'backend unavailable'):
                    continuity.recover_dark_source_track('server',clip,original,'cat','primary',2,124,root,1)
            self.assertFalse(list(root.glob('edit-dark-*.mp4')))


if __name__ == '__main__':
    unittest.main()
