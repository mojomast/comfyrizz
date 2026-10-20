# Conversational video agent

Select **OpenCode Go → deepseek-v4.1-flash** in Agent settings. Describe the
video in your own words; the agent writes copy, narration script and storyboard.
Other connections use the same tools through the [provider settings](AGENT_PROVIDERS.md).

## Try the workflow

1. “Give me two angles for a 30-second solar explainer for homeowners. Don't build yet.”
2. “Draft the how-it-works angle as four scenes. Procedural visuals only. Let me review first.”
3. “Change only the second headline to ‘Sunlight starts the flow’.”
4. Click **Build this project**, or say “Build this plan now.”
5. “Make the second headline ‘Your roof makes current’ and apply it.”

The build button applies the reviewed draft directly, with no model request.
Chat can also build and revise naturally. Advice-only turns leave the project
alone. Reload restores the conversation, draft and associated project. Mobile
includes the chat composer and draft controls.

A build produces an editable package and preview. Narration remains script
text until synthesis; image requests create pending GPU jobs. Audio synthesis,
GPU execution and MP4 export are separate operations. Procedural visuals render
the existing mesh backdrop and text layouts; visual-direction prose is not an
animation program. Built-in sketch and technical-flow recipes render bounded
diagrams from editable scene items; custom diagrams still need SVG markup.

## Animation and richer layouts

The agent authors all eight layouts: **title, hero, stat, chart, list, split,
compare and code**. Stat/chart use plan-level datasets with supplied values, units
and provenance; split/compare use two labeled plates; code carries actual source
and language. See [animation and storytelling](ANIMATION_STORYTELLING.md) for the
six recipes, timing contract, editor controls and live showcases.

Try these requests:

- “Build a procedural-only workflow explainer. Use a technical-flow list with
  Request, Worker and Result; anchor each node to that word in the narration.
  Use a paper reveal into the next scene and finish with a kinetic title.”
- “Change only this hero's shape animation from circle to triangle. Keep its
  intensity, seed, copy and narration.”
- “Use narration phrases instead of the explicit seconds on the workflow scene.”
- “Remove the focus recipe but preserve its original text-entry animation.”

The model receives the recipe/layout compatibility matrix on drafting and
revision turns, plus usage examples, whole-frame focus bounds, bounded morph
shapes, cue precedence and provenance, reveal-transition limits, and CPU/future
adapter boundaries. `project_patch_plan` merges omitted motion fields and nested
focus/morph fields. `null` clears a token or the whole motion object; `{recipe:null}`
preserves other motion settings. To switch to phrase timing, explicitly clear
`cue_seconds`. Focus and paper-cut enter at scene start; they do not consume phrase
anchors. Kokoro phrase timing is estimated, not forced alignment.

The authenticated `GET /api/animation-options` endpoint supplies editor/integration
discovery. It is not a model-callable tool: the agent gets its knowledge through
the system prompt, bundled skills and JSON tool descriptions. A contract test
checks the actual model requests against the shared catalogue in both Chat and
Express modes, for drafting and revision.

## Four bundled skills

Canonical Markdown lives under `packages/agent/src/skills/`:

| Skill | Purpose |
| --- | --- |
| `video-brief` | Clarify consequential unknowns, use creative defaults, respect review/build intent |
| `explainer-script` | Write clear explanations and readable copy with narration that fits timing |
| `storyboard-direction` | Choose concrete, consistent visuals within actual rendering capabilities |
| `project-revision` | Make scoped corrections while preserving unrelated work and stable scene IDs |

The runtime prompt is `2.2.0` and skill catalogue is `1.2.0`.
`storyboard-direction` is `1.2.0`, `project-revision` is `1.1.0`, and the briefing
and scripting skills remain `1.0.0`.
At most three skills are injected per model request. Once a draft exists,
`project-revision` replaces `video-brief`. The loader resolves fixed bundled
paths; compiled packages include the canonical source Markdown. Source links in
each file document research influences and are excluded from model instructions.

These are instruction-tuned skills, not a fine-tuned set of model weights.

## Runtime guarantees and boundaries

- `project_update_plan` writes an initial draft or deliberate replacement.
  `project_patch_plan` changes only supplied fields and supports scene additions,
  removals and ordering. Patches validate atomically.
- Runtime/tool limits align with package limits: narration ≤600 characters,
  visual notes ≤512, headline ≤64, supporting line ≤120, hero body ≤240;
  per-layout constraints may be tighter. Follow the active tool schema.
- `project_build` saves through package revision locking. Field-level merging
  preserves unrelated manual copy, scenes, ordering, media, audio and timing.
  Existing manual edits are included in model context; locked scenes and edits
  made during a running turn produce conflicts rather than being overwritten.
- Changed narration invalidates its old audio association; changed visual
  inputs regenerate the relevant asset. Copy-only edits reuse existing media.
- A saved build survives failure of the model's final summary. A valid draft
  survives a subsequent provider failure, with an explicit incomplete-turn reply.
- Turn IDs make immediate retries idempotent. Conversation revisions detect
  stale tabs. UI retry reuses the same turn ID; conflicts offer a reload action.
- Recent history has a character budget; older messages remain persisted and
  can be fetched through `conversation_read_history`. This is not semantic
  summarization. The brief must retain important requirements and corrections.

Sessions are stored in `<runtime>/conversations/<id>.json`; turn traces are in
`<id>.turns.jsonl`, both mode `0600`. Traces record prompt/skill versions, tool
outcomes, provider-reported usage, repairs and elapsed time. Keys remain in
server-owned provider settings. The browser stores the conversation ID.

### API

Authenticated `POST /api/agent/chat` accepts `message`, `provider`, `model`,
optional `conversationId`, `turnId`, `baseRevision`, `brand`, and `mode`.
`action: "build"` applies the existing draft directly. Responses include
`conversation`, `reply`, `built` and the associated `project` when present.
`GET /api/agent/chat/<id>` restores state.

## Live evaluation: October 19, 2026

All requests used **OpenCode Go / `deepseek-v4.1-flash`**, with isolated temporary
projects. Three conversations cover 11 turns: brainstorm/review/correct/build/
revise/advice, an express technical explainer with a factual correction, and a
fictional product without evidence for numerical claims.

| Run | Passing turns | Total turn time | Reported input/output tokens |
| --- | ---: | ---: | ---: |
| Original runtime baseline | 10/11 | 130s | Not recorded |
| First skills/runtime integration | 11/11 | 180s | 191,148 / 27,240 |
| Tuned skills + runtime | 11/11 | 154s | 177,778 / 14,602 |
| Same runtime, skills disabled | 10/11 | 138s | 99,332 / 10,984 |

Observed changes informed the implementation:

- The original baseline rewrote approved content while building after hitting
  package constraints. Matching schemas and a direct build action address this.
- Initial outputs described procedural diagrams that the renderer could not
  execute. Guidance now distinguishes direction notes, mesh/text layouts and
  SVG assets; the final checks explicitly enforce procedural media choices.
- Initial responses and quality passes were verbose. Guidance now favors short
  summaries and a focused quality pass; unrelated fields stay untouched during
  point edits.
- In the skills-disabled comparison, a malformed `project_patch_plan` JSON
  response interrupted the technical correction after a valid draft was saved.
  Recovery truthfully reported that the project had not been updated. The tuned
  skills run completed the correction and build.

These are single runs of a small behavioral suite, not statistical evidence of
general quality improvement. Timing varies with provider latency, and tokens
include repeated context across model steps. The first integration used fewer
media assertions than the final paired comparison. Automated checks establish
state transitions and preservation, not a comprehensive visual-quality score.

### Animation knowledge follow-up: October 20, 2026

With prompt `2.2.0`, a live OpenCode Go / `deepseek-v4.1-flash` run passed
**2/2 turns**. It built all six recipes in compatible layouts, then changed a morph
destination, replaced explicit seconds with phrase cues, and removed the focus
recipe while retaining its other motion settings. Assertions checked stable IDs,
unchanged non-motion scene content, preserved seeds/intensity/entry and no pending
GPU work. This is a targeted behavioral check, not a general quality benchmark.

Reproduce only that case with:

```bash
node packages/agent/scripts/eval-conversation.mjs \
  --case express-animation-build-revise --label animation \
  --output .runtime/evals/animation.json
```

Local evidence for the completed run is `.runtime/evals/animation-handoff.json`;
credentials and evaluation artifacts stay outside source control.

### Reproduce

From the repository root, after dependencies and workspace builds:

```bash
node packages/agent/scripts/eval-conversation.mjs \
  --label skills --output .runtime/evals/skills.json
node packages/agent/scripts/eval-conversation.mjs \
  --without-skills --label control --output .runtime/evals/control.json
```

The runner reads saved credentials from `apps/server/.runtime` (override with
`--settings-dir`) and never copies them to result files. It sends real, billable
model requests. `--case solar-review-build-revise` limits the run to one case.
Cases live in `packages/agent/evals/conversation-cases.json`. Local raw outputs
are in `.runtime/evals/`; they are intentionally git-ignored.

Implementation entry points: `packages/agent/src/conversation.ts`,
`apps/server/src/agent-chat.mjs`, `chat-state.mjs`, `chat-project.mjs`, and
`apps/web/src/project-chat.ts`. Meaningful agent and server tests cover scoped
patching, recovery, draft/build transitions, retries, revision conflicts, manual
edits, asset invalidation and brand context.

### DeepSeek thinking-mode continuation

The Chat Completions adapter preserves streamed `reasoning_content` fragments
on the corresponding assistant tool-call message and sends them back verbatim
on subsequent model steps. Conversation, legacy-agent and capability-probe
loops all retain this provider continuation data separately from visible text.
Conversation replies and traces do not include it. Omitting it can cause
DeepSeek to reject a tool-result follow-up with HTTP 400 in thinking mode.

Regression coverage includes fragmented reasoning, multiple tool steps through
the final build summary, and a mock server that rejects missing continuation
data. A live `deepseek-v4.1-flash` probe with thinking explicitly enabled passed,
as did the two-turn express build/correction evaluation after this fix.
