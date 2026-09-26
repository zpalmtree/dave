import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path

import video_edit

LIVE = Path(os.environ.get('VIDEO_DESKTOP_DIR', '/mnt/d/AI/ComfyUI_windows_portable/video_gen'))


class VideoEditTests(unittest.TestCase):
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
