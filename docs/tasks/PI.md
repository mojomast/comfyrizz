# Pi (`pipi`): Workstream A, first batch (due M1, Sun Oct 18 evening, Toronto)

Read first: `docs/tasks/RULES.md`, `docs/PLAN.md` (Workstream A, "Generated-first assets", A5), `docs/SPEC.md` §3, §6.3, §6.8, §6.9, §6.10.

You own: `apps/renderer/`, `packages/planner/` (timeline compiler), `packages/vector/` (procedural SVG), `examples/`, later `packages/tts/`.
You read: `packages/schema/` (Hermes lands `package-v1.schema.json` + `types.ts` + validator first; until then code against the §6.3 example).

Order: A1 skeleton → A5 sanitizer/render-check (small, unblocks example art) → A2 timeline → A1 layouts → A3 example + export. A4 (Kokoro) only after M1.

- **A1 Remotion renderer + 5 layouts** (Title, Hero, Stat, Chart, List). Deterministic frames, local pinned fonts, visible fail state for overflow. Accept: `npx remotion still` frame 0/mid/last for each layout; no network imports in compositions.
- **A2 Timeline compiler** (pure TS, tests). Accept: 6×150-frame scenes with 5×15-frame fades = **825** frames; oversize transition fails; target-mode deviation reported; provisional flag without narration; plate 24→30 fps retime records; stable hash.
- **A5 Procedural SVG assets** (`packages/vector/`): `sanitizeSvg` (allow-list; strip script, foreignObject, handlers, external refs/fonts/images), `renderCheck` with `@resvg/resvg-js` on CPU (parse error, blank output, invisible content → structured errors), `autoFix(generate, intent, maxRepairs=2)` with a stub generator, Remotion `VectorAsset` component; frame-driven animation for animated parts (no SMIL clock). Accept: malicious fixtures stripped, broken SVG fails with a usable message, stub auto-fix repairs within 2 tries.
- **A3 Bundled CPU example** `examples/launch-demo/`: ~6 scenes, all 5 layouts, 30–45 s, one dataset, **≥ 4 LLM-style SVG assets** (icon set, diagram, pattern background, one animated part) with provenance `origin: generated, generator: llm-svg`, CC0; voice off. Accept: MP4 1920×1080 30 fps H.264 on CPU, ffprobe frame count = compiled timeline, no LLM/GPU/network, validates with Hermes's validator once B1 lands; render time recorded.

Board entries: A1+A3 `t_f21519e48db54eef`, A2 `t_cee6f8f11cd8483f`, A5 `t_157a386a4ae646d9` (group "Comfyrizz build", see RULES.md). Coordinate with Hermes only through board check-ins.
