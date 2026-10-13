import tempfile
import unittest
from pathlib import Path
from unittest import mock
import video_source_download as downloads


class SourceVideoDownloadTests(unittest.TestCase):
    def test_only_a_canonical_youtube_video_is_downloaded_within_the_broker_limits(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / 'source-video.mp4'

            def run(command, **kwargs):
                output.write_bytes(b'v' * 2048)
                return mock.Mock(returncode=0, stderr='')
            with mock.patch.object(downloads.shutil, 'which', return_value='yt-dlp'), \
                    mock.patch.dict(downloads.os.environ, {'VIDEO_YTDLP': ''}), \
                    mock.patch.object(downloads.subprocess, 'run', side_effect=run) as call:
                with self.assertRaisesRegex(ValueError, 'YouTube'):
                    downloads.fetch_source_video('https://example.com/watch?v=GG1d35jpizo', output, 'ffmpeg')
                self.assertEqual(call.call_count, 0)
                self.assertEqual(downloads.fetch_source_video('https://www.youtube.com/watch?v=GG1d35jpizo', output, 'ffmpeg'), output)
            command = call.call_args.args[0]
            self.assertEqual(command[-2:], ['--', 'https://www.youtube.com/watch?v=GG1d35jpizo'])
            for flag in ('--ignore-config', '--no-playlist', '100M', 'duration <= 600 & !is_live'):
                self.assertIn(flag, command)
            self.assertNotIn('shell', call.call_args.kwargs)

    def test_a_blocked_or_skipped_download_reports_why(self):
        with tempfile.TemporaryDirectory() as directory, mock.patch.object(downloads.shutil, 'which', return_value='yt-dlp'):
            output = Path(directory) / 'source-video.mp4'
            blocked = mock.Mock(returncode=1, stderr='ERROR: Video unavailable')
            with mock.patch.object(downloads.subprocess, 'run', return_value=blocked):
                with self.assertRaisesRegex(RuntimeError, 'Video unavailable'):
                    downloads.fetch_source_video('https://www.youtube.com/watch?v=GG1d35jpizo', output, 'ffmpeg')
            # yt-dlp exits cleanly when its duration filter skips the video.
            with mock.patch.object(downloads.subprocess, 'run', return_value=mock.Mock(returncode=0, stderr='')):
                with self.assertRaisesRegex(ValueError, '10 minutes'):
                    downloads.fetch_source_video('https://www.youtube.com/watch?v=GG1d35jpizo', output, 'ffmpeg')


if __name__ == '__main__':
    unittest.main()
