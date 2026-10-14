"""Neutral offline regressions. Never launches a planner, GPU, or renderer."""
import asyncio
import copy
import io
import json
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

import video_gen as vg
import video_planning as vp
from video_worker import DesktopVideoWorker


def candidate(target=10, cut=5, words='One two three four five six seven eight nine ten eleven twelve thirteen fourteen.'):
    return {'intent': 'A gardener explains the seedlings.', 'continuity_bible': 'The same gardener and greenhouse.',
            'keyframe': {'recommended': False, 'reason': 'A simple scene.', 'prompt': 'A gardener beside seedlings.',
                         'motion_contract': {key: 'The gardener faces the camera.' for key in
                             ('subject_orientation', 'gaze_direction', 'travel_direction', 'camera_relation', 'first_second_action')}},
            'segments': [{'title': 'Seedlings', 'transition': 'start', 'target_seconds': target,
                          **({'output_seconds': cut} if cut is not None else {}), 'music': 'N/A',
                          'shots': [{'visual': 'A gardener holds a tray of seedlings.', 'camera': 'Static medium shot.',
                                     'audio': 'Quiet room tone.', 'duration_seconds': target,
                                     'dialogue': [{'speaker_id': 'gardener', 'text': words, 'language': 'English', 'delivery': 'natural'}] if words else []}]}]}


class PlanningDiagnosticsTests(unittest.TestCase):
    def test_short_retained_cut_is_original_conflict_not_normalization(self):
        plan = candidate()
        original = copy.deepcopy(plan)
        timings = {}
        self.assertIs(vg.repair_local_dialogue_segments(plan, 15, 4), plan)
        with self.assertRaisesRegex(vg.VideoGenError, 'final cut.*speech_estimate='):
            vg.validate_plan_shape(plan, 'A gardener explains the seedlings.', None, 15, 4,
                                   timing_diagnostics=timings)
        self.assertEqual(plan, original)
        for phase in ('input', 'normalized'):
            segment = timings[phase][0]
            self.assertEqual(segment['segment_index'], 1)
            self.assertLess(segment['output_seconds'], segment['speech_estimate_seconds'])
            self.assertLess(segment['speech_estimate_seconds'], 15)
        self.assertEqual(timings['input'][0]['target_seconds'], 10)
        self.assertEqual(timings['normalized'][0]['output_seconds'], 5)

    def test_feasible_cut_preserves_dialogue_and_fits_requested_runtime(self):
        plan = candidate(cut=8)
        normalized = vg.validate_plan_shape(plan, 'A gardener explains the seedlings.', 8, 15, 4)
        self.assertEqual(normalized['target_total_seconds'], 8)
        self.assertGreaterEqual(normalized['generation_total_seconds'], 8)
        self.assertEqual(normalized['segments'][0]['shots'][0]['dialogue'][0]['text'],
                         plan['segments'][0]['shots'][0]['dialogue'][0]['text'])

    def test_infeasible_runtime_is_rejected_without_dropping_speech(self):
        plan = candidate(cut=None)
        with self.assertRaisesRegex(vg.VideoGenError, 'duration conflict'):
            vg.validate_plan_shape(plan, 'Make it 3-5 seconds.', None, 15, 4)

    def test_range_applies_to_finished_runtime_and_reviewer(self):
        for seconds in (10, 11, 12):
            plan = vg.validate_plan_shape(candidate(15, seconds, ''), 'Make a 10–12 second video.', None, 15, 4)
            self.assertEqual(plan['target_total_seconds'], seconds)
            self.assertEqual(plan['runtime_constraint'], {'min_seconds': 10, 'max_seconds': 12, 'source': 'prompt'})
            with mock.patch.object(vg, 'planner_json', return_value={'message': {'content': '{"missing_requirements": [], "evidence": []}'}}) as planner:
                vg.verify_plan_fidelity('Make a 10–12 second video.', {}, plan, 0, 'offline')
            message = planner.call_args.args[1]['messages'][1]['content']
            self.assertIn('"min_seconds": 10.0', message)
            self.assertIn('"max_seconds": 12.0', message)
        with self.assertRaisesRegex(vg.VideoGenError, 'duration conflict'):
            vg.validate_plan_shape(candidate(15, 14, ''), 'Make a 10–12 second video.', None, 15, 4)

    def test_duration_parser_does_not_treat_spoken_numbers_or_pauses_as_runtime(self):
        for prompt in ('Say "make it 10-12 seconds".', 'Pause for 10-12 seconds then wave.', 'Hold for 5 seconds.'):
            self.assertIsNone(vp.runtime_constraint(prompt))
        for prompt in ('Make it 10-12 seconds.', 'Video runtime: 10 to 12 seconds.', 'A 10–12-second clip.'):
            self.assertEqual(vp.runtime_constraint(prompt)['max_seconds'], 12)
        self.assertEqual(vp.runtime_constraint('Make it 10-12 seconds.', 8)['max_seconds'], 8)
        self.assertEqual(vp.runtime_constraint('Make it 1-2 minutes.')['max_seconds'], 120)

    def run_failed_planning(self, root, responses):
        analysis = vg.conservative_semantic_analysis('A gardener explains seedlings.')
        with mock.patch.object(vg, 'analyze_video_intent', return_value=analysis), \
             mock.patch.object(vg, 'planner_json', side_effect=responses), \
             mock.patch.object(vg, 'unload_planner_model'), \
             mock.patch.object(vg, 'fallback_video_plan', return_value=candidate()), \
             redirect_stdout(io.StringIO()) as output:
            with self.assertRaises(vg.VideoGenError) as error:
                vg.create_video_plan('A gardener explains seedlings.', None, None, '16:9', ('h3',), diagnostics_dir=root)
        return str(error.exception), output.getvalue()

    def test_rejected_candidates_and_json_are_private_and_exhaustion_is_terminal(self):
        raw = json.dumps(candidate())
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            error, output = self.run_failed_planning(root, [
                {'message': {'content': raw}}, {'message': {'content': raw}}, {'message': {'content': '{invalid JSON'}}])
            self.assertTrue(vp.planning_exhausted(error))
            self.assertFalse(DesktopVideoWorker.is_retryable(error))
            self.assertNotIn('One two three', output + error)
            records = {p.stem: json.loads(p.read_text()) for p in root.glob('*/*.json')}
            self.assertEqual(set(records), {'1', '2', '3', 'fallback'})
            self.assertEqual(records['1']['response'], raw)
            self.assertEqual(records['1']['timings']['normalized'][0]['output_seconds'], 5)
            self.assertEqual(records['3']['stage'], 'json_validation')
            self.assertEqual(records['3']['response'], '{invalid JSON')
            self.run_failed_planning(root, [{'message': {'content': raw}}] * 3)
            self.assertEqual(len(list(root.iterdir())), 2, 'Separate passes retain separate evidence')

    def test_planner_service_failure_is_transient_even_when_fallback_is_invalid(self):
        with tempfile.TemporaryDirectory() as directory:
            error, _ = self.run_failed_planning(Path(directory), [vg.VideoGenError('service unavailable')] * 3)
        self.assertTrue(error.startswith('local_planning_unavailable:'))
        self.assertTrue(DesktopVideoWorker.is_retryable(error))
        self.assertTrue(DesktopVideoWorker.is_retryable('ComfyUI readiness timed out'))

    def test_semantic_rejection_details_stay_in_private_artifacts(self):
        plan = candidate(cut=8)
        issue = 'The blue watering can is missing.'
        with tempfile.TemporaryDirectory() as directory, \
             mock.patch.object(vg, 'analyze_video_intent', return_value=vg.conservative_semantic_analysis('A gardener explains seedlings.')), \
             mock.patch.object(vg, 'planner_json', return_value={'message': {'content': json.dumps(plan)}}), \
             mock.patch.object(vg, 'unload_planner_model'), \
             mock.patch.object(vg, 'fallback_video_plan', return_value=plan), \
             mock.patch.object(vg, 'plan_quality_issues', return_value=[]), \
             mock.patch.object(vg, 'verify_plan_fidelity', return_value=[issue]), \
             redirect_stdout(io.StringIO()) as output:
            with self.assertRaises(vg.VideoGenError) as error:
                vg.create_video_plan('A gardener explains seedlings.', None, None, '16:9', ('h3',),
                                     diagnostics_dir=Path(directory))
            self.assertTrue(vp.planning_exhausted(str(error.exception)))
            self.assertNotIn(issue, output.getvalue() + str(error.exception))
            artifact = next(Path(directory).glob('*/fallback.json'))
            self.assertEqual(json.loads(artifact.read_text())['issues'], [issue])

    def test_diagnostic_write_failure_does_not_hide_validation(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / 'file'
            root.write_text('not a directory')
            error, output = self.run_failed_planning(root, [{'message': {'content': '{}'}}] * 3)
            self.assertTrue(vp.planning_exhausted(error))
            self.assertIn('Could not save private planning diagnostics', output)

    def test_recovery_reports_exhausted_planning_as_terminal_and_outage_as_retryable(self):
        import video_recovery as recovery
        import video_worker
        for detail, retryable in [('local_planning_exhausted: Validation failed.', False),
                                  ('local_planning_unavailable: Service timeout.', True)]:
            response = mock.MagicMock(status=200)
            response.json = mock.AsyncMock(return_value={'local_plan_required': True})
            context = mock.MagicMock()
            context.__aenter__ = mock.AsyncMock(return_value=response)
            worker = SimpleNamespace(broker_url='ws://offline/v1/worker', cancel_reason=None,
                begin_metrics=mock.Mock(), save_journal=mock.Mock(), add_span=mock.Mock(),
                worker_headers=mock.Mock(return_value={}), send=mock.AsyncMock(),
                http_session=SimpleNamespace(post=mock.Mock(return_value=context)),
                fail_current=mock.AsyncMock())
            with tempfile.TemporaryDirectory() as directory, \
                 mock.patch.object(video_worker, 'SCRIPT_DIR', Path(directory)), \
                 mock.patch.object(recovery, 'plan_locally', side_effect=RuntimeError(detail)), \
                 mock.patch.object(recovery.traceback, 'print_exc'):
                asyncio.run(recovery.run_recovery_job(worker, {'id': 'neutral-test'}))
            worker.fail_current.assert_awaited_once_with(detail, retryable)


if __name__ == '__main__':
    unittest.main()
