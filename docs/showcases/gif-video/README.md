# GIF input for video replacement

Showcase: <http://localhost:4347>

Start from the repository root:

```sh
yarn build
node scripts/serve-gif-video-showcase.mjs
```

The page invokes the real shared Discord source resolver, clip validator,
replacement-preset selector and preparation-status formatter using synthetic
message fixtures. It does not post to Discord or generate an edited video.

The reviewed [desktop capture](desktop.png) is 1280 CSS pixels wide; the
[mobile capture](mobile.png) is 390 CSS pixels wide. Both include upload,
Tenor, Giphy, custom portrait, starting-frame, empty, preparation and error
states. There are no interactive controls or disabled states. Neither viewport
has horizontal overflow. The shared Chrome profile logged an unrelated wallet
extension injection error; the page itself has no client JavaScript.

Capture source: base revision `7d85e64` plus this feature. The concatenated
`GifVideo.ts`, `VideoGeneration.ts`, `VideoSourceClip.ts` and
`VideoSourceImage.ts` SHA-256 prefix is `44f49d5f3643`, also displayed in the
captures. This fingerprints the exact input implementation independently of the
later commit that stores these screenshots.

Validation includes real FFmpeg conversion of an infinitely looping GIF with
odd dimensions, frame motion and timing checks, excerpt handling, corrupt input,
host validation, reply precedence and broker submission for both commands.
Public Tenor and Giphy share links downloaded successfully; a direct Tenor GIF
converted to MP4 with its 1.2-second duration preserved, and its representative
starting-frame extraction succeeded. These checks do not claim replacement
render quality; the existing model pipeline is unchanged.
