import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch
from scipy.ndimage import binary_fill_holes, binary_dilation

import numpy as np
from PIL import Image, ImageDraw, ImageFont

import video_edit
from video_edit_captions import detect_layers, protection_frame, prepare_caption_mask


def caption_fixture(colour=(245, 180, 5), position=(40, 112), text='HELLO', frames=12):
    """A moving source, a person, and text; replacement intentionally crosses text."""
    font_path = ('C:/Windows/Fonts/arialbd.ttf' if os.name == 'nt' else
                 '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf')
    font = ImageFont.truetype(font_path, 36)
    glyph_image = Image.new('L', (320, 180))
    ImageDraw.Draw(glyph_image).text(position, text, font=font, fill=255, anchor='lt')
    glyphs = np.array(glyph_image) > 240
    source, render, masks = [], [], []
    for i in range(frames):
        y, x = np.indices((180, 320))
        scene = np.stack((120 + (x+i*3) % 70, 110 + (y+i*4) % 70,
                          140 + (x+y+i*5) % 60), axis=-1).astype(np.uint8)
        mask = np.zeros((180, 320), np.uint8)
        mask[25:108, 102+i:143+i] = 255
        original = scene.copy(); original[mask > 0] = [180, 30, 50]
        im = Image.fromarray(original)
        ImageDraw.Draw(im).text(position, text, font=font, fill=tuple(colour),
                               stroke_width=2, stroke_fill=(20, 20, 20), anchor='lt')
        source.append(np.array(im))
        replacement = scene.copy()
        replacement[20:165, 95:175] = [15, 35, 240]
        render.append(replacement)
        mask[np.array(glyph_image) > 0] = 0  # foreground caption occludes the person
        masks.append(mask)
    return np.array(source), np.array(render), np.array(masks), glyphs


def encode(path, frames):
    height, width = frames.shape[1:3]
    pixel_format = 'gray' if frames.ndim == 3 else 'rgb24'
    subprocess.run(['ffmpeg', '-v', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', pixel_format,
                    '-s', f'{width}x{height}', '-r', '24', '-i', '-', '-an', '-c:v', 'ffv1',
                    str(path)], input=frames.tobytes(), capture_output=True, check=True)


def write_fixture(directory):
    source, render, masks, glyphs = caption_fixture()
    paths = {key: Path(directory) / f'{key}.mkv' for key in ('source', 'render', 'subject', 'alpha')}
    for key, frames in [('source', source), ('render', render), ('subject', masks)]:
        encode(paths[key], frames)
    # The generated subject and source erasure both enter the caption band.
    alpha = np.zeros_like(masks); alpha[:, 20:165, 95:175] = 255
    encode(paths['alpha'], alpha)
    return paths, source, render, masks, glyphs


class CaptionTests(unittest.TestCase):
    def test_real_ocr_varied_colours_and_positions(self):
        for colour, position in [((245, 180, 5), (40, 112)), ((250, 250, 250), (25, 5)),
                                 ((5, 5, 5), (50, 140)), ((0, 220, 230), (150, 135))]:
            with self.subTest(colour=colour, position=position):
                source, _, masks, glyphs = caption_fixture(colour, position)
                layers = detect_layers(source[::2], masks[::2])
                protected = protection_frame(source[-1], layers)
                self.assertGreater(np.mean(protected[glyphs] == 255), 0.95)
                # Font counters / gaps are not an opaque OCR rectangle.
                x, y = position
                self.assertLess(np.mean(protected[y:y+30, x:min(x+135, 320)] > 0), 0.9)

    def test_text_on_original_subject_is_not_preserved(self):
        source, _, masks, _ = caption_fixture(position=(80, 45))
        masks[:, 35:90, 70:240] = 255
        self.assertEqual(detect_layers(source[::2], masks[::2]), [])

    def test_moving_text_and_no_text_do_not_make_a_static_layer(self):
        source, _, masks, _ = caption_fixture()
        moving = np.array([np.roll(frame, i*15, axis=1) for i, frame in enumerate(source)])
        self.assertEqual(detect_layers(moving[::2], np.zeros_like(masks[::2])), [])
        plain = np.full_like(source, [80, 100, 140])
        self.assertEqual(detect_layers(plain[::2], masks[::2]), [])

    def test_caption_disappearance_does_not_cut_holes_in_replacement(self):
        source, _, masks, _ = caption_fixture()
        layers = detect_layers(source[::2], masks[::2])
        self.assertTrue(layers)
        blank = np.full_like(source[0], [80, 100, 140])
        self.assertFalse(protection_frame(blank, layers).any())

    def test_bad_geometry_and_short_samples(self):
        source, _, masks, _ = caption_fixture()
        with self.assertRaises(ValueError):
            detect_layers(source, masks[:2])
        self.assertEqual(detect_layers(source[:2], masks[:2]), [])

    def test_real_compositor_protects_text_after_dilation_and_feather(self):
        with tempfile.TemporaryDirectory() as directory:
            paths, source, render, _, glyphs = write_fixture(directory)
            for expand in (False, True):
                output = Path(directory) / f'result-{expand}.mp4'
                video_edit.composite_segment(paths['source'], paths['render'], paths['alpha'],
                    output, len(source), dilate=expand, feather=expand, subject_mask=paths['subject'])
                decoded = np.array([np.frombuffer(data, np.uint8).reshape(180, 320, 3) for data in
                    video_edit.decoded_frames(output, 'rgb24', 180*320*3, len(source)+1)])
                self.assertEqual(len(decoded), len(source))
                # Full caption pixels agree with the source even under the new feet.
                self.assertLess(np.abs(decoded[:, glyphs].astype(float)-source[:, glyphs]).mean(), 12)
                counters = binary_fill_holes(glyphs) & ~binary_dilation(glyphs, iterations=4)
                counters[:, :95] = False; counters[:, 175:] = False
                self.assertTrue(counters.any())
                self.assertLess(np.abs(decoded[:, counters].astype(float)-render[:, counters]).mean(), 15)
                # Face/interior stays generated, not frozen original footage.
                self.assertLess(np.abs(decoded[:, 40:90, 115:135].astype(float)-render[:, 40:90, 115:135]).mean(), 8)
                report = json.loads(output.with_suffix('.captions.json').read_text())
                self.assertEqual(report['status'], 'protected')

    def test_missing_ocr_stops_edit_with_a_report(self):
        with tempfile.TemporaryDirectory() as directory:
            paths, source, *_ = write_fixture(directory)
            output = Path(directory) / 'result.mp4'
            with patch('video_edit_captions.ocr_words', side_effect=FileNotFoundError('tesseract')):
                with self.assertRaisesRegex(RuntimeError, 'caption protection failed'):
                    video_edit.composite_segment(paths['source'], paths['render'], paths['alpha'],
                        output, len(source), subject_mask=paths['subject'])
            self.assertFalse(output.exists())
            self.assertEqual(json.loads(output.with_suffix('.captions.json').read_text())['status'], 'error')

    def test_short_source_mask_fails_instead_of_truncating_video(self):
        with tempfile.TemporaryDirectory() as directory:
            paths, source, _, masks, _ = write_fixture(directory)
            encode(paths['subject'], masks[:3])
            with self.assertRaisesRegex(RuntimeError, 'caption protection failed'):
                prepare_caption_mask(paths['source'], paths['subject'], Path(directory)/'mask.mkv', len(source))


if __name__ == '__main__':
    unittest.main()
