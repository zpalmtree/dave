# Replacement editor fallback

Open <http://localhost:4348> after running:

```sh
yarn build
node scripts/serve-edit-fallback-showcase.mjs
```

The showcase executes `createVideoEditStill` with synthetic provider replies and
uses the shared bot message formatters. It does not call providers or render video.
Its quality-error card uses the shared failure formatter; broker review behavior
is covered by the HTTP integration tests.

Reviewed Playwright MCP captures: [desktop](desktop.png) at 1440px and
[mobile](mobile.png) at 390px. Both include loading, primary success, fallback
success, outage, empty output, both editors declining, unconfigured fallback,
cancellation, usable imperfect stills, source recovery, failed source recovery,
motion recovery, background-mask recovery, subject colour protection, failed animation
tracking and wrong-identity rejection states. Neither has horizontal overflow.
No task browser tabs remain open. The shared browser emitted a pre-existing wallet
extension `ethereum` injection error; the page has no scripts or application errors.

Captured from base revision `f37504a` plus this change. The feature fingerprint in
the screenshots is SHA-256 `680905616436` over `VideoKeyframeProvider.ts` and
`VideoBroker.ts`, then `VideoEditReview.ts`, `desktop/video-edit-recovery.patch`,
`desktop/video_edit_source_recovery.py`, `desktop/video-edit-source-recovery.patch`
and `desktop/video_edit_alignment.py` in that order.

Validation:

- TypeScript build passed.
- The editor, edit-review and broker suites passed all 64 tests. The still and
  motion reviewer use separate contracts; admitting a usable still does not
  override a rejected finished animation.
- Tests cover original image/prompt preservation, separate shot accounting,
  direct fallback after outages, missing configuration, empty/corrupt output,
  PNG conversion for effect metadata, cancellation, hook failures, deadline
  exhaustion and broker rejection of an alternate frame that fails review.
- Live review with the revised still contract accepted the user-approved Nano
  Banana output and rejected the unchanged source as a negative control. The
  reference identity, scene and composition were recognized despite pose and
  expression differences. Generation and motion quality are separate decisions.
- A GPU-admitted local animation test rendered that still through Viggle-Animate,
  then stopped during replacement-mask tracking (only 8% of frames had a usable
  track). No finished composite or Discord delivery is claimed. The raw animation
  and private job images remain outside the public showcase and Git history.
  Visual inspection at 1.5 and 2.8 seconds also showed severe ghosting in the raw
  output; accepting the still does not establish usable animation quality.

The October 28 animation-recovery follow-up passed 74 focused desktop tests and
the installer baseline/already-applied/concurrent-edit checks. Live Wan generation
followed the failing source turn; frame-by-frame spatial segmentation recovered
96% tracking versus 32% with propagation. An integrated replay of the actual
Viggle/Wan diffusion output exercised automatic fallback with live SAM,
compositing and evidence extraction. The finished clip passed a live motion review
and exported as a looping GIF. Visible clothing/leg/boundary distortion remains.
The earlier 8% failure above is retained as the original test record, not the
follow-up outcome. Public cards use fixtures; private test images remain untracked.

The October 29 source-tracking follow-up passed 74 focused Windows desktop tests,
the TypeScript build and 53 editor/reviewer/broker tests. Fresh preparation of the
original 17-second source passed both shots, including automatic backward and
seeded tracking recovery. The source recovery cards describe this bounded path
and use the shared failure formatter. These fixtures do not claim a finished
replacement render. Both updated captures were reviewed with no overflow; all
task-owned browser tabs were closed.

The replacement-alignment follow-up passed 91 focused tests in the Windows runtime.
A real 36-frame replay reused the two saved animation outputs, retried segmentation
through GPUq with source-interior points, and rebuilt colour matching and compositing.
Both segments passed the live motion reviewer. The original blanket masks failed
alignment validation; corrected masks selected the replacement. Private evidence
and the repaired video remain under `artifacts/edit-composite-f8551b5a/`. Public
captures contain only fixtures. No Discord delivery was performed by this replay.

The bounded-batch follow-up adds one Windows regression test (92 focused tests
total): 1, 23, 124 and 360 frames retain source order with logarithmic batch depth.
The ten alignment tests passed after the change. No pixel processing changed.
