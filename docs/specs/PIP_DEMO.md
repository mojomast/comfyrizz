# NEW DEMO plan: "Pip's Night Shift" as the editor's default project (rev 3, approved by Kyle 2026-10-21)

Status: APPROVED by Kyle 2026-10-21 07:28 with rev-2 defaults. Feature `PIP-DEMO`, branch `feat/pip-demo`, worktree a dedicated worktree, PC project `comfyrizz-pip-demo`, spec copy `docs/specs/PIP_DEMO.md`; branched from origin/main 717b3ed. Target = the main editor UI (`apps/web/index.html` + `apps/web/src/main.ts`), not `demo.html`.

## 1. How the default project loads today (origin/main)
- Browser: `apps/web/src/main.ts` statically imports `examples/launch-demo/package.json` + `timeline.json` (lines 16-17) and boots with them. `openRequestedPackage()` replaces it only when the URL has `?package=<id>` AND a session token; with no query "the bundled demo" stays. Activity log says "Loaded examples/launch-demo package + compiled timeline"; chat shows "The bundled demo is open for now...".
- Server: `apps/server/src/index.mjs` seeds `examples/launch-demo/package.json` into `<runtime>/packages` via `store.seed()` (only if the id is absent; never overwrites edits) and copies `examples/launch-demo/assets/*.svg` to `<runtime>/packages/assets`. Runtime dir = `COMFYRIZZ_RUNTIME` or `apps/server/.runtime`.
- No localStorage project selection (only the session token in sessionStorage).
- Sidecars live per runtime: takes `<runtime>/takes/<pkgId>.json`, editor `<runtime>/editor/<id>.json`, references `<runtime>/references/<chatId>/`, characters (branch) `<runtime>/characters/`. Nothing seeds them, so on first open the Takes tab, render bar, reference panel and (later) Characters tab are empty.
- What launch-demo contains: "Comfyrizz launch demo", 6 scenes (s_title, s_hero, s_stat, s_chart, s_list, s_outro), 4 SVG assets, datasets for the chart, voice, theme, motion. No generated clips, no cast, no references, no takes, no Google Colab history. It predates the motion looks and quality fixes.

## 2. Gaps vs features since
Characters/cast/@mentions; references with notes; generated clips with takes, correction, A/B, approvals and render gate; motion-gallery look; Google Colab progress history (feat/colab-progress); quality-fix output (look score / QA).

## 3. Storyline (kept)
"Pip's Night Shift": 4 scenes, about 20 s, for a fictional café. s1 dawn exterior (style reference), s2 Pip the barista robot at the counter (Pip + camera-move reference clip), s3 Juno the courier bursts in (Juno; take 1 off-model, rejected with the correction "keep Juno's yellow jacket and helmet, slower entry", take 2 is the candidate awaiting approval), s4 logo outro (Remotion text, no GPU). Look `warm-film` (or nearest of the 24 recipes, see D3). On open: library shows Pip + Juno, the cast strip shows both, the reference panel shows 2 refs with notes, the timeline has take chips (s3 shows 2 takes, A/B ready), the render bar shows 3/4 approved with Render locked until Kyle approves s3 take 2 live (A/B vs rejected take 1), and the Activity / Google Colab panel shows a finished past run plus the one-clip regeneration with gauges.

Fresh state is the default and only seeded state (resolved D4). A 4/4 state is only produced at runtime by the live approval.

## 3a. Motion graphics and text styles (Kyle, 07:28)
The scenes are real Remotion motion-graphics scenes from the existing schema/recipe system; generated clips are only optional backgrounds (placeholder media behind the type), so the timeline preview plays every animation on first open with no GPU. Package look: `film-35mm` ("warm film", one of the 24 motion-gallery recipes; package-level, Tier A fields). Variety comes from per-scene storytelling recipes (`motion.recipe`), layouts/variants, energy, entries, lower thirds, counters, captions and transitions (all in package-v1 on main). Package captions style `karaoke`.

| Scene | Layout / variant | motion.recipe, energy | Text treatment | Background | transitionOut |
|---|---|---|---|---|---|
| s1 dawn open | `title` / `full-bleed` | `kinetic`, high | kinetic-type headline "Pip's Night Shift" + kicker "05:58, Rue Lumière" | s1 clip (placeholder) + procedural pattern | `iris` |
| s2 Pip at counter | `hero` / `quote` | `paper-cut`, medium | quote card + attribution; lower third "Pip, barista bot"; Pip still as `frame: pip`, circle mask | s2 clip | `paper-reveal` |
| s3 Juno bursts in | `stat` / `centered` | `focus`, high | number counter (`data.display: counter`) "347 orders before 7 am", focus box; lower third "Juno, courier" | s3 clip (take being reviewed) | `push` |
| s4 outro | `title` / `outro` | `sketch`, calm | draw-on title card + CTA "Open all night" + footnote credits | procedural pattern only (no GPU) | `fade` |

Captions (karaoke) run under s1-s3 narration. Only one package look is supported per package on main; mixing gallery looks per scene would need a look-sidecar change, which is out of scope (the gallery itself is linked from the README).

## 4. Seeding design (no GPU)
- `examples/pip-night-shift/`: `package.json`, `timeline.json`, `editor.json`, `takes.json`, `references/manifest.json`, `characters/library.json` (+ characters.json sidecar), `colab-history.json`, `CREDITS.md`, `README.md`.
- Media generated at seed/build time by `scripts/pip-night-shift/make-media.mjs` (ffmpeg testsrc/colour + drawtext clips, SVG->PNG stills; SVG/webm fallback if no ffmpeg). Output gitignored; optional real Google Colab clips swap in by the same file names (D2).
- New seeder module `apps/server/src/seed-demo.mjs`: pure `seedDemoProject({runtimeDir, exampleDir, fs})` writes the package (store.seed semantics: only if absent), copies assets/media, and writes the takes/editor/references/characters sidecars only if absent. `index.mjs` calls it instead of the inline launch-demo block (1-line change); `COMFYRIZZ_DEMO=launch` keeps the old seed (D1).
- Web default: `main.ts` imports the new example instead of launch-demo, and on boot with a token and no `?package=` opens the seeded `pip-night-shift` from the server, so takes/refs/cast load from the API. No token (static build) = bundled package only, with sidecar panels showing "start the local server" (D5).
- Google Colab history: a read-only replay of recorded progress events (from `scripts/colab/simulate-progress.mjs`) shown in the Activity/progress panel as a past run. No Colab internals touched; uses the feat/colab-progress web gauge component.
- LLM: a joined cassette lets the chat answer the seeded storyline offline (`COMFYRIZZ_LLM_CASSETTE=play:examples/pip-night-shift/cassette.json`).

## 5. Offline vs Google Colab
Everything in section 3 works offline on CPU: placeholder media, local Remotion/CPU final render, canned Google Colab history. Only *new* real generations (a new take, real clip quality) need Google Colab or a ComfyUI URL; the render gate, A/B and approval are local.

## 6. Tasks (row format matches tasks_character_creator.py; prefix PN)
Boundaries: no edits to HyperFrames, Google Colab internals (colab/**, packages/backends/src/colab-*, apps/server/src/colab-*, pipeline-colab-render.mjs), renderer, pipeline-worker, or the takes/**, references/**, characters/** modules (consume their store APIs only). `apps/web/src/demo/**` untouched.

| ID slug | Title | Files | Deps | Flags | Acceptance |
|---|---|---|---|---|---|
| PN01 scene-design | Motion-graphics scenes, look, text styles | `examples/pip-night-shift/package.json`, `examples/pip-night-shift/timeline.json`, `examples/pip-night-shift/README.md`, `apps/server/test/pip-night-shift/package.test.mjs` | - | - | validatePackage passes; package look compiled from scripts/motionkit/data/recipes/film-35mm.json (Tier A: brand palette/fonts, per-scene motion, background.procedural); 4 scenes with the section 3a treatments: distinct layout+variant, motion.recipe, energy, entry and transitionOut per scene; s2 and s3 have lower_third; s3 data.display counter; captions.style karaoke; motion_lint clean; timeline.json is the planner compile of package.json (test recompiles and compares); every scene renders text with no generated media present (media optional) |
| PN17 motion-check | CPU frame check of the motion scenes | `apps/server/test/pip-night-shift/motion-frames.test.mjs` | PN01 | - | renders mid-scene stills for s1-s4 on CPU with the existing renderer script (skip with reason if Chromium/ffmpeg missing); asserts non-blank, distinct frames per scene and that the timeline has no GPU-only dependency; look score from scripts/motionkit reported >= recipe baseline |
| PN02 media | Placeholder media generator | `scripts/pip-night-shift/make-media.mjs`, `scripts/pip-night-shift/make-media.test.mjs`, `examples/pip-night-shift/.gitignore` | PN01 | - | deterministic clips for s1-s3 take1 + s3 take2, 2 ref files, 2 character stills; works without ffmpeg (fallback); no binaries committed |
| PN03 refs | Reference manifest | `examples/pip-night-shift/references/manifest.json`, `apps/server/test/pip-night-shift/references.test.mjs` | PN01 | - | passes references/validate.mjs; style image -> s1, camera clip -> s2, notes present |
| PN04 takes | Takes + approvals sidecar | `examples/pip-night-shift/takes.json`, `examples/pip-night-shift/editor.json`, `apps/server/test/pip-night-shift/takes.test.mjs` | PN01 | - | loads through takes/store+model; s3 take1 rejected w/ correction, take2 present but unapproved; s1, s2, s4 approved; gate reports 3/4 and blocks render; approving s3 take2 through the takes API makes it 4/4; editor sidecar valid |
| PN05 seeder | Seed module | `apps/server/src/seed-demo.mjs`, `apps/server/test/seed-demo.test.mjs` | PN02, PN03, PN04 | - | temp runtime: writes package, media, takes, editor, refs only if absent; second run no-op; never overwrites owner edits; injected fs |
| PN06 boot | Server uses seeder | `apps/server/src/index.mjs`, `apps/server/test/index-seed.test.mjs` | PN05 | - | default seeds pip-night-shift (launch-demo still seeded as a second project); `COMFYRIZZ_DEMO=launch` restores old default |
| PN07 web-default | Editor opens pip-night-shift | `apps/web/src/main.ts`, `apps/web/src/default-project.ts`, `apps/web/test/default-project.test.ts` | PN01, PN06 | - | no `?package=` + token -> opens seeded project via API (takes/refs/render bar populated); no token -> bundled package; `?package=` unchanged; activity text updated |
| PN08 cassette-a | Chat cassette (refs + takes turns) | `examples/pip-night-shift/cassette.json`, `apps/server/test/pip-night-shift/cassette.test.mjs` | PN03, PN04 | - | cassette/v1 validates; synthetic, < 40 KB |
| PN09 e2e-a | Server e2e: first open without GPU | `apps/server/test/pip-night-shift/e2e.test.mjs` | PN06 | - | createApp + temp runtime + fake backend: GET package, takes (s3 has 2), refs (2), render gate blocked at 3/4; approve s3 take2 -> gate ok -> CPU render request accepted; no network |
| PN10 cast | Characters library + cast seed | `examples/pip-night-shift/characters/library.json`, `examples/pip-night-shift/characters.json`, `apps/server/test/pip-night-shift/cast.test.mjs` | PN01 | after-CC | built via merged characters build: cast[], scene.cast (s2 Pip, s3 Juno), fictional flags; package updated with cast |
| PN11 seed-cast | Seeder writes character library | `apps/server/src/seed-demo-characters.mjs`, `apps/server/test/seed-demo-characters.test.mjs` | PN05, PN10 | after-CC | writes `<runtime>/characters` via characters store API only if absent; project snapshot pinned |
| PN12 cassette-b | Extend cassette with character turns | `examples/pip-night-shift/cassette.json`, `apps/server/test/pip-night-shift/cassette.test.mjs` | PN08, PN10 | after-CC | adds character_list / propose_cast with @pip/@juno; tool names exist |
| PN13 colab-hist | Google Colab progress history fixture | `examples/pip-night-shift/colab-history.json`, `apps/server/test/pip-night-shift/colab-history.test.mjs` | PN04 | after-CP | recorded from simulate-progress; 3-job run + 1 regen job; shape matches colab-progress.mjs |
| PN14 colab-seed | Seed + show history in editor | `apps/server/src/seed-demo-history.mjs`, `apps/web/src/colab-history.ts`, `apps/web/test/colab-history.test.mjs` | PN05, PN13 | after-CP | past run listed in Activity with gauges (read-only replay via colab-progress.ts render functions); labelled "Google Colab"; no Colab internals edited |
| PN15 e2e-b | Playwright: editor first open | `apps/web/e2e/default-project.spec.ts` | PN07, PN11, PN14, PN17 | after-CC; after-CP | fresh runtime: cast strip shows Pip+Juno, refs with notes, s3 A/B, render bar 3/4 and locked, approve s3 take2 -> 4/4 and Render enabled, Google Colab history visible, look name visible |
| PN16 docs | Guide + demo script | `docs/DEFAULT_PROJECT.md`, `docs/submission/DEMO_SCRIPT.md`, `examples/pip-night-shift/CREDITS.md` | PN15 | - | every command exists; first-open walkthrough; offline vs Google Colab table; 2:00 script |

Flags: `after-CC` = feat/character-creator merged to main (after CC18). `after-CP` = feat/colab-progress merged to main.
Waves: now: PN01 -> PN02, PN03, PN04, PN17 -> PN05, PN08 -> PN06 -> PN07, PN09 (10 tasks). After CC: PN10 -> PN11, PN12 (3). After CP: PN13 -> PN14 (2). Last: PN15 -> PN16 (2).
Conflict note: PN07 edits `apps/web/src/main.ts` and PN06 `apps/server/src/index.mjs`; CC16 (main.ts) and feat/colab-progress (main.ts, app.mjs) touch the same files, so PN07 should rebase after whichever merges first; keep the PN07 change to an import swap + one call into `default-project.ts`.

## 7. Resolved decisions (Kyle, 2026-10-21 07:28)
- D1 launch-demo stays seeded as a second project; `COMFYRIZZ_DEMO=launch` restores it as the default.
- D2 Placeholder media only; no real Google Colab clips recorded or hosted.
- D3 Look: 'warm film' = `film-35mm` recipe; names Pip and Juno, fictional café.
- D4 Fresh state: 3/4 approved, render gate locked until s3 take 2 is approved live.
- D5 No-server build: built-in package only, sidecar panels empty.
- D6 Retire nothing; apps/web/demo.html and apps/web/src/demo/** unchanged.
