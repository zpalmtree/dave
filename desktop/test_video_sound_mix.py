import asyncio
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import types
import unittest
from unittest import mock
import numpy as np
sys.path.insert(0, str(Path(__file__).resolve().parent))
import video_sound_mix as mix


class SoundMixTests(unittest.TestCase):
    def audio(self, path):
        return np.frombuffer(mix.media(['-i', str(path), '-vn', '-ar', '48000', '-ac', '1', '-f', 'f32le', 'pipe:1']).stdout, dtype='<f4')

    def fixture(self, root, expression):
        wav = root / 'input.wav'
        mix.media(['-f', 'lavfi', '-i', f'aevalsrc={expression}:s=48000:d=3', str(wav)])
        video = root / 'input.mp4'
        mix.media(['-f', 'lavfi', '-i', 'color=c=blue:s=128x72:r=24:d=3', '-i', str(wav),
                   '-c:v', 'libx264', '-c:a', 'aac', '-shortest', str(video)])
        return video

    def test_disabled_external_and_dialogue_guards(self):
        plan = {'sound_mix': {'music': 'instrumental', 'caption': 'One warm understated piano arrangement', 'effects': 'soften_transients'},
                'segments': [{'shots': [{'dialogue': [{'text': 'Hello'}]}]}]}
        self.assertEqual(mix.directive(plan)['effects'], 'preserve')
        self.assertEqual(mix.directive(plan, True)['music'], 'none')
        with mock.patch.dict('os.environ', {'VIDEO_SOUND_MIX': '0'}):
            self.assertEqual(mix.directive(plan)['music'], 'none')
        self.assertEqual(mix.mix_video(Path('missing'), Path('unused'), {'effects': 'preserve'}, 3), Path('missing'))

    def test_ducking_preserves_dry_voice_and_video_packets(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = self.fixture(root, '0.12*sin(2*PI*440*t)*between(t\\,1\\,2)')
            score = root / 'score.wav'
            mix.media(['-f', 'lavfi', '-i', 'sine=frequency=880:duration=1.4:sample_rate=48000', str(score)])
            seconds=float(subprocess.check_output(['ffprobe','-v','error','-show_entries','format=duration',
                '-of','default=nw=1:nk=1',str(source)]))
            output = mix.mix_video(source, root / 'out.mp4', {'effects': 'preserve'}, seconds, score)
            before, after = self.audio(source), self.audio(output)
            def magnitude(audio, frequency, start, end):
                data = audio[round(start*48000):round(end*48000)]
                return abs(np.mean(data * np.exp(-2j*np.pi*frequency*np.arange(len(data))/48000)))
            self.assertAlmostEqual(magnitude(after,440,1.2,1.7)/magnitude(before,440,1.2,1.7),1,delta=.08)
            self.assertLess(magnitude(after,880,1.2,1.7), magnitude(after,880,.6,.9)*.85)
            def packets(path):
                return json.loads(subprocess.check_output(['ffprobe','-v','error','-select_streams','v','-show_packets',
                    '-show_data_hash','sha256','-show_entries','packet=pts,dts,data_hash','-of','json',str(path)]))
            self.assertEqual(packets(source), packets(output))
            self.assertLess(abs(len(after)-len(before)),2048)
            self.assertGreater(np.sqrt(np.mean(after[10000:30000]**2)),.001)

    def test_softening_reduces_peaks_without_lifting_quiet_background(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory)
            source=self.fixture(root,'(0.01+0.7*between(t\\,1\\,1.2))*sin(2*PI*440*t)')
            output=mix.mix_video(source,root/'out.mp4',{'effects':'soften_transients'},3)
            before,after=self.audio(source),self.audio(output)
            self.assertLess(np.max(abs(after[49000:57000])), np.max(abs(before[49000:57000]))*.65)
            self.assertLess(np.sqrt(np.mean(after[:30000]**2)),np.sqrt(np.mean(before[:30000]**2))*1.1)

    def test_composition_failure_is_cached_and_cancellation_propagates(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory)
            step=mock.AsyncMock(side_effect=RuntimeError('offline'))
            fake=types.SimpleNamespace(SCRIPT_DIR=root,console_python_executable=lambda:sys.executable,
                stable_job_seed=lambda _:17,atomic_json=lambda p,v:p.write_text(json.dumps(v)))
            worker=types.SimpleNamespace(send=mock.AsyncMock())
            plan={'sound_mix':{'music':'instrumental','caption':'Warm piano and brushes, one continuous arrangement','effects':'preserve'}}
            with mock.patch.dict(sys.modules,{'video_worker':fake,'video_recovery':types.SimpleNamespace(run_local_step=step)}):
                for _ in range(2): self.assertIsNone(asyncio.run(mix.prepare_score(worker,{'id':'job'},plan,root,10))[1])
                step.assert_awaited_once()
                step.side_effect=asyncio.CancelledError()
                with self.assertRaises(asyncio.CancelledError):asyncio.run(mix.prepare_score(worker,{'id':'job'},plan,root,11))

    def test_composer_owns_only_the_server_it_starts(self):
        generator=types.SimpleNamespace(DEFAULT_SERVER='local',server_ready=mock.Mock(return_value=True),
            start_server=mock.Mock(return_value=('process','log')),stop_server=mock.Mock())
        song=types.SimpleNamespace(main=mock.Mock(return_value=0))
        with mock.patch.dict(sys.modules,{'video_gen':generator,'video_song':song}):
            self.assertEqual(mix.compose_main(),0)
            generator.start_server.assert_not_called();generator.stop_server.assert_not_called()
            generator.server_ready.return_value=False
            song.main.side_effect=RuntimeError('composition failed')
            with self.assertRaisesRegex(RuntimeError,'composition failed'):mix.compose_main()
            generator.stop_server.assert_called_once_with('process','log')

    def test_delivery_mixes_after_normalization_and_protects_external_audio(self):
        if not (Path(__file__).parent/'video_worker.py').exists():
            self.skipTest('Installed desktop integration test')
        import video_worker
        import video_sync_delivery
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);source=root/'source.mp4';source.write_bytes(b'fixture')
            normalized=root/'normalized.mp4';normalized.write_bytes(b'normalized')
            mixed=root/'mixed.mp4';mixed.write_bytes(b'mixed')
            worker=video_worker.DesktopVideoWorker.__new__(video_worker.DesktopVideoWorker)
            worker.current_job={};worker.add_span=mock.Mock()
            worker.normalize_delivery_audio=mock.AsyncMock(return_value=normalized)
            worker.delivery_video_is_compatible=mock.AsyncMock(return_value=True)
            policy={'music':'instrumental','effects':'preserve'}
            with mock.patch.object(video_sync_delivery,'correct_delivery_sync',mock.AsyncMock(return_value=source)), \
                 mock.patch.object(mix,'mix_video',return_value=mixed) as render:
                output=asyncio.run(worker.prepare_delivery(source,'job',3,sound_mix=policy,background_score=root/'score.flac'))
                self.assertEqual(output,mixed)
                self.assertEqual(render.call_args.args[0],normalized)
                self.assertEqual(render.call_args.args[2],policy)
                render.reset_mock();worker.normalize_delivery_audio.reset_mock()
                output=asyncio.run(worker.prepare_delivery(source,'job',3,preserve_audio=True,sound_mix=policy))
                self.assertEqual(output,source);render.assert_not_called();worker.normalize_delivery_audio.assert_not_awaited()
                render.side_effect=RuntimeError('decoder unavailable')
                output=asyncio.run(worker.prepare_delivery(source,'job',3,sound_mix=policy))
                self.assertEqual(output,normalized)


if __name__=='__main__': unittest.main()
