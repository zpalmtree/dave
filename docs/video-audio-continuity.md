# Audio continuity across scenes

New screenplays define `speaker_profiles` once for the entire video. Each entry
contains `speaker_id` and `voice_description` (accent, habitual pitch range,
resonance, texture and cadence). `dialogue.delivery` remains the performance of
that particular turn. Both frontier and desktop planners receive this contract.
The H3 and LTX compilers repeat the matching voice identity with each spoken turn;
H3 speaker tags retain the same mapping even when the order of speakers changes
between segments. Spoken wording and language tags remain separate.

Older plans remain accepted. The desktop derives a missing speaker profile from
that speaker's first delivery description. This fallback is less descriptive
than a newly authored profile, but prevents each segment from choosing its own
prompt-level identity. Matching is case-insensitive. Text conditioning cannot
guarantee identical synthesized voices; no audio reference conditioning or voice
replacement is introduced here.

Frontier dialogue staging respects an explicit `off-screen` or `voice-over`
description in a speaker's profile. Those turns remain audible without adding a
visible speaker or making the pictured character lip-sync the narrator's words.
An explicit `on-screen` or `off-screen` in a turn's `dialogue.delivery` overrides
the profile's default placement for that turn, while keeping its voice identity.
Other speakers in the same shot keep their own visible performance. Restaging a
saved plan replaces the old compiler-generated staging suffix, including the
previous unconditional visible-speaker instruction. Plans without explicit
placement retain the existing visible-speaker default.

The frontier planner also preserves vocal gender/presentation, age range and
register along with the existing accent and texture, and keeps narrator identity
separate from the pictured character. These changes use the existing planning
call and renderer; they add no TTS service, model call, or render stage. Normal
camera changes already stay within a continuous segment when the duration and
action permit. Independent renders can still drift in voice identity; this is
prompt consistency, not an audio voice lock.

Each segment selects `audio_transition` independently from its picture transition:

| Value | Picture cut or continuation | Picture dissolve |
| --- | --- | --- |
| `auto` (legacy default) | 12 ms fades at the audio splice | Existing audio crossfade |
| `cut` | Unfaded audio splice | Audio splice at the picture dissolve midpoint |
| `fade` | 12 ms fades at the audio splice | Same short fades at the dissolve midpoint |

Fades do not overlap speech or shorten the edit. For a picture dissolve with an
independent audio cut, half the existing overlap is trimmed from each adjacent
audio stream, retaining alignment with the picture. Every input audio stream is
padded or trimmed to the corresponding video duration so codec padding cannot
accumulate across scenes. A final generation manifest records the selected audio
transitions, profiles, seam duration and dialogue-guard scope.

The H3 dialogue opening guard still protects the first segment. Later segments
retain their generated ambience and music during the prompt's speech-only
lead-in; the renderer no longer mutes their entire opening mix. Set
`VIDEO_H3_DIALOGUE_OPENING_GUARD_SCOPE=all` to restore the previous per-segment
mute, or `VIDEO_H3_DIALOGUE_OPENING_GUARD=0` to disable the guard entirely. Without
the internal mute, unwanted opening vocalizations are controlled by the prompt
and may still occur. Previously muted clips reused on resume remain muted.

These edits operate on the combined soundtrack. They suppress splice clicks,
but do not create uninterrupted ambience, sustain effect tails across cuts, or
make independently generated music share a phrase. Those require separate audio
tracks and a video-wide mix. Finish spoken turns before segment boundaries.

## Verification and installation

Node tests cover legacy migration, explicit profiles, silent plans, validation
and planner schema requirements. Desktop tests cover both prompt compilers,
speaker-tag stability, guard scope, and actual CPU FFmpeg assembly and decoding.
The FFmpeg test uses audio longer than its video to check duration correction
across cuts, continuations and mixed dissolve/audio edits. This is structural
and signal-processing verification, not a listening evaluation of new AI renders.

The desktop source and tests are archived in
`desktop/video-audio-continuity.patch` with exact before/after hashes. Install on
the recorded baseline using:

```bash
python3 scripts/apply-video-audio-continuity-desktop.py --check
python3 scripts/apply-video-audio-continuity-desktop.py
```

The worker launches `video_gen.py` as a separate process for each planning/render
invocation. New invocations load these changes; active generator processes keep
their loaded code. A worker restart is unnecessary for this generator-only patch.

## Music comparison (2026-10-23)

`MUSIC_REVIEW_PAGE` in `scripts/video-experience-review-ui.mjs` uses the same
review server and playback controls with the explicit rubric
`['genre', 'coherence', 'audio']`. Reviewers choose recognizable style, musical
flow, soundtrack fit, and overall preference. Notes can name the perceived genre
without revealing the intended treatment. Legacy numeric and full experience
reviews retain their existing validation. Both pages start paused and unmuted;
music Listen A/B buttons switch at the last playing video's timestamp. Rating
clicks retain the media elements and playback state.

The local `artifacts/music-genre-20261023` experiment reuses three distinct
real-usage videos (chicken, painted Tahoe, castle cafe). Only new scores are
composed through GPUq. The frozen manifest records the original footage and
score hashes, seeds, captions, section tags, runtime hashes, and mix policy.
Candidate captions target bossa nova, synth-funk, and acoustic folk with steady
grooves. This is a bundled caption/structure intervention, not proof that genre
naming alone causes an improvement. The original mixed soundtracks are controls.
There is one new composition per case, with identical-spec retries permitted
only for admission preemption. Short cues fail the duration check instead of
being repeated or silently replaced. Video packet hashes and timestamps must
match before a pair becomes reviewable. This experiment does not change the
production planner or music defaults.

Music3's [model card](https://huggingface.co/MiniMaxAI/MiniMax-Music3) recommends
structured musical descriptions and supports lyric section tags, but these are
not guarantees. Its duration limit is a ceiling; the model may stop early.
