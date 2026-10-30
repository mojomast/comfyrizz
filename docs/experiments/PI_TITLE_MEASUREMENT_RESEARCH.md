# Pi Title visual acceptance: research and implementation decisions

Primary sources accessed **2026-10-29**, before the authorized `live-visual-v2`
trial. These sources guide implementation; they do not establish a Pi advantage.
See also [the evaluation protocol](PI_EVALUATION_PROTOCOL.md).

| Primary source | Source guidance/API fact | Applied project-specific inference |
| --- | --- | --- |
| [Official Pi 1.4.0 agent README](https://github.com/earendil-works/pi/blob/v1.4.0/packages/agent/README.md), checked against installed `@earendil-works/pi-agent-core@1.4.0/README.md` and Pi AI `dist/utils/transcript.d.ts` | Stateful `Agent`, sequential tool execution, abort, `finishTurn`; tool declarations are added/removed transcript deltas, replayed by `getCurrentTools`. | Replay declarations, test the effective HTTP wire body, reserve durable budgets before network, and explicitly end each phase. No coding-agent or provider-plugin dependency. |
| [Anthropic: Building effective agents](https://www.anthropic.com/engineering/building-effective-agents) | Prefer simple composable workflows, explicit gates and environmental ground truth. Clear criteria suit evaluator/optimizer workflows; tool documentation matters. This older article flags its changed tooling landscape. | A native draft → real CPU measurement → one correction is sufficient. Use deterministic evaluation, not another model or an app-wide framework migration. |
| [Anthropic: Writing effective tools](https://www.anthropic.com/engineering/writing-tools-for-agents) | Small purposeful toolsets, clear descriptions/examples, meaningful results, realistic evals; record errors, time and token use. | Document actual native argument shapes and admitted font identity. Return measured raster width, target/tolerance and a bounded estimate; optimize actual acceptance before token count. |
| [Anthropic: Demystifying evals](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents) | Distinguish transcript from environmental outcome; deterministic graders when appropriate, calibrated human/model grading otherwise. Use reference solutions, negative controls and stable environments. | Grade real native PNGs and decoded MP4 separately from prose. Establish 150px failure, ~440px passing reference, wrong-rendered-font and visibility/clipping controls. One paid trial is not a reliability estimate. |
| [WHATWG Canvas/TextMetrics](https://html.spec.whatwg.org/multipage/canvas.html#textmetrics); [MDN actualBoundingBoxLeft](https://developer.mozilla.org/en-US/docs/Web/API/TextMetrics/actualBoundingBoxLeft) | Advance width differs from actual glyph bounds; font, alignment and spacing affect metrics. | Do not treat font size or Canvas advance width as proof of DOM-rendered text width. Avoid duplicating the renderer's multiline CSS layout in Canvas. |
| [Remotion `loadFont`](https://www.remotion.dev/docs/fonts-api/load-font), checked against existing `apps/renderer/src/theme.ts` | Local font loading blocks rendering until ready. | Diagnostics use the identical native rendering path and admitted font bytes/family, not separate system-font measurement. Verify hashes and compare actual Anton/Inter controls. |
| [W3C Compositing Level 1 §5.1](https://www.w3.org/TR/compositing-1/#simplealphacompositing), Candidate Recommendation Draft | Source-over compositing relates source color, alpha and backdrop. | Paired black/white text-color interventions identify glyph contribution. Reconstruct the original composited PNG to validate assumptions. This diagnostic technique and thresholds are **our engineering inference**, not a W3C-prescribed text detector. |

## Frozen measurement contract

The original `title-simple-12` prompt stays verbatim. The default has explicit
structured acceptance `titleWidth:{fraction:0.60,tolerance:0.025,expectedLines:2}`:
**57.5–62.5% visible-ink width**, declared before model output. The tolerance is
our interpretation of “roughly”, not a vendor threshold. Arbitrary prompts do
not acquire hallucinated width targets; absent structured acceptance is unverified.

Supported scope: one native Title, only headline copy, plain backdrop, admitted
font, no overlays/assets/highlight/recipe behavior. Two diagnostic packages clone
the committed package, changing **only `theme.text`** to black and white. They
use the same renderer, font files, layout, frame, dimensions and scale. The
difference isolates glyph coverage: unchanged background/rule pixels cannot
expand the mask. Diagnostics are never substituted for the final film.

Evidence includes mask PNG, pixel/composition bboxes, scale factors, row bands,
font/source/brief/package hashes and thresholds. Coverage ≥16/255 defines ink;
coverage ≥240 defines opaque core. Reconstruct the original composed image from
the pair within 3 channel levels and require channel-consistent alpha. At least
99% of core pixels must contrast by ≥32 levels with the supported background.
A one-pixel frame-edge guard flags possible clipping; unexpected row-band count
fails the line requirement. This is not OCR or general perceptual legibility.

A geometrically valid width mismatch yields the estimate
`round(currentSize * targetFraction / observedFraction)`, clamped to 24–512.
Fixed letter spacing/rasterization make this an estimate, not a solver. Only
the corrected real render can pass. The live planner is not forced to 150px or
given the known 440px reference. A width repair can change only `headline_size`;
unrelated copy, timing, theme and font remain untouched.

## Budget and artifact decisions

Retain **two provider requests maximum**: a complete proposal needs no preceding
tool results; the correction already receives the full committed package and
actual findings. Extra acknowledgement turns are unnecessary for this scope.
The offline integration tests Pi and the actual ComfyRizz HTTP adapter together,
including nonempty font-aware wire schemas. Live failures are preserved, not
silently retried with a wider budget. One repair remains durable across resume.

Four lossless CPU samples still establish **sampled hold only**. Separately,
post-export audit decodes every MP4 frame from reveal completion to the end at
half resolution. Compared with the exported reveal-completion frame, tolerance
is mean channel delta ≤0.15 and ≤0.1% pixels exceeding 8 levels. Whole hold and
final three seconds have separate results and per-frame metrics/outlier IDs.
Visibility is independently checked by the headline grader; equality alone can
describe a blank frame. ffprobe checks actual duration, format and audio streams.
These checks do not establish full-resolution/perceptual quality or heard audio.

The decoded final MP4 frame is also compared to the measured, unmodified lossless
preview with a separate predeclared codec/resampling tolerance: mean channel
delta ≤2 and ≤2% pixels exceeding 16 levels. This links preview measurement to
the delivered frame without claiming exact MP4 glyph segmentation. A mismatch
is reported, not repaired through extra model calls.

The thin blue rule remains an explicit **native-tool capability gap**, and exact
sequential-word reveal remains unverified. Correct width is not a full-brief pass.

## Not applied

No visual-review LLM, OCR subsystem, generated DOM/CSS, general segmentation,
provider sweep, repeated paid retries, parallel agents, or framework migration.
Thinking stays disabled as authorized. Human perceptual review and broader
multi-trial/held-out evaluation remain necessary before generalizing results.
