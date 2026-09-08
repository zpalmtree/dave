# September 7 planner results

Keep **Sol low** for both MiniMax and OALGO. The cheapest eligible screening
finalist, Luna medium, failed the holdout promotion gates for both commands.
Screening covered eight configurations, including Astra and Gemini Flash;
incomplete screening candidates were ineligible. This does not establish that
every other model is worse than the control.

Each command used 20 unseen prompts plus four fixed repeat comparisons. Both
arms used the corrected broker duration validator, single-pass planning with
the production repair/fallback behavior, standard service tier, and the same
concurrency. Two providers judged blinded plans; repeated calls and judges were
clustered by prompt rather than counted as independent samples.

| Command | Planner | Mean API cost per plan | p95 planning seconds |
| --- | --- | ---: | ---: |
| MiniMax | Sol low | $0.02825 | 36.8 |
| MiniMax | Luna medium | $0.00248 | 54.0 |
| OALGO | Sol low | $0.05145 | 45.5 |
| OALGO | Luna medium | $0.00349 | 67.0 |

These are token-priced estimates, including repairs and fallback calls, for the
20 main holdout cases. They exclude image generation, rendering, queue wait,
judges and repeats. They are not invoices or projected whole-video savings.

| Command | Luna minus control, /10 | Prompt-cluster 95% interval | Candidate adherence flags | Repeat gate |
| --- | ---: | --- | ---: | --- |
| MiniMax | -0.208 | [-0.430, -0.018] | 1 | Failed |
| OALGO | -0.503 | [-0.933, -0.150] | 5 | Passed |

The flags and scores are machine judgments, not human video assessments. Both
models returned valid broker plans for all main and repeat cases after repairs.
The desktop compiler initially rejected one correctly timed plan for omitting
the runtime number from scene content. Its corrected validator accepts all 96
paid plans, while retaining object-count and quoted-number checks.

The audit trail retains two evaluation corrections: removal of timing metadata
from blinded plans, and clarification that choosing a runtime is allowed when
the user leaves duration open. The latter reran judgments with a new rubric
fingerprint and reused unchanged paid generations. Screening before the broker
duration fix remains hypothesis-selection evidence; the corrected holdout is
the qualification evidence.

All 72 frame-reviewer calls completed across 24 frames. Human frame labels are
now complete; full-video comparisons remain a separate gate; this planner result enables no
model, reviewer, composite or renderer canary. Live results and accounting are
retained under `artifacts/video-optimization/2026-09-07/`, including the raw usage
ledger, paired judgments, code hashes, compiler audits and frozen render inputs.

## Archived fast-command timing results

All eight isolated renders completed through GPUq. Each pair used the same
source images, compiled prompts, seed, scene layout and frame counts. FastH3
used the current four-step VSA profile with duration compression disabled.

| Anchor | Base service seconds | FastH3 service seconds | Reduction | Both output durations |
| --- | ---: | ---: | ---: | ---: |
| MiniMax racers | 475.193 | 95.180 | 80.0% | 10.144s |
| MiniMax note | 468.224 | 92.221 | 80.3% | 10.000s |
| OALGO refund | 241.050 | 64.107 | 73.4% | 8.000s |
| OALGO attachment/sign | 131.478 | 46.463 | 64.7% | 6.592s |

Service time excludes GPU admission wait and is not total Discord request
latency. A queued attempt was canceled before execution to bind the benchmark
to an unchanged source snapshot; the completed base render was reused after
hash verification. All four scene compilations were also verified unchanged
under the desktop duration-validator fix.

**Renderer promotion withdrawn after user clarification.** FastH3 is already
exposed by `$minimaxfast`, and the user has found its quality tradeoff unsuitable
for the normal commands. These timings describe that existing tradeoff; they
are not a newly achieved normal-command improvement. The four video comparisons
are archived and need no human ratings. Future AI configuration comparisons use
standard H3 for both arms, and legacy renderer release files are rejected.

At the frame-review checkpoint, recorded API charges were $12.7356, with
$8.6015 held for seven unresolved billing records: $21.3371 committed against
the authorized $50 cap. These reservations remain
held; they have not been treated as free calls. No additional AI configuration renders were prepared without component
qualification.


## Completed human frame review

The user accepted 22 of 24 frames and marked both rejected frames as material
failures. All three reviewers returned valid, fully metered decisions for all
24 frames. The same saved images and review context were verified before using
the completed human labels.

| Reviewer | Mean API cost | p95 seconds | False accepts | False rejects |
| --- | ---: | ---: | ---: | ---: |
| Sol high, control | $0.04486 | 49.41 | 0 | 15 |
| Sol low | $0.03316 | 23.36 | 0 | 15 |
| Flash low | $0.00246 | 14.39 | 0 | 3 |

Flash low qualifies for video testing: about 94.5% lower review cost and 70.9%
lower p95 review latency, with fewer false rejections on this set. Sol low also
passes the component gate, but Flash is the cheaper eligible finalist. Only two
human-rejected frames were present; zero observed false accepts does not
establish a reliable false-accept rate for other failures or prompt families.

| OALGO composite configuration | Human accepted | Material failures | Mean API cost | p95 seconds |
| --- | ---: | ---: | ---: | ---: |
| Pro image, 2K | 3/4 | 1 | $0.14073 | 74.32 |
| Flash image, 1K | 4/4 | 0 | $0.06843 | 73.43 |

Flash image at 1K qualifies for video testing with about 51.4% lower composite
cost and similar latency. Four paired composites are pilot evidence. The next
comparisons keep Sol-low planning and standard H3 rendering, change frame
review to Flash-low, and use Flash image at 1K for OALGO attachments. Both OALGO
video cases include an attachment so they exercise composition.

A source fingerprint change was audited against the original Git source.
Historical image evidence retains its original fingerprint; no human labels
were discarded and no completed image tests were repeated. Original paid
control/candidate assets are reused after explicit code and input-hash checks.
A read-only provider billing request returned HTTP 403 with the configured key;
unresolved reservations remain held and no production candidate is enabled.

## Completed MiniMax full-video review

The user reviewed both standard-H3 MiniMax pairs. The cheaper cloud arm changes
the frame reviewer to Flash-low; planning remains Sol-low.

| Case | Control score | Candidate score | Human findings |
| --- | ---: | ---: | --- |
| Three arcade racers | 5 | 5 | Both materially failed: speech came after stopping, and the finish line was blocked. |
| Handwritten note on Mars | 7 | 5 | Candidate materially failed by adding a second astronaut; control had no marked material failure. |

The user preferred the candidate in the tied racing pair and the control in the
astronaut pair. These preferences and both material-failure flags are preserved
as submitted. The candidate's mean score difference is -1 point across two
pairs, with a bootstrap interval of [-2, 0]. It fails the prespecified quality
gate, so MiniMax's cloud candidate is not eligible for a canary. Renderer service
time was also about 13.5% higher on average across these two single-run pairs;
this small comparison does not establish general latency behavior.

The saved racing plans already specify speech while racing, followed by boosting
and crossing the finish line. Both astronaut keyframes visibly contain one
astronaut, and both saved plans refer to the same astronaut throughout. The
late dialogue and extra astronaut conflict with those inputs. These checks
do not establish that the cheaper reviewer itself caused the failures or
that a more expensive planner would resolve them. Keep the rejected renders as
regression examples for dialogue/action timing, finish-line clearance and cast
continuity. OALGO's two cloud pairs remain pending, with their evidence separate.

## OALGO visual storytelling regression

The user reported that production job `f53e3fdc` spoke the Project Stargate
prompt correctly but showed only a talking head. Its saved Sol-low plan
explicitly required a locked close-up, no added text or graphics, and no
background changes. Its analysis listed the distinctive ideas but never turned
them into visual action. This failure was already present in the screenplay.

Cloud and desktop fallback guidance now separates spoken-word preservation from
visual subject-matter coverage. OALGO keeps his identity and opening frame while
the camera, environment and actions develop the premise. Explicit requests for
a static monologue still take precedence. The model and reasoning effort stay
at Sol-low; the change adds no extra planning stage.

The first revised Stargate plan supplied the missing visuals but extended the
video to 47 seconds, placing much of the action after the speech. After adding
guidance to stage action alongside the corresponding phrases, two new plans
finished at 25 and 26 seconds. Both preserved every original spoken word in
order and included technology completion, prestige/upgrades and cosmic rivalry
in shot visuals. The first used American symbols; the repeat explicitly staged
a separate US flag. The static-greeting control stayed a single five-second
locked portrait with exactly the requested greeting.

These are inspected plans, not proof of rendered quality or general benchmark
improvements. The two final Stargate planning calls took 51.9 and 67.4 seconds
and cost $0.1062 and $0.0577, including cache effects. Their richer staging also
requires more generated footage than the original 15-second portrait. The first
final plan is selected for a standard-H3 preview; the repeat remains evidence.
All plans and usage are retained in the campaign ledger and `oalgo-stargate/`.

The selected standard-H3 preview completed at 25.952 seconds, with 1,128.061
seconds of renderer service time and 1,271.847 seconds including admission and
wrapper work. Sampled output frames show the computing facility, branching
technology diagram, completion glow, gold upgraded branches and a final cosmic
reveal. The character turns and gestures. The sampled frames establish American
star/color motifs, but do not establish a distinct US flag. Both original and
revised videos passed browser playback checks with no console errors. The user
subsequently called the revision "muchbetter" but reported that it did not have
a very good Spanglish accent. This is qualitative feedback, not numerical
dialogue, lip-synchronization or pacing scores.
This one diagnostic has unequal durations and does not establish a speed gain.

The reviewed revision was uploaded to Discord as a reply to the original request:
[revised Stargate video](https://discord.com/channels/579913226129637376/746507379310461010/1546646014524657675).
The attachment's filename and 9,742,735-byte size were verified after posting.

## OALGO accent follow-up

The saved H3 effective prompt contains the requested Mexican-American Spanglish
delivery, including Mexican Spanish-influenced vowels, rhythm and intonation.
The accent instruction reached the renderer; its presence did not guarantee
the intended audible result. H3's
[official prompt guide](https://huggingface.co/MiniMaxAI/MiniMax-H3/blob/main/docs/VIDEO_PROMPT_WRITING_GUIDE_base_en.md)
supports describing voice identity and accent outside the spoken-text tags.
It does not establish the effectiveness of a particular wording.

A separate follow-up diagnostic rendered one 12.256-second standard-H3 clip with
no cloud calls. The first scene of the reviewed revision is reused as the
control: its effective prompt, 294 frames, seed, image, generator, templates,
and compiled scene were checked against the saved render. The candidate changes
only the delivery description to a concrete adult male voice with a strong
Mexican Spanish accent in English. Dialogue text and language, visuals, camera,
effects and timing remain identical in the compiled inputs. All English words
are preserved; no Spanish filler or phonetic respelling is introduced.

The trial is outside cloud-policy qualification and does not alter the original
14-video optimization manifest. Its frozen inputs and reuse audit are saved in
`oalgo-stargate/accent-test/`. A blind listening review must establish a suitable
accent without material dialogue, lip-sync or visual regressions before changing
default guidance. One scene and seed cannot establish reliability across prompts.
The candidate completed with 294 video frames and 523.821 seconds of renderer
service time. Its completed GPUq job, output manifest, effective prompt, seed,
frozen contract and video hash were verified before recovering a missing wrapper
completion record; no repeat render was needed. Both control and candidate pass
Windows Chrome playback checks with no console errors. The blind accent review
is complete. The user preferred B, the candidate, and marked dialogue clarity,
lip synchronization and visual storytelling acceptable. This supports the
specific voice description on this scene and seed; it does not establish an
accent success rate across other prompts.

OALGO planning guidance now supplies the exact preferred delivery as its default,
with performance changes permitted for explicitly requested emotions. The broker
also preserves up to 8,000 guidance characters: its previous 2,000-character cap
cut off most voice rules in the 2,992-character visual-story guidance. The revised
guidance is 3,385 characters. The reviewed accent trial used the complete cue,
so this is a separate production-submission issue, not an explanation for the
trial's weaker control voice.

A fresh production-guidance Sol-low plan preserved all supplied English words
and copied the tested delivery exactly into all three turns. All three cues
also compiled outside H3 spoken-text tags. That call cost $0.06268 and took 45.49
seconds; its 15-second plan has not been rendered. The full 279-test suite passes,
including broker storage of the complete longer character guidance. The desktop
worker already forwards that guidance unchanged, so no desktop source change or
additional inference stage was needed. Both OALGO cloud-comparison pairs are now
available and await their separate human ratings.

## OALGO attachment reaction follow-up

The user preferred B's accent and attachment inclusion in the refund pair, but
A's expressions. They reported that A omitted the woman and neither clip looked
toward the woman or clock. These are dimension-specific qualitative observations;
no overall preference, numerical score, or formal material-failure rating has
been inferred. This pair predates the separately approved Stargate voice change.

Inspection of the saved inputs confirms that A's starting composite omitted the
woman, while B's included her and the bedside props. Both plans explicitly kept
OALGO's gaze on the camera throughout. The composition instructions also favored
preserving the base portrait's framing/background and allowed a salient object
to stand in for the attached subject. These are actionable input failures; the
observations do not establish that a different planner model would fix them.

Composition guidance now preserves the main attached subjects and their
relationships to important props, allowing wider framing and the attached
setting. OALGO planning guidance names gaze targets and reaction timing in shot
visuals and distinguishes facial identity from a frozen expression. Explicit
continuous-eye-contact or stillness requests retain precedence. Production
models, reasoning effort, renderer profile, and number of inference stages are
unchanged. The longer guidance remains below the broker's 8,000-character cap.

One new production-model composite visibly preserves the sleeping woman, clock,
MONDAY papers, and OALGO. Two Sol-low diagnostic plans reuse the original complete
starting image to isolate planning from that new composition. The refund plan
speaks to camera, turns eyes and head toward the woman and clock, returns to the
camera, and slowly raises one eyebrow. The explicit continuous-eye-contact
control retains camera gaze throughout. Both preserve the exact five spoken
words and requested eight-second duration. Their gaze instructions survive
compilation into H3 prompts; the reaction compiles to 192 frames. The control
also calls OALGO seated, an unsupported pose description superseded by the
compiler's frame-zero image authority, so this is not a claim of perfect plans.

The composite cost $0.141724 and took 29.41 seconds; the reaction plan cost
$0.0607732 and took 35.10 seconds; the eye-contact control cost $0.0601632 and
took 33.21 seconds. All three calls are metered, totaling $0.2626604. These single
samples do not establish a cost, latency, or quality improvement across prompts.
Build and all 279 repository tests pass. No desktop source changes are required.
Inputs, usage, inspection, and compiled plans are retained in
`oalgo-refund-reaction/`, with the user's quote in
`human-review/oalgo-refund-feedback.json`.

One separate eight-second standard-H3 diagnostic uses the original complete
starting image, seed, duration, and frozen generator. It changes visual staging
and uses the previously approved voice. The original cloud-comparison manifest
and human ratings are preserved. Rendered gaze, expression, and audible quality
must be reviewed; plan compliance alone is not a rendered-quality result.

That first diagnostic completed at 800x800, 192 frames and eight seconds, with
197.129 seconds of renderer service time. Both earlier and revised clips played
in Windows Chrome. Sampled frames preserve the woman and props and show facial
changes, but only a small downward movement: they do not establish a clear look
toward either target. Later mouth opening also does not establish the planned
dialogue-first timing. This is recorded as a failed gaze check, not a quality pass.

A second guidance revision asks for a clear directional head turn and separates
ordered speech and reaction into successive shots. Its new Sol-low plan puts
the look toward the woman/clock before the line in the first shot, then devotes
the second shot to the silent eyebrow reaction. This is not the initially
proposed gaze-only silent shot; the actual model output and its limits are
retained. The explicit-eye-contact control also uses two shots and preserves
continuous camera gaze. Both keep the exact line and eight-second duration.
The reaction compiles to 192 frames with dialogue only in the first shot.
The two calls cost $0.0611132 / $0.0570632 and took 36.90 / 29.14 seconds.
All 279 tests pass again. One additional standard-H3 diagnostic tests this
staging, keeping the original image, seed and frozen generator; it is a combined
staging revision, not evidence isolating shot count, head-turn wording or voice.

The second clip completed at 800x800, 192 frames and eight seconds, using 206.623
seconds of renderer service time. Sampled frames now show a directional head
turn toward the woman's side of the scene, a return to camera, and a closer
facial reaction in the later shot. The woman remains visible. They do not
establish a distinct clock-specific glance or exact one-eyebrow compliance.
Both earlier and second-revision videos pass Windows Chrome playback checks.
The user preferred the new right-hand revision overall, but found its voice
slightly worse. The initially ambiguous "B" label was explicitly clarified as
the new right-hand clip before assigning the feedback. No numeric scores,
material-failure rating, or separate dialogue/lip-sync acceptance was supplied.
This supports retaining the revised staging while investigating its voice;
it does not qualify a cloud-model change.

## Refund voice isolation

The earlier and preferred-revision comparison changed visual staging, shot
count, sound descriptions and voice delivery together. It cannot attribute the
reported voice regression to the delivery description alone. A separate test
therefore reuses the preferred revision-2 render as control and copies the
earlier clip's exact complaint-delivery description into its otherwise unchanged
plan. The candidate retains both shots, camera instructions, soundscape, timing,
exact English words, source image, seed, templates and frozen standard-H3
generator. Deep comparison verifies that the compiled H3 input differs only in
the delivery description. It remains eight seconds and 192 frames.

This test requires one additional local render and no cloud-model calls. The
comparison uses fresh Voice A / Voice B labels and separate voice, dialogue,
lip-sync and reaction review fields. Changing voice instructions can still
change the generated facial performance, so visual checks remain necessary.
Production voice guidance is retained following this isolated comparison;
the earlier Stargate voice approval and original cloud-policy ratings remain
separate. Inputs and feedback are retained under
`oalgo-refund-reaction/voice-test/` and
`human-review/oalgo-refund-latest-feedback.json`.

The delivery-only candidate completed at 800x800, eight seconds and 192 frames,
with 191.676 seconds of renderer service time and 322.874 seconds including
admission and wrapper work. It matches the frozen candidate input. Both audio
and video decoded-stream hashes differ from the control, so this is not a
duplicate file or a container-only difference. Sampled frames retain the woman,
directional head turn and later closer facial reaction. Both videos pass Windows
Chrome playback checks with no console errors. All four dropdowns, including
every Yes option, are present, and desktop/mobile layout checks pass. The
experiment added no cloud requests or charges.

The user preferred the left clip, while describing the two as nearly identical.
The saved label mapping identifies the left clip as Voice A, the reused
revision-2 control with the current production delivery. This is a weak
qualitative preference at one scene and seed, not evidence of a large voice
improvement or general superiority. Retain the current voice with the preferred
revised staging and close this comparison without another voice render. Separate
dialogue, lip-sync and reaction acceptance checks were not supplied and have not
been inferred. The result does not qualify a cloud-policy change.

## MiniMax action timing and cast continuity

The reviewed race clips delayed “Not today!” until the vehicles stopped and
obstructed the finish. The astronaut candidate introduced a second astronaut.
Their saved inputs show two concrete weaknesses: the H3 compiler used the named
speaker only as a lookup key and emitted a generic delivery-based speaker instead;
the astronaut shots combined foreground hands with a facing helmet without clear
body ownership. These are plausible contributors, not isolated causal findings.

The compiler now binds each original speaker name to its stable S1/S2 voice ID,
keeping identity and delivery outside the exact spoken-content tag. This follows
the speaker-format guidance in the
[official MiniMax H3 prompt guide](https://huggingface.co/MiniMaxAI/MiniMax-H3/blob/main/docs/VIDEO_PROMPT_WRITING_GUIDE_base_en.md).
The cloud planner and desktop fallback also receive the same instructions to
keep simultaneous motion and speech together, reserve a later shot for a competing
finish/stop payoff, preserve an open travel path, and identify body ownership
through prop close-ups. Deliberately delayed speech, continuous-shot requests,
and intended additional characters remain allowed. Standard H3, cloud-model
defaults, and OALGO's selected delivery remain unchanged; no production model
stage was added.

Four fresh Sol-low diagnostic plans cost $0.3741662 across seven requests, all
settled. The race required single-pass fallback and a two-pass screenplay repair
for exhaustive roster validation: $0.2638552 and 125.11 seconds including retries.
Its final plan places the moving shout in a four-second first shot and the open
finish in a six-second second shot. The astronaut plan costs $0.048297 and takes
33.32 seconds, with discovery, a connected side-view pickup, and a readable-note
reaction. Its final helmet-behind-paper close-up still requires video inspection;
plan text alone does not establish that duplication is fixed.

The deliberately delayed-line control ($0.034832, 24.29 seconds) keeps crossing
and stopping silent, then speaks in shot 3. The two-person control ($0.027182,
17.94 seconds) retains both astronauts and their distinct hands in one side-view
shot. Compiled race input preserves the named magenta speaker and the exact words
once, in the first shot. These are diagnostic plan checks, not evidence of a
general cost, latency, or rendered-quality improvement.

Build and all 279 repository tests pass. The desktop suite runs 212 tests with
one skip and no failures, including new tests for named cast, stable voice IDs
across shots, and delayed dialogue. The cumulative desktop patch applies to the
audited original files and reproduces the tested live hashes. The existing frozen
campaign generator and unrelated working-tree changes remain untouched. All
inputs, usage, compiled contracts, and assessments are retained in
`artifacts/video-optimization/2026-09-07/minimax-adherence/`.

Two new standard-H3 diagnostics reuse each failed clip's original image and seed,
with the same 243 generated frames. Planning and compilation change together;
this comparison does not isolate either change or qualify a cloud-model promotion.

The revised race completes at 1344x768 and 10.144 seconds, matching the earlier
clip's displayed duration and dimensions. Renderer service takes 570.158 seconds,
versus 557.856 for the earlier failed clip; the new run takes 782.194 seconds
including startup, admission and wrapper work. One sample does not establish a
latency trend. Sampled frames show the magenta racer's speaking close-up with
changing roadside scenery, followed by all three racers continuing through an
open arch. The later arch gains invented lettering resembling “DEFIANT”; an early
arch leaves the view before that later arch appears, and a win by the speaking
racer is not conclusively established. This is partial visual improvement, not
a complete adherence pass. Exact audible wording, timing and lip sync await
listening and human review. Both race clips play in Windows Chrome, with no
console errors or horizontal overflow at desktop and mobile widths. The review
uses fixed Earlier/left and Revised/right labels and explicit Yes/Partly/No
choices; no human ratings were created during verification.

The astronaut follow-up completes at 1344x768 and ten delivered seconds, matching
its earlier clip (243 generated frames, 240 delivered frames). Renderer service
takes 509.707 seconds versus 513.096 earlier; total elapsed time is 773.063 seconds,
including waiting behind another desktop GPU job. Sampled frames keep one visible
astronaut through the approach, connected pickup and frontal note close-up, with
“back in five minutes” readable at 7–9 seconds and no second opposing astronaut
body. This supports a visible cast-continuity improvement at this image and seed;
full-video preference and absence of speech await human review. Both astronaut
clips play in Windows Chrome without console errors, and all acceptance fields
include Yes. The two comparisons remain separate from the original campaign's
ratings and do not change its failed cloud-policy promotion decision.

The user subsequently preferred the revised race. Moving speech, a clear finish,
three-racer continuity, and the combined dialogue/lip-sync check are all Yes;
the speaking racer's win is only Partly. Retain the action and speaker-binding
changes without claiming full winner clarity or a model-policy promotion.

The user preferred the earlier astronaut clip. The revised clip receives Yes for
one astronaut, readable note text, and silence, but only Partly for discovery.
Their reason is a physical contradiction the frame inspection missed: the note
faces the camera while the astronaut also faces the camera, so the astronaut
cannot read its written side. The earlier over-shoulder angle lets actor and
viewer read the same surface. Correct cast count and audience-readable text
therefore do not make the revised scene an overall improvement. Raw reviews and
video-hash mappings remain in `minimax-adherence/*-human-review.json`.

## Reading geometry follow-up

The cloud and desktop fallback planners now distinguish a character reading a
physical surface from presenting it to the audience. Reading requires the written
side to face the reader, a matching eyeline, and an audience view beside/behind
that same shoulder or through the reader's subjective view. Visible hands and
shoulders must still belong to the same identified body. Explicit presentation
remains allowed, as does turning the page outward after an actual reading beat.
This adds planning guidance, with no renderer, voice, or model-default change.

Two fresh Sol-low checks cost $0.1128836, with two settled requests. The reading
plan ($0.083117, 31.08 seconds) uses a three-second approach, four-second connected
pickup turning the written side toward the visor, and three-second over-left-
shoulder reading shot sharing the readable side. The explicit-presentation
control ($0.0297666, 21.09 seconds) retains a frontal shot with the note held
outward to the audience. Both preserve silence and ten seconds. The reading
directions survive compilation into the 243-frame H3 input. These are plan checks;
the prior failure demonstrates why actor-readable geometry still needs video
inspection and human review.

One new standard-H3 render reuses the original image, seed, templates and duration,
and compares against the earlier over-shoulder clip the user preferred. The
rejected outward-presentation clip and its review remain intact. Build and all
279 repository tests pass; the desktop suite runs 212 tests with one skip and no
failures, and the updated cumulative desktop patch reproduces its audited live
source. Evidence is retained in `minimax-adherence/note-reading/`.

The follow-up completes at 1344x768 and ten delivered seconds, with 243 generated
and 240 delivered frames. Renderer service takes 507.038 seconds and total elapsed
time is 574.870 seconds; these single-run timings do not establish a speed gain.
Sampled frames now show the paper's blank back during the middle reading setup,
then an over-shoulder view sharing its written face with the astronaut. The hand
belongs to the same visible astronaut and the phrase is readable. The face also
becomes visible during the middle shot, changing the reflective visor appearance
without a request; that remains a continuity concern for review. Both comparison
clips play in Windows Chrome without console errors, all acceptance fields have
Yes, and desktop/mobile layout checks pass. Reading geometry is now assessed
separately from audience readability, cast count, and overall preference; no new
human scores or acceptance have been inferred.

The user then preferred the new reading-angle revision and marked all five
checks Yes: physically possible reading, one astronaut, discovery, readable note
text, and silence. Retain the deployed reading-geometry correction and close this
targeted comparison without another render or cloud call. This is an overall
preference and five affirmative checks at one scene and seed; no numeric score,
material-failure rating, or separate visor-appearance rating was supplied. The
earlier frame-inspection concern remains recorded without treating it as a reason
to override the user's preference. The result does not qualify a cloud-model or
renderer-policy promotion. Raw feedback, video hashes, and the acceptance decision
are preserved in `minimax-adherence/note-reading/`.

## Billing reconciliation

After render preparation and the targeted planning checks, the ledger records
$14.5976 in token-priced charges and $8.6015 in unresolved reservations, or
$23.1991 committed against the $50 cap. Authenticated OpenAI minute-level usage
exports account for five additional Astra requests and one Sol judge request
after subtracting recorded usage. Their residual token-priced costs are $1.0850
and $0.0235 respectively. Astra's overlapping calls have aggregate attribution;
minute buckets do not establish individual request costs. These exports are
retained as reconciliation evidence, with no reservation released or promotion
gate changed. The canceled Google image call still lacks attributable billing.
