# Original-song lip-sync

Attach one audio file to `$minimax` or `$oalgo`, or reply to a message containing
one. An image may be attached alongside it. `$oalgo` keeps its built-in character;
`$minimax` uses the supplied image or its normal generated opening image.

Examples:

- Attach `verse.mp3`: `$oalgo rap this on stage`
- Attach `song.wav` and `character.png`: `$minimax perform this song in a recording studio`
- Reply to a song attachment: `$oalgo`

Supported files: MP3, WAV, FLAC, OGG, Opus, M4A and AAC, up to 25 MiB and
4–120 seconds. Trim longer songs to the excerpt you want before uploading.
The audio attachment's duration determines the finished video duration, rounded
up to the next video frame. The command's own song takes precedence over a
replied-to song. Image and audio selection are independent. Multiple songs on
the selected message are rejected.

The original vocals and backing track remain the soundtrack. This feature does
not convert the singer's voice to the character's voice, transcribe lyrics for
storyboarding, or assign different singers to different pictured characters.
Describe the performer and visual action in the prompt. Clear faces and visible
mouths are preferable; fast rap, occluded mouths and complex groups can still
produce imperfect synchronization.

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
