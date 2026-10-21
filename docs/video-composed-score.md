# Composed instrumental scores

A multi-scene H3 video renders each scene as its own run, and each run generates
its own music. A dialogue-free edit therefore restarts its soundtrack at every
cut. Job 311b658a ("make a hype edit for meximutt, aura farming, no speech, fast
cuts") had four phonk tracks, with only ambience between them.

Such requests now get one original instrumental score, composed before planning
through the same path as a composed song:

1. `mayWantComposedSong` also matches edit and montage words (hype edit, phonk,
   aura farming, montage, AMV, trailer, dancing, background music). Those
   requests pay for one songwriter call (`writeVideoSong`), which decides.
2. The songwriter returns `mode: 'score'` when nobody in the video speaks or
   sings and music carries it. A skit, argument, narration or reaction stays
   `none`, because a score replaces all of the video's sound, including sound
   effects. A score has a caption but no lyrics; the broker sends Music3 the
   `[Instrumental]` tag in place of lyrics (`VIDEO_SCORE_LYRICS`).
3. The worker composes it with `video_song.py` exactly as it composes a song.
   The worker needs no changes for this.
4. `storeComposedSong` skips whisper for a score. It detects the score's beat
   grid (`detectVideoScoreTiming`), using the caption's BPM to settle octave
   ambiguity, and stores `{ words: [], lines: [], score: { bpm, beats, bars } }`
   in `source_audio_lyrics_json`. `source_audio_origin` stays `composed`, so a
   regenerate composes a new score.
5. Planner guidance for a score forbids speech, singing and lip-sync, and lists
   the bar start times. `pinVideoPlanToAudio` moves each scene cut to the
   nearest bar (else beat) within two seconds, and each cut between shots to
   the nearest beat within half a second. It also marks every shot
   `source_audio_vocals: 'instrumental'`, so the desktop compiler asks H3 for
   closed mouths and movement to the rhythm.

Discord shows "Scoring an original soundtrack". `VIDEO_COMPOSED_SONG=0` disables
both songs and scores. A failed composition plans the job with per-scene audio,
as before.

Beat detection is a small onset-strength tempo and phase search on 11 kHz mono
PCM. It returns an empty grid when the audio has no steady pulse, and the plan
then keeps the planner's own timings.

Checks: `node --test tests/video-composed-song.test.mjs tests/video-source-audio.test.mjs`.
