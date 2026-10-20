import unittest
from video_fasth3_omni import build_prompt, MODEL


class OmniGraphTests(unittest.TestCase):
    def graph(self, **overrides):
        args = dict(prompt='<Picture 1> speaks.', images=['a.png'], prefix='test/omni', seed=42)
        args.update(overrides)
        return build_prompt(**args)

    def test_references_are_ordered_and_not_keyframes(self):
        graph = self.graph(images=['a.png', 'b.png'], audio=['voice.wav'])
        inputs = graph['conditioning']['inputs']
        self.assertEqual(inputs['ref_images.ref_image_1'], ['image_1', 0])
        self.assertEqual(inputs['ref_audios.ref_audio_0'], ['audio_0', 0])
        self.assertNotIn('first_frame', inputs)
        self.assertEqual(graph['audio_0']['inputs']['audio'], 'voice.wav')

    def test_release_sampling_and_audio_delivery(self):
        graph = self.graph()
        self.assertEqual(graph['model']['inputs']['unet_name'], MODEL)
        self.assertEqual(graph['scheduler']['inputs']['steps'], 8)
        self.assertEqual(graph['shift']['inputs']['shift_audio'], 3.0)
        self.assertEqual(graph['shift']['inputs']['shift_video'], 12.0)
        self.assertEqual(graph['video']['inputs']['audio'], ['decode_audio', 0])
        self.assertEqual(graph['sample']['inputs']['latent_image'], ['conditioning', 1])
        self.assertFalse(any('Lora' in n['class_type'] for n in graph.values()))
        self.assertEqual(graph['sparse']['inputs']['selection'], 'vsa')
        self.assertEqual(graph['sparse']['inputs']['selection.keep_percent'], 10.0)
        self.assertEqual(graph['guider']['inputs']['model'], ['sparse', 0])

    def test_rejects_unsupported_inputs(self):
        for options in [dict(images=[]), dict(images=['x'] * 10), dict(audio=['x'] * 4),
                        dict(frames=125), dict(width=831), dict(height=1024), dict(prompt='')]:
            with self.subTest(options=options), self.assertRaises(ValueError):
                self.graph(**options)

    def test_every_edge_resolves(self):
        for frames in (124, 243, 362):
            graph = self.graph(frames=frames)
            for n in graph.values():
                for value in n['inputs'].values():
                    if isinstance(value, list):
                        self.assertIn(value[0], graph)


if __name__ == '__main__':
    unittest.main()
