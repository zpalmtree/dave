# Original-song lip-sync

Attach one audio file to `$minimax` or `$oalgo`, or reply to a message containing
one. An image may be attached alongside it. `$oalgo` keeps its built-in character;
`$minimax` uses the supplied image or its normal generated opening image.

Examples:

- Attach `verse.mp3`: `$oalgo rap this on stage`
- Attach `song.wav` and `character.png`: `$minimax perform this song in a recording studio`
- Reply to a song attachment: `$oalgo`

Supported files: MP3, WAV, FLAC, OGG, Opus, M4A and AAC, up to 100 MiB and
1 second to 10 minutes. The excerpt's duration determines the finished video
duration, rounded up to the next video frame. The command's own song takes precedence over a
replied-to song. Image and audio selection are independent. Multiple songs on
the selected message are rejected.

The original vocals and backing track remain the soundtrack. This feature does
not convert the singer's voice to the character's voice or assign different
singers to different pictured characters. Describe the performer and visual
action in the prompt. Clear faces and visible mouths are preferable; fast rap,
occluded mouths and complex groups can still produce imperfect synchronization.

## Excerpts of long songs

H3 renders take about 80–110 seconds of GPU per finished second, so a whole song
would hold the desktop for hours. A song of up to 35 seconds is used whole.
A longer song is cut to an excerpt of about 30 seconds (15–45), roughly 40–55
minutes of rendering:

- A range in the prompt wins: `$oalgo 1:05-1:50 rap this at a gas station`, or
  `from 2:10` for about 30 seconds ending on the line nearest that length.
  Ranges use `m:ss`, accept `-`, `–`, `to` or `until`, and may span at most two
  minutes. The range text is removed from the prompt. Without a song or a source
  video, the times stay in the prompt as part of the idea.
- Otherwise Gemini Flash reads the request and the timed lyric lines and
  chooses the part the request names ("the chorus", "the part about the cops"),
  or else the best-known part or the first full chorus. It returns line numbers,
  which are padded into the pauses around them. An answer that cannot be used
  falls back to the run of lines with the most repeated lyrics. A song without
  usable lyrics starts from 0:00.

The broker decodes the whole song, transcribes it once, chooses the excerpt,
cuts it with a short fade at each cut edge, and moves the lyric timing onto the
excerpt. Discord status shows what was used, for example "Lip-syncing to the
chorus, 0:47–1:07 of your 1:38 song". A choice the user didn't make also shows
how to pick another part with a range.

## Lyric timing

The broker transcribes the song with OpenAI `whisper-1` word timestamps when
the job is submitted (about five seconds and $0.006 per audio minute), so the
user supplies nothing extra. The planner receives a vocal timeline of timed
lyric lines and instrumental passages (wordless stretches of two seconds or
more). It is told to start segments where lines or instrumental passages start,
to let the shots act out or literalize the lyrics when the request leaves the
action open, and to show singing only where there are vocals. The transcript is
labelled as approximate song content, never instructions.

After a song is cut, word and line timestamps are shifted onto the excerpt's
timeline. If no usable word/line timeline survives, the broker transcribes the
cut audio once more and uses those local timestamps directly. This recovery
applies to uploads and named recordings; a failed retry retains any available
timing and the original recording. Valid excerpt timing adds no provider call.

Pinning the plan to the song then moves each cut out of any sung word, by up to
two seconds. It prefers a pause of at least a quarter second, then the start of
a transcribed line, then any gap between words. Each shot records
`source_audio_vocals` (`vocals` or `instrumental`). A shot whose singing starts
or stops at least a second inside it, next to an instrumental passage, also
records `source_audio_vocals_from_seconds` or
`source_audio_vocals_until_seconds`. The desktop compiler turns these into H3
wording: lip-sync only over the vocal span, and closed relaxed mouths that move
to the rhythm elsewhere. A segment that is instrumental throughout uses
closed-mouth face identity wording.

Whisper captions music with stock phrases such as "Thank you for watching!".
Those phrases are dropped, as is any segment that combines a no-speech
probability above 0.6 with an average log probability below -0.8. Sung lyrics
often score a high no-speech probability with good confidence, so that score
alone is not used. A song with fewer than three remaining words, a transcription
failure, or a missing OpenAI key leaves the job on the previous behavior: no
timeline, proportional cuts, and lip-sync throughout. The filtered words and
lines are stored in `source_audio_lyrics_json` and reused when a recovery or
local plan is pinned.

## Pipeline

The broker downloads a bounded Discord attachment without following redirects,
decodes it with local ffmpeg using a restricted container/protocol list, and
stores a stereo 48 kHz PCM WAV. Invalid, empty, short and overlong audio is
rejected before the job enters the queue. Audio shares the job's existing
retention and cleanup lifecycle. The worker fetches it through the authenticated
lease-scoped `source-audio` endpoint; it never downloads an arbitrary user URL.

Song planning uses fixed audio duration and no generated dialogue, voice accents,
or catchphrases. The broker pins scene boundaries to a 24 fps timeline and
stores each scene's source offset and output frame count, including in recovery
contracts. H3 samples a legal frame bucket while the original song slice is
encoded with its audio VAE and a zero audio noise mask. Native
`LTXVConcatAVLatent` supports H3's joint latents: video remains generatable while
the audio stays fixed. No new ComfyUI custom node is required.

Each scene receives its exact audio window. Generated frame-bucket overruns are
trimmed; opening silence, frozen-mouth instructions, loop trimming, automatic
kinetic splitting and runtime-budget truncation do not apply to song jobs.
Video tracks are assembled without AAC padding accumulating at boundaries, and
one continuous original audio track is muxed into the result. Standard delivery
encoding and loudness normalization still apply.

Single-scene recovery renders also trim decoded video frames before muxing the
song. A 123-frame scene occupies H3's 124-frame bucket; stream-copying with only
`-t` can retain the extra B-frame and fail the final frame-count check. The
generator now uses `finalize_song_video` for both single and multiple scenes.
CPU regression checks cover padded and exact-length single scenes, plus joins.

This follow-up is recorded in `desktop/video-song-single-scene-trim.patch` for
`video_gen.py`, together with the updated `desktop/video_source_audio.py`.
Both are applied to the live desktop. Check the patch before applying it to
another matching revision, and copy the helper alongside it. New generator
subprocesses load these changes without a worker restart.

## Installation and verification

Apply `scripts/apply-video-source-audio-desktop.py` to the audited desktop
baseline. It installs `video_source_audio.py` and patches `video_gen.py`,
`video_worker.py` and `video_recovery.py`. Reload the supervised worker child
while idle; preserve its supervisor, active renders and GPUq reservations.
The worker advertises `source_audio_version: 1`, and the broker only leases song
jobs to workers with this capability. Deploy both server branches with
`scripts/deploy-bots.sh --with-broker`.

Checks:

- `yarn build && node --test tests/video-source-audio.test.mjs tests/video-recovery.test.mjs`
- `PYTHONPATH=desktop python3 -m unittest desktop/test_video_source_audio.py`
- The existing desktop generator, worker and recovery suites in the Windows
  embedded Python environment.

GPU smoke renders must run through `gpuq`, with declared Gaming Mode and
preemption policies. The synthetic-vocal smoke fixture uses an original spoken
rhythmic phrase plus a generated beat; it contains no third-party song.

For a controlled vocal-isolation experiment, run
`scripts/benchmark-video-vocal-conditioning.py` in the desktop Python environment
through `gpuq run --profile video-h3 --priority normal --when-gaming hold --on-preempt fail -- ...`.
Supply `--desktop`, `--audio`, `--image`, a new `--output` directory, and `--prompt`;
optionally set `--start`, `--seconds` (1-12), and `--seed`. The default renderer
is the production base H3 model; `--renderer taomate` tests the fast renderer.
The script separates vocals with torchaudio's Hybrid Demucs on CPU, renders both
audio-conditioning variants with identical visual settings, and puts the same
original mix on both final videos. It saves the request, workflows and timings
for review. Vocal isolation remains an experiment, not a production default.
