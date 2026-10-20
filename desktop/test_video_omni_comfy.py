"""CPU-only semantic checks for the isolated ComfyUI PDD backport.

Set OMNI_COMFY_ROOT and OMNI_MODEL_PATH in embedded Windows Python. The normal
repository suite skips these checks when ComfyUI/weights are unavailable.
"""
import json
import os
from pathlib import Path
import struct
import sys
from types import SimpleNamespace
import unittest


@unittest.skipUnless(os.environ.get('OMNI_COMFY_ROOT') and os.environ.get('OMNI_MODEL_PATH'),
                     'Set isolated ComfyUI and checkpoint paths for runtime checks.')
class PDDCompatibilityTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        sys.path.insert(0, os.environ['OMNI_COMFY_ROOT'])
        from comfy.cli_args import args
        args.cpu = True
        import torch
        import comfy.model_detection as detection
        import comfy.ops as ops
        from comfy.ldm.minimax.model import FinalLayer, time_shift_sigma
        cls.torch, cls.detection, cls.ops = torch, detection, ops
        cls.layer, cls.shift = FinalLayer, staticmethod(time_shift_sigma)
        with Path(os.environ['OMNI_MODEL_PATH']).open('rb') as handle:
            size = struct.unpack('<Q', handle.read(8))[0]
            cls.header = json.loads(handle.read(size))

    def test_checkpoint_head_bank_is_not_latent_channels(self):
        state = {k: SimpleNamespace(shape=tuple(v['shape'])) for k, v in self.header.items()
                 if k != '__metadata__'}
        config = self.detection.detect_unet_config(state, '', self.header['__metadata__'])
        self.assertEqual(config['pdd_steps'], 32)
        self.assertEqual(config['latents_dim'], 24)
        self.assertEqual(config['audio_latents_dim'], 32)
        # Undistilled head geometry retains its existing channel counts.
        state['final_layer.video_out.weight'] = SimpleNamespace(shape=(96, 5376))
        state['final_layer.audio_out.weight'] = SimpleNamespace(shape=(32, 5376))
        metadata = dict(self.header['__metadata__'])
        settings = json.loads(metadata['config'])
        settings['transformer'].pop('pdd_steps')
        metadata['config'] = json.dumps(settings)
        config = self.detection.detect_unet_config(state, '', metadata)
        self.assertEqual((config['latents_dim'], config['audio_latents_dim']), (24, 32))

    def test_zero_offset_head_bank_equals_plain_head_at_every_step(self):
        torch = self.torch
        layers = [self.layer(8, 4, 4, 2, 1e-5, pdd_steps=n, dtype=torch.float32,
                            device='cpu', operations=self.ops.disable_weight_init) for n in (1, 32)]
        with torch.no_grad():
            for layer in layers:
                for param in layer.parameters():
                    param.zero_()
                layer.norm.weight.fill_(1)
                layer.video_out.weight[:4].fill_(0.2)
                layer.audio_out.weight[:2].fill_(0.3)
            h = torch.ones(4, 8)
            t = torch.zeros(1, 4)
            sigmas = self.shift(torch.linspace(1, 0, 9), 1.0, 12.0)
            for sigma in sigmas[:-1]:
                plain = layers[0](h, t, (0, 2, 0), (2, 4, 0), sigma, sigmas, (12., 3.))
                pdd = layers[1](h, t, (0, 2, 0), (2, 4, 0), sigma, sigmas, (12., 3.))
                for actual, expected in zip(pdd, plain):
                    torch.testing.assert_close(actual, expected)


if __name__ == '__main__':
    unittest.main()
