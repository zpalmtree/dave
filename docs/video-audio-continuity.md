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

## Scoring the finished edit (2026-10-23)

The genre experiment's three reviews preferred the recognizable style in all
three cases, but preferred the original soundtrack overall in two. The follow-up
`artifacts/music-timing-20261023` uses the exact recognizable-score mixes as
controls for two dialogue/action scenes. The car is excluded because its engine
masked the music in the previous review. No new footage or music is generated.

`desktop/video_score_timing.py` is an offline experiment utility, not installed
in the live worker. It applies a bounded linear gain envelope to the existing
score without changing its sample timeline, normalization, fades or ducking.
It rejects short scores rather than repeating them. The original scene audio
remains the input for speech/effects; video packets are stream-copied. A flat
envelope reproduces the production mixer in the real-media regression test.

The experiment's envelopes are manually authored from timestamped frames of the
finished edit and conservatively cover dialogue sequences; they are not precise
speech recognition results or output from an automated scoring planner. The
chicken scene leaves its question and final betrayal without music; the cafe
leaves the order and catapult action without music. Timing and level change
together, so results cannot isolate the benefit of either one alone.

`SCORE_TIMING_REVIEW_PAGE` uses the explicit rubric
`['timing', 'restraint', 'audio']` to evaluate placement, intrusion and scene fit,
plus overall preference. Playback retains the music review's synchronized
Listen A/B controls and does not stop on rating clicks. Production defaults
remain unchanged pending evidence.

## Composer audition (2026-10-23)

The timing experiment won both relative comparisons, but the user still rejected
the overall quality and clarified that the remaining problem was mostly the
music itself. The next experiment, `artifacts/music-composer-20261023`, compares
one Music3 sample with one ACE-Step 1.5 Turbo sample on an identical acoustic
cafe brief. It changes the configured composer, not video rendering or effects.
This is one sample per system and cannot establish general model superiority.

The ACE-Step arm uses the official ComfyUI AIO checkpoint and workflow settings;
the checkpoint download is pinned to a revision and verified against its published
SHA-256 before installation. Existing ComfyUI nodes support it without upgrading
the runtime. Both music jobs use GPUq admission. Raw outputs and graphs are
preserved, with no quality rerolls. The comparison uses the beginning of each
output, equal duration (20 seconds, or the shorter output if at least 15 seconds),
and matched integrated loudness using static gain. A shared lower target avoids
clipping if either excerpt cannot meet -20 LUFS below -1 dBTP. Both excerpts get
the same short endpoint fades; there is no looping, compression, EQ or ducking.

`scripts/serve-music-audition.mjs` serves the private audio-only review page.
The absolute usability choices are Use A, Use B, Either works and Use neither.
Saving requires the frozen audition fingerprint, and both source paths and model
names stay out of the public packet. Choosing or saving a verdict does not
replace or pause the players. Listen A/B switches at the same position, with one
audible player at a time. No production composer default changes automatically.

Official setup references:
[ComfyUI ACE-Step guide](https://docs.comfy.org/tutorials/audio/ace-step/ace-step-v1-5)
and [checkpoint files](https://huggingface.co/Comfy-Org/ACE-Step-1.5).


## Production music editing (2026-10-24)

The user approved rollout of the combined concrete-brief / Music3 / audiovisual
editor pipeline. In the six-case review, four comparisons differed: the candidate
won three, with all four graded acceptable (one still received a negative quality
note). Two identical no-added-music comparisons carry no preference evidence.
Future combined experiments exclude byte-identical outputs from preference review.
This small review supports rollout, not a claim of general musical superiority.

Normal recovery delivery now synchronizes and normalizes scene audio first.
If the approved screenplay requests instrumental music, the broker watches a
small preview and writes the same 200–450-word Music3 brief used in the reviewed
experiment. The desktop composes one 40–60-second performance through its existing
GPUq reservation. The broker then inspects finished footage and the full score,
choosing cue times, source passages, attenuation and fades, or no added music.
The renderer retains picture packets and the dry soundtrack, normalizes the whole
score to -30 LUFS and ducks selected passages against scene audio. There is no
looping, time stretching or per-shot music regeneration.

The editor reports suspected vocal regions on the score clock; validation rejects
cues overlapping them or their 250 ms guard intervals. This is model-based
screening, not a guarantee of vocal detection. Explicit no-music, supplied audio,
source-video edits and composed-song timelines bypass added music. A provider,
composition or editing failure retains scene audio, never an unreviewed full bed.
The legacy effects-only softening path remains available for eligible scenes.

`lib/VideoMusic.ts` serves authenticated recovery operations `music-brief` and
`music-edit`, after the worker lease and approved contract checks. API credentials
remain broker-side; provider hooks account for requests and usage. Input hashes
and first-attempt results live in recovery state. Each model stage allows one
contract repair; saved failures and interrupted pending calls do not automatically
purchase another attempt. Desktop score receipts retain the first successful
composition. The local `music-delivery-edit.json` records the applied decision.

Install desktop changes using `scripts/apply-video-music-pipeline-desktop.py`
after `--check`; it requires audited before/after hashes and refuses unrelated
changes. Reload the supervised worker only while dispatch is drained and no job
is active, then resume dispatch. Deploy both server tracks with
`scripts/deploy-bots.sh --with-broker`. Setting `VIDEO_SOUND_MIX=0` in the worker
environment and reloading it disables optional music and softening; rollback does
not require modifying video generation or supplied soundtracks.
