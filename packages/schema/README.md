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
plate exists. `transitionOut` is `{ "type": "none"|"fade"|"slide"|"wipe", "frames": 0–120 }`;
the default (missing) is `{"type":"fade","frames":15}`.

## Generated-first fields (PLAN.md, Kyle's direction)

- Asset `kind`: `image | video | audio | svg | vector-anim`. `svg` and `vector-anim` are the
  procedural-vector kinds; `vector-anim` is a keyframed part driven by the Remotion frame,
  not by SMIL clocks.
- `gen.generator`: `llm-svg | flux3-klein | ltx25 | kokoro`.
- `gen.sanitizer_version` + `gen.render_check` are **required** for `llm-svg` assets, and a
  `ready` `llm-svg` asset must have `render_check.ok === true` (A5's sanitize → render-check
  → auto-fix loop gate).
- Generated output defaults: `license.id: "CC0-1.0"` and `redistributable: true`
  (`applyDefaults()` fills them when the fields are absent; the schema declares the other
  defaults — `cutout`, `locked`, `transitionOut`, `background.fit/loop/muted`, `anim`,
  `dataset.approved`).
- `model_license` (weights) is a **separate** object from `license` + `redistributable` (the
  output's rights). A `ready` asset made by `flux3-klein | ltx25 | kokoro` must record
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
