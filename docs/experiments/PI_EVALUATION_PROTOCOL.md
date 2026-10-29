# Pi Title experiment: evaluation protocol

Research reviewed 2026-10-29. This protocol defines evidence and future comparisons; it does not report new trials or establish a Pi quality improvement. Runner implementation and commands are documented in `PI_TITLE_RUNNER.md`.

## Primary guidance and its application

| Source | Relevant guidance | Application to ComfyRizz |
|---|---|---|
| [Anthropic: Demystifying evals for AI agents](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents), Jan 2026 | Grade environmental outcomes, isolate trials, distinguish infrastructure failures, combine deterministic and human grading, and inspect transcripts. | Measure the exported film and renderer evidence; preserve failed attempts; keep model, harness and renderer failures separate. An exported file alone is not a complete brief pass. |
| [Anthropic: Writing effective tools for agents](https://www.anthropic.com/engineering/writing-tools-for-agents), Sep 2025 | Use focused tools, meaningful feedback, actionable errors and realistic evaluation cases; avoid overfitting to one expected tool sequence. | Expose existing native Title capabilities, return measured mismatches, and allow any supported composition satisfying the brief. Use held-out titles before making reliability claims. |
| [Anthropic: Building effective agents](https://www.anthropic.com/engineering/building-effective-agents), Dec 2024 | Start with simple workflows; use environmental feedback and bounded refinement when criteria are clear. | Keep one durable correction budget and measurable findings. Pi is an orchestration implementation, not itself evidence of better results. This older article now explicitly notes that its tooling landscape has changed; use it for workflow principles, not current API details. |

The implementation choices below are project-specific applications of this guidance, not guarantees or vendor-prescribed numeric thresholds. Consult the runner guide for the verified installed Pi API/version and rendering-measurement references.

## Three questions, three different claims

1. **Integration:** Can the corrected adapter send real tools, execute a live plan, render it and resume without unintended provider calls? A successful live trial can establish this narrow result.
2. **Feedback usefulness:** Does a measured finding lead to a correction that improves the same saved draft without breaking other constraints? Retain before/after renders, package revisions and measurements. Scripted-provider success tests mechanics, not live model judgment.
3. **Harness advantage:** Does this workflow outperform a comparable existing workflow? Historical UI runs have different prompts/tool sets/builds and cannot establish that Pi caused a difference. A future matched comparison must control these factors.

## Grading contract

- Freeze the original brief, explicit structured acceptance targets, model options, font/source hashes, tool schemas and source/build manifest before planning.
- Define any width tolerance before inspecting model output. Do not loosen it to turn the observed result into a pass. A roughly 60% request may use an explicitly documented interval; report actual measurements as well.
- Check title bounds against renderer-grounded text evidence with the same admitted font, layout and frame. A diagnostic mask must exclude backgrounds and rules, and must remain labeled diagnostic rather than final output.
- Package copy checks establish authored strings, not visible or legible text. Font-size ranges establish schema validity, not correct rendered width.
- Preserve statuses **pass**, **fail**, and **unverified** for each requirement. Unsupported blue-rule geometry, reveal choreography or perceptual judgment must not silently disappear from the scorecard.
- Sampled-frame equality establishes only sampled stability. Full-hold claims need all relevant decoded frames and an explicit compression tolerance. A blank sequence can be perfectly still, so visibility must be checked separately.
- Check required dimensions, frame count/video duration and audio routing on the actual export. Distinguish AAC/container padding from video duration. No audio listening claim from decoding or signal measurements.
- Report pipeline completion separately from full-brief acceptance. Partial credit identifies progress; it does not turn a remaining required failure into a complete pass.

## Comparison and resource accounting

For a later matched comparison, keep model, thinking mode, brief, admitted assets, renderer and tool capabilities identical. Compare an initial plan with a bounded feedback-enabled run; record whether improvements come from better tools, additional provider calls or measured feedback. Do not attribute all changes to the Pi library.

Report initial planning, preview/measurement, correction, export, queue wait and recovery separately. Count provider requests, logical correction attempts, tool failures and usage independently. Report cumulative effort including failures, not only the fastest successful run. Lower token usage is a secondary outcome, and does not by itself establish lower dollar cost.

Use a short renderer temporary path, isolated run directory, bounded observer writes and a renderer preflight. A Chromium startup failure or observer stall is an infrastructure result. Export-only recovery can preserve a comparison if the exact package and asset hashes remain unchanged and the failed attempt remains recorded.

## Confidence and follow-up

One live run is a diagnostic. Before claiming reliability, use fresh sessions and several held-out title lengths, line breaks and admitted fonts, including already-correct drafts that should not be changed. Maintain tests for both correction-needed and correction-not-needed behavior, clipping, stale findings and resume budget persistence.

Human visual review remains necessary for polish and interpretation. A future vision-model grader should be calibrated against reviewed examples and may return unverified when evidence is insufficient. Avoid adding another model merely to replace cheap, reproducible measurements.
