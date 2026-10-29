# Experimental Pi native Title runner

An **opt-in direct-run experiment**, separate from the production agent and UI.
It uses the existing ComfyRizz native tool implementations, package schema,
timeline compiler, credential resolver, uploaded-font admission and CPU renderer.
It does **not** demonstrate a Super Easy UI journey or UI Download.

Visual-v2 adds actual rendered headline-width acceptance and a separate decoded
MP4 hold audit. See [primary-source research and measurement
contract](PI_TITLE_MEASUREMENT_RESEARCH.md) and [evaluation protocol](PI_EVALUATION_PROTOCOL.md).

## Install and check

Requires **Node >=22.19.0**, pnpm, the renderer's installed Chromium, and the
usual renderer dependencies. Run from the repository root:

```sh
pnpm install --frozen-lockfile
pnpm --filter @comfyrizz/agent --filter @comfyrizz/llm --filter @comfyrizz/planner --filter @comfyrizz/vector --filter @comfyrizz/pi-title-runner run build
pnpm --filter @comfyrizz/pi-title-runner test
```

Published versions verified on 2026-10-29 and pinned exactly in the manifest and
workspace lockfile:

- `@earendil-works/pi-agent-core@1.4.0`
- `@earendil-works/pi-ai@1.4.0`

Official references:

- <https://github.com/earendil-works/pi/tree/main/packages/agent>
- <https://registry.npmjs.org/@earendil-works/pi-agent-core/1.4.0>
- <https://registry.npmjs.org/@earendil-works/pi-ai/1.4.0>
- <https://api-docs.deepseek.com/guides/thinking_mode>

The installed 1.4.0 API was checked, rather than assuming older package names or
the main branch alone. The runner uses stateful `Agent`, sequential tool
execution, `beforeToolCall`, `finishTurn`, subscriptions and abort support.
`finishTurn: {action: "end"}` ends each phase after one provider response and its
tool calls. The stream adapter converts the Pi system-message transcript to the
existing `@comfyrizz/llm` request. Pi provider plugins and the full coding agent
are not used. Pi AI's published transitive dependencies remain in the lockfile.

## Commands

Every new run requires a fresh output directory. The default brief is the exact
`title-simple-12` prompt in
`docs/submission/super-easy-reduced-briefs.json`, with explicit package-string
acceptance text `PLEASE HOLD`, a reveal-completion sample at 3 seconds, and
`titleWidth:{fraction:0.60,tolerance:0.025,expectedLines:2}`. The original prompt
is unchanged; the explicit visible-ink acceptance interval is 57.5–62.5%.

### Model-disabled preflight

```sh
node packages/pi-title-runner/src/cli.mjs \
  --mode preflight --out /tmp/opencode/pi-title-runner/preflight-new
```

Freezes the brief, source fingerprint, system prompt and selected schemas.
Imports/checks integration dependencies. Makes no provider requests and does
not render. It is not a live-run checkpoint: use a fresh directory for live.

### Real CPU smoke, no model

```sh
node packages/pi-title-runner/src/cli.mjs \
  --mode smoke --out /tmp/opencode/pi-title-runner/smoke-new
```

Creates an explicitly labeled deterministic fixture using the **real native
`storyboard.propose` tool**. Renders CPU PNG samples and exports an MP4 through
the existing `renderPackageAsync`. This is renderer integration evidence, not
model-quality evidence. It is not a scripted model in the CLI. Scripted
providers and fake render bytes exist only in the focused test file.

### Explicit live run

```sh
node packages/pi-title-runner/src/cli.mjs \
  --mode live --out /tmp/opencode/pi-title-runner/live-new \
  --runtime /path/to/existing/app-runtime \
  --provider custom --model deepseek-flash --thinking disabled \
  --timeout-ms 180000
```

The current verified configurations are:

| Endpoint | Model | Thinking | Effort | Output cap |
| --- | --- | --- | --- | --- |
| `https://api.deepseek.com/v1` | `deepseek-flash` | disabled | low | 8192 |
| `https://opencode.ai/inference/go/openai/v1` | `deepseek-v4.1-flash` | disabled | low | 8192 |

The existing app preset supplies the 8192 planner limit; DeepSeek's current
official guide documents `thinking: {type: "disabled"}` and `reasoning_effort:
"low"`. Unsupported endpoint/model/thinking combinations fail before network.
Provider retries are explicitly zero. There is no model discovery/probe call.

`--runtime` reads normal saved app profiles using `createProviderSettings` on a
private disposable copy; it does not change the original app's settings,
selection or permissions. Without it, normal preset environment resolution is
used (`OPENCODE_API_KEY`/`OPENCODE_GO_API_KEY`, or
`COMFYRIZZ_CUSTOM_API_KEY` plus `COMFYRIZZ_CUSTOM_BASE_URL`). Credentials are
never model input or evidence. Config evidence contains redacted key presence
and header names, not header values. Temporary credential copies are removed.

To use an already-authorized Anton (or another uploaded TTF), add:

```sh
--font-runtime /path/to/runtime-with-authorized-font \
--font-conversation chat_existingConversationID
```

`--font-runtime` defaults to `--runtime`. The existing `adoptSuppliedFont`
verifies rights assertion, TTF structure and byte hash before copying into this
run's own assets. The model receives the admitted family identifier, not a font
URL. With no configured font, the normal bundled Inter is used; condensed-font
fidelity is not claimed. Font bytes are hashed and checked on reuse.

### JSON input or an ordinary Title prompt

```sh
node packages/pi-title-runner/src/cli.mjs --mode preflight \
  --out /tmp/opencode/pi-title-runner/json-preflight --input /path/to/brief.json

node packages/pi-title-runner/src/cli.mjs --mode smoke \
  --out /tmp/opencode/pi-title-runner/prompt-smoke \
  --prompt 'Create exactly 8 seconds of one native title called HELLO. Silent, no narration or music.'
```

JSON shape:

```json
{
  "id": "my-title",
  "videoType": "title-reveal",
  "prompt": "Create exactly 8 seconds of one native title called HELLO. Silent, no narration or music.",
  "durationSeconds": 8,
  "exactText": "HELLO",
  "revealSeconds": 3,
  "titleWidth": { "fraction": 0.60, "tolerance": 0.025, "expectedLines": 1 }
}
```

`prompt` is required; duration can come from the existing intent parser or
`durationSeconds` (conflicts fail). Duration is bounded to 30 seconds, one native
title scene. The app-owned exact timeline contract is applied independently of
model-proposed preferred frames. Audio/media requests outside this silent
experiment fail rather than silently substitute content. `exactText` is
optional: absent an explicit value, exact-copy acceptance is **unverified**.
`revealSeconds` chooses the sampling boundary; it does not alter renderer motion.
The default is 3 seconds or half the duration for shorter titles. For arbitrary
smoke input without `exactText`, the deterministic fixture says `CPU SMOKE`.

### Resume, inspect or export without model calls

```sh
node packages/pi-title-runner/src/cli.mjs --mode resume --out /path/to/run
node packages/pi-title-runner/src/cli.mjs --mode inspect --out /path/to/run
node packages/pi-title-runner/src/cli.mjs --mode export --out /path/to/run
```

All three modes are model-disabled. `inspect` samples/inspects without exporting;
`resume` and `export` also create or reuse the MP4. Reuse verifies artifact hashes.
No changed plan means no extra model requests and no redundant render work.

The canonical `package.json` can be edited by an external authorized editor;
changed content/revision invalidates old findings and export, and runs admission
again. It does not grant another correction. Existing findings retain their
package ID, revision, content hash, source hash and brief hash. The compiler owns
the exact duration; on-disk edits to that authority are rejected by the run's
consistency check rather than adopted as a new brief.

Source changes or a different frozen brief require a new run directory. This
prevents old evidence from certifying a different renderer/tool revision. The
source manifest includes source and built implementation hashes plus the
dependency lock. An interrupted request with no committed draft is not retried
on resume. An interrupted correction has already consumed its single budget;
resume can inspect/export the last committed revision without replanning.

## Bounds and tools

Phases: freeze → draft → CPU samples → deterministic inspection → **at most one
targeted correction total** → refreshed samples → export. Both request budgets
are reserved durably before network. Every phase records elapsed time, and
every committed mutation gets a revision snapshot. There is one initial model
request and at most one correction request, not one request per tool.

The native subset is `storyboard.propose`, `storyboard.edit`, `storyboard.theme`,
plus runner adapters `title.inspect` and `title.preview`. It includes actual
copy, `headline_size`, palette/text and admitted-font controls. Scene/motion
schemas reuse the existing native tool definitions and package-schema fields.
The adapters call existing package inspection/CPU rendering; they are not
production UI tools. No shell, custom code, arbitrary asset paths/URLs, drawing,
SVG generation, paid images, video or GPU tools are exposed.

All tool execution is sequential; each phase permits at most eight executable
tool calls. The correction only exposes edit/inspect/preview. Only fields
implicated by deterministic failed findings can be edited, and a text correction
can only change `copy.headline`, retaining unrelated copy. Unsupported tool
calls are recorded as errors, never manufactured successes.

A supported rendered-width failure additionally permits `headline_size` (24–512).
Its measured size estimate is passed to the correction, then re-rendered once.
Other fields cannot be modified solely because a width finding failed.

The whole run has a 180-second default deadline (configurable from 100 ms to
600 seconds), propagated through Pi and the cancellable CPU renderer. Signals
cancel the renderer process group; staged renderer directories are cleaned by
the existing render library. A private `runner.lock` excludes concurrent writers.
On an uncatchable process kill, first verify its recorded PID is gone, then
remove that run's stale lock manually. The model budgets remain reserved.

The CLI uses short `TMPDIR=/tmp/opencode/pitmp` for Chromium socket paths. It
does not touch other live/frozen app runtimes or browser traffic. Observers write
only local bounded records: 4 MiB per JSON document, 256 KB per event, 8 MiB
event log. There is no browser-response-body observer.

`PI_TITLE_TMPDIR` may select another short path under `/tmp/opencode`, including
a symlink to disk-backed storage when tmpfs is full. Actual rendering and ffmpeg
work acquire `/tmp/opencode/deepseek-thinking-matrix/locks/cpu-render.lock` with
kernel `flock`; render-worker records separate queue and active render times.

## What the findings establish

- Valid native package and one Title scene, supported size range and admitted
  font identity; these are schema checks, **not measured text bounds**.
- Exact compiled duration and absence of audio sources; not a listening review.
- Exact headline string when provided, with whitespace normalization; not OCR.
- Real CPU PNGs at opening, requested reveal completion, final-three-second
  hold start, and last frame, deduplicating coincident sample times. Previews are
  half-resolution for cost. Equality is exact PNG byte equality at those sampled
  times only; it does not certify intervening or full-resolution frames.
- For supported plain, headline-only Titles with an explicit `titleWidth` target:
  paired black/white diagnostic text-color renders isolate the headline mask,
  validate it against the original composed frame, and measure bbox/width,
  visibility, clipping guard and row bands. Ambiguous/unsupported cases remain
  unverified. See the research appendix for scope, thresholds and calibration.
- After export, `export-audit.json` independently probes the actual MP4 and checks
  every decoded hold frame at half resolution with explicit codec tolerance.
  The preview finding remains labeled sampled; export audit does not retroactively
  turn four samples into an all-frame proof.
- Thin blue rule is an explicit capability gap; precise word-by-word reveal and
  perceptual quality remain **unverified**. A palette token is not a visible rule.

An MP4 can be exported with unresolved findings so it can be reviewed. `complete`
means the bounded pipeline finished; acceptance stays `human-review-required`,
with failed/unverified findings and tool errors explicit. There is no automatic
claim that the brief was fully satisfied and no visual-review model dependency.

## Evidence

Run directories contain the frozen brief/source/config/checkpoint, actual system
and user prompts, effective provider request and tool schemas, tool/usage events,
phase times, revision snapshots, pre/post correction packages, findings, preview
PNGs, renderer props, and MP4 hash/provenance. Token usage is from the existing
provider; Pi's zero price placeholders are not a billing estimate.

`*-effective-request.json` is the adapter's effective model context before the
existing ComfyRizz provider escapes dotted tool names for OpenAI-compatible wire
format (for example `storyboard.propose` → `storyboard_propose`). It is not an
HTTP capture and intentionally excludes authentication headers.

Live-v2 also retains `wire-request-N.json`, containing the actual HTTP JSON body
after existing-provider name escaping and before fetch, with no authentication
headers. Pre-network checks require a nonempty proper loadout, correct model,
thinking disabled and 8192 cap; an independent guard caps actual fetches at two.

Local implementation verification evidence is under
`/tmp/opencode/pi-title-runner/`. The focused tests verify one correction across
resume, stale findings, restricted tools, model-disabled preflight, resumable
render failures, provider timeout reservation, and real child-process cleanup.

### Historical v1 local results (2026-10-29; preserved)

- Relevant TypeScript library builds (`agent`, `llm`, `planner`, `vector`) and
  runner syntax build passed.
- Focused suite: **9 passed**, with the opt-in real CPU integration test skipped
  in the default suite. Includes a Pi 1.4 transcript → existing provider → HTTP
  wire-format regression test checking nonempty tool schemas, alias names,
  thinking disabled, low effort and 8192 output limit.
- Optional real CPU integration: **1 passed**, using a clearly labeled
  **test-only scripted provider**, real Pi/native tools, one targeted correction,
  real PNGs/MP4, and resume with zero further provider responses. Evidence:
  `/tmp/opencode/pi-title-runner/current-offline-pi-cpu/`.
- Model-disabled authorized-Anton smoke: **1920×1080, 360 frames, 12.000 seconds**,
  PNG samples at frames 0/90/270/359, exact sampled hold equality after frame 90,
  zero model calls. Evidence:
  `/tmp/opencode/pi-title-runner/current-anton-smoke/`. The smoke fixture does not
  establish fulfillment of the typography brief.
- Current model-disabled schema preflight:
  `/tmp/opencode/pi-title-runner/current-preflight/`.

To reproduce the optional integration test (fresh directory required):

```sh
PI_TITLE_CPU_EVIDENCE=/tmp/opencode/pi-title-runner/my-offline-pi-cpu \
  node --test packages/pi-title-runner/test/cpu.integration.test.mjs
```

**Live limitation:** exactly one authorized direct DeepSeek request was made
(`deepseek-flash`, thinking disabled, low effort, 8192 maximum; 583 input and
388 output tokens). It exposed an initial adapter bug: Pi 1.4 represents tool
availability as `toolsAdded`/`toolsRemoved` transcript deltas, and reading a
nonexistent `systemMessage.tools` produced an empty provider tool list. The model
returned textual pseudo-tool markup; it was **not executed**, no draft/export
was produced, and no correction or retry was spent. The failure is preserved in
`/tmp/opencode/pi-title-runner/live-deepseek/`.

The adapter was fixed using the installed API's `getCurrentTools()` replay helper
and an empty-loadout guard. At the end of v1, the HTTP regression and real CPU
scripted integration passed, but no second paid trial had been authorized. The
original app provider-settings hash was checked unchanged; a local scan found
no live credential values in evidence. Earlier run directories are intermediate
snapshots; the three `current-*` directories above describe the historical v1 source.

### Visual-v2 live verification (2026-10-29)

**Real live integration and one measured corrective edit succeeded; full brief
does not pass.** The newly authorized fresh trial is preserved separately at
`/tmp/opencode/pi-title-runner/live-visual-v2/REPORT.md`.

- Original `title-simple-12` prompt unchanged, same authorized Anton,12s16:9 silent.
- Exactly **two** direct DeepSeek `deepseek-flash` requests, thinking disabled,
  low effort,8192 maximum, no retries. Both HTTP200; two tools, zero errors.
- Model initial size **200px → measured26.6667% width**. The one correction changed
  **only size to450px → measured60.7292%**, inside the frozen57.5–62.5% interval.
  No evaluator edited the live package. Copy/timing/theme/font/motion were preserved.
- MP4:1920×1080,30fps,360frames,12.000000s,no audio stream. Four preview samples
  passed sampled hold. A separate all-frame decoded audit passed270 hold frames
  and90 final-three-second frames with the declared half-resolution codec tolerance.
- **Separate final-MP4/lossless-preview agreement failed narrowly**: mean channel
  delta2.023132 exceeded its predeclared2.0 limit; the pixel-outlier fraction passed.
  The failure was retained without loosening the threshold. Therefore the measured
  width claim refers to the lossless native render, not exact lossy-MP4 glyph bounds.
- Thin blue rule remains a tool capability gap. Sequential-word reveal is not
  supplied: the model disclosed whole-title masked entry. Human/perceptual review
  remains required. `acceptance.failed` summarizes preview findings; export gates
  are separately reported under `export.audit` and must also be reviewed.
-13 focused tests passed;2 optional CPU integrations were skipped in the default
  suite. The real-render visual test passed separately, using a clearly labeled
  test-only scripted HTTP provider:150px20%→450px60.83%, independent440px59.48%,
  wrong-rendered-font rejected. These tests are not live-model evidence.
- Live usage: **13,595 input +554 output =14,149 tokens**. Resume reused the same
  artifact with zero additional provider calls; correction count remained1.

Real visual preflight command (fresh output directory, authorized font required):

```sh
TMPDIR=/tmp/opencode/piv2tmp \
PI_TITLE_VISUAL_EVIDENCE=/tmp/opencode/pi-title-runner/my-visual-test \
PI_TITLE_FONT_RUNTIME=/path/to/authorized/font-runtime \
PI_TITLE_FONT_CONVERSATION=chat_existingConversationID \
  node --test packages/pi-title-runner/test/visual.integration.test.mjs
```

Preflight/test evidence: `/tmp/opencode/pi-title-runner/visual-v2-preflight/`.
Current source/build manifest hash:
`41133191d6575ec83d22ff31cbc70b9dc62ad087916ccc28142b875c01a596e0`.
The implementation is isolated to the experimental package; it does not establish
a Pi-vs-production quality advantage. See the research appendix and evaluation
protocol for applied recommendations and limits on inference.
