import importlib.util
import os
from pathlib import Path
import subprocess
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import Mock

path = Path(__file__).resolve().parents[1] / 'scripts' / 'benchmark-video-omni.py'
spec = importlib.util.spec_from_file_location('omni_benchmark', path)
bench = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bench)


class BenchmarkTests(unittest.TestCase):
    def test_render_requires_admission_before_loading_desktop(self):
        env = {k: v for k, v in os.environ.items() if k != 'GPUQ_LEASE_ID'}
        result = subprocess.run([sys.executable, str(path), '--desktop', 'absent',
            '--manifest', 'absent.json', '--output', 'absent', '--renderer', 'fasth3_omni'],
            env=env, capture_output=True, text=True)
        self.assertEqual(result.returncode, 2)
        self.assertIn('Render through gpuq', result.stderr)
        self.assertNotIn('ModuleNotFoundError', result.stderr)

    def test_output_requires_matching_geometry_fps_and_audio(self):
        case = dict(width=832, height=480, frames=124)
        result = dict(width=832, height=480, decoded_video_frames=124, fps=24.0,
                      decoded_audio_frames=163, audio_channels=2)
        bench.validate_output(result, case)
        for field, bad in [('width', 768), ('height', 832), ('decoded_video_frames', 125),
                           ('fps', 30), ('decoded_audio_frames', 0), ('audio_channels', 0)]:
            with self.subTest(field=field), self.assertRaises(RuntimeError):
                bench.validate_output(dict(result, **{field: bad}), case)

    def test_cancellation_names_only_owned_prompt(self):
        api = Mock()
        bench.cancel_owned(SimpleNamespace(api_json=api), 'server', 'owned-id')
        self.assertEqual(api.call_args_list[0].args, ('server', '/queue', {'delete': ['owned-id']}))
        self.assertEqual(api.call_args_list[1].args, ('server', '/interrupt', {'prompt_id': 'owned-id'}))

    def test_baselines_use_production_compiler_with_matched_canvas(self):
        case = dict(prompt='same prompt', frames=124, aspect='16:9', width=832, height=480)
        for renderer in ('base', 'taomate'):
            build = Mock(return_value={'cond': {'inputs': {'width': ['size', 0], 'height': ['size', 1]}}})
            vg = SimpleNamespace(WORKFLOWS={('h3', 'i2v'): {'prompt': 'cond'}}, build_prompt=build)
            graph = bench.graph_for(vg, case, renderer, 7, 'same.png', 'test')
            self.assertEqual(graph['cond']['inputs'], dict(width=832, height=480))
            self.assertEqual(build.call_args.kwargs['fast'], renderer == 'taomate')
            self.assertEqual(build.call_args.kwargs['text_prompt'], case['prompt'])
            self.assertEqual(build.call_args.kwargs['input_name'], 'same.png')
            self.assertEqual(build.call_args.kwargs['seed'], 7)


if __name__ == '__main__':
    unittest.main()
