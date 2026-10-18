# `@comfyrizz/agent` — tools + asset router (C3)

The agent layer is provider-agnostic and transport-free: it consumes the structural
`ChatModel` contract from `@comfyrizz/llm` and requires no LLM SDK at runtime.

## Asset-type router

`routeAsset({sceneId, intent, kind?, animated?, transparent?, source?})` returns a tool:

- `assets.generate_svg` — icons, diagrams, charts, patterns, logos, badges, vectors and
  animated vector parts. This is the default for procedural, text-light art.
- `assets.generate_image` — illustrations, photos, textures, backgrounds, plates,
  transparent cutouts and other raster art (FLUX plan with an expanded caption).
- `assets.sketch_to_render` — a hero/background/diagram that asks for a style (`clay`,
  `glass`, `editorial`, ...). It emits an SVG base through the same A5 pipeline and then
  plans a Klein reference edit whose image0 is that SVG, so the style pass keeps the source
  layout and labels (docs/GPU_TEST_2.md). Icons never take this path: they stay SVG-only.
- `assets.search` / `assets.upload` — only when the need explicitly asks for stock or
  an upload; they are fallbacks, not automatic choices.

`routeBrief()` splits a mixed brief on `and`/punctuation, so "an icon of a rocket and an
illustration of a nebula" becomes one SVG route and one FLUX route.

## Tools (zod-validated)

| Tool | Behaviour |
| --- | --- |
| `storyboard.propose` | Package draft; missing numbers stay labelled placeholders |
| `storyboard.edit` | Patch one scene by id; copy patches merge |
| `assets.route` | Router decision |
| `assets.generate_svg` | Calls the injected A5 generator; result records `origin: generated`, `generator: llm-svg`, CC0, sha256/bytes, attempts/repairs |
| `assets.generate_image` | Plans a FLUX still + expanded caption; never submits a GPU job (`requires_approval: spend`) |
| `assets.sketch_to_render` | SVG base through A5 **plus** a planned Klein reference edit (`refs: [svg_id]`, ref-edit workflow, GPU test 2 template); icons stay SVG-only |
| `assets.search` / `assets.attach` | Fallback metadata; attach requires approval |

`createToolset({generateSvg, planImage, initialPackage})` injects the real generator.
Wire A5's loop as:

```js
import { autoFix, stubGenerator } from '@comfyrizz/vector';
const tools = createToolset({
  generateSvg: async intent => {
    const result = await autoFix(stubGenerator, intent, 2, { width: 512 });
    if (!result.ok) throw new Error(result.errors.map(e => `${e.code}: ${e.message}`).join('; '));
    return { svg: result.svg, attempts: result.attempts, repairs: result.repairs, sanitizerVersion: result.sanitizerVersion };
  },
});
```

`runAgent({model, brief, tools, maxSteps = 8, maxRepairs = 2})` runs a bounded tool loop:
each call is validated before execution, invalid arguments go back to the model (default
max 2 repairs), unknown tools and tool failures become tool results, and the loop stops on
`max_steps`. Partial streamed arguments never reach a tool.

## Brand kit (B1)

`normalizeBrandKit(input)` (
`src/brand.ts`) turns a loose owner kit — palette hexes, fonts with a licence, tone words,
logo — into a `BrandKit` and a list of warnings, and never throws: bad hexes, a font with no
file or an unsafe licence, duplicates and an invalid logo id are dropped. A font survives only
with a file **and** one of `OFL-1.1`, `Apache-2.0`, `MIT`, `CC0-1.0`, `UFL-1.0`,
`BSD-3-Clause`, `ISC`, `MPL-2.0`; anything else falls back to `Inter` (always bundled).

- `brandTheme(kit)` → the package `theme` fragment (`palette`, `font`, `fonts[]`, `logo_asset`).
- `brandBriefStyle(style, kit)` → the brief's style (brand palette/font win over the preset).
- `brandStyleBlock(preset, kit)` → the one deterministic per-package generation STYLE_BLOCK
  reused for every image job.
- `createToolset({brand, brandAssets, stylePreset})` / `runCpuSlice({brand, brandAssets})` thread
  the kit through `storyboard.propose` (theme + uploaded logo assets) and into every
  `assets.generate_image` caption, so a run does not drift from the owner's palette from the
  first tool call.

See `examples/brand-kit/` for a kit, a logo and a package whose theme is the normalised result.

## Language variants (L1)

`src/language.ts` builds a translated variant of a package. `translatableStrings(pkg)` lists every
scene copy string, list item and `narration`; `translationPrompt(strings, language)` is the JSON-in/
JSON-out instruction for the agent LLM (names, URLs and numbers stay exact); `translateStrings` and
`applyLanguageVariant(pkg, {language, translations})` produce a new `...-fr` package with translated
copy + narration and `voice.language` set (Kokoro reads it), leaving the source package untouched.
The translator is injected, so tests and offline examples use `dictionaryTranslator`.

## Data-driven charts (D1)

`src/dataset.ts` turns CSV text into a validated `package-v1` dataset:
`parseCsv` (quotes, `\r\n`, a BOM, `,`/`;`/tab), `parseCsvNumber` (thousands
separators, currency, `(42)` negatives, `%`) and `datasetFromCsv`, which warns
on bad rows/duplicates and clamps to 64 values. `src/chart-scenes.ts`
`proposeChartScenes` builds a bar, a big-number and a comparison scene whose
labels and values are the dataset's own — no invented numbers. See
`examples/csv-charts/`.

## Motion parameters (MS5)

`src/prompts/motion.ts` is the motion section of the agent system prompt. The token
lists are read from `package-v1.schema.json`, so the model can only pick MS2
vocabulary (`motion`, `transitionOut`). It does not write animation code.
`motionFixInstructions()` turns `lintMotion()` errors and warnings into
`storyboard.edit` calls, and `storyboard.propose` / `storyboard.edit` return them
as `motion_fixes` for the next turn.

Style presets map to a default `motion.energy`: clay and glass are `calm`,
editorial-flat, isometric-tech and paper-cut are `medium`, cinematic-dark is `high`.

`runMotionCritique()` is a separate judge call over an MS4 contact sheet. It scores
each scene /10 on readability, rhythm, continuity and brand, fixes only scenes at
7 or below, leaves 9 or above alone, and stops after 2 rounds. It stays off unless
the provider sets `imageInput: true` (DeepSeek v4.1 and the scripted model do not).

## Evidence

```bash
npm test                         # router, zod, repair loop, step cap, A5 bridge, C7 sketch-to-render,
                                 # R2 brief/outline/presets/scene-chips, B1 brand kit, L1 language variants,
                                 # D1 CSV/chart scenes, MS5 motion prompt / lint fixes / critique rubric
node scripts/m4-live.mjs         # live OpenCode Go: propose → edit → 2 routes → SVG through A5
node scripts/m4-two-providers.mjs # same loop against a local OpenAI-compatible endpoint
```

Live M4 run (2026-10-17, `deepseek-v4.1-flash`): package `Orbit launch`, headline
`Meet Orbit`, routes `assets.generate_svg` + `assets.generate_image`, SVG 265 B through
A5 with 0 repairs. A local custom endpoint also routed both asset types. OpenRouter was
not exercised live because no key was present; it is the same adapter.
