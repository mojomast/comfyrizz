# Procedure capture: record a Generate run

**Record this run** films Comfyrizz while it makes a video: the prompt, Generate, the Google Colab spend approval, the stage gauges (Plan, Characters, Shots, Voice, Video), and the finished video with its download. You can cut a demo from it without OBS or another screen recorder.

There are two ways to capture:

| | In the app | Headless (`pnpm capture:procedure`) |
| --- | --- | --- |
| What it films | Your real run, in your browser tab | The real app against a scripted production, so no Google Colab units are spent |
| How | The browser's own screen-share and `MediaRecorder` | Playwright's built-in video, then ffmpeg |
| Output | Your Downloads folder: video (`.mp4` or `.webm`) plus a `.json` step log | `out/procedure-capture/<stamp>/procedure.mp4` with chapters and captions |
| Needs | Chrome or Edge on a desktop (Firefox and Safari work without the "This tab" shortcut) | Node 22, Playwright Chromium, ffmpeg |

## In the app

1. Tick **Record this run**:
   - **Super Easy:** the box is under **Generate** on the home screen.
   - **Easy Studio:** the box is on the **Plan** step, below the plan. Recording starts when you approve it.
   - Adding `?capture=1` to the URL ticks it for you. The choice is kept for the rest of the browser tab's session.
2. Press **Generate** (in Easy Studio, approve the plan). The browser asks what to share. Pick **This tab**; Chrome and Edge list it first. Sound is not recorded.
3. A small badge in the corner shows **Recording this run** and the latest step. It doubles as an on-screen caption in the recording.
4. The recording stops by itself 4 seconds after the final video is ready (so the finished screen is in the shot), when the run stops with an error, or after 30 minutes. **Stop and save** ends it sooner.
5. Two files land in your Downloads folder, both named after the prompt, for example `comfyrizz-procedure-a-friendly-robot-who-learns-to-bake-brea-20261027-031500`:
   - The video, `.mp4` where the browser can record MP4 (Chrome and Edge 126+, Safari), otherwise `.webm`.
   - The step log, `.json`. It has one line per step, with times measured from the first frame of the video.

If you turn screen sharing down, or the browser cannot share a tab, the run is still logged and only the `.json` is saved. The badge then reads **Logging this run (no screen recording)**.

### What the step log records

- The prompt.
- Where the video is made (This computer or Google Colab).
- The spend approval, with the Google Colab unit cap when one was set.
- Each Easy Studio step you visit.
- Every stage change (for example `Shots: Running`, then `Shots: Done`).
- Google Colab session lines (starting, making your shots, collecting, stopping, stopped).
- Preview ready, Final video ready, Downloaded the video, and any error.

It never stores links, media tickets, tokens, keys or local paths. Each line is redacted before it is written, and again when a script reads it back.

### Turn a download into an edit-ready MP4

```sh
pnpm capture:procedure --assemble ~/Downloads/comfyrizz-procedure-…-20261027-031500.webm
```

The step log next to the video is picked up automatically (pass `--journal <file.json>` if you moved it). The output goes in `out/procedure-capture/<stamp>/`:

| File | What it is |
| --- | --- |
| `procedure.mp4` | H.264, 30 fps constant frame rate, `faststart`. Has one chapter per step and a caption track (`mov_text`) that editors import as markers or subtitles. |
| `procedure.vtt` | The same captions as WebVTT. Steps less than 0.6 s apart share one caption. |
| `procedure.ffmeta` | The chapter list in ffmpeg metadata format. |
| `procedure.json` | The redacted step log. |

Use `--out <dir>` to choose another folder. ffmpeg is the only requirement; it is already a Comfyrizz prerequisite.

## Headless, with no Google Colab spend

```sh
pnpm capture:procedure                       # about 30 s, writes out/procedure-capture/<stamp>/
pnpm capture:procedure --prompt "A lighthouse keeper's cat" --phase-ms 4000
pnpm capture:procedure --dry-run             # print the plan, start nothing
```

This starts the local app the way the browser tests do. It runs Super Easy with **Record this run** ticked against `apps/web/e2e/procedure-fixture.mjs`, a scripted production that walks through the following, each phase lasting `--phase-ms`:

1. Characters.
2. FLUX stills.
3. LTX motion.
4. Voice.
5. A Google Colab session that starts, makes shots, collects and stops.
6. A final video.

Every `/api` call is answered by the fixture, so nothing reaches Google Colab. The first caption, and the opening chapter, say so: *Fixture run: the Google Colab session and GPU stages are mocked; no Google Colab units are spent.* The script refuses to finish if the app ever calls a paid route.

Use it for A-roll that shows how Comfyrizz moves through a run, and for checking the capture pipeline in CI. For footage of a real generation, use the in-app capture.

## Secrets and privacy

- **Share only the Comfyrizz tab.** A tab capture does not include the address bar, other tabs or the desktop. Sharing a window or a screen would, which is why the app asks the browser to offer **This tab** and, in Chrome and Edge, to hide whole screens.
- **The server's sign-in fragment is never in frame.** The app removes it from the address bar on load, and a tab capture does not show the address bar anyway.
- **Pixels cannot be redacted after the fact**, so the app hides risky elements while it records. Anything marked `data-secret`, `data-token` or `data-runtime-path`, the server token and runtime path fields, and password inputs are hidden. Keep settings, provider keys and devtools closed during a take.
- **The step log is text-only and redacted.** Links, `token=` and `ticket=` values, bearer tokens, JWTs, `sk-`/`hf_`/`ghp_`/`AIza` keys, long hex or base64 strings, and home or temp paths are replaced before anything is written.
- **Nothing is uploaded.** Both files stay on your machine.

## Limits

- The browser asks for permission on every run. Browsers do not let a page remember screen-share consent.
- `getDisplayMedia` is not available in headless browsers, which is why the headless path uses Playwright's own video instead.
- Firefox and Safari do not offer the **This tab** shortcut or hide whole screens. Pick the Comfyrizz window and keep it in front.
- Some browsers record WebM only. `--assemble` converts it to MP4.
- Browsers may ask once whether Comfyrizz can download multiple files; allow it to get both the video and the step log.
- Recordings are not yet copied into the video's Export folder; they stay in Downloads.

## Why this approach

The capture uses what the browser already ships, plus Playwright and ffmpeg, which the repository already depends on. No new runtime dependency was added.

| Option | License, upkeep | Verdict |
| --- | --- | --- |
| `getDisplayMedia` and `MediaRecorder` (browser built-ins) | Web standard | **Used** for the in-app capture. It records the real pixels, including `<video>`, and writes MP4 on current Chrome and Edge. |
| Playwright `recordVideo` | Apache-2.0, already a dev dependency, active | **Used** for the headless capture. It is deterministic, needs no permission prompt, and supports `size` and `fps`. |
| ffmpeg (system binary) | LGPL/GPL, already a prerequisite | **Used** to assemble MP4, chapters and captions. |
| RecordRTC | MIT, last release 2021 | Not used. It wraps the same `MediaRecorder`, and its upkeep has stalled. |
| puppeteer-screen-recorder | MIT, inactive since 2024 | Not used. It needs Puppeteer, which Comfyrizz does not use; Playwright covers the same job. |
| rrweb / rrvideo | MIT, active | Not used. It records the DOM, including typed field values (a secret risk), and its video export replays in a headless browser and does not capture `<video>` frames. |
| html2canvas / modern-screenshot frame grabs | MIT | Not used. They are slow, approximate CSS, and cannot read cross-origin video frames. |
| ffmpeg.wasm | LGPL core, about 30 MB | Not used. The browser can already write MP4, and system ffmpeg handles the rest. |
| Electron `desktopCapturer` | MIT | Not applicable. Comfyrizz is a web app with a local server, not an Electron app. |

Code: `apps/web/src/easy/procedure/` (step log, recorder, badge, checkbox), `scripts/capture-procedure.mjs`, tests in `apps/web/src/easy/procedure/*.test.ts` and `apps/web/e2e/procedure-capture.spec.ts`.
