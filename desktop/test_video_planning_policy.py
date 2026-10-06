"""Offline contract regressions: no model, GPU, network, or renderer is launched."""
import copy
import json
from pathlib import Path
import unittest
from unittest import mock
import video_gen as vg


def scene(label, seconds=8):
    return {'title': label, 'transition': 'cut', 'target_seconds': seconds, 'music': 'N/A',
            'shots': [{'visual': f'A gardener {label}.', 'camera': 'Static wide shot.',
                       'audio': 'Wind in leaves.', 'dialogue': [], 'duration_seconds': seconds}]}


def analysis():
    return {**vg.conservative_semantic_analysis('A gardener tends a garden.'),
            'presentation_mode': 'live action', 'preserved_features': ['gardener'],
            'visible_proof': ['six garden actions'], 'recommended_total_seconds': 30,
            'scene_beats': [{'transition': 'start' if i == 0 else 'cut',
                'target_seconds': 8, **scene(label)['shots'][0]}
                for i, label in enumerate(['enters', 'digs', 'plants', 'waters', 'rests', 'waves'])]}


class PlanningPolicyTests(unittest.TestCase):
    def test_metadata_numbers_and_literal_content_match_broker(self):
        fixture = Path(__file__).with_name('video-planning-numbers.json')
        for case in json.loads(fixture.read_text(encoding="utf-8")):
            with self.subTest(prompt=case['prompt']):
                self.assertEqual(vg.video_prompt_content_numbers(case['prompt'], case['duration']), case['numbers'])

    def test_six_scenes_are_compressed_without_losing_the_ending(self):
        candidate = vg.fallback_video_plan('A gardener tends a garden.', analysis(), 30, 15, 4)
        self.assertEqual(len(candidate['segments']), 6)
        original = copy.deepcopy(candidate)
        plan = vg.validate_plan_shape(candidate, 'Make it 30 seconds. Use 6 scenes.', 30, 15, 4)
        self.assertAlmostEqual(plan['target_total_seconds'], 30)
        self.assertEqual([s['shots'][0]['visual'] for s in plan['segments']],
                         [s['shots'][0]['visual'] for s in original['segments']])
        self.assertNotIn('best_effort_truncated', plan)

    def test_over_budget_fallback_keeps_words_then_reports_a_duration_conflict(self):
        prompt = 'I believe ' + ' '.join(['the garden needs careful attention'] * 12)
        candidate = vg.fallback_video_plan(prompt, vg.conservative_semantic_analysis(prompt), 7, 15, 4)
        spoken = ' '.join(line['text'] for s in candidate['segments'] for shot in s['shots'] for line in shot['dialogue'])
        self.assertEqual(vg.spoken_words(spoken), vg.spoken_words(prompt))
        with self.assertRaisesRegex(vg.VideoGenError, 'duration conflict.*requested runtime is 7s'):
            vg.validate_plan_shape(candidate, prompt, 7, 15, 4)

    def test_rejected_fallback_reports_attempts_and_never_claims_render_success(self):
        with (mock.patch.object(vg, 'analyze_video_intent', return_value=analysis()),
              mock.patch.object(vg, 'planner_json', side_effect=vg.VideoGenError('invalid draft')),
              mock.patch.object(vg, 'unload_planner_model'),
              mock.patch.object(vg, 'verify_plan_fidelity', return_value=['The final wave is missing'])):
            with self.assertRaisesRegex(vg.VideoGenError,
                    'after 3 screenplay attempts; fallback quality gate: The final wave is missing. No video was rendered'):
                vg.create_video_plan('A gardener tends a garden.', None, 30, '16:9', ('h3',))

    def test_validated_fallback_can_succeed_after_three_invalid_drafts(self):
        with (mock.patch.object(vg, 'analyze_video_intent', return_value=analysis()),
              mock.patch.object(vg, 'planner_json', side_effect=vg.VideoGenError('invalid draft')),
              mock.patch.object(vg, 'unload_planner_model'),
              mock.patch.object(vg, 'verify_plan_fidelity', return_value=[])):
            plan = vg.create_video_plan('A gardener tends a garden.', None, 30, '16:9', ('h3',))
        self.assertEqual(plan['planner']['screenplay_attempts'], 3)
        self.assertEqual(plan['planner_route'], 'local-validated-fallback')
        self.assertEqual(len(plan['segments']), 6)
        self.assertAlmostEqual(plan['target_total_seconds'], 30)
        self.assertNotIn('quality_gate_bypassed', plan)


if __name__ == '__main__':
    unittest.main()
