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
is now available; the voice change remains unproven until listening feedback.

## Billing reconciliation

After render preparation and the targeted planning checks, the ledger records
$13.6670 in token-priced charges and $8.6015 in unresolved reservations, or
$22.2685 committed against the $50 cap. Authenticated OpenAI minute-level usage
exports account for five additional Astra requests and one Sol judge request
after subtracting recorded usage. Their residual token-priced costs are $1.0850
and $0.0235 respectively. Astra's overlapping calls have aggregate attribution;
minute buckets do not establish individual request costs. These exports are
retained as reconciliation evidence, with no reservation released or promotion
gate changed. The canceled Google image call still lacks attributable billing.
