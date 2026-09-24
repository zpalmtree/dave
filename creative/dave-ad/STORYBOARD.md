# Dave: make the chat come alive

13 seconds, 960×540, 24 fps. Original synthetic music and effects at 120 BPM.

The [Claude Animation Base](https://github.com/JohnHeibel/ClaudeAnimationBase) guide inspired the painted paper, boiling outlines, expressive character, rhythmic motion, and connected transitions. This is an original Dave character and original artwork; rendering uses the repository's canvas dependency and FFmpeg so it does not launch a browser.

| Time | What the viewer reads | Event and transition |
| --- | --- | --- |
| 0–3.4 | A creative request in chat | Dave spots a spark in the message and catches it with a brush. The brush stroke sweeps into the next shot. |
| 3.4–7.5 | Dave makes an image | A rainy neon fox is painted into a framed image. Dave presents it. The paint ripples into motion. |
| 7.5–10.4 | Dave can make video too | Rain falls, the fox blinks and its tail moves; the image gets playback marks. The moving picture becomes the end card's glowing circle. |
| 10.4–13 | DAVE / Your creative sidekick in chat | Dave waves beside the title. Hold the title and fade to dark. |

The three main reads reflect actual bot features: chat, image generation, and video generation. Text is limited to the example request, a short image/video cue, and the final brand line so it works with or without audio.

Run `node creative/dave-ad/render.mjs`. It writes `creative/dave-ad/dave-ad.mp4` and `creative/dave-ad/contact-sheet.jpg`.
