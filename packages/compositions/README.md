# @comfyrizz/compositions

Dependency-free Node 20+ compiler for original, curated **native JavaScript frame
sources**. No GSAP, font downloads, network resources, user scripts, or arbitrary
HTML inputs. The output is an opaque, silent, standalone HTML scene; the final
renderer owns captions, narration, audio and scene transitions.

## Source manifest

For a standalone project directory, save `compositions/manifest.json` beside its
`package.json`. **Shared server package directories require scoped sources** at
`compositions/<pkg.id>/manifest.json`, because multiple `<pkg.id>.json` packages
share the same directory. The package ID must match `/^[A-Za-z0-9_-]+$/` before
it can be used in a path. A scoped manifest takes precedence when present; the
generic manifest remains a fallback intended only for standalone project scope.
Scoped manifests belonging to other IDs are never adopted. For example:

```json
{
  "version": 1,
  "scenes": [{
    "sceneId": "s_receipt",
    "component": "object-transfer",
    "params": {
      "title": "Give the receipt a home",
      "objectLabel": "Receipt",
      "fromLabel": "Unassigned",
      "toLabel": "Project Atlas",
      "resultLabel": "Receipt assigned",
      "qualifier": "Illustrative workflow"
    },
    "cues": {
      "action": { "phrase": "assign the receipt" },
      "result": { "frame": 90 }
    }
  }]
}
```

Every `sceneId` must identify exactly one real package scene and may appear only
once in the manifest. Unknown properties are errors at every manifest level.
The manifest is the complete editable source; it cannot reference HTML, scripts,
files, URLs, fonts or runtime dependencies. Text is escaped rather than interpreted.
At most 256 entries and 128 KiB of manifest source are accepted.

### Components and parameters

All components require a human `title` (100 characters maximum) and `resultLabel`
(120 maximum); optional `qualifier` (180 maximum) remains visible throughout.
Labels are supplied editorial content, never auto-generated product claims.

| Component | Additional required parameters | Observable action/result |
| --- | --- | --- |
| `object-transfer` | `objectLabel`, `fromLabel`, `toLabel` (60 characters each) | A labeled object physically moves into the destination; destination highlights and the result appears. |
| `mechanism-journey` | `signalLabel` (40); `stations`: 2–4 `{label, detail}` objects (50/100 characters) | A signal follows a visible causal path, activating named stations in sequence; the final consequence appears. |
| `evidence-reveal` | `dataset`: package dataset ID; `rows`: 2–6 unique **exact row labels** (60 each) | A zero-based horizontal comparison grows to exact signed values; values and the finding appear at the result cue. |

Evidence uses `pkg.datasets[id].values` with `{label,value}` rows, `unit`, declared
`source`, optional `label`, `note`, `source_url` and `retrieved_at`. Selected rows
must match exactly one finite number (absolute value ≤ 10^15). Negative and zero
values are supported without treating them as positive. Example datasets require
`approved: true`. The dataset label, source, note and supplied qualifier remain
visible; URLs are provenance metadata used in the source hash, never fetched.
An author must supply a truthful `resultLabel`; the compiler does not infer or
fact-check prose claims. There is no arbitrary numeric input array in the manifest.

### Cue contract

Optional `cues.action` and `cues.result` each accept `{frame: integer}` or
`{phrase: "spoken phrase"}`. `frame` is **scene-local**, inclusive 0 to N−1; when
both are supplied it takes precedence over the phrase. Result must follow action
by at least one frame. Defaults are deliberate: action at floor((N−1)×0.22),
result at floor((N−1)×0.64), then an unchanged inspection hold to N−1.

Phrase resolution first uses matching `timelineScene.motionCues` and subtracts
`timelineScene.from` from its absolute frame. Otherwise it matches the scene's
`timeline.captions` using the planner's Unicode, case/punctuation-insensitive token
rules: original word timings first, caption-start anchors otherwise. Caption text
may contain editor display-only corrections, so caption-start fallback is allowed
only when the complete ordered scene transcript agrees token-for-token with
`scene.narration` (or `timelineScene.narration` when absent on the source scene).
The transcript uses untouched `words[].text` wherever words exist. Unverifiable
caption-only matches fail explicitly; a phrase's mere presence elsewhere in the
narration is insufficient to establish its caption timing. Planner `motionCues`
and original word timings remain usable even when display wording is corrected.
This allows manifest
phrases without changing canonical `scene.motion.cue_phrases`. The first occurrence
wins and the match count is reported. Matching stays within one caption, just like
the planner. Missing requested phrases and out-of-scene anchors **throw** rather
than inventing narration sync. `word-cues`, `measured-caption`, `estimated-caption`,
`estimated`, `timing` and occurrence provenance are preserved. A measured
caption-start anchor is sentence-level timing and does not inherit estimated-word
status or claim word-alignment provenance from an unused word-timing method.
A word cue is not
described as forced alignment unless its actual timing provenance says so.

The action starts movement; the result frame is the exact completed geometry and
reveal. The result is invisible before that frame and remains visible through the
last frame. Native integer-frame evaluation is stateless, supporting repeated,
random and reverse seeks. There are no animations running on a wall clock.

## Public API

```js
import {
  loadCompositionManifest,
  validateCompositionManifest,
  compileComposition,
  collectCompositionExtras,
} from '@comfyrizz/compositions';

const manifest = loadCompositionManifest(packageDir, pkg); // synchronous
if (manifest) {
  const entry = manifest.scenes[0];
  const output = compileComposition({
    entry, pkg,
    scene: pkg.scenes.find(scene => scene.id === entry.sceneId),
    timelineScene: timeline.scenes.find(scene => scene.id === entry.sceneId),
    timeline,
  });
  // {html, motionSpec, sourceHash, frames, width, height, fps, diagnostics}
}
```

- `loadCompositionManifest(packageDir, pkg)` returns `null` only when the manifest
  is absent. Malformed, oversized, invalid or symlinked source throws.
- `validateCompositionManifest(manifest, pkg)` throws on invalid input and returns
  the unchanged manifest otherwise. It performs no I/O and mutates no inputs.
- `compileComposition(...)` is synchronous and performs no I/O. It revalidates the
  entry, checks all three scene identities, and takes `N` only from
  `timelineScene.durationInFrames` and dimensions/fps only from `timeline`.
  N must be an integer ≥3; dimensions 240–8192; fps an integer 1–240. Root
  `data-duration` is exactly N/fps. Timelines with noninteger fps are rejected.
- `collectCompositionExtras(pkg, packageDir)` returns `[]` when absent, otherwise
  `[{path: 'compositions/<pkg.id>/manifest.json', data: Buffer}]` for scoped sources
  or `[{path: 'compositions/manifest.json', data: Buffer}]` for standalone sources.
  The actual relative path is preserved for export/import and source staging.
  It validates first and checks real paths, symlinks (including intermediate
  `compositions` and package-ID directories), regular-file status and byte limits. Unlisted files
  are never included. No additional source metadata files are required: these
  components are versioned compiler code, and the manifest is their entire source.

The output includes an inline original render function registered with
`window.__hyperframes.registerFrameSource`, a `data-no-timeline` root and no external
runtime. In a plain browser it renders frame zero and exposes
`window.__comfyrizzComposition.render(seconds)` for inspection. The worker must
inject HyperFrames before the inline scene script, as its CLI normally does.

Landscape transfers move horizontally; portrait and square transfer vertically.
Mechanisms use a horizontal path, a vertical portrait path, or a square 2×2 grid.
Charts reallocate label and bar widths for portrait. Text has bounded fitting and
uses a local-only `ComfyrizzSystem` font-face alias for Arial, Liberation Sans or
DejaVu Sans, with generic sans-serif fallback. This also prevents HyperFrames from
rewriting ordinary system-family names to downloadable Inter. No scene font assets
are needed. The bottom
20% of the canvas is reserved for final captions; scene text ends by 77%.
The safe default dark palette is complemented by valid six-digit hex
`pkg.theme.text`, `text_muted`, and `palette[1]` (accent); arbitrary CSS is ignored.

`motionSpec` uses supported HyperFrames v1 `appearsBy`, `before`, and
`staysInFrame` assertions. The appears-by deadline rounds up to the next upstream
20 Hz / maximum-300-sample grid point, with 1 ms rounding tolerance; actual native
visibility and semantic diagnostics retain the exact integer result frame.
Diagnostics also record resolved cue provenance,
`COMPOSITION_NOT_BEFORE`, `COMPOSITION_INTENTIONAL_HOLD`, and aspect/caption bounds.
Not-before and hold-until are semantic diagnostics rather than unsupported
HyperFrames assertion kinds. Runtime layout/contrast checks and exact decoded-frame
verification remain the worker's responsibility.

`sourceHash` is SHA-256 over canonical source params, implementation version,
generated HTML (including the complete runtime), exact timing/cue provenance,
referenced dataset data/provenance, effective theme, dimensions and motion spec.
Object key ordering and unrelated package edits do not invalidate it. Worker
browser/engine/encoding versions should be added to the worker's derived cache key.

## Verification

```bash
node --test packages/compositions/test/*.test.mjs
```

Tests execute the emitted script with a native-DOM test double, check random and
reverse seeks, exact action/result and inspection holds, cue provenance, signed
data, source hashes, escaping, deliberate aspect reflow and filesystem boundaries.
