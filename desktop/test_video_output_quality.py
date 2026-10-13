"""CPU regressions for approved timing, camera beats, mouth actions, and final edits."""
import array
import copy
import json
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest
from unittest import mock

import video_gen as vg
import video_recovery as recovery


def plan():
    return {
        'intent': 'A man opens a chest and studies its map.',
        'continuity_bible': 'The same man and chest in one room.',
        'recovery_approved': True,
        'keyframe': {'recommended': False, 'reason': 'Use the source.', 'prompt': 'A man beside a chest.',
            'reference_requirements': [], 'motion_contract': dict.fromkeys(
                ['subject_orientation', 'gaze_direction', 'travel_direction', 'camera_relation', 'first_second_action'],
                'Continue from the supplied frame.')},
        'segments': [{'title': 'Map', 'target_seconds': 12, 'transition': 'start', 'music': 'N/A',
            'shots': [{'duration_seconds': 12, 'location': 'room', 'camera_transition': 'continuous',
                'visual': 'The man says Ready, then spends eleven seconds opening the chest and studying its map.',
                'camera': 'Locked medium shot. Do not cut.', 'audio': 'Hinge creak and paper rustle.',
                'dialogue': [{'speaker_id': 'man', 'text': 'Ready.', 'language': 'English', 'delivery': 'calm'}]}]}],
    }


class OutputQualityTests(unittest.TestCase):
    def test_approved_action_time_survives_the_real_loading_and_compilation_path(self):
        candidate = plan()
        before = copy.deepcopy(candidate)
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'approved.json'
            path.write_text(json.dumps(candidate), encoding='utf-8')
            loaded = vg.load_frontier_video_plan(path, 'Render the supplied approved scene.', None, ('h3',))
        self.assertEqual(loaded['segments'][0]['target_seconds'], 12)
        self.assertEqual(loaded['segments'][0]['shots'], before['segments'][0]['shots'])
        compiled = vg.prepare_model_segments('', loaded, 'h3', 'opening.png', {}, True, 1)
        self.assertGreaterEqual(compiled[0]['output_seconds'], 12)
        self.assertLess(compiled[0]['output_seconds'], 12.75)
        self.assertIn('eleven seconds', compiled[0]['prompt'])
        # Existing unapproved local drafts retain their duration optimization.
        candidate.pop('recovery_approved')
        normalized = vg.validate_plan_shape(candidate, '', None, 15, 5)
        self.assertLess(normalized['segments'][0]['target_seconds'], 12)

    def test_approved_multi_beat_allocations_and_delivery_cut_survive(self):
        candidate = plan()
        segment = candidate['segments'][0]
        segment['output_seconds'] = 11
        segment['shots'][0]['duration_seconds'] = 8
        segment['shots'].append({**segment['shots'][0], 'duration_seconds': 4, 'dialogue': [],
                                 'visual': 'He follows the map with his finger.'})
        normalized = vg.validate_plan_shape(candidate, '', None, 15, 5, preserve_timing=True)
        result = normalized['segments'][0]
        self.assertEqual([s['duration_seconds'] for s in result['shots']], [8, 4])
        self.assertEqual(result['output_seconds'], 11)

    def test_continuous_beats_keep_one_shot_and_real_cuts_still_cut(self):
        segment = plan()['segments'][0]
        segment['shots'][0]['duration_seconds'] = 4
        reaction = {**segment['shots'][0], 'dialogue': [], 'visual': 'He reacts silently.'}
        segment['shots'].append(reaction)
        prompt = vg.compile_h3_prompt(segment, True)
        self.assertIn('At 00:04.000, within the same unbroken shot', prompt)
        self.assertNotIn('[Shot 2]', prompt)
        self.assertNotIn('After the cut,', prompt)
        self.assertNotIn('the camera cuts', prompt)
        segment['shots'].append({**reaction, 'camera_transition': 'cut', 'camera': 'Closeup of the map.'})
        prompt = vg.compile_h3_prompt(segment, True)
        self.assertIn('[Shot 2] At 00:08.000, the camera cuts.', prompt)
        self.assertNotIn('[Shot 3]', prompt)

    def test_legacy_plans_respect_clear_no_cut_constraints(self):
        segment = plan()['segments'][0]
        segment['shots'] *= 2
        for shot in segment['shots']:
            shot.pop('camera_transition', None)
        self.assertNotIn('the camera cuts', vg.compile_h3_prompt(segment, True))
        for shot in segment['shots']:
            shot['camera'] = 'Static medium view.'
        self.assertIn('[Shot 2]', vg.compile_h3_prompt(segment, True), 'Static angles alone do not forbid editing.')

    def test_later_speech_in_one_take_does_not_restart_the_shot_clock(self):
        segment = plan()['segments'][0]
        speaking = {**segment['shots'][0], 'duration_seconds': 4}
        segment['shots'] = [{**speaking, 'dialogue': [], 'visual': 'He opens the chest.'}, speaking]
        prompt = vg.compile_h3_prompt(segment, True)
        self.assertNotIn('No speech occurs in this shot', prompt)
        self.assertIn('No speech occurs during this beat', prompt)
        later_beat = prompt.split('At 00:04.000, within the same unbroken shot,')[1]
        self.assertIn('lead-in at this beat', later_beat)
        self.assertIn('<d>[English] Ready.</d>', later_beat)
        self.assertNotIn('from 00:00.000', later_beat)
        self.assertNotIn('beginning of this shot', later_beat)

    def test_silent_mouth_actions_and_post_dialogue_reactions_are_not_frozen(self):
        segment = plan()['segments'][0]
        for action in ['takes a bite of a sandwich', 'yawns', 'laughs', 'opens his mouth in surprise']:
            with self.subTest(action=action):
                shot = {**segment['shots'][0], 'dialogue': [], 'visual': f'The man {action}.'}
                segment['shots'] = [shot]
                prompt = vg.compile_h3_prompt(segment, True)
                self.assertIn(action, prompt)
                self.assertNotIn('lips remain closed', prompt)
                self.assertNotIn('teeth remain covered', prompt)
                self.assertIn('No speech occurs', prompt)
        segment['shots'].insert(0, plan()['segments'][0]['shots'][0])
        prompt = vg.compile_h3_prompt(segment, True)
        self.assertNotIn('mouths closed outside the dialogue', prompt)
        self.assertIn('Outside dialogue, mouth movement follows only the scripted physical actions', prompt)


class RecoveryAssemblyTests(unittest.TestCase):
    def setUp(self):
        if not shutil.which('ffmpeg') or not shutil.which('ffprobe'):
            self.skipTest('FFmpeg and ffprobe are required.')
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.clips = []
        for color in ['red', 'blue']:
            path = self.root / (color + '.mp4')
            subprocess.run(['ffmpeg', '-v', 'error', '-f', 'lavfi', '-i', f'color={color}:s=64x64:r=24:d=1',
                '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=1',
                '-c:v', 'libx264', '-threads', '1', '-c:a', 'aac', '-ac', '2', str(path)],
                capture_output=True, check=True)
            self.clips.append(path)

    def probe(self, path):
        result = subprocess.run(['ffprobe', '-v', 'error', '-show_entries', 'stream=codec_type,duration',
                                 '-of', 'json', str(path)], capture_output=True, text=True, check=True)
        return json.loads(result.stdout)['streams']

    def test_recovery_dissolve_blends_pixels_and_keeps_audio_aligned(self):
        output = recovery.join_clips(self.clips, self.root / 'dissolve.mp4',
            [{'transition': 'start'}, {'transition': 'dissolve', 'audio_transition': 'auto'}])
        for stream in self.probe(output):
            self.assertAlmostEqual(float(stream['duration']), 1.75, delta=0.05)
        frame = subprocess.run(['ffmpeg', '-v', 'error', '-ss', '0.875', '-i', str(output),
            '-frames:v', '1', '-vf', 'scale=1:1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'],
            capture_output=True, check=True).stdout
        self.assertGreater(frame[0], 30)
        self.assertGreater(frame[2], 30, 'The boundary must blend red and blue, not hard-cut.')

    def test_recovery_auto_audio_edit_softens_seam_without_changing_runtime(self):
        levels = {}
        for mode in ['cut', 'auto', 'fade']:
            output = recovery.join_clips(self.clips, self.root / (mode + '.mp4'),
                [{'transition': 'start'}, {'transition': 'cut', 'audio_transition': mode}])
            for stream in self.probe(output):
                self.assertAlmostEqual(float(stream['duration']), 2, delta=0.05)
            pcm = subprocess.run(['ffmpeg', '-v', 'error', '-i', str(output), '-map', '0:a:0',
                '-ac', '1', '-ar', '48000', '-f', 'f32le', '-'], capture_output=True, check=True).stdout
            samples = array.array('f', pcm)
            seam = samples[48000 - 96:48000 + 96]
            levels[mode] = sum(sample * sample for sample in seam) / len(seam)
        self.assertLess(levels['auto'], levels['cut'] * .4)
        self.assertLess(levels['fade'], levels['cut'] * .4)

    def test_song_join_keeps_all_frames_and_single_clip_is_written(self):
        output = recovery.join_clips(self.clips, self.root / 'song.mp4',
            [{'transition': 'start'}, {'transition': 'dissolve'}], source_audio=True)
        self.assertAlmostEqual(float(self.probe(output)[0]['duration']), 2, delta=.05)
        one = recovery.join_clips(self.clips[:1], self.root / 'single.mp4', [{'transition': 'start'}])
        self.assertTrue(one.is_file())
        self.assertAlmostEqual(float(self.probe(one)[0]['duration']), 1, delta=.05)


if __name__ == '__main__':
    unittest.main()
