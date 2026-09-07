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

All 72 frame-reviewer calls completed across 24 frames. Human frame labels and
full-video comparisons remain separate gates; this planner result enables no
model, reviewer, composite or renderer canary. Live results and accounting are
retained under `artifacts/video-optimization/2026-09-07/`, including the raw usage
ledger, paired judgments, code hashes, compiler audits and frozen render inputs.

## Renderer timing results

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

**No renderer promotion yet.** Four blinded video pairs are ready for human
visual and audio review. The 24-frame labels are also pending. Recorded API
charges are $12.7356, with $8.6015 held for seven unresolved billing records:
$21.3371 committed against the authorized $50 cap. These reservations remain
held; they have not been treated as free calls. No additional cloud-policy or
combined renders were prepared without component qualification.
