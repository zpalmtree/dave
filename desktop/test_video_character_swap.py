import argparse
import hashlib
import json
import math
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parent
LIVE = Path(os.environ.get('VIDEO_DESKTOP_DIR', str(ROOT) if (ROOT / 'templates').is_dir()
                           else '/mnt/d/AI/ComfyUI_windows_portable/video_gen'))
sys.path.insert(0, str(LIVE))
import video_edit
sys.path.insert(0, str(ROOT))
import video_character_swap as swap


class CharacterSwapTests(unittest.TestCase):
    def test_graph_uses_aligned_source_and_native_reference_with_approved_sampling(self):
        graph = swap.render_graph('source.mp4', 'ref.png', 'the woman in red', 'a robot',
                                  'primary', 544, 640, 'test/swap')
        self.assertEqual(graph['source']['inputs']['file'], 'source.mp4')
        self.assertEqual(graph['cond']['inputs']['ref_images.ref_image_0'], ['reference', 0])
        self.assertEqual(graph['guide']['inputs']['image'], ['frames', 0])
        self.assertEqual(graph['guide']['inputs']['frame_idx'], 0)
        self.assertEqual(graph['guider']['inputs']['positive'], ['guide', 0])
        self.assertEqual(graph['sample']['inputs']['latent_image'], ['cond', 1])
        self.assertEqual(graph['model']['inputs']['unet_name'], video_edit.REF_MODEL)
        self.assertEqual(graph['swap']['inputs']['lora_name'], swap.SWAP_LORA)
        self.assertEqual(graph['turbo']['inputs']['lora_name'], swap.TURBO_LORA)
        self.assertEqual(graph['scheduler']['inputs']['steps'], 8)
        self.assertEqual(graph['sampler']['inputs']['sampler_name'], 'euler')
        self.assertEqual(graph['guider']['inputs']['cfg'], 1)
        self.assertEqual(graph['shift']['inputs']['shift_video'], 12)
        self.assertEqual(graph['cond']['inputs']['length'], 124)
        self.assertNotIn('audio', graph['video']['inputs'])
        self.assertFalse(any('FunControlNet' in node['class_type'] or 'SAM3' in node['class_type']
                             for node in graph.values()))
        for node in graph.values():
            for value in node['inputs'].values():
                if isinstance(value, list):
                    self.assertIn(value[0], graph)

    def test_prompt_preserves_grounded_target_and_single_or_group_selection(self):
        single = swap.swap_prompt('the woman in red', 'use the robot reference', 'primary')
        group = swap.swap_prompt('the dancers', 'use the robot reference', 'group')
        self.assertTrue(single.startswith('body_swap:'))
        self.assertIn('single most prominent subject matching "the woman in red"', single)
        self.assertIn('every subject matching "the dancers"', group)
        self.assertIn('Leave other subjects unchanged', single)
        self.assertIn('use the robot reference', single)

    def test_segments_preserve_all_frames_and_never_cross_shot_cuts(self):
        shots = [(0, 109), (109, 401), (401, 2880)]
        segments = swap.segments_for_shots(shots)
        self.assertEqual(sum(length for _, length, _ in segments), 2880)
        cursor = 0
        for start, length, model_frames in segments:
            self.assertEqual(start, cursor)
            self.assertTrue(0 < length <= 124)
            self.assertEqual(model_frames, 124)
            self.assertTrue(any(a <= start < start + length <= b for a, b in shots))
            cursor += length

    def test_canvas_matches_reviewed_samples_and_limits_memory_without_upscaling(self):
        self.assertEqual(swap.canvas(544, 640), (544, 640))
        self.assertEqual(swap.canvas(640, 768), (640, 768))
        for width, height in [(3840, 2160), (1080, 1920), (33, 40), (160, 96)]:
            w, h = swap.canvas(width, height)
            self.assertLessEqual(w, width)
            self.assertLessEqual(h, height)
            self.assertLessEqual(w * h, 500_000)
            self.assertEqual((w % 32, h % 32), (0, 0))

    def test_missing_models_fail_before_comfy_submission(self):
        with tempfile.TemporaryDirectory() as directory, \
                mock.patch.object(swap, 'MODEL_ROOTS', (Path(directory),)), \
                mock.patch.object(video_edit, 'run_graph') as render:
            with self.assertRaisesRegex(RuntimeError, 'Character Swap model is missing'):
                swap.required_models()
            render.assert_not_called()

    def test_wrong_length_or_canvas_is_rejected(self):
        for stream in [{'width': 544, 'height': 640, 'nb_read_frames': '123', 'r_frame_rate': '24/1'},
                       {'width': 512, 'height': 640, 'nb_read_frames': '124', 'r_frame_rate': '24/1'},
                       {'width': 544, 'height': 640, 'nb_read_frames': '124', 'r_frame_rate': '30/1'}]:
            with mock.patch.object(video_edit, 'command', return_value=json.dumps({'streams': [stream]})):
                with self.assertRaisesRegex(RuntimeError, 'invalid video timeline or canvas'):
                    swap.validate_render(Path('output.mp4'), 544, 640)

    def test_real_media_assembly_trims_padding_and_preserves_audio_or_silence(self):
        for with_audio in (True, False):
            with self.subTest(with_audio=with_audio), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                source, reference, output = root / 'source.mp4', root / 'ref.png', root / 'edited.mp4'
                command = ['ffmpeg', '-nostdin', '-v', 'error', '-y', '-f', 'lavfi', '-i',
                           'testsrc2=size=160x96:rate=30']
                if with_audio:
                    command += ['-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-c:a', 'aac']
                subprocess.run(command + ['-t', '8.1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', str(source)], check=True)
                reference.write_bytes(b'not read by the mocked diffusion step')
                duration, _, _ = video_edit.clip_details(source)
                frames = math.ceil(duration * 24)
                args = argparse.Namespace(clip=source, image=reference, target='the person', prompt='a robot',
                                          subjects='primary', output=output, server='test', seed=46)
                # Return the real padded guide as a stand-in for diffusion, testing all actual
                # normalization, trim, concat and soundtrack operations around the model.
                def render(_server, graph, _node, _timeout):
                    return root / 'inputs' / graph['source']['inputs']['file']
                with mock.patch.object(swap, 'INPUT', root / 'inputs'), \
                        mock.patch.object(swap, 'required_models'), \
                        mock.patch.object(video_edit, 'edit_plan', return_value=([(0, 60), (60, frames)], [])), \
                        mock.patch.object(video_edit, 'run_graph', side_effect=render) as rendered:
                    swap.replace_clip(args)
                self.assertEqual(rendered.call_count, 3)
                info = json.loads(video_edit.command('ffprobe', '-v', 'error', '-count_frames',
                    '-show_entries', 'stream=codec_type,nb_read_frames:format=duration', '-of', 'json', str(output)))
                video = next(s for s in info['streams'] if s['codec_type'] == 'video')
                self.assertEqual(int(video['nb_read_frames']), frames)
                self.assertAlmostEqual(float(info['format']['duration']), duration, delta=0.05)
                self.assertEqual(any(s['codec_type'] == 'audio' for s in info['streams']), with_audio)
                if with_audio:
                    def audio_hash(path):
                        data = subprocess.check_output(['ffmpeg', '-v', 'error', '-i', str(path), '-map', '0:a:0',
                                                        '-c', 'copy', '-f', 'adts', '-'])
                        return hashlib.sha256(data).hexdigest()
                    self.assertEqual(audio_hash(source), audio_hash(output))
                self.assertEqual(list((root / 'inputs').iterdir()), [])
                manifest = json.loads(output.with_suffix('.character-swap.json').read_text())
                self.assertEqual(manifest['status'], 'completed')
                self.assertEqual(sum(s['source_frames'] for s in manifest['segments']), frames)

    def test_failed_render_leaves_no_output_and_cleans_its_inputs(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            reference = root / 'reference.png'
            reference.write_bytes(b'ref')
            args = argparse.Namespace(clip=root / 'source.mp4', image=reference, target='the person',
                                      prompt='a robot', subjects='primary', output=root / 'edited.mp4',
                                      server='test', seed=46)
            with mock.patch.object(swap, 'INPUT', root / 'input'), \
                    mock.patch.object(swap, 'required_models'), \
                    mock.patch.object(video_edit, 'clip_details', return_value=(1, 160, 96)), \
                    mock.patch.object(video_edit, 'normalized_clip'), \
                    mock.patch.object(video_edit, 'edit_plan', return_value=([(0, 24)], [])), \
                    mock.patch.object(video_edit, 'segment_clip'), \
                    mock.patch.object(video_edit, 'run_graph', side_effect=RuntimeError('model failed')):
                with self.assertRaisesRegex(RuntimeError, 'model failed'):
                    swap.replace_clip(args)
            self.assertFalse(args.output.exists())
            self.assertEqual(list((root / 'input').iterdir()), [])
            self.assertEqual(json.loads(args.output.with_suffix('.character-swap.json').read_text())['status'], 'failed')

    def test_rounded_124_frame_duration_does_not_create_a_second_model_window(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            reference = root / 'reference.png'
            reference.write_bytes(b'ref')
            args = argparse.Namespace(clip=root / 'source.mp4', image=reference, target='the person',
                                      prompt='a robot', subjects='primary', output=root / 'edited.mp4',
                                      server='test', seed=46)
            with mock.patch.object(swap, 'INPUT', root / 'input'), \
                    mock.patch.object(swap, 'required_models'), \
                    mock.patch.object(video_edit, 'clip_details', return_value=(5.166667, 544, 640)), \
                    mock.patch.object(video_edit, 'normalized_clip') as normalize, \
                    mock.patch.object(video_edit, 'edit_plan', return_value=([(0, 125)], [])), \
                    mock.patch.object(video_edit, 'segment_clip') as segment, \
                    mock.patch.object(video_edit, 'run_graph', side_effect=RuntimeError('stop after planning')):
                with self.assertRaisesRegex(RuntimeError, 'stop after planning'):
                    swap.replace_clip(args)
            self.assertEqual(normalize.call_args.args[-1], 124)
            self.assertEqual(segment.call_args.args[-3:], (0, 124, 124))
            manifest = json.loads(args.output.with_suffix('.character-swap.json').read_text())
            self.assertEqual(manifest['segments'][0]['source_frames'], 124)


if __name__ == '__main__':
    unittest.main()
