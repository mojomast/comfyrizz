# Demo video script: Pip's Night Shift (2:00)

The demo video for the Comfy Open Source Higgsfield hackathon entry. It shows the
editor's default project, **Pip's Night Shift**, on a first open and follows the
review loop from 3/4 approved to a final CPU render. The seven beats fill the
**2:00** ceiling exactly: 10 + 20 + 20 + 20 + 20 + 20 + 10 = 120 seconds.

The work in action, the build explanation and the innovation argument are all on
screen. The only part that needs Google Colab is *new* generated media; this
demo deliberately shows the local review and render path and a recorded
Google Colab history replay.

**Sources:** [`docs/specs/PIP_DEMO.md`](../specs/PIP_DEMO.md) sections 3-5 and 7,
[`docs/DEFAULT_PROJECT.md`](../DEFAULT_PROJECT.md),
[`examples/pip-night-shift`](../../examples/pip-night-shift/README.md) and the
PN15 spec
[`apps/web/e2e/default-project.spec.ts`](../../apps/web/e2e/default-project.spec.ts).

## 1. Shot list

| # | Time | On screen | Voiceover | UI action | Fallback if a live step fails |
| --- | --- | --- | --- | --- | --- |
| 1 — Hook | 0:00–0:10 | The finished film, full screen: s1 kinetic title "Pip's Night Shift", then the iris into the counter. Music bed from the first downbeat. | "This is Pip's Night Shift: a four-scene, twenty-second film that opens as the default project in Comfyrizz. Every frame is drawn by code." | Open the editor and press play in the Player. | Cut to the pre-rendered MP4 from the CPU export (`video.mp4` under the runtime's `out/export/pkg_pipnightshift01/`). |
| 2 — First open | 0:10–0:30 | The whole editor: four scene cards, `film-35mm` palette in Theme, cast strip with Pip and Juno, two references with notes. Activity line names the project. | "On first open the editor already holds the film: four Remotion scenes in the warm film-35mm look, Pip and Juno in the cast, two references with production notes, and a music bed synthesized locally. No GPU, no account, no network." | Hover the look and both reference cards; open the Characters tab briefly; return to the storyboard. | Start a fresh runtime and use the manual first-open walkthrough. The PN15 browser harness is the intended path but is currently blocked by a fixture schema gap (section 6). |
| 3 — Motion, type, sound | 0:30–0:50 | Scrub s1 to s4: kinetic headline, paper-cut quote and lower third, focus counter "347 orders before 7 am" and lower third, sketch outro. Captions run in karaoke style. | "The motion is real Remotion, not a video file: kinetic type at dawn, a paper-cut quote at the counter, a focus counter for three hundred and forty-seven orders, then a sketch outro. Karaoke captions and a CC0 bed run underneath." | Scrub the timeline from s1 to s4, pausing on the s3 counter hit and the s4 draw-on. | Hold still frames from the CPU render; the scenes draw without generated media. |
| 4 — A/B and the correction | 0:50–1:10 | Takes tab for `s3_juno:a_juno_plate`: "Take 1: rejected", "Take 2: unreviewed". Click take 1, then take 2. Diff names the correction. | "Scene three carries two takes. Take one went off-model: grey jacket, no helmet, rushed entry. It was rejected with one correction: keep Juno's yellow jacket and helmet, slower entry. Take two answers it, and A/B compares them." | Open Takes, select s3, click take 1 then take 2. Keep the diff line visible. | Freeze on the verdict list and read the correction; the sidecar is committed. |
| 5 — Gate unlock | 1:10–1:30 | Render bar reads "3/4 clips approved" and Render is absent. Click Approve. Bar becomes "4/4 clips approved", "All clips approved"; Render appears enabled. | "The render bar is honest: three of four clips approved, final Render locked. Approving take two is a local write, with no Google Colab and no model call. The gate flips to four of four and Render unlocks." | Show the locked bar, then Approve in the take panel, then the 4/4 bar and enabled Render button. | Re-record from a fresh runtime; the PN15 spec asserts the same transition. |
| 6 — Recorded Google Colab run | 1:30–1:50 | Activity pane: "Google Colab history", a past run plus its one-clip regeneration, gauges for model, sampler, nodes, frames and encode, "Past run · read-only replay". | "Activity replays a recorded Google Colab run and its one-clip regeneration, with model, sampler, node, frame and encode gauges. It is read-only: nothing starts a VM. New clips would need Google Colab or your own ComfyUI; review, edit and CPU render never do." | Scroll the two runs; keep the read-only label in frame. Do not open a terminal or a Google Colab account screen. | If the PN15 harness is unavailable, keep the beat on the read-only fixture description over a still of the gauge markup. Do not fake a live run. |
| 7 — Ship it | 1:50–2:00 | Start the CPU export, then the export folder: `video.mp4`, `captions.srt`, `captions.vtt`, `CREDITS.md`, `package.zip`. End card: MIT repo, `examples/pip-night-shift`, "Pip and Juno are fictional". | "The project, scene code, music recipe and credits ship in the MIT repo under examples slash pip-night-shift. One command opens it. Pip and Juno are fictional." | Click Export, show the five bundle files, then the end card. | Show the committed example folder and `CREDITS.md` if the export is still running; state that the CPU render is local. |

**Runtime check:** 0:00–0:10, 0:10–0:30, 0:30–0:50, 0:50–1:10, 1:10–1:30,
1:30–1:50, 1:50–2:00. Total **2:00**. If a take runs long, cut words inside a
beat; do not move a beat boundary.

## 2. Pre-flight

Run everything from the repository root. A disposable runtime keeps the take
fresh and leaves your normal editor state alone.

```sh
pnpm install --frozen-lockfile
pnpm run build:libs
node scripts/pip-night-shift/make-media.mjs
node scripts/pip-night-shift/make-music.mjs
node scripts/pip-night-shift/make-music.mjs --check examples/pip-night-shift/package.json
COMFYRIZZ_RUNTIME=/tmp/pip-night-shift-demo pnpm --filter @comfyrizz/server start
```

Before recording, verify the first-open state and the approval transition
without a camera running:

```sh
node --test apps/server/test/pip-night-shift/e2e.test.mjs
node --test apps/server/test/pip-night-shift/motion-frames.test.mjs
```

The server-side test checks the 3/4 gate, the two s3 takes, the approval
transition and the CPU render request. The motion test renders real stills and
the scored MP4; it skips with a reason if Chromium or ffmpeg is missing. The
PN15 browser spec is the intended UI check, but it currently stops in its
fixture setup (section 6), so record the first open manually.

Then confirm the repository is clean of secrets and personal paths:

```sh
pnpm run test:scan
```

`make-media.mjs` exits 0 without ffmpeg (SVG fallback); `make-music.mjs --check`
must print `"ok": true`. If the CPU export is part of the take, Chrome or
Chromium must be available for Remotion.

## 3. Offline vs Google Colab

| Beat | Runs offline on CPU | Needs Google Colab or a GPU |
| --- | --- | --- |
| 1 — finished film | Remotion scenes, local media, local WAVs | No |
| 2 — first open | Package, timeline, takes, references, cast, look | No |
| 3 — motion, type, sound | Remotion preview and generated audio | No |
| 4 — A/B and correction | Takes store, diff, verdicts | No |
| 5 — approval and gate | Local write; gate recomputed locally | No |
| 6 — Activity | Read-only replay of a recorded run | No; a *new* run would need Google Colab or a ComfyUI URL |
| 7 — export | CPU Remotion, captions, credits, package zip | No |

Only a new generation (a new take or real clip quality) leaves this path. The
demo never starts a VM, never asks for a provider key, and never shows a live
Google Colab account screen.

## 4. Recording checklist

### 4.1 Format

- [ ] Record at **1920×1080, 30 fps**, browser full screen at 100% zoom.
- [ ] Deliver **H.264 MP4, total 2:00** (or shorter; never longer).
- [ ] Read voiceover at about 2.5 words per second. Cut words before cutting a
      beat.
- [ ] Music is the project's CC0-1.0 bed, not a stock track. It is already mixed
      at -16 dB with a 0.5 s fade-in and 1.5 s fade-out.

### 4.2 No secrets or private context on screen

- [ ] Do not show the server's printed URL: its fragment carries the session
      token. Open the app off-screen and check the address bar is clean.
- [ ] Do not open browser devtools, provider settings, `.env` files or key
      fields. No terminal scrollback with credentials.
- [ ] No personal filesystem paths, home-directory paths, private host names,
      account IDs or personal e-mail addresses in frame.
- [ ] Use a disposable runtime (`COMFYRIZZ_RUNTIME=/tmp/pip-night-shift-demo`) so
      the recording starts from the seeded state.
- [ ] `pnpm run test:scan` prints `clean:` before the take.

### 4.3 Claims to keep exact

- [ ] Say **Google Colab** in full, never the short product name alone.
- [ ] The Activity pane is a **recorded, read-only replay**, not a live run.
      Keep "Past run · read-only replay" visible and say so.
- [ ] The film is **four scenes, roughly twenty seconds**; the compiled timeline
      is 572 frames (19.07 s), and the music bed is 20 s.
- [ ] The start state is **3/4 approved and locked**. A 4/4 state exists only
      after the on-camera approval.
- [ ] Pip and Juno are fictional. Placeholder media is generated locally and is
      not a real Google Colab generation.

### 4.4 Procedure A-roll without OBS

Comfyrizz can film its own Generate run. See
[docs/ui/PROCEDURE_CAPTURE.md](../ui/PROCEDURE_CAPTURE.md).

- **A real run:** tick **Record this run** under Generate (or open `/?capture=1`)
  and share **This tab**. The video and a step log land in Downloads. Then
  `pnpm capture:procedure --assemble <video>` makes an H.264 MP4 with a chapter
  and caption per step.
- **No spend:** `pnpm capture:procedure` films Super Easy against a scripted
  production in about 30 s and writes `out/procedure-capture/<stamp>/procedure.mp4`.
  Its first caption says the Google Colab session is mocked; keep it on screen or
  say so in the voiceover.

## 5. Why this demo is the product

The default project is the shortest honest path through the whole product:

1. **Code draws what must be exact.** The headline, the counter and the
   captions come from the timeline and the renderer, so they are identical on
   every play. A generated plate is only a background.
2. **Review is a first-class state.** Two takes, a written correction, an A/B
   diff and a render gate that refuses to run at 3/4. Approving the candidate is
   a deliberate user action, not an automatic "looks good".
3. **The CPU path is complete.** The look, the motion, the music, the gate and
   the final render all work offline. Google Colab is for new pixels, not for
   opening or finishing the project.
4. **Rights travel with the work.** The music and generated media are original
   and CC0-1.0, the package records bytes and sha256, and the export writes
   `CREDITS.md` beside the MP4.

The narration carries the same four points across beats 2, 3, 5 and 7.

## 6. Status

- **Available now:** package and compiled timeline, `film-35mm` look, four motion
  scenes, takes and gate, references, cast, generated media/music, and the
  recorded Google Colab history fixture.
- **Browser harness gap:** the PN15 spec seeds the cast conversation and the
  recorded history in its temporary runtime, but its PATCH omits the
  `model_license` now required for the `ltx25` generated assets. The server
  answers 422 in `prepareRuntime` and the three UI tests do not run. The
  server-side e2e test passes; record the manual walkthrough until the fixture
  is fixed.
- **Activity gap:** the bare editor does not mount the recorded history panel
  yet; the PN15 spec mounts it explicitly. Beat 6 therefore needs the harness,
  or the read-only fixture fallback in the shot list.
- **Not in this demo:** a live Google Colab run, a new generation, or a paid
  provider. None is needed for the 2:00 cut.
- **Verification:** see the checks in
  [`docs/DEFAULT_PROJECT.md`](../DEFAULT_PROJECT.md#checks). Frames that need
  Chromium or ffmpeg skip honestly when those tools are absent.
