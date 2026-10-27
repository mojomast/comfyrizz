# Hackathon demo: the one-shot judge path

This is the path a first-time judge should take: one prompt in, a downloaded MP4 out, without
opening Easy Studio's settings or the Advanced editor. It runs on **This computer** (CPU) with the
built-in scripted model, so it needs no API key, no GPU and no Google Colab.

## Before the judge arrives

```bash
pnpm install --frozen-lockfile
pnpm -r --if-present run build
cd apps/server && npm start
```

Open the URL the server prints (`http://127.0.0.1:4319/#token=…`). Use a fresh browser profile, or
clear site data, so the judge lands on Super Easy and not on a resumed video.

## Click by click

| Step | What the judge does | What they see |
| --- | --- | --- |
| 1 | Opens the link. | **Make a video**: one prompt box, a coaching hint ("One sentence is enough… no GPU and no Google Colab"), **Generate**, **Try an example** and three idea chips. |
| 2 | Clicks an idea chip, for example **How a coffee bean becomes your morning cup**, or types one sentence. | The prompt fills in. A too-short prompt shows an inline message instead of a browser tooltip. |
| 3 | Clicks **Generate**. | **Making your video**: the overall gauge and the **Plan** gauge move at once, and running gauges sweep so the screen never looks frozen. |
| 4 | Waits a few seconds. | **Your preview is ready** appears at the top of the column. **Plan** and **Shots** read **Done**, **Characters** and **Voice** read **Skipped** when the video has no cast or narration, and **Video** reads **Preview ready** at 90%. |
| 5 | Clicks **Download MP4**. | Easy Studio opens directly on **Export** and starts the CPU render. The header says **Saved**. |
| 6 | Waits about 90 seconds. | **Your video is ready**: a playable MP4 with its length, shape and size. |
| 7 | Clicks **Download MP4**. | The browser saves `<video-name>.mp4`. |

That is four clicks after the page opens: idea chip, **Generate**, **Download MP4**, **Download MP4**.
**Watch and review** on the preview card is the slower path through Review if the judge wants to
look at each shot first.

Measured on the build in this PR: about 5 seconds from **Generate** to the preview card and about
100 seconds from **Generate** to a 30-second, 3.6 MB MP4, with no page errors.

## What this PR fixed on that path

- **The app crashed before Super Easy appeared.** The production bundle included the Easy step
  `*.test.ts` files; their first `test()` call threw and left a half-drawn Advanced editor. The
  e2e suite had been stubbing those files, which hid the crash. The glob now excludes them, and the
  full-app e2e runs without the stub and fails on any page error.
- **Export always failed** with "commandId or idempotencyKey is required on a production-bound
  request", because Super Easy creates a production and the web export never sent the command id
  or production revision. It now sends both and retries once or twice if another production
  command lands first.
- **A false "Can't reach the Comfyrizz server. Retrying…"** showed in the Studio header after every
  Super Easy run. The server-saved revision of the built package is now acknowledged, so it reads
  **Saved**.
- **The gauges sat at Waiting / 0%** for the whole This computer run, because the production journal
  stays empty until export. They now follow the run phase and the built package, and only ever move
  forward from what the server reports.
- **The next action was hidden.** The preview card rendered unstyled below the fold, outside the
  column. It now sits above the gauges and leads with **Download MP4**.
- **The home scolded instead of coaching.** "Tell us what you want to make first." showed even
  after typing. It is now an inline message only after a too-short **Generate**; the always-on hint
  explains what will happen, and idea chips give a one-click start.

## Known gaps (out of scope for this PR)

- **Narration and GPU art need more than this path.** With the scripted model and no AI provider,
  the video is a templated motion-graphics explainer with narration off, so **Voice** reads
  **Skipped**. A narrated film needs an AI provider plus local voice (Python) for VO, and FLUX
  stills or LTX motion plates need Google Colab. Those belong to the film and VO tracks.
- **Super Easy never plays the video itself.** The preview plays in Easy Studio; the **Video** tile
  in the Super Easy gallery stays a placeholder on the This computer path.
- **Export screen polish.** "Your video is ready" appears twice. "This export cannot be reopened
  after reload." and "Delivery facts not recorded for this file." read as warnings to a judge. The
  duration line can disagree with the player (0:30 against 0:36).
- **Review counts.** Review can say "4 of 4 shots kept" beside six shots.
- **The scripted title is truncated** with a trailing "Le…" in the header and title card.
- **Background noise in the hidden editor.** While the bundled example project sits behind Super
  Easy, the parked Advanced player requests `/assets/music-bed.wav` hundreds of times a second
  (404). It is not visible but wastes the network panel. `/src/ui/palette.css` also 404s in the
  production build, so the command palette is unstyled.
- **Unit tests already failing on `main`.** Ten web unit tests fail on `main` before this PR
  (banned-word, Google Colab naming, layout and SyncNet copy checks). This PR adds no new failures.
