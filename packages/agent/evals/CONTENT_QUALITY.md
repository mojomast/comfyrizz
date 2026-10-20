# Content-quality evaluation

Research/skill revision: **2026-10-20**, catalog **1.3.0**. These cases turn the
rich-demo review into repeatable authoring tasks. The JSON suite's `expect` fields
are executable state/constraint checks; the rubric below requires human review
or a separately calibrated judge. A green runner result is **not** a creative score.

## Run and record

Use `scripts/eval-conversation.mjs` from the repository root, for example:

```bash
node packages/agent/scripts/eval-conversation.mjs \
  --case quality-worked-example --label content-quality \
  --output .runtime/evals/content-worked-example.json
```

Repeat for `quality-comic-payoff`, `quality-plate-coverage-advice` and
`quality-caption-access`. The runner uses saved provider settings and billable LLM
requests, with isolated temporary projects. It does not synthesize speech or run GPU
generation. Preserve the existing regression cases, including the explicit
six-recipe showcase: purposeful variety must still honor a user's exact request.

For a comparison, use the same model, brief, runtime, tool configuration and trial
count for both skill revisions. Record commit, prompt/skill versions, model, date,
latency, tokens and failures. Start with three independent trials per case per
revision; report counts and disagreement, not statistical significance. The
`--without-skills` option tests the entire bundle's contribution, not just this change.
Randomize output order for blinded comparison. Human-review disputed grades.

## Evidence and anchors

Grade each applicable dimension **0** (fails), **1** (partly useful), **2** (clear,
feasible and supported), or **unknown** (necessary artifact unavailable). Record
scene ID/field or exact response excerpt with every grade. A script-only run cannot
establish pronunciation, caption fit, motion smoothness or delivered video quality.

| Dimension | 0 | 1 | 2 |
|---|---|---|---|
| Through-line | Unrelated feature cards | Topic coherent, weak progression | One situation develops toward a concrete result |
| Visual contribution | Decorative substitute for explanation | Relevant illustration without mechanism | Image/labels show the relationship or consequence |
| Timing | Incorrect coverage math or unjustified stretching | Recognizes issue without usable remedy | Feasible pacing/coverage with explicit uncertainty |
| Readability/access | Removes speech access or essential labels | Less text, unresolved competition | Captions retained; copy, labels and space prioritized |
| Continuity | Entities/metaphors drift | Some recurring identifiers | Stable entity, role and visual identifiers across beats |
| Executability/evidence | Invented feature, tool or claimed review | Notes partly exceed available capabilities | Schema-valid artifacts and accurate completion claims |

Report individual dimensions and deterministic failures; do not hide a factual or
capability error behind a high average. Suggested authoring acceptance: no zeros,
with 2 for visual contribution and executability. This is a local rubric to calibrate,
not a validated audience-engagement predictor.

## Case-specific reference outcomes

### quality-worked-example

- One identifiable receipt moves conceptually from unassigned → assigned to a named
  project → visible in that project's collection. Exact arrangement is flexible.
- SVG geometry/labels actually express these states; a generic dashboard plus prose
  promising dragging/moving objects is insufficient. Static frames are valid.
- Clearly fictional/illustrative, with no OCR, automatic categorization, savings or
  real-product screenshot claims. Stable receipt and project identifiers.
- Concise narration, selective copy, caption space considered. Actual fit is unknown
  until previewed. Headline revision preserves the rest byte-for-byte structurally.

### quality-comic-payoff

- Opening establishes anonymous suggestions without giving away missing-signature
  rejection. Middle reveals the contradiction, ending supplies a reaction/callback.
- The teal form remains identifiable. Static SVGs are genuinely authored, rather
  than a promise of arbitrary character animation.
- Timing serves the beats. Do not require mechanically different durations: an
  intentional equal-duration edit can work if the action/reaction justifies it.
- Do not assert that a script's gag is funny in playback without viewing it.

### quality-plate-coverage-advice

- `4 / 0.4 = 10` seconds of coverage, `14 - 10 = 4` seconds of shortfall. Diagnose
  expected hold risk, not an observed freeze. Recommend additional coverage or
  editorial restructuring; keep requested scope and available tools in view.
- Recheck new narration timing, cue resolution and coverage. Zero audio lag does
  not prove word-aligned visual reveals; syllable-fallback remains estimated.
- Preserve the separately specified intentional two-second inspection hold.
- Do not claim to have viewed the video, heard audio or applied a fix.

### quality-caption-access

- Preserve full-speech access and qualifications; reduce redundant paragraph copy,
  group captions at natural phrases and protect diagram labels.
- These measurements imply about **135 WPM / 12.9 characters per second**. They
  alone do not establish excessive reading speed. The reported problem is clutter;
  line count and actual rendered width are unknown.
- Consider phone playback, portrait re-layout and natural breaks. BBC recommends
  two lines for landscape/square and three for portrait; its 37-character Teletext
  rule is not a universal web-video limit.
- Guidance is a proposed revision, not a claim that chat can set caption groups or
  that a rendered accessibility check has passed.

## Rendered follow-up

For drafts that pass, review captioned narrated rough cuts with opening/action/end
samples plus playback across cuts. Record coverage shortfall, deliberate holds,
readability, temporal cue accuracy, continuity and sound intelligibility. Use the
same rubric, replacing unknowns only with actual evidence. Technical package tests
and midpoint contact sheets complement this review; neither substitutes for it.
