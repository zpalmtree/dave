import unittest
import numpy as np
from video_edge_repair import repair_mask, restore_protected


class RepairTests(unittest.TestCase):
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
        self.assertFalse(mask[80, 59])  # two-pixel protection around confident head

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


if __name__ == '__main__':
    unittest.main()
