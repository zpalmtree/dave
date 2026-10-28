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


if __name__ == '__main__':
    unittest.main()
