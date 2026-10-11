"""CPU-only regression tests using actual encoded media and the production paths."""
import asyncio
import json
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import video_gen
import video_worker
from video_metadata import read_workflows, preserve_joined_workflows
from video_recovery import normalize_clip, join_clips
from video_source_audio import finalize_song_video


class WorkflowMetadataTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.ffmpeg = shutil.which('ffmpeg') or video_gen.ffmpeg_executable()
        self.prompt = {'1': {'class_type': 'Text', 'inputs': {'text': 'duck = 🦆; #hello\nline two'}}}
        self.source = self.root / 'source.mp4'
        self.run_media([self.ffmpeg, '-v', 'error', '-f', 'lavfi', '-i', 'color=s=96x64:r=24:d=1',
                        '-f', 'lavfi', '-i', 'sine=duration=1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
                        '-c:a', 'aac', '-metadata', 'prompt=' + json.dumps(self.prompt),
                        '-movflags', '+use_metadata_tags', str(self.source)])

    def run_media(self, command):
        subprocess.run(command, check=True, capture_output=True, timeout=90)

    def check_prompt(self, path):
        self.assertEqual(read_workflows(path), [{'prompt': self.prompt}])

    def test_generation_finish_loudness_and_two_pass_discord_compression(self):
        finished = self.root / 'finished.mp4'
        self.run_media(video_gen.segment_delivery_finish_command(self.ffmpeg, self.source, finished, 1, None))
        self.check_prompt(finished)
        worker = video_worker.DesktopVideoWorker.__new__(video_worker.DesktopVideoWorker)
        normalized = asyncio.run(worker.normalize_delivery_audio(self.ffmpeg, finished, 'test-job'))
        self.assertNotEqual(normalized, finished)
        self.check_prompt(normalized)
        destination = self.root / 'compressed.mp4'
        for number in (1, 2):
            self.run_media(video_worker.discord_transcode_command(self.ffmpeg, normalized, destination,
                           200_000, 64_000, 96, 24, number, self.root / 'pass'))
        self.check_prompt(destination)

    def test_recovery_normalization_and_single_clip_concat(self):
        normalized = normalize_clip(self.source, self.root / 'normalized.mp4')
        self.check_prompt(normalized)
        self.check_prompt(join_clips([normalized], self.root / 'joined.mp4'))

    def test_song_trim_and_audio_mux_preserve_graph(self):
        output = finalize_song_video(self.ffmpeg, [self.source],
            [{'source_audio_frames': 24, 'source_audio_start_seconds': 0}],
            self.source, self.root / 'song.mp4')
        self.check_prompt(output)

    def test_join_keeps_all_scene_graphs_and_metadata_file_escaping(self):
        second = self.root / 'second.mp4'
        other = {'2': {'class_type': 'Text', 'inputs': {'text': 'second scene'}}}
        self.run_media([self.ffmpeg, '-v', 'error', '-i', str(self.source), '-c', 'copy',
                        '-metadata', 'prompt=' + json.dumps(other), '-movflags', '+use_metadata_tags', str(second)])
        joined = join_clips([self.source, second], self.root / 'joined.mp4')
        self.assertEqual(read_workflows(joined), [{'prompt': self.prompt}, {'prompt': other}])
        # Nested joins flatten the existing collection instead of dropping later scenes.
        copy = self.root / 'copy.mp4'
        shutil.copyfile(joined, copy)
        preserve_joined_workflows([joined, self.source], copy, self.ffmpeg)
        self.assertEqual(read_workflows(copy), [{'prompt': self.prompt}, {'prompt': other}, {'prompt': self.prompt}])


if __name__ == '__main__':
    unittest.main()
