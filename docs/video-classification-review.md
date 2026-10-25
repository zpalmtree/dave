# Planner classification review

A `minor_sexualization` planner label now pauses routing for one independent
classification review of the original prompt, all supplied source images, and
current planning guidance. The reviewer does not generate a screenplay or use
the rejected screenplay as evidence. OpenAI reviews Anthropic/Meta/Google
classifications; Anthropic reviews OpenAI classifications.

The review separately assesses minors, sexual content, and whether sexual
content concerns a minor. Positive findings require grounded excerpts or
indexed image observations. Text evidence must occur in the submitted material.
Only an explicit, internally consistent clearance permits ordinary fallback.
Confirmed findings stop. Refusals, uncertain findings, invalid evidence, invalid
JSON, incomplete responses, and unavailable services leave the request unresolved
and stop generation. Usage-persistence failures propagate unchanged. Review calls
have a 90-second deadline and no automatic retries.

The recovery broker stores the review in `recovery_json.classification_reviews`
before routing or stopping. A versioned hash binds it to prompt, guidance, image
bytes, and image MIME types. Resumed planning can reuse that review for the same
rejecting model. Changed inputs require a new review. Regeneration deliberately
starts fresh. Provider attempt metrics retain the review outcome and evidence;
these are private operational records, not public Discord explanations.

When Muse's classification is cleared after a primary planner refusal, the
broker persists the original primary analysis and dialogue contract for Qwen.
It discards the flagged screenplay and requires a fresh local plan, which follows
the existing contract and validation path. A minor-classified candidate can no
longer emit a misleading `single_pass_salvage` acceptance event.

For a valid single-pass analysis whose screenplay omitted an explicit number,
the planner reuses that analysis and supplies the existing screenplay plus the
specific validation failure to one correction pass. It does not restart prompt
analysis. The corrected screenplay still passes normal contract validation.

## Reproducible routing evidence

Run after `node node_modules/typescript/bin/tsc`:

```
node --test tests/video-classification-review.test.mjs tests/video-recovery.test.mjs
node --test --test-name-pattern='missing count|minor classification' tests/video-protocol.test.mjs
```

The broker integration fixture exercises primary refusal → Muse flag → independent
clearance → persisted local routing → local-plan upload and approval. It verifies
that the original dialogue reaches Qwen, the approved local plan retains it, and
requesting the plan again does not repeat the provider calls. Additional fixtures
cover confirmed findings, unavailable/refusing reviewers, uncertain and malformed
responses, fabricated evidence, changed inputs, accounting failures, and legacy
worker routing. The protocol fixtures cover focused count repair and prevention
of premature salvage. These are API fixtures; no Discord UI is simulated.

Deploy both server branches using `scripts/deploy-bots.sh --with-broker`.
The existing desktop worker already consumes the local-planning response and
obtains its GPU reservation through `gpuq`; no desktop installation is required.
