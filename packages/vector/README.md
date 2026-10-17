# `@comfyrizz/vector` — procedural SVG assets

Spec A5 / PLAN "Generated-first assets": generated SVG is the default for icons,
diagrams, simple charts, pattern backgrounds and animated vector parts.

Pipeline: **generate → sanitize → render-check on CPU → auto-fix (max 2 repairs)**.
The production generator is the agent LLM (`gen.generator: "llm-svg"`); tests use
a deterministic stub. Generated output is `origin: "generated"`, `license: CC0-1.0`,
`redistributable: true`.

```bash
npm install
npm test        # tsc + node:test (12 tests)
```

## API

- `sanitizeSvg(src) -> { ok, svg, removed, warnings, errors }`
  Allow-list of elements/attributes. Drops `<script>`, `<foreignObject>`, `<style>`,
  event handlers (`on*`), external `href`/`src`, external `url(...)`, `@import`,
  `data:` images, unknown elements. Enforces `viewBox`, node-count, path-length and
  dimension limits, and requires the SVG namespace.
- `renderCheck(svg, { width, palette, ... }) -> { ok, width, height, opaqueFraction, errors }`
  Rasterises with `@resvg/resvg-js` on CPU. Fails with structured `parse-error`,
  `blank-output`, `near-invisible` or `out-of-palette` errors.
- `autoFix(generate, intent, maxRepairs = 2, renderOptions?) -> { ok, svg, attempts, history, errors }`
  Feeds sanitizer/render errors back to `generate` for at most two repairs.
- `createStubGenerator({ brokenFirstAttempt })` — deterministic test/example generator.

## Animation

Animated vector parts are **frame-driven by Remotion**, not SMIL wall-clock clocks.
The sanitizer permits `<animate>`/`<animateTransform>` markup for static output, but
the `VectorAsset` renderer derives motion from `useCurrentFrame()` and ignores SMIL
timing so a still/export is deterministic. `VectorAsset` lives in
`apps/renderer/src/VectorAsset.tsx` (it needs React + Remotion; this package stays
framework-free for tests and the agent tool layer).

## Sanitizer version

`SANITIZER_VERSION = "1.0.0"` is recorded on every generated asset
(`gen.sanitizer_version`) and render-check result (`gen.render_check`).
