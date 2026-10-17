# `@comfyrizz/agent` — tools + asset router (C3)

The agent layer is provider-agnostic and transport-free: it consumes the structural
`ChatModel` contract from `@comfyrizz/llm` and requires no LLM SDK at runtime.

## Asset-type router

`routeAsset({sceneId, intent, kind?, animated?, transparent?, source?})` returns a tool:

- `assets.generate_svg` — icons, diagrams, charts, patterns, logos, badges, vectors and
  animated vector parts. This is the default for procedural, text-light art.
- `assets.generate_image` — illustrations, photos, textures, backgrounds, plates,
  transparent cutouts and other raster art (FLUX plan with an expanded caption).
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

## Evidence

```bash
npm test                         # 8 tests: router, zod, repair loop, step cap, A5 bridge
node scripts/m4-live.mjs         # live OpenCode Go: propose → edit → 2 routes → SVG through A5
node scripts/m4-two-providers.mjs # same loop against a local OpenAI-compatible endpoint
```

Live M4 run (2026-10-17, `deepseek-v4.1-flash`): package `Orbit launch`, headline
`Meet Orbit`, routes `assets.generate_svg` + `assets.generate_image`, SVG 265 B through
A5 with 0 repairs. A local custom endpoint also routed both asset types. OpenRouter was
not exercised live because no key was present; it is the same adapter.
