# Agent design for one-prompt films — research and decisions

Date: 2026-10-27. This is a targeted review for ComfyRizz, not a generic agent
framework survey.

## What the live failure established

The first real planner returned four FLUX still plans for a four-shot wordless
film, no native sound, repeated on-screen titles and four unreferenced restyle
jobs. It was not primarily a model-intelligence problem: the default tool surface
had no generated-video/native-audio tool and no generated-film completion check.
The job planner also counted orphan assets, while the Easy estimate omitted
session overhead. No GPU was allocated.

The correct response is a bounded production compiler, not a more autonomous
agent and not merely a larger model.

## Primary guidance

- Anthropic distinguishes predictable workflows from open-ended agents and
  recommends routing and evaluator-optimizer loops only where they help:
  https://www.anthropic.com/engineering/building-effective-agents
- OpenAI recommends strict function schemas, clear tool descriptions, typed
  outputs and evaluation of tool choice:
  https://platform.openai.com/docs/guides/function-calling
  https://platform.openai.com/docs/guides/structured-outputs
  https://platform.openai.com/docs/guides/agent-evals
- Anthropic's tool-design guidance favors a small, explicit tool surface and
  evaluation with real tasks:
  https://platform.claude.com/docs/en/agents-and-tools/tool-use/define-tools
  https://www.anthropic.com/engineering/writing-tools-for-agents
- Comfy SDK jobs are poll-authoritative; SSE is enhancement, and output bytes
  should be collected rather than treating temporary URLs as durable state:
  https://docs.comfy.org/development/api-development/sdks-design
  https://docs.comfy.org/development/api-development/sdks
- Model-specific prompt contracts matter. FLUX 3 Klein supports image generation
  and reference editing; H3 uses reference-driven multimodal direction and native
  audio; LTX has its own flowing shot/audio prompt structure:
  https://docs.comfy.org/tutorials/flux/flux-3-klein
  https://docs.comfy.org/tutorials/video/minimax/minimax-h3
  https://docs.comfy.org/tutorials/video/minimax/minimax-h3-prompt-guide
  https://docs.ltx.video/api-documentation/implementation-guides/prompting-guide

## Applied design

### 1. Deterministic stages, bounded model decisions

```text
brief → creative plan → short proposal → free user revisions
→ Make this film → semantic/capability validation → server-priced plan
→ execution → collected assets → deterministic finishing → editable result
```

The model writes creative direction, not executable ComfyUI graphs, approvals,
budget settlement, idempotency keys or runtime lifecycle operations. The server
selects pinned workflows, prices the plan and owns execution.

### 2. A real generated-film contract

Intent classification is rule-first. Procedural charts/text/SVG remain motion
graphics; physical characters, observable action, cinematic shots and native
sound require generated film. Wordless does not mean silent. A generated-film
plan is incomplete if it substitutes stills, drops required sound or leaves jobs
unattached to scenes.

The motion tool uses the existing H3 reference/direction contracts. It must have
visual references and explicit conditioning audio; wordless shots use a silent
reference, not missing inputs. Character identity and composition references stay
distinct. No universal long prompt is reused unchanged across models.

### 3. A concise creative checkpoint

The planner supplies `proposal.logline`, `look` and `soundtrack`. The user sees a
title, at most two sentences and a few facts, then **Make this film** or a revision
box. Revisions preserve the original prompt and notes. No production or paid run
exists before approval. This is creative review, not another spending dialog; the
one-time Colab cap remains the spending boundary.

### 4. One reachable-asset graph and one price

Only scene-reachable assets and their reference/audio dependencies become jobs.
Orphan restyles cannot count as completion or consume budget. `scene.media` is
part of reachability. Final-plan pricing uses the server's dry-run estimator,
including bootstrap/session overhead, and approval refers to that returned price.

### 5. Validation and evidence, not silent degradation

Validate structure, IDs, scope, editorial requirements, model capabilities and
cost before allocation. A FLUX-only film, missing soundscape or invalid reference
route fails with an actionable error instead of silently becoming a scripted or
still-only result. Fallback to a different medium requires an explicit product
policy, not a hidden rescue path.

Collected hashes and technical decode checks establish asset integrity, not
creative approval. Evals cover exact tool trajectories, scope, motion/audio
requirements, reachable jobs and retry behavior. Real outputs receive temporal
visual review and audible review; an LLM judge does not become human approval.

### 6. Deployment

Keep loopback authentication, server-held credentials, pinned model/workflow
revisions and verified teardown. Treat provider/BYO URLs as sensitive
configuration. Do not let the agent install nodes or dependencies. Retry malformed
planner output with bounded validation feedback; reconcile ambiguous job
submission before paying again. Use capability-compatible model fallback only
before output, and pin the selected provider/model into the plan trace.

## Remaining evaluation work

- Run the same generated-film brief against explicit candidate agent models and
  compare plan validity and editorial quality; do not choose a default from a
  leaderboard or one successful tool probe.
- Verify native sound independently of narration/TTS.
- Add calibrated per-shot perceptual triage without converting it to human
  approval, then inspect the complete film with sound.
- Measure accepted shot-seconds per total LLM/GPU cost and time to first usable
  preview, not only generation count or test pass rate.
