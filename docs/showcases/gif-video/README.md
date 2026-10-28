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
converts it to a looping GIF. It also invokes the installed desktop compositor
on synthetic source/replacement footage and shows the actual source, generated
subject and protected-caption result. Install the caption patch first (see
`desktop/README.md`); Python, NumPy, SciPy, Pillow, FFmpeg and CPU Tesseract are
required. `VIDEO_DESKTOP_DIR` can select another audited desktop installation.
It does not post to Discord or run a model render.

The reviewed [desktop capture](desktop.png) is 1280 CSS pixels wide; the
[mobile capture](mobile.png) is 390 CSS pixels wide. Both include upload,
pasted Discord GIF links with signed thumbnails, missing embeds, ambiguous links,
Tenor, Giphy, custom portrait, starting-frame, empty, preparation, GIF delivery,
upload-limit fallback and error states. Caption cases show successful protection,
no detected caption, and an actual injected OCR failure with its production
error report. There are no interactive controls or
disabled states. Neither viewport
has horizontal overflow. The shared Chrome profile logged an unrelated wallet
extension injection error; the page itself has no client JavaScript.

Capture source: base revision `77e70ad` plus Discord GIF link support. The concatenated
`GifVideo.ts`, `VideoGeneration.ts`, `VideoSourceClip.ts` and
`VideoSourceImage.ts`, followed by `VideoGifDelivery.ts`, `VideoProtocol.ts`
and `VideoBroker.ts`, then `desktop/video_edit_captions.py` and
`desktop/video-edit-captions.patch`, SHA-256 prefix is `fd01bbb35403`, also displayed in the
captures. This fingerprints the exact input implementation independently of the
later commit that stores these screenshots.

Validation includes real FFmpeg conversion of an infinitely looping GIF with
odd dimensions, frame motion and timing checks, excerpt handling, corrupt input,
host validation, reply precedence and broker submission for both commands.
Public Tenor and Giphy share links downloaded successfully; a direct Tenor GIF
converted to MP4 with its 1.2-second duration preserved, and its representative
starting-frame extraction succeeded. These checks do not claim replacement
render quality; model generation is unchanged. The compositor now preserves
automatically detected fixed captions, with 68 native Windows desktop tests
passing (including eight new caption tests). GIF-output checks
cover infinite looping, retained duration/motion, file-size adaptation, unchanged
original MP4/audio, cache invalidation after regeneration, explicit MP4 fallback,
matching Discord filenames and the private workflow button. All 64 targeted
input, delivery and broker regression tests passed for the preceding caption change.
The Discord GIF link change passed the build and all 12 targeted GIF input and
delivery tests, including signed CDN/proxy selection, matching attachment identity,
embed-only messages, missing embeds, rejected hosts, ambiguity and reply precedence.

The reported `e02575b8` ending artifacts were traced to the public Tenor source
`https://tenor.com/view/repost-ddmf-penalty-flag-referee-gif-16152028`.
Its MP4, WebM and full-resolution GIF already contain the corrupt final frame;
its tiny GIF preview omits it. Source selection is unchanged. The local repair
holds the edited clip's last clean frame for two final frames (56–57, zero-based)
at 24 fps, retaining all 58 frames, and also exports a GIF. This is a repair of
that specific delivered clip, not a global rule that discards video endings.
