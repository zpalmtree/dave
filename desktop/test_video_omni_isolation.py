import importlib.util
import io
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import Mock, patch

path = Path(__file__).resolve().parents[1] / 'scripts' / 'run-video-omni-isolated.py'
spec = importlib.util.spec_from_file_location('omni_isolated', path)
runner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runner)


class IsolationTests(unittest.TestCase):
    def test_owned_server_stops_on_benchmark_failure_and_import_path_is_isolated(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            comfy = root / 'ComfyUI'
            comfy.mkdir()
            (comfy / 'main.py').write_text('import sys; print(sys.path[0])')
            child = Mock()
            child.poll.return_value = None
            socket = Mock()
            socket.__enter__ = Mock(return_value=socket)
            socket.__exit__ = Mock(return_value=False)
            socket.connect_ex.return_value = 1
            argv = ['run', '--comfy', str(comfy), '--desktop', str(root / 'video_gen'),
                    '--manifest', str(root / 'corpus.json'), '--output', str(root / 'output')]
            with patch.dict(os.environ, GPUQ_LEASE_ID='test-lease'), patch.object(sys, 'argv', argv), \
                    patch.object(runner.socket, 'socket', return_value=socket), \
                    patch.object(runner.subprocess, 'Popen', return_value=child) as launch, \
                    patch.object(runner.subprocess, 'run', side_effect=RuntimeError('benchmark failed')), \
                    patch.object(runner.urllib.request, 'urlopen', return_value=io.BytesIO(b'{}')):
                with self.assertRaisesRegex(RuntimeError, 'benchmark failed'):
                    runner.main()
            child.terminate.assert_called_once()
            child.wait.assert_called_once_with(timeout=15)
            command = launch.call_args.args[0]
            # Execute the captured bootstrap against a harmless stub, proving
            # directory precedence instead of checking a string in source code.
            result = subprocess.run(command, capture_output=True, text=True, check=True)
            self.assertEqual(Path(result.stdout.strip()), comfy.resolve())

    def test_occupied_port_is_never_reused_or_stopped(self):
        socket = Mock()
        socket.__enter__ = Mock(return_value=socket)
        socket.__exit__ = Mock(return_value=False)
        socket.connect_ex.return_value = 0
        argv = ['run', '--comfy', '.', '--desktop', '.', '--manifest', 'none', '--output', 'none']
        with patch.dict(os.environ, GPUQ_LEASE_ID='test-lease'), patch.object(sys, 'argv', argv), \
                patch.object(runner.socket, 'socket', return_value=socket), \
                patch.object(runner.subprocess, 'Popen') as launch:
            with self.assertRaisesRegex(RuntimeError, 'occupied'):
                runner.main()
        launch.assert_not_called()


if __name__ == '__main__':
    unittest.main()
