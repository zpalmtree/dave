import unittest
import tempfile
import subprocess
import json
from pathlib import Path
import numpy as np
from PIL import Image
from video_edge_repair import repair_mask, restore_protected, boundary_context, blend_frame_boundary, repair_frame_count, inpaint_inputs, assemble_segments, indexed_frames


class RepairTests(unittest.TestCase):
    def test_one_frame_cut_assembly_retains_every_frame_at_constant_rate(self):
        with tempfile.TemporaryDirectory() as directory:
            work = Path(directory); clips = []
            for index, count in enumerate([1, 15]):
                path = work / f'{index}.mp4'
                subprocess.run(['ffmpeg', '-v', 'error', '-f', 'lavfi', '-i',
                    f'color=c={"red" if index == 0 else "blue"}:s=64x64:r=24',
                    '-frames:v', str(count), '-c:v', 'libx264', str(path)], check=True)
                clips.append(path)
            output = work / 'joined.mp4'
            assemble_segments(clips, clips[1], output, work)
            probe = json.loads(subprocess.check_output(['ffprobe', '-v', 'error',
                '-select_streams', 'v:0', '-show_frames', '-show_streams',
                '-of', 'json', str(output)]))
            self.assertEqual(probe['streams'][0]['avg_frame_rate'], '24/1')
            self.assertEqual(len(probe['frames']), 16)
            for i, frame in enumerate(probe['frames']):
                self.assertAlmostEqual(float(frame['best_effort_timestamp_time']), i/24, places=5)
            raw = subprocess.check_output(['ffmpeg', '-v', 'error', '-i', str(output),
                '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'])
            pixels = np.frombuffer(raw, np.uint8).reshape(16, 64, 64, 3)
            self.assertGreater(pixels[0, 32, 32, 0], 200)
            self.assertTrue(np.all(pixels[1:, 32, 32, 2] > 200))
            sampled = indexed_frames(output, [0, 1, 15], 64, 64)
            for index in [0, 1, 15]:
                np.testing.assert_array_equal(sampled[index], pixels[index])
            with self.assertRaisesRegex(ValueError, 'every requested frame'):
                indexed_frames(output, [16], 64, 64)

    def test_continuous_shot_can_span_motion_windows_but_remains_bounded(self):
        for count in [1, 124, 131, 360]:
            self.assertEqual(repair_frame_count(count/24), count)
        for count in [0, -1, 361]:
            with self.assertRaisesRegex(ValueError, '1–360'):
                repair_frame_count(count/24)

    def fixture(self):
        source = np.zeros((160, 240), np.uint8); source[60:120, 45:95] = 255
        replacement = np.zeros_like(source); replacement[65:135, 60:115] = 255
        return source, replacement, replacement.copy(), [0, 30, 150, 160]

    def test_only_background_gap_is_repaired(self):
        source, replacement, alpha, box = self.fixture()
        mask = repair_mask(source, replacement, alpha, box)
        self.assertTrue(mask[70, 45])
        self.assertFalse(mask[80, 80])
        self.assertFalse(mask[0, 230])
        self.assertTrue(mask[80, 59])  # background beside the head is repairable

    def test_partial_foreground_protected_without_fixed_background_ring(self):
        source, replacement, alpha, box = self.fixture()
        alpha[70:110, 59] = 160  # antialiased hair/face boundary
        alpha[70:110, 58] = 64   # contaminated background fringe
        mask = repair_mask(source, replacement, alpha, box)
        self.assertFalse(mask[80, 59])
        self.assertTrue(mask[80, 58])
        self.assertTrue(mask[80, 57])

    def test_broad_uncertain_halo_is_not_protected_as_foreground(self):
        source, replacement, alpha, box = self.fixture()
        alpha[70:110, 50:60] = 160
        mask = repair_mask(source, replacement, alpha, box)
        self.assertFalse(mask[80, 58])  # narrow supported edge
        self.assertTrue(mask[80, 57])   # uncertain patch outside the core's edge
        self.assertTrue(mask[80, 50])

    def test_soft_matte_alone_does_not_pass_foreground_loss_check(self):
        source, replacement, alpha, box = self.fixture()
        alpha[alpha > 0] = 160
        with self.assertRaisesRegex(ValueError, 'lost'):
            repair_mask(source, replacement, alpha, box)

    def test_boundary_follows_moving_foreground_without_trailing_protection(self):
        source, replacement, alpha, box = self.fixture()
        before = repair_mask(source, replacement, alpha, box)
        replacement = np.roll(replacement, 8, axis=1)
        alpha = np.roll(alpha, 8, axis=1)
        after = repair_mask(source, replacement, alpha, box)
        self.assertFalse(before[80, 63])
        self.assertTrue(after[80, 63])
        self.assertFalse(after[80, 120])

    def test_empty_and_partial_foreground_fail_closed(self):
        source, replacement, alpha, box = self.fixture()
        for factor in [0, .5]:
            with self.assertRaisesRegex(ValueError, 'lost'):
                repair_mask(source, replacement, alpha*factor, box)
        alpha[:100] = 0
        alpha[110:] = 0
        with self.assertRaisesRegex(ValueError, 'lost'):
            repair_mask(source, replacement, alpha, box)

    def test_foreground_evidence_cannot_select_another_region(self):
        source, replacement, alpha, box = self.fixture()
        alpha[20, 200] = 255
        with self.assertRaisesRegex(ValueError, 'outside'):
            repair_mask(source, replacement, alpha, box)

    def test_canvas_and_crop_mismatch_rejected(self):
        source, replacement, alpha, box = self.fixture()
        with self.assertRaisesRegex(ValueError, 'equal-size'):
            repair_mask(source, replacement[:-1], alpha, box)
        with self.assertRaisesRegex(ValueError, 'crop'):
            repair_mask(source, replacement, alpha, [-1, 0, 150, 160])

    def test_nonfinite_or_out_of_range_alpha_rejected(self):
        source, replacement, alpha, box = self.fixture()
        for value in [np.nan, -1, 256]:
            candidate = alpha.astype(float); candidate[70, 80] = value
            with self.assertRaisesRegex(ValueError, 'alpha'):
                repair_mask(source, replacement, candidate, box)

    def test_overbroad_repair_rejected(self):
        source, replacement, alpha, box = self.fixture(); source[:] = 255
        with self.assertRaisesRegex(ValueError, 'too much'):
            repair_mask(source, replacement, alpha, box)

    def test_inpainting_cannot_change_protected_pixels(self):
        original = np.full((10, 20, 3), [10, 30, 50], np.uint8)
        prediction = np.full_like(original, 200)
        mask = np.zeros((10, 20), bool); mask[2:4, 5:8] = True
        result = restore_protected(original, prediction, mask)
        np.testing.assert_array_equal(result[~mask], original[~mask])
        np.testing.assert_array_equal(result[mask], prediction[mask])
        with self.assertRaisesRegex(ValueError, 'dimensions'):
            restore_protected(original, prediction[:-1], mask)


class BoundaryTests(unittest.TestCase):
    def test_one_frame_shot_gets_flow_context_without_changing_original_inputs(self):
        with tempfile.TemporaryDirectory() as directory:
            work = Path(directory)
            for name in ['frames', 'masks']:
                (work / name).mkdir()
                Image.fromarray(np.full((40, 40), 123, np.uint8)).save(work / name / '0000.png')
            context = inpaint_inputs(work)
            for name in ['frames', 'masks']:
                self.assertEqual(len(list((work / name).glob('*.png'))), 1)
                for index in range(2):
                    self.assertEqual((work / name / '0000.png').read_bytes(),
                                     (context / name / f'{index:04}.png').read_bytes())
            self.assertEqual(inpaint_inputs(context), context)

    def test_all_edges_corrected_without_changing_interior_or_protected_pixels(self):
        original = np.full((40, 40, 3), 80, np.uint8)
        padded = np.full((104, 104, 3), 20, np.uint8)
        base_mask = np.zeros((40, 40), bool); base_mask[5:35, :20] = True
        for turns in range(4):
            mask = np.rot90(base_mask, turns)
            actual = np.rot90(blend_frame_boundary(original, padded, mask), -turns)
            self.assertEqual(actual[20, 0, 0], 20)
            self.assertGreater(actual[20, 7, 0], 20)
            self.assertLess(actual[20, 7, 0], 80)
            np.testing.assert_array_equal(actual[:, 12:], original[:, 12:])
            np.testing.assert_array_equal(actual[~base_mask], original[~base_mask])

    def test_nonedge_repairs_keep_original_prediction(self):
        original = np.full((40, 40, 3), 80, np.uint8)
        padded = np.full((104, 104, 3), 20, np.uint8)
        mask = np.zeros((40, 40), bool); mask[1:39, 1:39] = True
        np.testing.assert_array_equal(blend_frame_boundary(original, padded, mask), original)

    def test_wrong_context_canvas_rejected(self):
        with self.assertRaisesRegex(ValueError, 'dimensions'):
            blend_frame_boundary(np.zeros((40, 40, 3)), np.zeros((104, 103, 3)), np.ones((40, 40), bool))

    def test_reflected_image_and_mask_stay_aligned(self):
        with tempfile.TemporaryDirectory() as directory:
            work = Path(directory)
            for name in ['frames', 'masks']:
                (work / name).mkdir()
            pixels = np.arange(40*40*3, dtype=np.uint8).reshape(40, 40, 3)
            mask = np.zeros((40, 40), np.uint8); mask[10:20, :5] = 255
            Image.fromarray(pixels).save(work / 'frames/0000.png')
            Image.fromarray(mask).save(work / 'masks/0000.png')
            context = boundary_context(work)
            padded = np.array(Image.open(context / 'frames/0000.png'))
            padded_mask = np.array(Image.open(context / 'masks/0000.png'))
            np.testing.assert_array_equal(padded[32:-32, 32:-32], pixels)
            np.testing.assert_array_equal(padded_mask[32:-32, 32:-32], mask)
            np.testing.assert_array_equal(padded[47, 31], pixels[15, 1])
            self.assertEqual(padded_mask[47, 31], 255)
            self.assertEqual(padded_mask[47, 26], 0)

    def test_context_pass_skipped_when_no_frame_edge_is_repaired(self):
        with tempfile.TemporaryDirectory() as directory:
            work = Path(directory); (work / 'masks').mkdir()
            mask = np.zeros((40, 40), np.uint8); mask[1:39, 1:39] = 255
            Image.fromarray(mask).save(work / 'masks/0000.png')
            self.assertIsNone(boundary_context(work))
            self.assertFalse((work / 'boundary-context').exists())


if __name__ == '__main__':
    unittest.main()
