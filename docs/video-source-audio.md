# Original-song lip-sync

Attach one audio file to `$minimax` or `$oalgo`, or reply to a message containing
one. An image may be attached alongside it. `$oalgo` keeps its built-in character;
`$minimax` uses the supplied image or its normal generated opening image.

Examples:

- Attach `verse.mp3`: `$oalgo rap this on stage`
- Attach `song.wav` and `character.png`: `$minimax perform this song in a recording studio`
- Reply to a song attachment: `$oalgo`

Supported files: MP3, WAV, FLAC, OGG, Opus, M4A and AAC, up to 25 MiB and
1–120 seconds. Trim longer songs to the excerpt you want before uploading.
The audio attachment's duration determines the finished video duration, rounded
up to the next video frame. The command's own song takes precedence over a
replied-to song. Image and audio selection are independent. Multiple songs on
the selected message are rejected.

The original vocals and backing track remain the soundtrack. This feature does
not convert the singer's voice to the character's voice or assign different
singers to different pictured characters. Describe the performer and visual
action in the prompt. Clear faces and visible mouths are preferable; fast rap,
occluded mouths and complex groups can still produce imperfect synchronization.

## Lyric timing

The broker transcribes the song with OpenAI `whisper-1` word timestamps when
the job is submitted (about five seconds and $0.006 per audio minute), so the
user supplies nothing extra. The planner receives a vocal timeline of timed
lyric lines and instrumental passages (wordless stretches of two seconds or
more). It is told to start segments where lines or instrumental passages start,
to let the shots act out or literalize the lyrics when the request leaves the
action open, and to show singing only where there are vocals. The transcript is
labelled as approximate song content, never instructions.

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
