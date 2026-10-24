import json
from pathlib import Path
import subprocess
import tempfile
import unittest
import numpy as np
from video_score_cues import RATE, assemble_cues, passage_candidates, render
from video_sound_mix import media


def cue(**kwargs):
    return dict(start=.5, end=1.5, source_start=2, gain_db=-6,
                fade_in=.1, fade_out=.1, reason='Leave the spoken setup silent, enter for reveal', **kwargs)


class ScoreCueTests(unittest.TestCase):
    def test_source_offsets_silent_gaps_and_fades(self):
        audio=np.ones((4*RATE,2),dtype=np.float32);audio[2*RATE:3*RATE]*=.4
        c=cue();result=assemble_cues(audio,2,[c])
        self.assertEqual(np.max(abs(result[:RATE//2])),0)
        self.assertEqual(np.max(abs(result[3*RATE//2:])),0)
        self.assertAlmostEqual(float(result[RATE,0]),.4*10**(-6/20),places=6)
        self.assertEqual(result[RATE//2,0],0);self.assertEqual(result[3*RATE//2-1,0],0)
        for update in [{'source_start':3.5},{'start':-1},{'gain_db':1},{'end':float('nan')},{'fade_out':2}]:
            with self.assertRaises(ValueError):assemble_cues(audio,2,[{**c,**update}])
        with self.assertRaises(ValueError):assemble_cues(audio,2,[c,c])

    def test_sustained_passage_ranking_ignores_single_peak(self):
        audio=np.full((8*RATE,2),.01,dtype=np.float32)
        audio[RATE:RATE+4]=1;audio[4*RATE:6*RATE]=.2
        result=passage_candidates(audio,2)
        self.assertAlmostEqual(result[0]['source_start'],4,places=1)
        self.assertIn('requires scene review',result[0]['method'])

    def test_real_media_preserves_picture_and_no_music_is_identity(self):
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder);source=root/'dry.mp4';score=root/'score.wav';out=root/'out.mp4'
            media(['-f','lavfi','-i','color=c=blue:s=64x64:r=10:d=2',
                   '-f','lavfi','-i','sine=frequency=220:duration=2',
                   '-c:v','libx264','-pix_fmt','yuv420p','-c:a','aac','-shortest',str(source)])
            media(['-f','lavfi','-i','sine=frequency=880:duration=4',str(score)])
            returned,audit=render(source,None,out,2,[])
            self.assertEqual(returned,source);self.assertFalse(out.exists());self.assertEqual(audit['music'],'none')
            returned,audit=render(source,score,out,2,[cue()])
            packets=lambda p:json.loads(subprocess.check_output(['ffprobe','-v','error','-select_streams','v','-show_packets','-show_data_hash','sha256','-show_entries','packet=pts,dts,data_hash','-of','json',str(p)]))
            self.assertEqual(packets(source),packets(returned));self.assertFalse(audit['looped'])
            audio=lambda p:np.frombuffer(media(['-i',str(p),'-ar',str(RATE),'-ac','1','-f','f32le','pipe:1']).stdout,dtype='<f4')
            before,after=audio(source),audio(out)
            def tone(x,freq,start,end):
                x=x[round(start*RATE):round(end*RATE)]
                return abs(np.mean(x*np.exp(-2j*np.pi*freq*np.arange(len(x))/RATE)))
            self.assertAlmostEqual(tone(after,220,.7,1.2)/tone(before,220,.7,1.2),1,delta=.08)
            self.assertLess(tone(after,880,.1,.4),tone(after,880,.7,1.2)*.05)
            with self.assertRaises(ValueError):render(source,score,source,2,[cue()])


if __name__=='__main__':unittest.main()
