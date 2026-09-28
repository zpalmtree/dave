import json
import hashlib
import os
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import video_edit

LIVE = Path(os.environ.get('VIDEO_DESKTOP_DIR', str(video_edit.ROOT) if video_edit.TEMPLATE.is_file()
                           else '/mnt/d/AI/ComfyUI_windows_portable/video_gen'))


class VideoEditTests(unittest.TestCase):
    def make_mask(self, path, color="black", filters=None, pixel_format="yuv420p"):
        args = ["ffmpeg", "-nostdin", "-v", "error", "-y", "-f", "lavfi", "-i",
                f"color=c={color}:s=160x96:r=24:d=1"]
        if filters:
            args += ["-vf", filters]
        subprocess.run(args + ["-c:v", "libx264", "-crf", "0", "-pix_fmt", pixel_format,
                               str(path)], check=True)

    def test_black_and_full_masks_fail_for_both_video_color_ranges(self):
        with tempfile.TemporaryDirectory() as directory:
            mask = Path(directory) / "mask.mp4"
            for pixel_format in ("yuv420p", "yuvj420p"):
                for color, expected in (("black", 0), ("white", 1)):
                    with self.subTest(pixel_format=pixel_format, color=color):
                        self.make_mask(mask, color=color, pixel_format=pixel_format)
                        self.assertEqual(video_edit.mask_frame_coverages(mask), [expected] * 24)
                        with self.assertRaisesRegex(RuntimeError, "Could not reliably isolate"):
                            video_edit.validate_tracking_mask(mask, "the subject", 24)

    def test_valid_selection_counts_pixels_and_accepts_brief_occlusion(self):
        with tempfile.TemporaryDirectory() as directory:
            mask = Path(directory) / "mask.mp4"
            self.make_mask(mask, filters="drawbox=x=40:y=24:w=40:h=48:color=white:t=fill:enable='gte(n,3)'")
            coverage = video_edit.validate_tracking_mask(mask, "the red car", 24)
            self.assertAlmostEqual(coverage, (40 * 48 / (160 * 96)) * 21 / 24, places=4)

    def test_tiny_detections_and_mostly_lost_tracks_fail(self):
        with tempfile.TemporaryDirectory() as directory:
            mask = Path(directory) / "mask.mp4"
            for filters in (
                "drawbox=x=40:y=24:w=2:h=2:color=white:t=fill",
                "drawbox=x=40:y=24:w=40:h=48:color=white:t=fill:enable='lt(n,2)'",
            ):
                with self.subTest(filters=filters):
                    self.make_mask(mask, filters=filters)
                    with self.assertRaisesRegex(RuntimeError, "visible appearance and position"):
                        video_edit.validate_tracking_mask(mask, "the subject", 24)

    def test_model_padding_cannot_hide_failed_tracking_or_missing_frames(self):
        with tempfile.TemporaryDirectory() as directory:
            mask = Path(directory) / "mask.mp4"
            self.make_mask(mask, filters="drawbox=x=40:y=24:w=40:h=48:color=white:t=fill:enable='gte(n,4)'")
            with self.assertRaisesRegex(RuntimeError, "Could not reliably isolate"):
                video_edit.validate_tracking_mask(mask, "the subject", 4)
            with self.assertRaisesRegex(RuntimeError, "shorter than the source"):
                video_edit.validate_tracking_mask(mask, "the subject", 25)

    def test_failed_tracking_stops_before_diffusion_or_output(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            mask = root / "mask.mp4"
            self.make_mask(mask)
            reference = root / "reference.png"
            reference.write_bytes(b"unused reference")
            output = root / "edited.mp4"
            args = ["video_edit.py", "--clip", str(root / "source.mp4"), "--image", str(reference),
                    "--target", "the subject", "--prompt", "a blue car", "--output", str(output)]
            with patch.object(video_edit.sys, "argv", args), \
                 patch.object(video_edit, "INPUT", root / "input"), \
                 patch.object(video_edit, "required_models"), \
                 patch.object(video_edit, "clip_details", return_value=(1, 160, 96)), \
                 patch.object(video_edit, "normalized_clip"), \
                 patch.object(video_edit, "segment_clip"), \
                 patch.object(video_edit, "run_graph", return_value=mask) as run_graph, \
                 patch.object(video_edit, "tracked_edit_mask") as expand, \
                 patch.object(video_edit, "join_segments") as join:
                with self.assertRaisesRegex(RuntimeError, "Could not reliably isolate"):
                    video_edit.main()
                self.assertEqual(run_graph.call_count, 1)
                self.assertEqual(run_graph.call_args.args[2], "save_mask")
                expand.assert_not_called()
                join.assert_not_called()
                self.assertFalse(output.exists())

    def test_short_clip_is_padded_for_h3_and_trimmed_to_source_length(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "source.mp4"
            normalized = root / "normalized.mp4"
            padded = root / "padded.mp4"
            trimmed = root / "trimmed.mp4"
            output = root / "joined.mp4"
            subprocess.run(["ffmpeg", "-nostdin", "-v", "error", "-y",
                            "-f", "lavfi", "-i", "testsrc2=size=160x96:rate=30",
                            "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000",
                            "-t", "2.2", "-c:v", "libx264", "-c:a", "aac", str(source)],
                           check=True)
            duration, _, _ = video_edit.clip_details(source)
            self.assertAlmostEqual(duration, 2.2, delta=0.05)
            plan = video_edit.segment_plan(duration)
            self.assertEqual(len(plan), 1)
            start, source_frames, model_frames = plan[0]
            self.assertEqual((start, source_frames, model_frames), (0, 53, 124))
            video_edit.normalized_clip(source, normalized, 160, 96, source_frames)
            video_edit.segment_clip(normalized, padded, start, source_frames, model_frames)
            video_edit.command("ffmpeg", "-nostdin", "-v", "error", "-y",
                               "-i", str(padded), "-frames:v", str(source_frames),
                               "-an", "-c:v", "libx264", str(trimmed))
            video_edit.join_segments([trimmed], source, output, duration, root)
            def frames(path):
                info = json.loads(video_edit.command("ffprobe", "-v", "error",
                                                     "-select_streams", "v:0", "-of", "json",
                                                     "-show_entries", "stream=nb_frames", str(path)))
                return int(info["streams"][0]["nb_frames"])
            self.assertEqual(frames(padded), 124)
            self.assertEqual(frames(output), 53)
            self.assertAlmostEqual(video_edit.clip_details(output)[0], duration, delta=0.05)

    def test_long_clip_segments_keep_every_frame_and_original_audio(self):
        self.assertEqual(video_edit.segment_plan(120),
                         [(index * 360, 360, 362) for index in range(8)])
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "source.mp4"
            normalized = root / "normalized.mp4"
            output = root / "joined.mp4"
            subprocess.run(["ffmpeg", "-nostdin", "-v", "error", "-y",
                            "-f", "lavfi", "-i", "testsrc2=size=160x96:rate=30",
                            "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000",
                            "-t", "16.2", "-c:v", "libx264", "-c:a", "aac", str(source)],
                           check=True)
            duration, _, _ = video_edit.clip_details(source)
            plan = video_edit.segment_plan(duration)
            self.assertEqual(len(plan), 2)
            source_frames = sum(length for _, length, _ in plan)
            self.assertEqual(source_frames, 389)
            video_edit.normalized_clip(source, normalized, 160, 96, source_frames)
            segments = []
            for index, (start, length, model_frames) in enumerate(plan):
                padded = root / f"padded-{index}.mp4"
                rendered = root / f"rendered-{index}.mp4"
                mask = root / f"mask-{index}.mp4"
                segment = root / f"segment-{index}.mp4"
                video_edit.segment_clip(normalized, padded, start, length, model_frames)
                video_edit.command("ffmpeg", "-nostdin", "-v", "error", "-y",
                                   "-f", "lavfi", "-i", "color=c=red:s=160x96:r=24",
                                   "-frames:v", str(model_frames), "-c:v", "libx264", str(rendered))
                video_edit.command("ffmpeg", "-nostdin", "-v", "error", "-y",
                                   "-f", "lavfi", "-i", "color=c=black:s=160x96:r=24",
                                   "-vf", "drawbox=x=48:y=24:w=64:h=48:color=white:t=fill",
                                   "-frames:v", str(model_frames), "-c:v", "libx264", str(mask))
                video_edit.composite_segment(padded, rendered, mask, segment, length)
                segments.append(segment)
            video_edit.join_segments(segments, source, output, duration, root)
            info = json.loads(video_edit.command("ffprobe", "-v", "error", "-of", "json",
                                                 "-show_entries", "stream=codec_type,nb_frames:format=duration",
                                                 str(output)))
            self.assertEqual(int(info["streams"][0]["nb_frames"]), source_frames)
            self.assertAlmostEqual(float(info["format"]["duration"]), duration, delta=0.05)
            def audio_hash(path):
                result = subprocess.run(["ffmpeg", "-nostdin", "-v", "error", "-i", str(path),
                                         "-map", "0:a:0", "-c", "copy", "-f", "adts", "-"],
                                        check=True, capture_output=True)
                return hashlib.sha256(result.stdout).hexdigest()
            self.assertEqual(audio_hash(output), audio_hash(source))

    def test_tracked_edit_mask_expands_subject_to_moving_replacement_region(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "track.mp4"
            expanded = Path(directory) / "expanded.mp4"
            subprocess.run(["ffmpeg", "-nostdin", "-v", "error", "-y",
                            "-f", "lavfi", "-i", "color=c=black:s=320x180:r=24:d=1",
                            "-vf", "drawbox=x=100:y=60:w=60:h=40:color=white:t=fill",
                            "-an", "-c:v", "libx264", str(source)], check=True)
            video_edit.tracked_edit_mask(source, expanded, 320, 180)
            frame = video_edit.rgb_frame(expanded, 0.5, 320, 180)
            self.assertGreater(int(frame[40, 80, 0]), 245)
            self.assertGreater(int(frame[80, 150, 0]), 245)
            self.assertLess(int(frame[30, 70, 0]), 10)

    def test_normalized_video_keeps_timeline_and_uses_h3_frame_grid(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "source.mp4"
            normalized = root / "normalized.mp4"
            subprocess.run(["ffmpeg", "-nostdin", "-v", "error", "-y",
                            "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=30",
                            "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000",
                            "-t", "5.2", "-c:v", "libx264", "-c:a", "aac", str(source)],
                           check=True)
            duration, width, height = video_edit.clip_details(source)
            frames = video_edit.legal_frames(duration)
            self.assertEqual(frames % 17, 5)
            self.assertEqual((width, height), (320, 180))
            self.assertEqual(video_edit.audio_codec(source), "aac")
            self.assertEqual(video_edit.canvas(1920, 1080), (896, 512))
            self.assertEqual(video_edit.canvas(320, 180), (288, 160))
            video_edit.normalized_clip(source, normalized, 320, 160, frames)
            info = json.loads(video_edit.command("ffprobe", "-v", "error", "-select_streams", "v:0",
                                                "-show_entries", "stream=nb_frames,width,height",
                                                "-of", "json", str(normalized)))
            self.assertEqual(int(info["streams"][0]["nb_frames"]), frames)
            self.assertEqual((info["streams"][0]["width"], info["streams"][0]["height"]), (320, 160))

    def test_render_graph_uses_tracked_video_and_replacement_image(self):
        template = video_edit.TEMPLATE
        video_edit.TEMPLATE = LIVE / 'templates' / 'h3_i2v.json'
        try:
            graph = video_edit.render_graph("source.mp4", "replacement.png", "mask.mp4",
                                           "Keep the camera move.", 768, 432, 141, "test/edit")
        finally:
            video_edit.TEMPLATE = template
        self.assertEqual(graph["105:6"]["inputs"]["unet_name"], video_edit.REF_MODEL)
        self.assertEqual(graph["105:104"]["class_type"], "MiniMaxH3ReferenceToVideo")
        self.assertEqual(graph["105:104"]["inputs"]["ref_images.ref_image_0"], ["replacement", 0])
        self.assertNotIn("ref_videos.ref_video_0", graph["105:104"]["inputs"])
        self.assertIn("<Picture 1> is the new subject", graph["105:104"]["inputs"]["prompt"])
        self.assertEqual(graph["patched_model"]["inputs"]["mask"], ["mask", 0])
        self.assertEqual(graph["patched_model"]["inputs"]["source_video"], ["source_frames", 0])
        self.assertEqual(graph["105:16"]["inputs"]["model"], ["patched_model", 0])
        self.assertEqual(graph["105:124"]["inputs"]["value"], 40)
        for name, component in graph.items():
            for value in component["inputs"].values():
                if isinstance(value, list) and len(value) == 2 and isinstance(value[0], str):
                    self.assertIn(value[0], graph, f"{name} references a removed node")


if __name__ == "__main__":
    unittest.main()
