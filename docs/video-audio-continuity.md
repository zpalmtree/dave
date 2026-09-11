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
