# Motion quality research: why Comfyrizz output looks basic, and the levers

Date: 2026-10-20 (America/Toronto). Scope: motion-graphics output of the chat agent (package → Remotion renderer / HyperFrames on Google Colab). Feeds `docs/specs/MOTION_UPGRADE.md`.

Licence rule for anything we redistribute: **MIT, ISC (MIT-equivalent), CC0 or SIL OFL 1.1 only**, licence recorded per item. Apache-2.0 / BSD code may be *used at runtime* (already the case for HyperFrames, Google Colab CLI) but is not vendored by this feature.

## 1. What exists today (read from origin/main 7158f6b)

| Layer | What it has | Where |
|---|---|---|
| Style presets | 6 looks (clay, glass, editorial-flat, isometric-tech, paper-cut, cinematic-dark); each = 4-colour palette + **font `Inter` for all six** + one attribute sentence | `packages/agent/src/brief.ts`, `style-presets.ts` |
| Motion vocabulary | easing 5 (`enter exit move land linear`), springs 5, energies 3, entries 7 (`fadeUp maskRise pop countUp waterfall drawOn`), emphasis 3, transitions 12 (`fade blur slide push wipe zoom iris paper-reveal draw-reveal shape-reveal` + none/cut) | `packages/schema/src/motion.mjs`, `apps/renderer/src/motion/*` |
| Story recipes | 6 (`sketch paper-cut morph technical-flow focus kinetic`) | `packages/schema/src/animation.mjs`, `apps/renderer/src/recipes/*` |
| Backgrounds | procedural `gradient grid dots grain mesh`; **`grain` and `mesh` render as a flat colour** | `apps/renderer/src/background-model.js` |
| Fonts bundled | Inter Variable, JetBrains Mono (OFL) | `apps/renderer/public/fonts` |
| Lint / QA | `motion_lint` (py + mjs twins): duration bands, energy↔transition families, **max 3 transition types per film**, reading holds; `frame-qa`: black/static/flash/safe-area/contrast | `pipeline-py/.../motion_lint.py`, `apps/renderer/scripts/frame-qa.mjs` |
| Agent | picks tokens from the vocabulary, never writes animation code; 4 skills (video-brief, explainer-script, storyboard-direction, project-revision) | `packages/agent/src/prompts/motion.ts`, `skills/` |

## 2. Why it looks basic (top findings)

1. **One typeface for every look.** All six presets typeset in Inter. Typography carries most of a motion-graphics "look"; identical type makes six presets read as one. Brand fonts are already loadable (`brand.fonts`, B1), but nothing ships alternatives. *Biggest, cheapest lever.*
2. **No surface / finish layer.** No grain, vignette, light leak, halation, chromatic aberration, scanlines, colour grade or texture. `grain`/`mesh` backgrounds fall back to flat colour. Clean vector frames with no finish read as "template". Professional motion design nearly always adds a finishing pass (grain, glow, grade).
3. **Small, safe vocabulary, enforced to be smaller.** 5 easing curves, 7 entries, ≤3 transition types per film, and an energy table that funnels calm films into fade/blur. These rules are good taste for *one* film but, with no per-look identity, every film converges on fade + fadeUp + `enter` ease.
4. **No camera.** No push-in/dolly, parallax layers, 2.5D depth, rack focus, or handheld drift. Everything happens on a static flat canvas; the 12 principles' *staging*, *follow-through* and *secondary action* barely appear.
5. **Presets are palettes, not looks.** A world-class "look" binds palette + type pairing + easing personality + transition grammar + texture + layout rhythm. Today only palette varies.
6. **No variety memory.** Nothing stops consecutive films (or scenes) from picking the same preset/transition/entry. LLMs default to the modal choice.
7. **QA checks correctness, not quality.** frame-qa catches black/static/flash/contrast; nothing scores diversity, rhythm, hierarchy or adherence to a look.

## 3. Levers, ranked (impact ÷ effort, respecting the HyperFrames/Google Colab ownership boundary)

| # | Lever | Needs renderer change? |
|---|---|---|
| 1 | **Style recipes**: 24 named looks compiled to *existing* package fields (palette, brand.fonts, energy, entries, transitions, easing/spring tokens, story recipe, background pattern) | No (tier A) |
| 2 | **OFL font pack** (12 families) referenced via `brand.fonts` | Font files must be reachable by the renderer → one gated task |
| 3 | **Variety engine**: seeded recipe pick + anti-repetition history + per-scene variation within a look | No |
| 4 | **Look sidecar + finishing layer** (grain, vignette, leak, glow, CA, scanlines, duotone/grade) as pure CSS/SVG-filter generators | Mounting it is gated (needs-kyle-ok) |
| 5 | **Quality score** (look adherence, rhythm, transition entropy, contrast) that feeds the agent's existing critique loop | No |
| 6 | Camera moves / parallax (scale+translate per layer, depth from Depth Anything V2) | Gated; later |
| 7 | WebGL transitions (gl-transitions, MIT) | Gated; later, CPU fallbacks mapped now |

## 4. Motion design systems (sources)

- **Easing and springs.** CSS `cubic-bezier`/`linear()` ([MDN easing-function](https://developer.mozilla.org/en-US/docs/Web/CSS/easing-function)); Material 3 "emphasized" easing and duration tokens ([m3.material.io motion](https://m3.material.io/styles/motion/easing-and-duration/tokens-specs)); Penner equations as catalogued at [easings.net](https://easings.net/); `bezier-easing` 2.x (MIT, npm, verified 2026-10-20) for an exact cubic-bezier solver; damped-spring physics as in Remotion's `spring()` ([remotion.dev/docs/spring](https://www.remotion.dev/docs/spring)) and Framer Motion / react-spring. Recipe → easing personality: *snappy* (expo-out, short), *elastic* (back/overshoot), *editorial* (emphasized decel), *mechanical* (linear + hard stops), *floaty* (sine in-out, long).
- **12 principles** (Thomas & Johnston, *The Illusion of Life*, 1981): squash/stretch, anticipation, staging, straight-ahead/pose-to-pose, follow-through/overlap, slow in/out, arcs, secondary action, timing, exaggeration, solid drawing, appeal. Today: slow in/out ✔, timing ✔ (bands), staging partial; missing anticipation, overlap, arcs, secondary action → recipe fields `anticipation`, `overlap` (stagger offsets), `arc` hints.
- **Kinetic typography patterns**: word cascade, per-character stagger, mask/line reveal, scale punch on keyword, tracking expand, split-flap, typewriter, highlighter sweep, outline→fill, variable-font weight animation. Existing: waterfall, highlight sweep, maskRise. Adding per-char stagger, tracking, weight-axis (needs variable fonts → OFL variable families).
- **Transitions**: wipes (linear, radial, clock), masks/iris, morphs (flubber already vendored for shape morphs), match cuts (shape or colour continuity), whip-pan (motion-blurred push), zoom-through, glitch cut, light-leak cut, film burn, luma fade, page turn. Remotion models overlays at a cut without shortening sequences via `TransitionSeries.Overlay` ([remotion.dev/docs/transitioning](https://www.remotion.dev/docs/transitioning)); its light-leak effect is WebGL2 ([remotion.dev/docs/light-leaks](https://www.remotion.dev/docs/light-leaks)).
- **GLSL transitions**: [gl-transitions](https://github.com/gl-transitions/gl-transitions), MIT (LICENSE verified 2026-10-20; npm `gl-transitions` 1.x). ~70 shaders; each file carries its own author/licence header — vendor only files whose header says MIT.
- **Noise / shaders**: Ashima/Gustavson webgl-noise ([stegu/webgl-noise](https://github.com/stegu/webgl-noise), MIT, verified), `simplex-noise` 4.x (MIT, npm verified) for CPU-side seeded noise fields (drift, flow fields, particles); `glsl-film-grain` ([mattdesl](https://github.com/mattdesl/glsl-film-grain), MIT, verified). **LYGIA is Prosperity/Patron licensed (non-commercial default) — excluded** ([lygia.xyz/version](https://lygia.xyz/version)).
- **Finishing**: film grain, halation/bloom, vignette, chromatic aberration, scanlines/CRT curvature, VHS tracking, light leaks, dust/scratches, LUT grading (3D LUT `.cube`). Most have cheap CSS/SVG equivalents: `feTurbulence` grain, radial-gradient vignette, `mix-blend-mode: screen` leaks, `feColorMatrix` grade/duotone, offset RGB channels for CA, repeating-linear-gradient scanlines ([MDN feTurbulence](https://developer.mozilla.org/en-US/docs/Web/SVG/Element/feTurbulence), [feColorMatrix](https://developer.mozilla.org/en-US/docs/Web/SVG/Element/feColorMatrix)). We generate LUTs procedurally (our own MIT code) rather than vendoring third-party LUT packs, most of which have unclear licences.
- **Motion blur**: Remotion `@remotion/motion-blur` (CameraMotionBlur/Trail) — covered by the Remotion licence (free for ≤3-person orgs; *not* MIT) ([remotion licence FAQ](https://www.remotion.dev/docs/license/faq)). Comfyrizz already depends on Remotion under that licence; adding more `@remotion/*` packages is a renderer-owner decision → not in this feature.
- **2.5D / parallax / camera**: layer depth z → translate = cameraMove × (1/z); depth maps from Depth Anything V2 Small (Apache-2.0 code+weights, runtime-only) for photo parallax.
- **Lottie**: `lottie-web` 5.13 (MIT, npm verified). Most LottieFiles marketplace animations are under the *Lottie Simple License*, **not** CC0/MIT → excluded unless an individual file is explicitly CC0/MIT. We prefer generating our own Lottie-free SVG animations.

## 5. Ecosystems

- **Remotion** (source-available, Remotion licence) — `@remotion/transitions`, `light-leaks`, `noise`, `motion-blur`, `shapes`, `paths`. Useful *patterns*; adopting packages is renderer-owner territory.
- **HyperFrames** (Apache-2.0, HeyGen) — owned by mojo-opencode; see `docs/research/HYPERFRAMES_2026.md`. This feature only emits data both renderers can read.
- **Motion Canvas** ([MIT](https://github.com/motion-canvas/motion-canvas), verified) — generator-based tweening, signals, good reference for camera and code animations.
- **Theatre.js** — core Apache-2.0, studio AGPL-3.0 ([theatre-js/theatre](https://github.com/theatre-js/theatre)); do not bundle studio.
- **GSAP** — see `docs/research/GSAP_LICENSING_2026.md` (already researched; not adopted here).

## 6. Open asset libraries (MIT/ISC/CC0/OFL only)

| Asset | Licence | Use | Source |
|---|---|---|---|
| Google Fonts families (see manifest) | SIL OFL 1.1 | type pairings per recipe | [github.com/google/fonts](https://github.com/google/fonts) `ofl/<family>/OFL.txt` |
| gl-transitions (per-file MIT only) | MIT | WebGL transitions (gated) | github.com/gl-transitions/gl-transitions |
| webgl-noise | MIT | shader noise | github.com/stegu/webgl-noise |
| glsl-film-grain | MIT | grain shader | github.com/mattdesl/glsl-film-grain |
| simplex-noise 4.x | MIT | CPU noise fields | npm |
| bezier-easing 2.x | MIT | easing solver (or reimplement) | npm |
| lottie-web 5.13 | MIT | Lottie playback (optional) | npm |
| Phosphor Icons | MIT | icon sets per recipe weight (thin/bold/duotone) | [phosphor-icons/core](https://github.com/phosphor-icons/core) LICENSE verified |
| Tabler Icons | MIT | technical icon set | [tabler/tabler-icons](https://github.com/tabler/tabler-icons) LICENSE verified |
| Lucide | ISC (+MIT for Feather-derived) | general icons | lucide.dev |
| Kenney Interface Sounds / UI Audio | CC0 | whooshes, clicks, pops for transitions | [opengameart.org/content/interface-sounds](https://opengameart.org/content/interface-sounds) |
| ForFilmCreation overlays | CC0 (site-wide marking) | film/VHS/dust overlays (video, large → fetch-on-demand, not vendored) | [forfilmcreation.com](https://www.forfilmcreation.com/categorias/7) |
| Poly Haven / ambientCG textures | CC0 | paper, concrete, fabric textures | polyhaven.com, ambientcg.com |
| Procedural grain/leak/LUT generators | MIT (ours) | default finishing | this repo |

**Traps (excluded):** LYGIA (Prosperity), LottieFiles Simple License, Pixabay items after 2019-01-09 and Freesound non-CC0 files, Enchanted Media overlays (no redistribution), LTX-2.x (community licence with revenue cap — see [LTX-2 LICENSE-2_x](https://github.com/Lightricks/LTX-2/blob/main/LICENSE-2_x)).

## 7. ComfyUI-side quality (runtime only, inside the Google Colab boundary)

| Tool | Licence | Lever | Note |
|---|---|---|---|
| Practical-RIFE 4.25 | MIT, weights MIT ([repo](https://github.com/hzwer/Practical-RIFE)) | 2× interpolation of AI clips → smoother motion | author recommends 4.24+ for diffusion video |
| FILM | Apache-2.0 ([repo](https://github.com/google-research/frame-interpolation)) | large-motion interpolation | runtime only |
| Depth Anything V2 Small | Apache-2.0 | depth → 2.5D parallax of stills | runtime only |
| LTX-Video (0.9.x repo) | Apache-2.0 code ([LICENSE](https://github.com/Lightricks/LTX-Video/blob/main/LICENSE)); check per-checkpoint weight licence; LTX-2.x restricted | image-to-video motion | |
| AnimateDiff + MotionDirector | Apache-2.0 | camera-motion LoRAs | check each LoRA card |
| Style LoRAs | per-model card; many are CreativeML OpenRAIL-M (use-restrictions, not MIT) | look-matched stills | manifest records licence; only *outputs* are shipped |

These are recorded as a data manifest (`scripts/motionkit/data/comfy-workflows.json`); wiring them into Google Colab jobs is mojo-opencode's code and out of scope.

## 8. Making the agent use it well

- **Style taxonomy** with axes: *era* (modernist, y2k, retro-70s, futurist), *finish* (clean, grain, print, CRT), *energy* (calm/medium/high), *geometry* (flat, isometric, organic, 3D-ish), *typography* (grotesk, serif editorial, mono, display). Recipes are points in this space; distance in it drives variety.
- **Style recipe** = palette + type pair + easing personality + entries + transition grammar (primary + accent, within the 3-type budget) + background + finishing stack + do/don't rules + reference prompt fragment for ComfyUI stills.
- **Skill cards**: one short card per recipe (≤ ~350 tokens) loaded only for the chosen look, plus one `motion-style` skill telling the agent *how* to pick, vary and critique. Keeps the free-model prompt budget small.
- **Variety**: seeded pick weighted by brief tone/goal fit, penalising recent looks (history ring of last 8), and per-scene variation (rotate entries/emphasis inside the recipe's allowed set, one hero moment).
- **Auto-QA**: package-level *look score* 0-100 (adherence, rhythm, transition entropy within budget, contrast of recipe palette against text, finish present) + existing frame-qa; agent critiques scenes < threshold (pattern from howseen-ai/claude-motion-design already cited in `prompts/motion.ts`).
