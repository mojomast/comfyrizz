# @comfyrizz/schema — `comfyrizz.package/v1`

Owner: **Hermes** (WS-B). Read-only for everyone else; changes go through the board.
This package is the contract between the renderer (Pi), the pipeline (`pipeline-py`) and
the agent: one JSON Schema, one set of semantic rules, two language bindings that are
tested against each other.

## Files

| Path | What it is |
|---|---|
| `package-v1.schema.json` | JSON Schema 2020-12. Single source of truth. |
| `types.ts` | **Generated** TS types (`PackageV1`, `Asset`, `Scene`, `Gen`, …). Do not edit. |
| `scripts/gen-types.mjs` | The generator; `--check` fails if `types.ts` is stale. |
| `src/index.mjs` | `validatePackage()`, `schemaErrors()`, `compile()`, `parse()`. |
| `src/semantic.mjs` | The semantic rules (`SEM_*`), the layout contract, `applyDefaults()`, `pathProblem()`. |
| `src/motion.mjs` | MS2: the motion vocabulary, `lintMotion()`, `applyMotionFixes()`, `autofixMotion()`. |
| `bin/comfyrizz-validate.mjs` | CLI: `node bin/comfyrizz-validate.mjs <pkg.json \| -> [--json] [--defaults]`. |
| `fixtures/valid/*.json` | Hand-written good packages (§6.3 example, minimal, generated-first, defaults). |
| `fixtures/invalid/*.json` | **Generated** from the good ones by `fixtures/build.mjs` (one declared violation each). |
| `fixtures/manifest.json` | Declared expectation per fixture (structural verdict, `SEM_*` codes, warnings). |
| `test/types-consumer.ts` | Proof the generated types are usable; typechecked by `tsc --strict`. |

## Run it

```bash
pnpm --filter @comfyrizz/schema test          # node:test over the fixture corpus + API + CLI
pnpm --filter @comfyrizz/schema gen:types     # regenerate types.ts
pnpm --filter @comfyrizz/schema check:types   # fail if types.ts is stale
node bin/comfyrizz-validate.mjs ../../examples/launch-demo/package.json
../../.venv/bin/python -m pytest ../pipeline-py            # the Python side
```

Python side (`pipeline-py/comfyrizz_pipeline/schema.py`) exposes the same API:
`validate_package(doc)`, `semantic_check(doc)`, `apply_defaults(doc)`, `path_problem(value)`,
`SEMANTIC_CODES`, `LAYOUTS`. `python -m comfyrizz_pipeline.validate <file> [--json]` is the CLI.

## Layout contract (renderer-facing)

`layout` is one of `title | hero | stat | chart | list`. `variant` is optional but closed
per layout. Copy limits are a **fail state** (never silent clipping) — the schema holds a
loose syntax bound, the semantic layer holds the readability bound.

| layout | variants | requires | copy limits (characters) |
|---|---|---|---|
| `title` | `centered`, `outro` | `copy.headline` | headline 48, sub 90 |
| `hero` | `full-bleed`, `split` | `copy.headline` | headline 64, sub 120, body 240 |
| `stat` | — (no variant) | `copy.headline`, `data.dataset` | headline 48, sub 90, body 40 |
| `chart` | `bar` | `data.dataset` | headline 64, sub 120, footnote 120 |
| `list` | `bullets`, `quote` | `bullets`: `copy.items` (2–6) · `quote`: `copy.quote` | headline 64, quote 200, attribution 80 |

Scene ids are `s…`, asset ids `a…`, dataset ids `d…` (`^s[A-Za-z0-9_-]{0,63}$` etc.).
`background` sets **exactly one** of `asset` (a plate/still) or `procedural`
(`gradient | grid | dots | grain | mesh`) — procedural backgrounds are the fallback when no
plate exists. `transitionOut` is `{ "type", "frames": 0–120, "direction"? }` (types below);
the default (missing) is `{"type":"fade","frames":15}`.

## Motion (MS2)

All motion fields are optional and a package without them is unchanged. The names are
**exactly** the renderer's MS1 token names (`apps/renderer/src/motion/`), so the renderer looks
them up directly; `test/motion.test.mjs` fails if the two drift.

| Field | Values |
|---|---|
| `motion.energy` (package) | `calm \| medium \| high` (= `ENERGY_PROFILES`; default `medium`) |
| `motion.direction` (package) | `left \| right \| up \| down`: the film's one current (default `left`; `up` = conclusion) |
| `scenes[].motion.entry` | `none \| fadeUp \| maskRise \| pop \| countUp` (MS1 primitives) `\| waterfall \| drawOn` (MS3); omitted = layout default |
| `scenes[].motion.ease` | `enter \| exit \| move \| land \| linear` (= `EASING_TOKENS`) |
| `scenes[].motion.spring` | `settle \| heavy \| snap \| pop \| elastic` (= `SPRING_PRESETS`) |
| `scenes[].motion.stagger` | `none \| word \| listItem \| dot` (= `STAGGER_SECONDS`) |
| `scenes[].motion.emphasis` / `highlight` | `none \| keyword \| hero`; `highlight` = the phrase of the copy a keyword emphasis marks |
| `scenes[].motion.energy` | per-scene override of the package energy |
| `transitionOut.type` | `none \| cut \| fade \| blur` (no direction) `\| slide \| push \| wipe` (left/right/up/down) `\| zoom \| iris` (in/out) |
| `transitionOut.direction` | omitted on a directional type = package `motion.direction` (planar) or `in` (zoom/iris) |

`lintMotion(doc, { fps?, timeline? })` is pure and advisory: `validatePackage()` returns it as
`motion` (it never changes `valid`), the CLI prints error/warning findings as `motion …` lines and
the full list in `--json`. Each finding is `{ code, severity, scene, path, message, autofix }`;
`autofix` is `null` or `{ description, ops: [{op:"set"|"delete", path, value?}] }`.
`autofixMotion(doc)` lints → fixes → re-lints (≤ 5 passes) and returns `{ document, applied, remaining }`.
Pass the compiled `timeline` when you have it; otherwise scene length is `preferredFrames`.
The Python mirror is `comfyrizz_pipeline.motion_lint` (`lint_motion`, `autofix_motion`), compared case by case.

| Code | Severity | Rule (autofix) |
|---|---|---|
| `MOTION_CUT_HAS_FRAMES` | error | a cut has frames 0 (→ 0) |
| `MOTION_DIRECTION_AXIS` | error | zoom/iris go in/out, slide/push/wipe go left/right/up/down (→ current or `in`) |
| `MOTION_HIGHLIGHT_MISSING` / `_NOT_IN_COPY` | error | keyword emphasis needs a highlight that is in the copy (→ drop it) |
| `MOTION_DIRECTION_UNUSED` | warning | direction on none/cut/fade/blur (→ delete) |
| `MOTION_TRANSITION_DURATION` | warning | frames inside the type's band: fade 0.3–0.8 s, blur 0.4–0.8, slide/push/wipe 0.25–0.6, zoom 0.15–0.4, iris 0.25–0.45 (→ clamp) |
| `MOTION_TRANSITION_BUDGET` | warning | ≤ 3 transition types per film, none/cut excluded (→ primary type) |
| `MOTION_DIRECTION_PINGPONG` | warning | consecutive transitions never reverse direction (→ previous direction) |
| `MOTION_HERO_MULTIPLE` | warning | one `hero` per film; the last is kept (→ others `none`) |
| `MOTION_ELASTIC_REPEAT` | warning | `elastic` spring once per film (→ `pop`) |
| `MOTION_LINEAR_ENTRY` | warning | no linear entrances (→ `enter`) |
| `MOTION_ENTRY_MISMATCH` | warning | countUp needs `data.dataset`, drawOn needs an svg/vector-anim asset (→ layout default) |
| `MOTION_READING_HOLD` / `MOTION_FINAL_HOLD` | warning | after settling, copy holds ≥ 1 s + 0.25 s per word beyond 3; the last scene ≥ 2 s (→ longer `preferredFrames`) |
| `MOTION_AGAINST_CURRENT`, `MOTION_HERO_EARLY`, `MOTION_NO_HERO`, `MOTION_ENERGY_MISMATCH` | info | advisory, no autofix |

## Generated-first fields (PLAN.md, Kyle's direction)

- Asset `kind`: `image | video | audio | svg | vector-anim`. `svg` and `vector-anim` are the
  procedural-vector kinds; `vector-anim` is a keyframed part driven by the Remotion frame,
  not by SMIL clocks.
- `gen.generator`: `llm-svg | flux3-klein | ltx25 | kokoro | qwen3-tts`.
- `gen.sanitizer_version` + `gen.render_check` are **required** for `llm-svg` assets, and a
  `ready` `llm-svg` asset must have `render_check.ok === true` (A5's sanitize → render-check
  → auto-fix loop gate).
- Generated output defaults: `license.id: "CC0-1.0"` and `redistributable: true`
  (`applyDefaults()` fills them when the fields are absent; the schema declares the other
  defaults — `cutout`, `locked`, `transitionOut`, `background.fit/loop/muted`, `anim`,
  `dataset.approved`).
- `model_license` (weights) is a **separate** object from `license` + `redistributable` (the
  output's rights). A `ready` asset made by `flux3-klein | ltx25 | kokoro | qwen3-tts` must record
  `model_license.id`.
- Image jobs may set `cutout: true` (alpha PNG). The asset-level `cutout` flag means the
  stored file already has alpha, so the renderer composites instead of filling.
- `gen.inputs` is free-form, but keys named `image | mask | reference | audio` are treated as
  asset references and must resolve.

## Semantic codes

`SEM_DUPLICATE_SCENE_ID`, `SEM_ID_PATTERN`, `SEM_REF_UNRESOLVED`, `SEM_PATH_NOT_RELATIVE`,
`SEM_NUMBER_NOT_FINITE`, `SEM_LAYOUT_VARIANT`, `SEM_LAYOUT_REQUIRES_DATA`, `SEM_COPY_REQUIRED`,
`SEM_COPY_TOO_LONG`, `SEM_LICENSE_MISSING`, `SEM_LICENSE_CONFLICT`, `SEM_MODEL_LICENSE_MISSING`,
`SEM_SVG_PROVENANCE`, `SEM_RENDER_CHECK_FAILED`, `SEM_GEN_MISSING_GENERATOR`,
`SEM_READY_WITHOUT_FILE`, `SEM_DURATION_TARGET_REQUIRED`, `SEM_FLEXIBLE_OVER_CEILING`,
`SEM_NARRATION_EMPTY`, `SEM_VOICE_INCOMPLETE`, `SEM_DATASET_UNAPPROVED`,
`SEM_BACKGROUND_AMBIGUOUS`, `SEM_CUTOUT_KIND` — plus the advisory
`WARN_ASSET_UNUSED` / `WARN_DATASET_UNUSED`.

Paths (`asset.file`, `gen.workflow`, `renders[].file`, `theme.fonts[].file`) must be
repository-relative POSIX paths: no absolute paths, no `..`, no `\`, no drive letters, no `~`,
no leading `./`, no URLs.

## Deliberate strictness (ask on the board before fighting these)

1. `unevaluatedProperties: false` everywhere — an unknown key is an error, because a typo in
   `foreground` silently changes a video.
2. `sha256` is lowercase hex only, 64 characters; hashes are compared byte-for-byte with the
   manifest.
3. `format: "uri"` is enforced on `license.url`, `source.landing_url`, `model_license.url` and
   `datasets[].source_url`: placeholders such as `https://…` from SPEC §6.3 must be filled in
   before a document validates. The document's own `$schema` string is intentionally **not**
   URI-checked so the scaffolded placeholder is not a hard failure.
4. `schemaVersion` is the literal `1`; the layout/variant/kind/generator enums are closed.
5. Numbers: non-finite values are reported (`SEM_NUMBER_NOT_FINITE`) and magnitudes above
   `1e15` are rejected (they are not representable in a hashed document).

## Adding a rule

1. Add the mutation to `fixtures/build.mjs` with the codes you expect, run
   `node fixtures/build.mjs`, commit the regenerated fixtures + manifest.
2. Implement it in **both** `src/semantic.mjs` and `pipeline-py/comfyrizz_pipeline/schema.py`
   — the conformance tests (one on each side) compare the two implementations over the whole
   corpus, code and path.

Cross-language comparison is practical because it is scoped: the two libraries word
*structural* findings differently (ajv reports an aggregate keyword plus the inner failure,
`jsonschema` one of them), so cross-language tests compare the structural **verdict** plus the
structural codes each fixture **declares**, while the semantic layer is compared exactly.
