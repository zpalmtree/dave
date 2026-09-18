# OALGO attachment composition

An OALGO request with an attachment must produce a reviewed image containing
both OALGO and the attachment's main subjects before a video can be queued.
Composition failures now reject the submission with a retry message. They do
not substitute the built-in portrait. Provider attempts and paid usage remain
recorded against the rejected submission; temporary images are cleaned up.

## Incident f4f1cd08

The attachment downloaded successfully. Both GPT Image 2 edits also completed:
135.477 seconds for the first image, 137.008 seconds for the corrective image.
The first review rejected the composition because it replaced the attached
warrior with OALGO and transferred the warrior's glowing weapon to him. After
26.796 seconds of first-review work, the second image left less than a second
under the shared five-minute deadline. Its review was aborted at 300 seconds.
The broker then copied the built-in portrait into `source.png` and rendered it.
The renderer's downloaded input hash exactly matched `images/oalgo.png`.

The provider produced images; the failures were composition adherence, review
timing, and the fallback behavior. The original candidates were not retained,
so the first rejection is known from stored review diagnostics rather than a
fresh visual inspection of those candidates.

## Changes

- Ask for a scene edit that adds OALGO as a separate person, retaining the
  attachment's subjects, setting, and ownership of important props. Use the
  portrait as visual authority instead of a long prose redesign of his anatomy.
- Use a source-composition prompt instead of the finished-frame prompt. The old
  wrapper imposed immediate-motion, gaze, and no-reframe constraints before a
  screenplay existed. Image-only composition no longer invents an action.
- Give composition nine minutes, sufficient for two three-minute image calls
  and two 75-second reviews. The bot allows eleven minutes for submission,
  including source downloads and returning the result. These are ceilings;
  successful requests return immediately.
- Preserve the required identity and scene-content review. A failed or
  unavailable review cannot become an unreviewed success or a portrait fallback.

The nine-minute ceiling still bounds transient provider retries. An extended
provider outage can fail the request and require a user retry.

## Verification

The full isolated master suite passed 331 tests. Regression coverage includes
both failed visual checks and reviewer outages, no queued job on failure,
temporary-file cleanup, paid-usage retention, and a simulated 328-second
two-image/two-review sequence that would have failed under the old deadline.

Live tests used the production compositor and unchanged strict reviewer:

| Fixture | Configured image model | Result | Total time |
| --- | --- | --- | --- |
| Exact recovered f4f1cd08 attachment | GPT Image 2.5 Sunburst | First candidate accepted | 70.122 s |
| Saved classroom reference from 4fdbc1d1 | GPT Image 2.5 Sunburst | First candidate accepted | 55.711 s |
| Exact recovered f4f1cd08 attachment | GPT Image 2 (original incident model) | First candidate accepted | 168.440 s |

All three accepted images were also visually inspected against their source images.
The original attachment's giant, warrior, and glowing weapons remain visible,
with OALGO added separately. The classroom retains the masked teacher, student,
and laptop with OALGO added at a desk.

Sunburst was already configured by the preceding model-update commits; this
change does not switch models. The original-model check used a test-only model
override; its successful composition shows the simplified request can work
without a model upgrade. These successes establish working examples, not a
measured general acceptance rate or an isolated prompt-vs-model speedup.
Investigation inputs, captured requests, candidates, review outputs, usage, and
test logs are saved locally under
`artifacts/video-identity-investigation/f4f1cd08/` (ignored by Git).

The official [image-generation guide](https://developers.openai.com/api/docs/guides/image-generation#earlier-gpt-image-models)
confirms that GPT Image 2 already reads inputs at high fidelity automatically;
adding an `input_fidelity` parameter would not fix this incident.

## September 18: candidate repair and actionable errors

Three consecutive submissions failed for two different reasons: `f92bb210` and
`e2fdb677` received image-provider safety refusals; `ee600fec` generated two images,
but both changed OALGO's identity. The bot previously hid both causes behind the
same generic retry message.

Source-composite corrections now send the first candidate as an explicit edit
target alongside the two original references. The repair changes the identified
defects while retaining already-correct scene content. Both reviews still compare
against the originals; the rejected candidate never becomes an identity reference.
The extra input is included in request budgeting and normal usage accounting.
This follows the official [image prompting guidance](https://developers.openai.com/api/docs/guides/image-prompting#prompting-fundamentals)
on using the previous output as the next edit input and specifying what to preserve.

Typed errors distinguish provider safety refusals, failed likeness checks, failed
scene checks, reviewer outages, and the shared composition deadline. Discord shows
the corresponding reason. Refusals stop immediately without retrying or switching
providers; their message no longer recommends repeating the same request.
No failed or unverified composition queues a video.

Verification: all 337 isolated master tests passed. A live production-compositor
run using the recovered `f4f1cd08` attachment reproduced an initial identity
rejection, then passed the unchanged reviewer after the targeted edit (140.065
seconds total). Both candidates were visually inspected. A separate saved classroom
candidate was accepted on its first review and therefore did not exercise repair.
These checks demonstrate a working repair, not a measured improvement in general
acceptance rate. Images, requests, reviews, and usage are saved under
`artifacts/video-identity-investigation/f4f1cd08/repair-sep18-*` and
`saved-candidate-repair-*` (ignored by Git).
