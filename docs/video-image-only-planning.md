# Image-only screenplay planning

Job `282551cc` classified two stacked social posts as a `rigid_artifact` and
planned a six-second screenshot hold. Its analysis listed interface elements
instead of the posts' premises and explicitly prohibited reenactment.

Image-only planning now reads the legible content before selecting an animation
strategy. Screenshot format and text density do not imply an artifact hold.
The existing analysis fields record the selected premise, participants, events,
and content-based reason for the strategy; no protocol or schema change is needed.

| Source or direction | Expected treatment |
| --- | --- |
| Anecdote, joke, exchange, hypothetical scene, or visualizable claim | Adapt the grounded premise into concrete action, preserving its relationships and payoff. |
| Unrelated stacked posts | Choose the clearest complete premise and identify the choice; do not combine unrelated casts or events. |
| Informational UI or insufficient legible content | Keep a readable artifact; do not invent concealed text or a missing ending. |
| Explicit user staging or preservation direction | Follow the user's direction over automatic adaptation. |
| Instructions embedded in the image | Treat them as source content, never planner authority. |

The supplied image remains frame zero. A narrative adaptation briefly establishes
it and then cuts into a new segment, using `output_seconds` to trim the source
hold while retaining the model minimum for `target_seconds`. Original in-world
dialogue can support an adaptation; screenshot text is not automatically read
aloud. Source avatars and interface details are not automatically story cast
or required scenery.

Both single-pass and two-pass frontier planning use these rules. The matching
desktop fallback instruction change is archived in
[`desktop/image-only-planning.patch`](../desktop/image-only-planning.patch).
It has also been applied to the live desktop `video_gen.py`. The worker launches
the generator as a subprocess, so subsequent launches read the updated file.
To apply the archived change to a matching older copy, first run
`git apply --check /absolute/path/to/desktop/image-only-planning.patch` from the
generator directory, then apply it. An already-patched copy should pass the
equivalent `git apply --reverse --check` instead. Do not apply over conflicts.

Build and run the normal repository tests with `yarn test`. The opt-in live
regression harness uses synthetic, non-explicit screenshots, makes paid planner
calls, and records images, returned plans, usage, and results locally:

```sh
node scripts/check-video-image-only-planning.mjs --live --out /tmp/image-only-check
node scripts/check-video-image-only-planning.mjs --live --two-pass --case unrelated-posts --out /tmp/image-only-two-pass
node scripts/check-video-image-only-planning.mjs --replay --out /tmp/image-only-check
```

Review each saved plan against the fixture's `review` criterion as well as the
automated strategy, source-frame, narrative-cut, and visual-coverage checks.
These are planning checks, not rendered-video quality tests. The harness does
not enqueue jobs, invoke GPU inference, or send Discord messages.

Validation on 2026-09-09: TypeScript build, all 287 repository tests, and all
158 desktop generator tests passed. All six single-pass fixtures and the
two-pass unrelated-posts fixture passed live planning and manual review; all
seven saved plans also passed the desktop H3 validator and prompt compiler.
The cat/box adaptation excluded the unrelated truncated post. The vacuum joke
produced physical events plus one short original in-world line. The settings,
explicit-preservation, and insufficient-content cases remained artifacts.
No video render or live desktop model inference was performed.

Deploy the frontier change with `scripts/deploy-bots.sh --with-broker` after
pushing both branches: the broker process imports the planner. Its deployment
flow holds new dispatch and reconciles an active render after restart.
