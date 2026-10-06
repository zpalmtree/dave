"""Regression: alpha is coverage, never a hidden black background."""
import base64
import io
from pathlib import Path
import tempfile
import unittest

from PIL import Image
from video_recovery import data_image, image_rgb, save_image


class TransparentSourceTests(unittest.TestCase):
    def test_transparent_and_partial_pixels_are_composited_without_changing_opaque_subject(self):
        source = Image.new('RGBA', (3, 1))
        source.putdata([(0, 0, 0, 0), (0, 0, 0, 128), (31, 61, 91, 255)])
        with io.BytesIO() as encoded, tempfile.TemporaryDirectory() as folder:
            source.save(encoded, format='PNG')
            path = Path(folder) / 'source.png'
            save_image('data:image/png;base64,' + base64.b64encode(encoded.getvalue()).decode(), path)
            with Image.open(path) as saved:
                self.assertEqual(list(saved.getdata()), [(255, 255, 255), (127, 127, 127), (31, 61, 91)])

    def test_palette_transparency_is_supported(self):
        source = Image.new('P', (2, 1))
        source.putpalette([0, 0, 0, 31, 61, 91] + [0] * 762)
        source.putdata([0, 1])
        source.info['transparency'] = 0
        self.assertEqual(list(image_rgb(source).getdata()), [(255, 255, 255), (31, 61, 91)])

    def test_real_black_background_is_not_replaced(self):
        for mode, color in [('RGB', (0, 0, 0)), ('RGBA', (0, 0, 0, 255))]:
            self.assertEqual(image_rgb(Image.new(mode, (1, 1), color)).getpixel((0, 0)), (0, 0, 0))

    def test_review_image_uses_same_matte_as_renderer(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / 'transparent.png'
            Image.new('RGBA', (16, 16), (0, 0, 0, 0)).save(path)
            payload = data_image(path).split(',', 1)[1]
            with Image.open(io.BytesIO(base64.b64decode(payload))) as decoded:
                self.assertEqual(decoded.getpixel((8, 8)), (255, 255, 255))


if __name__ == '__main__':
    unittest.main()
