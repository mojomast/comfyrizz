# MOTION_UPGRADE: style recipes, effects, assets and variety for the chat agent

Status: planned 2026-10-20 (America/Toronto). Branch `feat/motion-upgrade`. Research and sources: `docs/research/MOTION_RESEARCH.md`. Deadline context: hackathon submission due 2026-10-30 12:00 PM Toronto time.

## 1. Problem and goal

Output is "kind of basic" because every look shares one typeface (Inter), there is no finishing layer (grain, grade, leaks, glow), `grain`/`mesh` backgrounds render flat, the vocabulary is small and lint-funnelled to fade + fadeUp, there is no camera, presets are palettes rather than looks, and nothing prevents repetition (research §2).

Goal: the chat agent can pick from **24 named, distinct, world-class looks**, apply one in a single tool call, vary scenes inside it, avoid repeating recent looks, and score the result, using only MIT/ISC/CC0/OFL assets.

## 2. Ownership and design principles

- **HyperFrames and Google Colab rendering code belong to mojo-opencode.** This feature does not edit them. It also does not edit `apps/renderer/**` or `packages/schema/**` except in the single gated task M17 (`needs-kyle-ok`).
- **Tier A (works today, no renderer change):** a recipe compiles to fields the package schema already accepts: `brand.palette`, `brand.fonts`, per-scene `motion` (energy, entry, ease/spring, emphasis, `transitionOut`, `recipe`), `background.procedural.pattern`. That alone varies palette, type (once font files are reachable), easing personality, entry and transition grammar and story recipe per look.
- **Tier B (after M17):** a `comfyrizz.look/v1` sidecar carries the finishing stack, font files and GL/overlay transition hints. Renderers that ignore it still render tier A.
- All new code is pure `.mjs` in `scripts/motionkit/` (same pattern as `scripts/doctor`, `scripts/cassette`), data in `scripts/motionkit/data/`, no new npm dependencies, deterministic for a seed.

```
brief ─► style.suggest (variety.mjs) ─► recipe id ─► style.apply (compile.mjs) ─► package (tier A) + look sidecar (tier B)
                                                                         └► look-score.mjs (+ frame-qa) ─► agent critique loop
```

## 3. Style recipe library

### 3.1 `comfyrizz.recipe/v1`

```json
{ "schema": "comfyrizz.recipe/v1", "id": "swiss-grid", "label": "Swiss grid",
  "taxonomy": { "era": "modernist", "finish": "clean", "energy": "medium", "geometry": "flat", "type": "grotesk" },
  "palette": [ {"role":"background","hex":"#f2f0eb"}, {"role":"text","hex":"#111111"}, {"role":"accent","hex":"#e3241b"}, {"role":"muted","hex":"#9a9a9a"} ],
  "fonts": { "display": "space-grotesk", "text": "inter", "mono": "jetbrains-mono" },
  "easing": { "personality": "editorial", "entry": "enter", "exit": "exit", "spring": "settle" },
  "entries": ["maskRise", "fadeUp", "waterfall"], "emphasis": ["keyword", "hero"],
  "transitions": { "primary": "wipe", "accent": ["push", "cut"] },
  "storyRecipe": "kinetic", "background": { "pattern": "grid" },
  "finish": [ {"id":"paper-grain","params":{"amount":0.04}} ],
  "rules": { "do": ["flush-left headlines on a 12-col grid"], "dont": ["centered text", "drop shadows"] },
  "prompt": "Swiss International Style poster, strict grid, red accent, flat colour, no gradients" }
```

Every token comes from `MOTION_VOCABULARY` / `ANIMATION_RECIPE_IDS` (imported, never copied). `primary + accent` ≤ 3 transition types and inside the energy's `ENERGY_TRANSITIONS` family, so compiled packages pass `motion_lint` untouched.

### 3.2 Easing personalities (M02)

| Personality | Entry curve | Exit | Duration × | Overshoot | Nearest schema token |
|---|---|---|---|---|---|
| snappy | expoOut cubic-bezier(0.16,1,0.3,1) | expoIn | 0.8 | 0 | enter / snap |
| editorial | emphasizedDecel (0.05,0.7,0.1,1) | (0.3,0,0.8,0.15) | 1.0 | 0 | enter / settle |
| elastic | backOut (0.34,1.56,0.64,1) | backIn | 0.9 | 0.08 | land / elastic |
| floaty | sineInOut (0.37,0,0.63,1) | sineIn | 1.3 | 0 | move / settle |
| mechanical | linearStep (stepped 12 fps feel) | linear | 1.0 | 0 | linear / snap |
| heavy | circOut (0,0.55,0.45,1) | circIn | 1.2 | 0.02 | land / heavy |
| anticipate | anticipate (0.36,0,0.66,-0.56 → out) | expoIn | 1.0 | 0.05 | land / pop |

### 3.3 The 24 recipes (M06 = 1-12, M07 = 13-24)

| # | id | Look | Palette (bg / text / accent / extra) | Display / text font | Easing | Transitions (primary + accents) | Story recipe | Background | Finish |
|---|---|---|---|---|---|---|---|---|---|
| 1 | swiss-grid | International Style poster | #f2f0eb #111111 #e3241b #9a9a9a | Space Grotesk / Inter | editorial | wipe + push, cut | kinetic | grid | paper-grain |
| 2 | editorial-serif | Magazine feature | #faf7f2 #1c1a17 #b0412e #d9cfc1 | Playfair Display / Inter | editorial | fade + slide, cut | focus | gradient | paper-grain, vignette-soft |
| 3 | neo-brutalist | Raw web brutalism | #fffb00 #000000 #ff3ea5 #ffffff | Archivo Black / Space Grotesk | snappy | cut + push, zoom | kinetic | dots | hard-shadow, halftone |
| 4 | kinetic-poster | Big type, high energy | #0d0d0d #f5f5f5 #ff5a1f #3a3a3a | Bebas Neue / Inter | snappy | push + zoom, cut | kinetic | gradient | motion-smear, grain-fine |
| 5 | bauhaus-play | Primary shapes | #f4efe1 #1d1d1b #d6402b #2a5db0 | Unbounded / Inter | elastic | shape-reveal + slide, wipe | morph | gradient | paper-grain |
| 6 | mono-terminal | Developer CLI | #0b0f0c #c8facc #39ff88 #4a5a4e | JetBrains Mono / IBM Plex Mono | mechanical | cut + wipe, fade | technical-flow | grid | scanlines-soft, glow-text |
| 7 | blueprint | Engineering drawing | #0f2a4a #e8f1fb #7cc4ff #3d6a99 | IBM Plex Mono / Inter | editorial | draw-reveal + wipe, fade | technical-flow | grid | paper-grain, vignette-soft |
| 8 | isometric-saas | Product explainer | #0d1117 #e6edf3 #2d6cff #31d0aa | Space Grotesk / Inter | snappy | slide + push, zoom | technical-flow | dots | soft-glow |
| 9 | glassmorphism | Frosted UI | #0b1020 #eef3ff #4f6bff #9fe8ff | Syne / Inter | floaty | blur + fade, zoom | focus | gradient | bloom, grain-fine |
| 10 | clay-soft | Claymation 3D-ish | #f4e9dd #2b2320 #c98a6b #6d4b3a | Fraunces / Inter | elastic | shape-reveal + slide, fade | morph | gradient | soft-shadow, grain-fine |
| 11 | paper-collage | Cut paper | #fdf6e3 #2d2a26 #e0b13c #3f7d5a | Caveat / Fraunces | heavy | paper-reveal + slide, cut | paper-cut | grain | paper-texture, drop-shadow |
| 12 | risograph | Two-ink riso print | #f6f1e7 #1f2a5c #ff4f7b #ffd23f | Syne / IBM Plex Mono | snappy | wipe + slide, cut | kinetic | dots | riso-misregister, halftone, paper-grain |
| 13 | cinematic-noir | Black & white noir | #050505 #f2f2f2 #c9a227 #3b3b3b | DM Serif Display / Inter | heavy | fade + iris, cut | focus | gradient | film-grain, vignette-hard, mono-grade |
| 14 | film-35mm | Warm 35 mm film | #1a1410 #f6ead8 #ff8a3d #6b4a33 | Instrument Serif / Inter | floaty | fade + blur, cut | focus | grain | film-grain, halation, light-leak, gate-weave |
| 15 | vhs-retro | 90s camcorder | #120c1f #f8f4ff #ff2fd1 #19e3ff | VT323 / IBM Plex Mono | mechanical | cut + wipe, slide | kinetic | gradient | vhs-tracking, chroma-shift, scanlines |
| 16 | crt-arcade | 8-bit arcade | #000000 #f8f8f8 #ffd400 #00e5ff | Press Start 2P / VT323 | mechanical | cut + iris, zoom | kinetic | grid | crt-curve, scanlines, pixelate-in |
| 17 | y2k-chrome | Millennium chrome | #e9ecf5 #101326 #6c5cff #b8f3ff | Monoton / Syne | elastic | zoom + iris, push | morph | gradient | chrome-sheen, bloom |
| 18 | synthwave | Neon 80s horizon | #120428 #fdf0ff #ff2a6d #05d9e8 | Orbitron / Inter | floaty | zoom + push, cut | kinetic | grid | glow-text, scanlines-soft, bloom |
| 19 | vaporwave | Pastel internet | #2b1055 #fef6ff #ff71ce #01cdfe | Syne / VT323 | floaty | blur + fade, slide | morph | gradient | chroma-shift, grain-fine, duotone |
| 20 | organic-hand | Hand-drawn | #fbf8f1 #2e2a24 #ef6f4b #6aa58e | Caveat / Inter | anticipate | draw-reveal + paper-reveal, fade | sketch | grain | paper-texture, boil-line |
| 21 | data-journalism | FT/Bloomberg charts | #fff1e5 #262a33 #0f5499 #990f3d | Instrument Serif / IBM Plex Mono | editorial | slide + wipe, fade | technical-flow | gradient | paper-grain (subtle) |
| 22 | luxury-minimal | Premium brand | #0e0e0e #f4efe6 #c8a96a #2a2a2a | Instrument Serif / Inter | floaty | fade + blur, cut | focus | gradient | grain-fine, vignette-soft |
| 23 | neon-cyber | Cyberpunk HUD | #05010d #e7f9ff #00f0ff #ff003c | Orbitron / JetBrains Mono | snappy | cut + zoom, push | technical-flow | grid | glitch-slice, chroma-shift, glow-text |
| 24 | documentary-archive | Archival doc | #e8e0cf #241f1a #8a3b12 #7d7464 | DM Serif Display / IBM Plex Mono | heavy | fade + paper-reveal, cut | focus | grain | dust-scratches, sepia-grade, gate-weave |

Distinctness rule (tested): no two recipes share both background colour and display font; taxonomy distance between any two ≥ 0.2.

### 3.4 `comfyrizz.look/v1` sidecar

`{ schema, recipeId, seed, fonts:[{family, assetId}], finish:[{id, params, cpuFallback}], transitions:[{scene, id, native, glsl?, overlay?}], camera?:{move, amount} }`. Written next to the package; never inside it (the package schema rejects extra properties).

## 4. Effects and transitions catalog

### 4.1 Effects (M04, `data/effects.json`, 30 entries)

| Family | Effects (cost: css / svg / webgl→fallback) |
|---|---|
| Grain & texture | film-grain (svg feTurbulence, animated seed), grain-fine (svg), paper-grain (svg), paper-texture (CC0 image, svg fallback), dust-scratches (CC0 overlay video fetch-on-demand → svg specks), halftone (svg pattern) |
| Light | light-leak (css radial gradients + screen blend; webgl Remotion-style optional), halation (css blur of highlights), bloom (css drop-shadow/blur stack), glow-text (css text-shadow), chrome-sheen (css linear-gradient sweep), soft-glow |
| Lens | vignette-soft, vignette-hard (css radial), chroma-shift (css RGB offset via 3 layered copies / svg feOffset), motion-smear (directional blur svg feGaussianBlur stdDeviation x), depth-blur (css blur by layer depth) |
| Display | scanlines, scanlines-soft (css repeating-linear-gradient), crt-curve (svg feDisplacementMap; webgl→scanlines), vhs-tracking (svg displacement band), glitch-slice (css clip-path slices), pixelate-in (svg feMorphology/steps) |
| Grade | mono-grade, sepia-grade, duotone, teal-orange (svg feColorMatrix), lut (procedural .cube → feComponentTransfer approximation; webgl exact) |
| Print | riso-misregister (offset accent layer + multiply), hard-shadow, drop-shadow, soft-shadow |
| Drawn | boil-line (seeded per-2-frame path jitter via noise.mjs) |
| Camera | push-in, drift (noise), parallax-layers (z-scaled translate), rack-focus (depth-blur over time) |

### 4.2 Transitions (M05, `data/transitions.json`, 24 entries, each resolving to a native schema type)

| id | Grammar | Native fallback | GL (gated, MIT) | Overlay/SFX |
|---|---|---|---|---|
| hard-cut | cut | cut | - | - |
| luma-fade | fade | fade | luma | - |
| dip-to-black / dip-to-white | fade | fade | fadecolor | - |
| linear-wipe | wipe | wipe | directionalwipe | whoosh-soft |
| radial-wipe / clock-wipe | wipe | iris | radial / angular | - |
| barn-door | wipe | wipe | doorway | - |
| push / whip-pan | depth | push | directional-easing | whoosh, motion-smear |
| slide-over | wipe | slide | - | - |
| zoom-through | depth | zoom | crosszoom | whoosh |
| iris-open / iris-close | mask | iris | circleopen | - |
| shape-mask | mask | shape-reveal | - | pop |
| ink-bleed | mask | paper-reveal | - | paper |
| paper-tear | mask | paper-reveal | - | paper |
| line-draw | mask | draw-reveal | - | pencil |
| blur-dissolve | fade | blur | - | - |
| glitch-cut | overlay | cut + glitch-slice | glitchdisplace | glitch |
| light-leak-cut | overlay | fade + light-leak | - | - |
| film-burn | overlay | fade + light-leak | burn | - |
| pixel-dissolve | overlay | fade + pixelate-in | pixelize | blip |
| match-cut-shape | match | cut (shape kept in both scenes via morph recipe) | - | - |
| match-cut-colour | match | cut (accent colour continuity) | - | - |

GL shader files are vendored only if their own header says MIT (gl-transitions files carry per-file licences).

## 5. Asset pack manifest (M08) and vendoring (M09)

### 5.1 Fonts (all SIL OFL 1.1, source `github.com/google/fonts/tree/main/ofl/<dir>`, each OFL.txt verified 2026-10-20)

inter (bundled), jetbrains-mono (bundled), space-grotesk, playfair-display, fraunces, dm-serif-display, archivo-black, bebas-neue, ibm-plex-mono, instrument-serif, syne, press-start-2p, caveat, orbitron, unbounded, vt323, monoton.

### 5.2 Other assets

| id | Kind | Licence | Vendor strategy |
|---|---|---|---|
| phosphor-icons | icons | MIT | vendored subset (≤ 60 SVGs) + LICENSE |
| tabler-icons | icons | MIT | vendored subset + LICENSE |
| lucide | icons | ISC (+MIT Feather part) | fetch-on-demand |
| kenney-interface-sounds | sfx | CC0-1.0 | vendored subset (≤ 20 OGG, < 1 MB) |
| kenney-ui-audio | sfx | CC0-1.0 | fetch-on-demand |
| polyhaven / ambientcg paper & concrete | texture | CC0-1.0 | fetch-on-demand (1K JPG) |
| forfilmcreation overlays | overlay video | CC0-1.0 | fetch-on-demand only (large) |
| gl-transitions (per-file MIT) | shader | MIT | vendored selected .glsl |
| webgl-noise | shader | MIT | vendored |
| glsl-film-grain | shader | MIT | vendored |
| procedural grain / leak / LUT | generated | MIT (ours) | generated at build time |

Strategy: the manifest is committed; small items are vendored into `assets/motionkit/` with their licence file, a `lock.json` of sha256 and a combined `NOTICE.txt`; large items are fetch-on-demand into `assets/motionkit/cache/` (gitignored). `validateManifest` refuses any SPDX id outside `[MIT, ISC, CC0-1.0, OFL-1.1]`. Excluded: LYGIA (Prosperity), LottieFiles Simple License, post-2019 Pixabay, non-CC0 Freesound, Enchanted Media overlays.

## 6. Agent skill cards and tools (M15, M16)

- Skill `motion-style` (bundled, ~1 KB): choose → apply → vary → score → fix weakest scenes only; never exceed 3 transition types; one hero moment; name the look in the storyboard.
- Recipe cards (≤ 1400 chars each) injected only for the chosen recipe; a one-line-per-recipe catalog card (≤ 24 × 120 chars) for choice. Fits the ~100k free-model budget easily.
- Tools: `style.list`, `style.suggest({tone, goal, history})` → 3 ids with reasons, `style.apply({recipeId, seed})` → compiled package + look + score. Existing tools unchanged.

## 7. Variety mechanism (M11)

Fit score = tone/goal affinity table × energy match. Penalty for recipes with `recipeDistance` < 0.35 to any of the last 8 looks (history is plain JSON the server/agent keeps per user session). Seeded weighted sampling (mulberry32) so a seed reproduces a pick. Inside a film: rotate entries/emphasis across scenes (no 3 identical in a row), exactly one hero, primary transition on ≥ 60% of cuts, accents elsewhere.

## 8. QA (M14)

`scoreLook` 0-100 = adherence 30, rhythm 20, variety 15, contrast 20, finish 5, frame-qa 10. Below 70 → agent revises flagged scenes (existing critique loop). Gallery and tests assert every compiled demo ≥ 80. frame-qa (existing) remains the hard gate for black/static/flash/contrast frames.

## 9. ComfyUI-side quality (M18, data only)

Manifest of runtime-only workflows: RIFE 4.25 (MIT) 2× interpolation, FILM (Apache-2.0), Depth Anything V2 Small (Apache-2.0) for parallax depth, LTX-Video 0.9 (Apache-2.0 code; check weights), AnimateDiff MotionDirector (Apache-2.0), per-recipe prompt fragment and LoRA hints with licences. Executing them inside Google Colab is mojo-opencode's work.

## 10. Demo gallery (M13)

`docs/motion-gallery/index.html` + `gallery.json`: 24 deterministic SVG style frames (CPU only), filter by energy/finish, licence footer. After M17, a follow-up can render one 6 s clip per recipe from `apps/renderer/fixtures/recipe-showcase` for the submission video.

## 11. Tasks

Simple tier = free models (~100k-token prompt budget); standard = deepseek-v4.1-flash. M17 is `needs-kyle-ok` (touches the renderer core) and is not dispatched automatically.

| Task | Title | Tier | Files | Depends on | Acceptance |
|---|---|---|---|---|---|
| M01 recipe-schema | Recipe and look-sidecar contract | simple | `scripts/motionkit/recipe-schema.mjs`, `scripts/motionkit/recipe-schema.test.mjs` | - | valid fixture passes; unknown transition/entry/ease rejected with path; palette of 3 rejected; vocabularies imported from packages/schema (test asserts no hard-coded copy by mutating nothing and checking a schema token is accepted) |
| M02 easing | Easing personalities and spring solver | simple | `scripts/motionkit/easing.mjs`, `scripts/motionkit/easing.test.mjs` | - | curves hit 0 and 1 at ends and are monotonic where expected; backOut overshoots >1; spring settles within 2% and reports settle frame; every nearestToken exists in MOTION_VOCABULARY |
| M03 noise | Seeded noise fields | simple | `scripts/motionkit/noise.mjs`, `scripts/motionkit/noise.test.mjs` | - | same seed -> identical values; different seeds differ; output within [-1,1]; no Math.random usage (test greps the file) |
| M04 effects-catalog | Effects catalog data | simple | `scripts/motionkit/data/effects.json`, `scripts/motionkit/effects.mjs`, `scripts/motionkit/effects.test.mjs` | - | 30+ effects, unique ids; every webgl effect has a valid css/svg fallback; licences only MIT/ISC/CC0-1.0/OFL-1.1/own-MIT; defaults inside ranges |
| M05 transitions-catalog | Transitions catalog and native fallbacks | simple | `scripts/motionkit/data/transitions.json`, `scripts/motionkit/transitions.mjs`, `scripts/motionkit/transitions.test.mjs` | - | every native value is a schema transition type; resolved frames inside the schema band at 24 and 30 fps; glsl entries name MIT shaders only; 20+ entries |
| M06 recipes-a | Style recipes 1-12 | simple | `scripts/motionkit/data/recipes/swiss-grid.json`, `scripts/motionkit/data/recipes/editorial-serif.json`, `scripts/motionkit/data/recipes/neo-brutalist.json`, `scripts/motionkit/data/recipes/kinetic-poster.json`, `scripts/motionkit/data/recipes/bauhaus-play.json`, `scripts/motionkit/data/recipes/mono-terminal.json`, `scripts/motionkit/data/recipes/blueprint.json`, `scripts/motionkit/data/recipes/isometric-saas.json`, `scripts/motionkit/data/recipes/glassmorphism.json`, `scripts/motionkit/data/recipes/clay-soft.json`, `scripts/motionkit/data/recipes/paper-collage.json`, `scripts/motionkit/data/recipes/risograph.json`, `scripts/motionkit/recipes-a.test.mjs` | M01 | all 12 pass validateRecipe; palette text-on-background contrast >= 4.5 (compute WCAG in the test); no two recipes share both palette[0] and display font; transitions within energy family |
| M07 recipes-b | Style recipes 13-24 | simple | `scripts/motionkit/data/recipes/cinematic-noir.json`, `scripts/motionkit/data/recipes/film-35mm.json`, `scripts/motionkit/data/recipes/vhs-retro.json`, `scripts/motionkit/data/recipes/crt-arcade.json`, `scripts/motionkit/data/recipes/y2k-chrome.json`, `scripts/motionkit/data/recipes/synthwave.json`, `scripts/motionkit/data/recipes/vaporwave.json`, `scripts/motionkit/data/recipes/organic-hand.json`, `scripts/motionkit/data/recipes/data-journalism.json`, `scripts/motionkit/data/recipes/luxury-minimal.json`, `scripts/motionkit/data/recipes/neon-cyber.json`, `scripts/motionkit/data/recipes/documentary-archive.json`, `scripts/motionkit/recipes-b.test.mjs` | M01 | all 12 pass validateRecipe; contrast >= 4.5; distinct from each other (same rule as M06); transitions within energy family |
| M08 font-manifest | Asset pack manifest | simple | `scripts/motionkit/data/assets.json`, `scripts/motionkit/assets.mjs`, `scripts/motionkit/assets.test.mjs` | - | allowlist enforced (a GPL fixture is rejected); every recipe font id resolvable (read M06/M07 files only if present; otherwise check spec font ids constant); no http:// URLs; listLicenses groups by licence |
| M09 asset-fetch | Asset fetch and licence notices | simple | `scripts/motionkit/fetch-assets.mjs`, `scripts/motionkit/fetch-assets.test.mjs`, `.gitignore` | M08 | fake fetch: files + licence + NOTICE written to a temp dir; sha mismatch -> non-zero exit and nothing kept; --dry-run writes nothing; disallowed licence refused |
| M10 compile | Recipe compiler | standard | `scripts/motionkit/compile.mjs`, `scripts/motionkit/compile.test.mjs` | M01, M02, M05, M06 | compile of packages/schema/fixtures/valid sample with 3 different recipes -> validatePackage ok and lintMotion has no error/warning; input not mutated; same seed -> identical output; look passes validateLook |
| M11 variety | Variety and anti-repetition engine | simple | `scripts/motionkit/variety.mjs`, `scripts/motionkit/variety.test.mjs` | M01 | 100 seeded picks with history never repeat within 4; tone 'playful' favours playful recipes (statistical test with fixed seeds); no 3 consecutive equal entries; exactly one hero |
| M12 style-frames | SVG style frames | simple | `scripts/motionkit/style-frame.mjs`, `scripts/motionkit/style-frame.test.mjs` | M01 | same input -> same SVG; parses as XML (minimal checker or DOMParser-free regex balance test); text escaped; contains no http(s) refs except the SVG xmlns |
| M13 gallery | Demo gallery generator | simple | `scripts/motionkit/gallery.mjs`, `scripts/motionkit/gallery.test.mjs`, `docs/motion-gallery/index.html`, `docs/motion-gallery/gallery.json` | M06, M07, M12 | 24 cards; html has no external URLs; regeneration is byte-identical; gallery.json licences subset of allowlist |
| M14 look-score | Look quality score | simple | `scripts/motionkit/look-score.mjs`, `scripts/motionkit/look-score.test.mjs` | M01 | perfect fixture >= 90; all-fade-all-fadeUp fixture < 60 with a variety finding; low-contrast palette finding; frame-qa errors lower the score |
| M15 skill-cards | Skill and recipe cards | simple | `packages/agent/src/skills/motion-style/SKILL.md`, `scripts/motionkit/cards.mjs`, `scripts/motionkit/cards.test.mjs` | M01, M04 | SKILL.md front matter matches the existing skills' format (test reads one); each card <= 1400 chars; catalog lines <= 120 chars; cards contain no URLs |
| M16 agent-tools | Agent style tools and skill registration | standard | `packages/agent/src/style-recipes.ts`, `packages/agent/test/style-recipes.test.ts`, `packages/agent/src/tools.ts`, `packages/agent/src/skills/index.ts` | M10, M11, M14, M15 | pnpm --filter @comfyrizz/agent test passes (or exact failing output); style.apply output passes validatePackage; tools.ts diff only adds the three tool entries and one import; skills test sees motion-style |
| M17 renderer-look-layer | Renderer finishing layer (needs-kyle-ok) | standard (needs-kyle-ok) | `apps/renderer/src/look-layer.tsx`, `apps/renderer/src/look-model.js`, `apps/renderer/test/look-model.test.mjs`, `apps/renderer/src/composition.tsx`, `apps/renderer/public/fonts/` | M04, M09, M10 | no sidecar -> existing renderer tests unchanged; look-model pure tests for each effect's style output; frame-qa still passes on recipe-showcase fixture with a look |
| M18 comfy-workflows | ComfyUI quality manifest | simple | `scripts/motionkit/data/comfy-workflows.json`, `scripts/motionkit/comfy-workflows.mjs`, `scripts/motionkit/comfy-workflows.test.mjs` | - | every non-MIT/CC0/OFL item is runtimeOnly and vendor:false; LTX-2.x flagged restricted; sources https |
| M19 docs | Motion styles guide | simple | `docs/MOTION_STYLES.md` | M13, M16 | commands match scripts in scripts/motionkit; licence table matches assets.json; states clearly which effects are visible today vs after M17 |

Details:

- **M01** validateRecipe(obj)->{ok,errors[] with JSON paths} for comfyrizz.recipe/v1 exactly as spec section 3.1 (id kebab-case, label, taxonomy{era,finish,energy,geometry,type}, palette 4-6 #rrggbb with roles, fonts{display,text,mono?} naming families from the font manifest ids, easing{personality,entry,exit,spring}, entries[] and transitions{primary,accent[]} drawn ONLY from the vocabularies in packages/schema/src/motion.mjs (import MOTION_VOCABULARY, do not copy), storyRecipe? from packages/schema/src/animation.mjs ANIMATION_RECIPE_IDS, background{pattern} from the schema enum, finish[] effect ids, rules{do[],dont[]}, prompt fragment <=240 chars). validateLook(obj) for comfyrizz.look/v1 sidecar (spec 3.4).
- **M02** Pure cubicBezier(x1,y1,x2,y2)->t=>y (Newton+bisection, no dependency), named curves (spec 3.2 table: expoOut, emphasizedDecel, backOut, sineInOut, circOut, anticipate, linearStep), spring({stiffness,damping,mass}) sampled per frame with settle frame detection, and PERSONALITIES mapping each personality to {entryCurve,exitCurve,durationScale,overshoot,nearestToken} where nearestToken is one of the existing schema easing/spring tokens.
- **M03** Own MIT implementation of seeded 2D/3D simplex noise (re-expressed from Gustavson's public-domain description, no copied code), fbm(octaves), curl2d, and drift(seed,t,amp) for camera/particle wobble. mulberry32(seed) PRNG exported.
- **M04** effects.json: the 30 effects of spec section 4.1 with {id,label,family,params{name:{min,max,default}},cost:'css'|'svg'|'webgl',cpuFallback,source,license,notes}. effects.mjs: loadEffects(), getEffect(id), validateEffects() (unique ids, defaults in range, webgl effects have a cpuFallback id that exists and is css/svg, license in allowlist).
- **M05** transitions.json: spec section 4.2 entries {id,label,grammar:'cut'|'wipe'|'mask'|'morph'|'depth'|'overlay'|'match',native: one of the existing schema transition types, direction?, sfx?, glsl?:{name in gl-transitions,license:'MIT'}, overlayEffect?}. resolveTransition(id,{webgl:false}) -> a schema-valid {type,direction?,frames} using bands from packages/schema/src/motion.mjs TRANSITIONS at a given fps.
- **M06** Write the first 12 recipes of spec section 3.3 as comfyrizz.recipe/v1 JSON, faithful to the table (palette, fonts, easing personality, transition grammar, finish). Font ids must exist in spec 5.1. Respect the motion lint budget: primary+accent transitions <= 3 types and each in the ENERGY_TRANSITIONS family of the recipe's energy.
- **M07** Write recipes 13-24 of spec section 3.3, same rules as M06.
- **M08** assets.json = spec section 5 manifest: fonts (the 15 Google Fonts OFL families of spec 5.1 plus the 2 already bundled with github.com/google/fonts raw paths for the font file and OFL.txt), icons (Phosphor MIT, Tabler MIT, Lucide ISC), sfx (Kenney CC0 packs), textures (Poly Haven/ambientCG CC0), shaders (gl-transitions MIT per-file, webgl-noise MIT, glsl-film-grain MIT), each {id,kind,name,license (SPDX),licenseUrl,source,files[],vendor:'vendored'|'fetch-on-demand',sha256:null|hex}. assets.mjs validateManifest(): SPDX allowlist [MIT, ISC, CC0-1.0, OFL-1.1], https only, vendored items must have sha256 or be marked pending, and listLicenses() for NOTICE generation.
- **M09** node scripts/motionkit/fetch-assets.mjs [--only kind] [--dry-run]: with injected fetch/fs, downloads manifest files into assets/motionkit/<kind>/<id>/, verifies sha256 when present (writes assets/motionkit/lock.json with computed hashes otherwise), always writes the licence file next to each asset and a combined assets/motionkit/NOTICE.txt. Refuses any licence outside the allowlist. Add `assets/motionkit/cache/` to .gitignore (only that line).
- **M10** compileRecipe(pkg, recipe, {seed, variation}) -> {pkg, look}. pkg: a deep copy where ONLY existing schema fields change: brand.palette, brand.fonts (family names), per-scene motion energy/entry/ease/emphasis/transitionOut (via resolveTransition), scene motion.recipe if the recipe names a story recipe and the layout supports it, background.procedural.pattern. look: comfyrizz.look/v1 sidecar {recipeId, finish stack with params, fontFiles, transitions with glsl/overlay hints}. Must call validatePackage from packages/schema (import, do not edit) and autofixMotion so output has zero errors and zero motion warnings.
- **M11** pickRecipe(recipes,{tone[],goal,energy?,history[],seed}) weighted by taxonomy fit (spec 7) and penalising recipes within distance < 0.35 of the last 8 picks (taxonomy+palette distance exported as recipeDistance). sceneVariation(recipe, scenes, seed) rotates entries/emphasis within the recipe so no 3 consecutive scenes share an entry and exactly one hero scene exists. History is passed in/out as plain JSON (no storage here).
- **M12** styleFrame(recipe,{width=320,height=180,text}) -> deterministic SVG string showing the look: background pattern, palette blocks, headline in the display font (font-family attribute only), a CSS/SVG version of the first finish effect (feTurbulence grain, vignette gradient, scanlines, duotone feColorMatrix) and a transition glyph. No external refs, XML-escaped text.
- **M13** node scripts/motionkit/gallery.mjs writes docs/motion-gallery/gallery.json (recipe id,label,taxonomy,fonts,finish,licences) and a static index.html grid of inline style frames with filters by energy/finish, no JS frameworks, no external requests. Commit the generated files.
- **M14** scoreLook(pkg, recipe, {frameQa?}) -> {score 0-100, parts:{adherence,rhythm,variety,contrast,finish,qa}, findings[]} per spec section 8: adherence = share of scene motion tokens inside the recipe's sets; rhythm = scene length variance + stillness before hero; variety = entry entropy within budget; contrast = WCAG of text colours vs palette background; qa = deduct per frame-qa error/warning if a frame-qa report object is given (shape from apps/renderer/scripts/frame-qa.mjs runQa, read only). Findings name the scene.
- **M15** SKILL.md (front matter like the other skills in packages/agent/src/skills): how to choose a look (style.suggest), apply it (style.apply), vary scenes, never exceed the transition budget, and critique with the look score. cards.mjs: recipeCard(recipe, effects) -> compact markdown <= 1400 chars (palette roles, type pair, easing, transitions, finish, do/don't) for prompt injection; catalogCard(recipes) -> one line per recipe <= 120 chars.
- **M16** style-recipes.ts loads scripts/motionkit data at runtime (readFileSync with candidate URLs like skills/index.ts readMarkdown) and exposes three tools added to tools.ts next to the existing ones: style.list (catalog card), style.suggest({tone,goal,history}) -> 3 recipe ids via pickRecipe, style.apply({recipeId, seed}) -> compiled package + look + look score. Register 'motion-style' in BUNDLED_SKILL_IDS (bump SKILL_CATALOG_VERSION minor). Keep tools.ts diff minimal; existing agent tests must still pass.
- **M17** GATED: touches the Remotion renderer core; dispatch only after Kyle OKs it and mojo-opencode is told. Mount an optional LookLayer above scenes when a look sidecar is passed in input props: CSS/SVG implementations of grain, vignette, light-leak, scanlines, chromatic-aberration, duotone/grade, halation; load recipe fonts from assets/motionkit/fonts copied into public/fonts. Absent sidecar -> byte-identical render path. HyperFrames/Google Colab code untouched.
- **M18** Data manifest of spec section 9: interpolation (Practical-RIFE MIT, FILM Apache-2.0), depth parallax (Depth Anything V2 Small Apache-2.0), upscale, LTX-Video/AnimateDiff motion control, recipe-to-LoRA/prompt hints, each {id,purpose,model,codeLicense,weightsLicense,runtimeOnly:true,vendor:false,source,notes}. Validator: runtimeOnly must be true for any non-allowlist licence; no Google Colab code or job wiring here.
- **M19** User/judge guide: the 24 looks (link docs/motion-gallery), how the agent picks and varies them, the effects and transitions catalogs, asset licences and how to fetch them, the look score, and what needs the gated renderer layer. Every command shown must exist.
