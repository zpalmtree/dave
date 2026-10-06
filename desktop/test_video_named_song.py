import tempfile
import asyncio
import json
import sys
import types
import unittest
from pathlib import Path
from unittest import mock
import video_named_song as songs


class NamedSongTests(unittest.TestCase):
    def test_worker_downloads_without_gpu_and_preserves_cancellation(self):
        import video_recovery as recovery
        if not hasattr(recovery, 'compose_song'):
            self.skipTest('Run integration checks on the installed desktop revision.')
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'recording.mp3').write_bytes(b'audio')
            (root / 'recording.json').write_text(json.dumps({'title': 'fixture'}))
            worker = types.SimpleNamespace(cancel_reason=None, process=None)
            module = types.SimpleNamespace(SCRIPT_DIR=root, console_python_executable=lambda: 'python',
                atomic_json=lambda path, value: path.write_text(json.dumps(value)), stable_job_seed=lambda _: 1)
            process = types.SimpleNamespace(returncode=0, communicate=mock.AsyncMock(return_value=(b'done', None)))
            request = mock.AsyncMock(return_value={'composed': True, 'seconds': 20})
            job = {'id': 'test'}
            with mock.patch.dict(sys.modules, {'video_worker': module}), \
                    mock.patch.object(recovery, 'ffmpeg', return_value='ffmpeg'), \
                    mock.patch.object(recovery.asyncio, 'create_subprocess_exec', mock.AsyncMock(return_value=process)), \
                    mock.patch.object(recovery, 'run_local_step', mock.AsyncMock()) as gpu:
                asyncio.run(recovery.compose_song(worker, job, root, {'recording': {'title': 'fixture'}}, request))
                gpu.assert_not_called()
                self.assertTrue(job['has_source_audio'])
                self.assertEqual(job['source_audio_seconds'], 20)
                self.assertEqual(request.call_args.args[1]['format'], 'mp3')

                async def interrupted():
                    worker.cancel_reason = 'user'
                    raise RuntimeError('Cancelled by client.')
                process.communicate = interrupted
                request.reset_mock()
                with self.assertRaises(asyncio.CancelledError):
                    asyncio.run(recovery.compose_song(worker, job, root, {'recording': {'title': 'fixture'}}, request))
                request.assert_not_called()

    def test_matches_original_artist_and_rejects_alternate_versions(self):
        source = {'id': 'MmZexg8sxyk', 'title': 'MGMT - Electric Feel (Official HD Video)',
                  'channel': 'MGMT', 'duration': 228, 'channel_is_verified': True}
        entries = [{**source, 'title': source['title'] + ' cover'},
                   {**source, 'title': source['title'] + ' remix'},
                   {**source, 'channel': 'someone', 'channel_is_verified': False, 'title': 'MGMT Electric Feel'},
                   {**source, 'is_live': True}, {**source, 'duration': 3600}, source]
        self.assertEqual(songs.choose_recording(entries, 'Electric Feel', 'MGMT'), source)
        with self.assertRaises(ValueError):
            songs.choose_recording(entries[:-1], 'Electric Feel', 'MGMT')
        with self.assertRaises(ValueError):
            songs.choose_recording(entries, 'Electric Feel', 'Another Artist')

    def test_links_cannot_select_other_hosts_or_playlists(self):
        self.assertEqual(songs.youtube_url('https://youtu.be/MmZexg8sxyk'), 'https://www.youtube.com/watch?v=MmZexg8sxyk')
        for url in ['https://example.com/watch?v=MmZexg8sxyk', 'file:///tmp/song',
                    'https://youtube.com/playlist?list=abc', 'https://youtube.com:443/watch?v=MmZexg8sxyk',
                    'https://x@youtube.com/watch?v=MmZexg8sxyk']:
            with self.assertRaises(ValueError):
                songs.youtube_url(url)

    def test_a_blocked_download_stops_without_using_another_song(self):
        result = mock.Mock(returncode=1, stderr='Sign in to confirm you are not a bot.')
        with tempfile.TemporaryDirectory() as directory, mock.patch.object(songs.shutil, 'which', return_value='yt-dlp'), \
                mock.patch.object(songs.subprocess, 'run', return_value=result) as run:
            with self.assertRaisesRegex(RuntimeError, 'Sign in'):
                songs.fetch_recording({'title': 'Electric Feel', 'artist': 'MGMT', 'url': ''}, Path(directory) / 'song.mp3', 'ffmpeg')
            self.assertEqual(run.call_count, 1)
            self.assertNotIn('shell', run.call_args.kwargs)
            self.assertIn('--ignore-config', run.call_args.args[0])


if __name__ == '__main__':
    unittest.main()
