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

Reviewed Playwright MCP captures: [desktop](desktop.png) at 1280px and
[mobile](mobile.png) at 390px. Both include loading, primary success, fallback
success, outage, empty output, both editors declining, unconfigured fallback,
cancellation and quality-rejection states. Neither has horizontal overflow.
No task browser tabs remain open. The shared browser emitted a pre-existing wallet
extension `ethereum` injection error; the page has no scripts or application errors.

Captured from base revision `5099159` plus this change. The feature fingerprint in
the screenshots is SHA-256 `4e0ce9fe89e7` over `VideoKeyframeProvider.ts` and
`VideoBroker.ts` in that order.

Validation:

- TypeScript build passed.
- The editor, edit-review, broker and video-protocol suites ran 174 tests: 173
  passed. The only failure is an unchanged planner-wording assertion expecting
  `physical source, material or timbre`; the existing planner says
  `physical source, material, acoustic space and timing`. Neither that planner
  nor its assertion was changed here.
- Tests cover original image/prompt preservation, separate shot accounting,
  direct fallback after outages, missing configuration, empty/corrupt output,
  PNG conversion for effect metadata, cancellation, hook failures, deadline
  exhaustion and broker rejection of an alternate frame with bad pose/identity.
- A live Gemini-only check used a cached source/reference pair, replaying the
  recorded preferred-editor rejection locally. Gemini produced an image, but
  the existing review rejected its expression/pose fidelity. This validates
  editor routing and the retained quality stop, not a successful finished edit.
  No video was rendered or sent to Discord. Private job images are excluded.
