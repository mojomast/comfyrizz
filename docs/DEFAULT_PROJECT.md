# The default project: Pip's Night Shift

The editor opens **Pip's Night Shift** on first run. It is a four-scene, roughly
twenty-second motion-graphics film for a fictional café on Rue Lumière, and it is
designed to show the whole review loop on a CPU with no GPU, no API key and no
network:

- **Look:** `film-35mm` ("warm film"), compiled from
  [`scripts/motionkit/data/recipes/film-35mm.json`](../scripts/motionkit/data/recipes/film-35mm.json).
- **Scenes:** real Remotion motion graphics (kinetic title, paper-cut quote,
  focus counter, sketch outro), not pre-rendered clips. Generated media is an
  optional background layer.
- **Fresh state:** 3 of 4 clips approved; the final render gate is locked until
  s3 take 2 is approved in the editor.
- **Sound:** a locally synthesized, CC0-1.0 music bed and two sound effects at
  96 BPM, aligned so every cut lands on a bar line.
- **Sidecars:** takes, editor state, references, cast and a recorded Google Colab
  history replay.

The package is [`examples/pip-night-shift`](../examples/pip-night-shift/README.md);
the approved plan is [`docs/specs/PIP_DEMO.md`](specs/PIP_DEMO.md).

## What first open shows

| Area | Fresh state | Source |
| --- | --- | --- |
| Player / timeline | Four scenes, 150 frames each, transitions of 10/9/9 frames, 572 compiled frames (19.07 s at 30 fps) | `package.json`, `timeline.json` |
| Look | Palette `#1a1410 / #f6ead8 / #ff8a3d / #6b4a33`, Instrument Serif display, Inter text, procedural grain on every scene | `film-35mm` recipe compiled into the package |
| Scene 1, `s1_dawn` | Kinetic headline "Pip's Night Shift", kicker "05:58, Rue Lumière", `iris` out | `motion.recipe: kinetic` |
| Scene 2, `s2_counter` | Quote card "Still warm. Still open.", lower third "Pip, barista bot", `paper-reveal` out | `motion.recipe: paper-cut` |
| Scene 3, `s3_juno` | Counter "347 orders before 7 am", focus box, lower third "Juno, courier", `push` out | `data.display: counter`, `motion.recipe: focus` |
| Scene 4, `s4_outro` | Draw-on "Open all night", CTA "Come in", footnote line, `fade` out | `motion.recipe: sketch` |
| Captions | `karaoke` style under s1-s3 narration | `captions.style` |
| Cast strip | Pip and Juno (fictional; no real person depicted) | `characters/library.json`, seeded conversation |
| References | `dawn-style.png` with a warm-35mm grade note; `counter-push.mp4` with a camera-move-only note | `references/manifest.json` |
| Takes | s1, s2 and s4 approved; s3 has two takes. Take 1 is rejected with the correction "keep Juno's yellow jacket and helmet, slower entry"; take 2 is unreviewed and selected for A/B | `takes.json` |
| Render bar (PN09/PN15 fixture) | "3/4 clips approved", final render locked, "Render anyway" override only; appears once the generated takes are attached to their scenes | `apps/web/src/takes/render-bar.ts` |
| Activity (PN15 harness) | A past Google Colab run and its one-clip regeneration, shown read-only with gauges | `colab-history.json` via `seedDemoHistory`; mounted by the PN15 spec |
| Chat (optional) | The seeded storyline answers from a cassette without a provider | `cassette.json` |

A 4/4 state is produced only by approving s3 take 2 at runtime; it is never the
seeded state. Approvals, take selection, A/B and the gate are local store writes.

## Quick start (offline, CPU)

Requirements: Node.js 20+ (Node 22 recommended), pnpm 10, and Chrome or Chromium
only if you want to render a final MP4. ffmpeg is optional: media generation
falls back to SVG stills, and motion-frame checks skip themselves when the
browser or ffmpeg is missing.

```sh
pnpm install --frozen-lockfile
pnpm run build:libs
COMFYRIZZ_RUNTIME=/tmp/pip-night-shift-demo pnpm --filter @comfyrizz/server start
```

The server prints a loopback URL with a session fragment. Open it in a browser;
the fragment is stripped from the address bar and the token is never part of a
request path you need to copy. Do not paste the printed URL into a recording,
issue or chat.

`COMFYRIZZ_RUNTIME` points at a disposable runtime directory, so this starts from
an empty state even if you have used the default runtime before. For a truly
fresh run later, remove that directory and start again. `COMFYRIZZ_PORT` changes
the port (default `4319`); `COMFYRIZZ_DEMO=launch` restores the old
`examples/launch-demo` default and keeps Pip's Night Shift out of the seed.

The server seeds the package, generated media, takes, editor sidecar and
references on first run, and never overwrites later edits. In this checkout the
PN15 browser fixture also seeds the cast conversation and the recorded
Google Colab history before it opens the editor; the bare server seed does not
yet write those two sidecars. Use the harness below for the full first-open
walkthrough.

### Optional offline chat

The joined cassette replays the demo conversation with no provider and no
network:

```sh
COMFYRIZZ_LLM_CASSETTE=play:$PWD/examples/pip-night-shift/cassette.json \
  COMFYRIZZ_RUNTIME=/tmp/pip-night-shift-demo \
  pnpm --filter @comfyrizz/server start
```

## First-open walkthrough

With the server from [Quick start](#quick-start-offline-cpu) running, open the
printed loopback URL. This is the fresh state: the seeder writes only missing
files, so remove the runtime directory and restart if you have edited it.

The server-side acceptance runs the same first open without a GPU and without a
browser:

```sh
node --test apps/server/test/pip-night-shift/e2e.test.mjs
```

It seeds a temporary runtime, opens the package, checks the 3/4 gate and the two
s3 takes, approves s3 take 2 through the takes API, and confirms the CPU render
request is accepted. No network, Google Colab or model call is involved.

What to check in the editor, in order:

1. **The film is already there.** The Player shows four scenes. Press play: s1
   kinetic type, s2 quote card and lower third, s3 counter and focus box, s4
   sketch outro. The Theme section shows the `film-35mm` palette and type.
2. **The cast is on set.** When the seeded conversation sidecar is present (the
   PN15 harness writes it), the cast strip shows **Pip** then **Juno**, two
   chips. The Characters tab lists the same fictional pair from the seeded
   character library.
3. **References carry notes.** The References panel has exactly two cards:
   `dawn-style.png` ("warm 35mm dawn grade") and `counter-push.mp4` ("camera
   move only"). Both notes are visible, not hidden in a tooltip.
4. **Review the two Juno takes.** The s3 chip reads "take 2 of 2" in the review
   state. Open **Takes**, select `s3_juno:a_juno_plate`; the verdict list reads
   "Take 1: rejected" and "Take 2: unreviewed". Click take 1, then take 2, to
   A/B them. The diff names the correction: "keep Juno's yellow jacket and
   helmet, slower entry".
5. **The gate is locked for the right reason.** The render bar reads
   "3/4 clips approved" and `data-gate-ok="false"`; the final Render button is
   absent. Only the explicit override is offered.
6. **Approve take 2.** Press **Approve** in the take panel. The bar changes to
   "4/4 clips approved" and "All clips approved", `data-gate-ok` becomes `true`,
   the override disappears and Render becomes visible and enabled. No network
   request leaves the machine.
7. **Optional: render.** With 4/4 approved, Render or Export uses the CPU
   Remotion path and writes the MP4, captions, `CREDITS.md` and `package.zip`
   under the runtime's `out/export/` directory.

**Bare-server caveat:** the seeder writes `takes.json` and the placeholder
files, but it does not rewrite `package.json` to point each scene at its
generated take. The clip list and the 3/4 render bar therefore appear only after
those generated assets are attached to their scenes; the PN09 server test and
the PN15 browser fixture both PATCH the package to do that. Until the seed does
the same rewrite, use the PN09 test for the gate and treat the UI steps above as
the target state. The Player still previews all four motion scenes without any
generated media.

The recorded Google Colab history is a read-only replay. The PN15 spec seeds the
history and cast conversation into its temporary runtime and mounts the replay
in the Activity pane; the shipped editor does not mount that panel on its own
yet. Until it does, use the harness or
[`apps/web/src/colab-history.ts`](../apps/web/src/colab-history.ts) directly to
inspect the fixture.

### Browser harness status

The full browser walkthrough is specified by
[`apps/web/e2e/default-project.spec.ts`](../apps/web/e2e/default-project.spec.ts)
and runs its own loopback server and Vite app on ports 4175 and 4391:

```sh
pnpm --filter @comfyrizz/web test:e2e
pnpm --filter @comfyrizz/web exec playwright test -c e2e/playwright.config.ts default-project.spec.ts
```

In this checkout the spec currently stops in `prepareRuntime`: its PATCH adds
the placeholder takes as generated assets without the `model_license` that the
current package schema requires for the `ltx25` generator, so the server answers
422 and the three tests do not run. That is a fixture gap in
`apps/web/e2e/default-project.spec.ts`, not a package or runtime failure; the
server-side e2e test above passes. Record the walkthrough manually until the
fixture is updated.

## Offline vs Google Colab

Everything in the first-open walkthrough runs on the CPU. Only *new* generated
pixels need Google Colab (or your own ComfyUI).

| Capability | Offline / CPU | Google Colab or GPU | Where it appears |
| --- | --- | --- | --- |
| Package, timeline compile, motion scenes | Yes | Not needed | Player and storyboard on first open |
| Placeholder clips and character stills | Yes, generated locally by `scripts/pip-night-shift/make-media.mjs` (ffmpeg or SVG fallback) | Not needed | s1-s3 backgrounds, references, character art |
| Music bed and SFX | Yes, synthesized locally by `scripts/pip-night-shift/make-music.mjs`; CC0-1.0 | Not needed | Preview playback and final mix |
| Takes, A/B, verdicts, approval, render gate | Yes, local store and API | Not needed | Takes tab and render bar |
| Final MP4 render and export bundle | Yes, Remotion on CPU | Not needed | Render / Export |
| Recorded progress history | Yes, read-only fixture replay | Never contacted by the replay | Activity pane |
| New clip generation, new take quality | No | Yes: Google Colab backend or a ComfyUI URL | Backend picker, outside the seeded demo |
| Live model chat | Cassette replay is offline | A provider is optional for live chat | Chat panel |

The demo shows the boundary honestly: the review loop and the final CPU render
are local, while the Activity gauges are a recorded Google Colab run, labelled
"Google Colab" and marked read-only.

## Regenerate the generated assets

Placeholder media and audio are generated at seed/build time, written under the
example's gitignored folders, and never committed.

```sh
node scripts/pip-night-shift/make-media.mjs
node scripts/pip-night-shift/make-media.mjs --no-ffmpeg
node scripts/pip-night-shift/make-music.mjs
node scripts/pip-night-shift/make-music.mjs --check examples/pip-night-shift/package.json
```

`make-media.mjs` writes the s1-s3 take clips (take 1 plus s3 take 2), the s4
still, both reference files and the Pip/Juno stills. Without ffmpeg it writes
animated SVGs for clips and PNG stills, and still exits 0. `make-music.mjs`
writes `music-bed.wav`, `sfx-whoosh.wav` and `sfx-ding.wav`; `--check` verifies
the bytes and sha256 recorded in `package.json`. Both generators are
deterministic: the same script produces the same bytes.

## Checks

Build the libraries once, then run the demo's tests from the repository root:

```sh
pnpm run build:libs
node --test apps/server/test/pip-night-shift/package.test.mjs
node --test apps/server/test/pip-night-shift/audio.test.mjs
node --test apps/server/test/pip-night-shift/references.test.mjs
node --test apps/server/test/pip-night-shift/takes.test.mjs
node --test apps/server/test/pip-night-shift/cast.test.mjs
node --test apps/server/test/pip-night-shift/colab-history.test.mjs
node --test apps/server/test/pip-night-shift/e2e.test.mjs
node --test apps/server/test/pip-night-shift/motion-frames.test.mjs
pnpm --filter @comfyrizz/web test:e2e
pnpm run test:scan
```

`motion-frames.test.mjs` renders real frames and skips with a reason when
Chromium or ffmpeg is unavailable. The Playwright suite boots its own loopback
harness; nothing else may hold ports 4175 or 4391. In this checkout it currently
stops in the PN15 fixture (see [Browser harness status](#browser-harness-status)),
so treat the server-side tests as the passing path. `test:scan` checks tracked
files for secrets and personal paths.

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| Render is locked at 3/4 | Expected. Open Takes, select s3, compare take 1 and take 2, and approve take 2. |
| No music or the preview is silent | The WAVs are generated files and may not exist yet. Run `node scripts/pip-night-shift/make-music.mjs`, then restart with a fresh runtime or let the seeder copy the new files. |
| Clips are missing but the type plays | Placeholder media has not been generated. Run `node scripts/pip-night-shift/make-media.mjs`; the scenes still draw their text without it. |
| Cast strip or Activity is empty | The bare server seed does not write the conversation cast or recorded Google Colab history. Use the Playwright first-open walkthrough, or start from a runtime where those PN11/PN14 sidecars exist. |
| The editor opens launch-demo | `COMFYRIZZ_DEMO=launch` is set. Unset it to return to Pip's Night Shift. |
| Playwright cannot start | Install the workspace dependencies and Playwright's Chromium, and free ports 4175 and 4391. |
| A check skips | `motion-frames.test.mjs` skips without Chromium/ffmpeg; that is reported as a skip, not a pass. |

## Boundaries

The demo consumes the takes, references and characters store APIs; it does not
edit those modules. It does not touch the renderer, GPU or composition code,
`apps/server/src/pipeline-worker.mjs`, `apps/web/src/demo/**`,
`apps/web/demo.html`, HyperFrames, or the Google Colab internals under `colab/**`
and the `colab-*` modules. The recorded history is a fixture, not a live run.
Pip, Juno and the café are fictional. Music and generated media are original,
locally produced, and credited in
[`examples/pip-night-shift/CREDITS.md`](../examples/pip-night-shift/CREDITS.md).
