# Local screenplay validation and recovery

Local planning emits `local_planning_exhausted:` after screenplay and fallback
candidates fail validation. The worker and broker stop that job after one
recovery pass, even if a worker mistakenly marks the failure retryable. Planner
or review service failures instead produce `local_planning_unavailable:` and
retain bounded infrastructure recovery. A pass containing a service failure is
not considered a fully exhausted candidate-validation sequence.

Rejected screenplays and fallbacks stay on the desktop under
`worker_plans/<job-id>.local.diagnostics/<invocation-id>/`. The CLI derives this
path from `--local-plan-output`; direct generator calls use
`worker_logs/planning_diagnostics/<invocation-id>/`. Distinct invocations never
overwrite one another. Existing worker cleanup removes these with expired plan
and log artifacts after seven days.

Artifacts contain the raw response, prepared candidate, failure phase, private
error or semantic issues, resolved runtime constraint and timing snapshots.
Segment indexes are one-based. `original` records the parsed response; `input`
records validation input after candidate preparation;
`normalized_before_allocation` and `normalized` record timing normalization.
Invalid JSON retains its raw response. Earlier failures may have only the
snapshots reached before failure.

These files contain user content. They are never uploaded to the broker or
included in public errors. POSIX files use mode 0600; Windows files inherit the
worker directory ACL. Diagnostic write failures produce a content-free warning
and preserve the original planning failure.

Compare generated `target_seconds`, retained `output_seconds` and
`speech_estimate_seconds` across snapshots before changing timing behavior.
Speaking time remains a heuristic, not measured audio. The speech estimator and
final-cut dialogue guard are unchanged. Rejected cuts are not automatically
lengthened and required dialogue is not deleted.

Explicit API durations remain exact. Total-runtime ranges such as “Make it
10–12 seconds” or “a 10–12-second video” remain bounds on the finished cut. Local
planner instructions, structural validation and semantic review share the
resolved constraint. Fallback construction targets the upper bound; validation
accepts feasible cuts throughout the range. Quoted speech and shot-level waits
do not become total-runtime constraints. Runtime numbers are timing metadata;
quoted numbers and object counts remain content checks.

The logs for `6b73c6d7-f4ef-4f06-900f-18254ed451f8` and
`dfc5aa23-ef88-4955-b56d-7ad58c57dedc` do not recover the rejected plans or numeric
timings. Their original conflict source remains undetermined. This patch starts
from inspected generator SHA-256
`f2dd437f287df1763a02290cb87d8fabc3ffbed8846caf0af139f9a6c659363e`, not a verified
snapshot of the code executing those jobs. Neutral offline fixtures demonstrate
an already-short candidate cut, feasible and infeasible runtimes, range handling,
JSON diagnostics, semantic rejection privacy and recovery classification.

Install with:

```bash
python3 scripts/apply-video-planning-diagnostics-desktop.py --check
python3 scripts/apply-video-planning-diagnostics-desktop.py
```

The installer checks exact before/after hashes and preserves existing unrelated
desktop edits. New generator processes load the change immediately; reload the
supervised worker child while idle to activate recovery classification. Deploy
both server branches with `scripts/deploy-bots.sh --with-broker`.
