# GIF input and output for video replacement

Showcase: <http://localhost:4347>

Start from the repository root:

```sh
yarn build
node scripts/serve-gif-video-showcase.mjs
```

The page invokes the real shared Discord source resolver, clip validator,
replacement-preset selector, preparation-status formatter and GIF delivery
converter using synthetic fixtures. It creates a silent test animation and
converts it to a looping GIF. It does not post to Discord or run a model render.

The reviewed [desktop capture](desktop.png) is 1280 CSS pixels wide; the
[mobile capture](mobile.png) is 390 CSS pixels wide. Both include upload,
Tenor, Giphy, custom portrait, starting-frame, empty, preparation, GIF delivery,
upload-limit fallback and error states. There are no interactive controls or
disabled states. Neither viewport
has horizontal overflow. The shared Chrome profile logged an unrelated wallet
extension injection error; the page itself has no client JavaScript.

Capture source: base revision `0c54805` plus this feature. The concatenated
`GifVideo.ts`, `VideoGeneration.ts`, `VideoSourceClip.ts` and
`VideoSourceImage.ts`, followed by `VideoGifDelivery.ts`, `VideoProtocol.ts`
and `VideoBroker.ts`, SHA-256 prefix is `4f0179087f89`, also displayed in the
captures. This fingerprints the exact input implementation independently of the
later commit that stores these screenshots.

Validation includes real FFmpeg conversion of an infinitely looping GIF with
odd dimensions, frame motion and timing checks, excerpt handling, corrupt input,
host validation, reply precedence and broker submission for both commands.
Public Tenor and Giphy share links downloaded successfully; a direct Tenor GIF
converted to MP4 with its 1.2-second duration preserved, and its representative
starting-frame extraction succeeded. These checks do not claim replacement
render quality; the existing model pipeline is unchanged. GIF-output checks
cover infinite looping, retained duration/motion, file-size adaptation, unchanged
original MP4/audio, cache invalidation after regeneration, explicit MP4 fallback,
matching Discord filenames and the private workflow button. All 64 targeted
input, delivery and broker regression tests passed.

The reported `e02575b8` ending artifacts were traced to the public Tenor source
`https://tenor.com/view/repost-ddmf-penalty-flag-referee-gif-16152028`.
Its MP4, WebM and full-resolution GIF already contain the corrupt final frame;
its tiny GIF preview omits it. Source selection is unchanged. The local repair
holds the edited clip's last clean frame for two final frames (56–57, zero-based)
at 24 fps, retaining all 58 frames, and also exports a GIF. This is a repair of
that specific delivered clip, not a global rule that discards video endings.
