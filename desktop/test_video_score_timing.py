import json
from pathlib import Path
import subprocess
import tempfile
import unittest
import numpy as np
from video_score_timing import gain_envelope, timed_bed, render
from video_sound_mix import continuous_bed, mix_video, media


class ScoreTimingTests(unittest.TestCase):
    def test_envelope_guards_and_silence(self):
        for points in ([[0,1],[2,1.1]], [[0,1],[1,0],[1,.2],[2,0]], [[0,float('nan')],[2,0]], [[.1,0],[2,0]]):
            with self.assertRaises(ValueError):gain_envelope(points,2)
        envelope=gain_envelope([[0,0],[.5,0],[1,.5],[1.5,0],[2,0]],2,100)
        self.assertTrue(np.all(envelope[:50]==0))
        self.assertTrue(np.all(envelope[150:]==0))
        self.assertAlmostEqual(float(envelope[100]),.5)

    def test_real_media_flat_equivalence_silence_and_unchanged_video(self):
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder);score=root/'score.flac';source=root/'dry.mp4'
            media(['-f','lavfi','-i','sine=frequency=440:duration=3','-c:a','flac',str(score)])
            media(['-f','lavfi','-i','color=c=blue:s=64x64:r=10:d=2',
                   '-f','lavfi','-i','sine=frequency=220:duration=2',
                   '-c:v','libx264','-pix_fmt','yuv420p','-c:a','aac','-shortest',str(source)])
            flat=root/'flat.wav';reference=root/'reference.wav'
            timed_bed(score,flat,2,[[0,1],[2,1]])
            continuous_bed(score,reference,2)
            pcm=lambda p:media(['-i',str(p),'-f','f32le','pipe:1']).stdout
            self.assertEqual(pcm(flat),pcm(reference),'Flat envelope must reproduce existing bed exactly')
            gated=root/'gated.wav';timed_bed(score,gated,2,[[0,0],[.5,0],[.75,.5],[1.25,.5],[1.5,0],[2,0]])
            data=np.frombuffer(pcm(gated),dtype='<f4').reshape(-1,2)
            self.assertEqual(float(np.max(np.abs(data[:24000]))),0)
            self.assertEqual(float(np.max(np.abs(data[72000:]))),0)
            self.assertGreater(float(np.max(np.abs(data[40000:55000]))),0)
            with self.assertRaisesRegex(ValueError,'too short'):timed_bed(score,root/'short.wav',4,[[0,1],[4,1]])
            baseline=mix_video(source,root/'baseline.mp4',{'effects':'preserve'},2,score)
            output=root/'edited.mp4';render(source,score,output,2,[[0,1],[2,1]])
            self.assertEqual(pcm(baseline),pcm(output),'Flat render must preserve the baseline mix')
            packets=lambda p:json.loads(subprocess.check_output(['ffprobe','-v','error','-select_streams','v','-show_packets','-show_data_hash','sha256','-show_entries','packet=pts,dts,data_hash','-of','json',str(p)]))
            self.assertEqual(packets(source),packets(output))
            with self.assertRaisesRegex(ValueError,'overwrite'):render(source,score,source,2,[[0,1],[2,1]])


if __name__=='__main__':unittest.main()
