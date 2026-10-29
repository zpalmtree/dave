import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import video_edit as edit
import video_edit_source_recovery as recovery


class SourceRecoveryTests(unittest.TestCase):
    def call(self, root):
        return recovery.recover_source_track('server', root/'clip.mp4', root/'original.mp4',
            'the man wearing glasses and a light blue t-shirt', 'primary', 182, 192, root, 2)

    def test_valid_track_does_not_start_another_gpu_pass(self):
        with tempfile.TemporaryDirectory() as d, patch.object(edit, 'validate_tracking_mask', return_value=.2), \
             patch.object(edit, 'track_subject') as track, patch.object(recovery, 'reverse_clip') as reverse:
            self.assertEqual(self.call(Path(d)), Path(d)/'original.mp4')
            track.assert_not_called()
            reverse.assert_not_called()
            self.assertFalse((Path(d)/'source-recovery-02.json').exists())

    def test_retry_preserves_target_subject_selection_timing_and_validation(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            with patch.object(edit, 'INPUT', root), \
                 patch.object(edit, 'validate_tracking_mask', side_effect=[RuntimeError('Could not reliably isolate target'), .06]) as validate, \
                 patch.object(edit, 'track_subject', return_value=root/'reverse-mask.mp4') as track, \
                 patch.object(recovery, 'reverse_clip') as reverse:
                result = self.call(root)
            self.assertEqual(result, root/'source-recovered-02.mp4')
            self.assertEqual(track.call_count, 1)
            self.assertEqual(track.call_args.args[2], 'the man wearing glasses and a light blue t-shirt')
            self.assertEqual(track.call_args.args[-2:], ('primary', 182))
            self.assertEqual(reverse.call_args_list[0].args[2:], (182,))
            self.assertEqual(reverse.call_args_list[1].args[2:], (182, 192))
            self.assertEqual(validate.call_args.args, (result, track.call_args.args[2], 182))
            self.assertEqual(json.loads((root/'source-recovery-02.json').read_text())['status'], 'tracked')

    def test_failed_recovery_stops_after_one_attempt_and_cleans_input(self):
        for failure in ('Could not reliably isolate target', 'ComfyUI unavailable'):
            with self.subTest(failure=failure), tempfile.TemporaryDirectory() as d:
                root = Path(d)
                def reverse(source, destination, *args):
                    destination.write_bytes(b'fixture')
                with patch.object(edit, 'INPUT', root), \
                     patch.object(edit, 'validate_tracking_mask', side_effect=RuntimeError('Could not reliably isolate target')), \
                     patch.object(edit, 'track_subject', side_effect=RuntimeError(failure)) as track, \
                     patch.object(recovery, 'reverse_clip', side_effect=reverse):
                    with self.assertRaisesRegex(RuntimeError, failure):
                        self.call(root)
                self.assertEqual(track.call_count, 1)
                self.assertEqual(list(root.glob('edit-source-recovery-*.mp4')), [])
                self.assertEqual(json.loads((root/'source-recovery-02.json').read_text())['status'], 'failed')

    def test_recovered_mask_must_pass_unchanged_guard(self):
        with tempfile.TemporaryDirectory() as d, patch.object(edit, 'INPUT', Path(d)), \
             patch.object(edit, 'validate_tracking_mask', side_effect=RuntimeError('Could not reliably isolate target')), \
             patch.object(edit, 'track_subject', return_value=Path(d)/'bad.mp4') as track, \
             patch.object(recovery, 'reverse_clip'), \
             patch.object(recovery, 'track_from_seed', return_value=(Path(d)/'seeded.mp4', 90)) as seeded:
            with self.assertRaisesRegex(RuntimeError, 'Could not reliably isolate'):
                self.call(Path(d))
            self.assertEqual(track.call_count, 1)
            seeded.assert_called_once()
            self.assertEqual(json.loads((Path(d)/'source-recovery-02.json').read_text())['status'], 'failed')

    def test_truncated_or_unreadable_mask_is_not_treated_as_occlusion(self):
        for error in ('Tracked replacement mask is shorter than the source segment', 'Could not decode replacement mask'):
            with self.subTest(error=error), tempfile.TemporaryDirectory() as d, \
                 patch.object(edit, 'validate_tracking_mask', side_effect=RuntimeError(error)), \
                 patch.object(edit, 'track_subject') as track:
                with self.assertRaisesRegex(RuntimeError, error):
                    self.call(Path(d))
                track.assert_not_called()

    def test_seed_requires_sustained_detection_and_ignores_short_false_hits(self):
        self.assertEqual(recovery.stable_seed([.1]*3 + [0]*10 + [.2]*52 + [0]*40), 39)
        for values in ([0]*100, [.2]*3+[0]*100):
            with self.assertRaisesRegex(RuntimeError, 'stable recovery seed'):
                recovery.stable_seed(values)

    def test_seed_graph_cannot_redetect_a_different_person(self):
        graph = recovery.seeded_graph('clip.mp4', 'mask.png', 'test/seed')
        self.assertNotIn('target', graph)
        self.assertNotIn('conditioning', graph['track']['inputs'])
        self.assertEqual(graph['track']['inputs']['max_objects'], 1)
        self.assertEqual(graph['track']['inputs']['initial_mask'], ['seed_mask', 0])

    def test_offscreen_source_cannot_gain_a_generated_person(self):
        import numpy as np
        from video_edit_composite import composite_alpha
        source = np.zeros((64, 96), np.uint8)
        generated = source.copy()
        generated[20:50, 10:35] = 255
        self.assertFalse(composite_alpha(source, generated, [0, 0, 96, 64]).any())

    def test_seeded_passes_join_once_and_preserve_offscreen_frames_and_padding(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            source = root/'source.mp4'
            edit.command('ffmpeg', '-nostdin', '-v', 'error', '-y', '-f', 'lavfi', '-i',
                'color=black:s=96x64:r=24:d=2', '-vf',
                "drawbox=x=20:y=10:w=30:h=40:color=white:t=fill:enable='between(n,12,39)'",
                '-c:v', 'libx264', '-crf', '0', str(source))
            def graph_result(server, graph, output, timeout):
                return root/graph['source']['inputs']['file']
            with patch.object(edit, 'INPUT', root), patch.object(edit, 'run_graph', side_effect=graph_result) as run:
                result, anchor = recovery.track_from_seed('server', source, source, 48, 60, root, 2)
            self.assertEqual(anchor, 26)
            self.assertEqual(run.call_count, 2)
            self.assertEqual(edit.mask_frame_coverages(result), edit.mask_frame_coverages(source)+[0]*12)
            self.assertEqual(list(root.glob('edit-source-seed-*')), [])

    def test_group_recovery_never_turns_into_single_subject_seed(self):
        with tempfile.TemporaryDirectory() as d, patch.object(edit, 'INPUT', Path(d)), \
             patch.object(edit, 'validate_tracking_mask', side_effect=RuntimeError('Could not reliably isolate target')), \
             patch.object(edit, 'track_subject', return_value=Path(d)/'bad.mp4'), \
             patch.object(recovery, 'reverse_clip'), patch.object(recovery, 'track_from_seed') as seeded:
            with self.assertRaisesRegex(RuntimeError, 'Could not reliably isolate'):
                recovery.recover_source_track('server', Path('clip'), Path('mask'), 'the dancers', 'group', 48, 60, Path(d), 1)
            seeded.assert_not_called()

    def test_real_video_reverse_excludes_padding_and_restores_frame_order(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            source, reverse, restored = [root/name for name in ('source.mp4', 'reverse.mp4', 'restored.mp4')]
            # First 6 frames contain the subject; next 6 and all model padding are empty.
            edit.command('ffmpeg', '-nostdin', '-v', 'error', '-y', '-f', 'lavfi', '-i',
                'color=black:s=96x64:r=24:d=1', '-vf',
                "drawbox=x=20:y=10:w=30:h=40:color=white:t=fill:enable='lt(n,6)'",
                '-c:v', 'libx264', '-crf', '0', str(source))
            recovery.reverse_clip(source, reverse, 12)
            self.assertEqual(len(edit.mask_frame_coverages(reverse)), 12)
            self.assertEqual(edit.mask_frame_coverages(reverse)[:6], [0]*6)
            recovery.reverse_clip(reverse, restored, 12, 24)
            values = edit.mask_frame_coverages(restored)
            self.assertEqual(len(values), 24)
            self.assertTrue(all(v > .1 for v in values[:6]))
            self.assertEqual(values[6:], [0]*18)


if __name__ == '__main__':
    unittest.main()
