# Planning-only prompt stress suite — research handoff

Status: researched, not implemented. Research subagent session: `ses_e7fd1077effe337NGLaJFe5JfR`.

## Goal

Build a **36-fixture planning stress suite**: 30 positive plans and 6 expected actionable failures. Exercise simple and ambiguous requests, ordinary motion graphics, sourced data/charts, wordless films, narrated hybrid films, Klein/H3/LTX/Auto routes, timing, aspect ratio and text density, and contradictory/unsupported inputs.

This is **plan generation only**. Never click Make this film and never call `/api/run`, production dispatch, GPU/media providers, or `/api/pipeline`. Do not touch the active test server on 4403, the user's server on 4404, their runtimes, or the existing GPU lock.

## Recommended schedule

- Six isolated worker servers/runtimes; initially schedule four plans at once.
- Smoke at concurrency 2: `S02`, `D13`, `H24`, `X33`.
- Main: remaining 32 fixtures, complex plans first, in checkpoint batches of 8.
- Per-attempt timeout: 8 minutes. Stop/restart only the affected isolated worker on timeout; an HTTP timeout does not cancel server-side work.
- Raise concurrency by one after two healthy batches with no 429/network errors and p95 under 180s; maximum 6. Reduce on rate limiting or p95 over 240s.
- After three transport failures in 60s, open a 60s circuit breaker and resume with one canary.
- At most one external rerun for transport failures, malformed streams, max-step/repair-limit or non-deterministic incomplete plans. This is separate from the server's built-in focused repair.
- Do not rerun semantic oracle failures, expected negatives, fallback substitution or attempts over 100,000 aggregate tokens.
- Hard suite deadline: 60 minutes. Target: 5–10 minute smoke plus 25–35 minute main run.

## Existing code to reuse

- `apps/web/scripts/live-agent.mjs`: minimal authenticated `POST /api/agent` pattern.
- `.tmp/live-verification/run-live.mjs`: narration-enabling package PATCH and token reporting. **Do not execute this harness**: it starts Playwright, probes setup and is too close to production.
- `.tmp/live-verification/prompts-v4.json`: examples of complex narrated film briefs.
- `apps/server/src/agent-runner.mjs`: initial plan plus one focused repair; `generatedFilmCompletionProblems()` and `packageSchemaProblems()` are reusable oracle components.
- `apps/server/src/agent-progress.mjs`: sanitized phases, timings, tool names, validation details and usage.
- `apps/server/src/duration-policy.mjs`: current shared duration acceptance policy. New oracle code must use this rather than the exact-frame rules from the original research.
- `packages/schema/src/index.mjs`: `validatePackage`.
- `packages/agent/src/production-intent.ts`: expected brief classification.
- `packages/agent/src/motion-model.ts` and `packages/agent/test/generated-film.test.ts`: route/workflow expectations.
- Offline patterns: `apps/server/test/generated-film-runner.test.mjs`, `live-loop.test.mjs`, `agent-progress.test.mjs` and `duration-policy.test.mjs`.

## Fixture matrix

Positive cases require HTTP 200, `live:true`, `fallback:false`, expected provider/model and a valid package. Check scene count, per-scene frames, **accepted compiled duration range**, media route, narration/cues and format as appropriate. No media execution: generated assets remain planned/pending except deterministic CPU SVG/audio.

### Simple and ambiguous (8)

- `S01`: 6s, one-scene motion-graphics title card, exact headline, SVG underline and one planned paper texture.
- `S02`: 8s, two scenes, four check/arrow SVG icons, `READY TO RENDER`, one nebula background.
- `S03`: 9s, three-scene PLAN/BUILD/REVIEW checklist, dot pattern, animated progress and paper grain.
- `S04`: 5s, two-scene kinetic bumper `MAKE IT` then `MOVE`, bold cuts, no narration.
- `A05`: short warm neighborhood repair-café intro; sensible defaults and no invented facts.
- `A06`: approachable bill-becomes-law diagram for teenagers; no fabricated statistics.
- `A07`: stylish solar desk-lamp vector teaser; default 1920x1080 and positive duration.
- `A08`: 10s, two-scene quarterly-results chart with no figures supplied; all numbers labelled Example data.

### Motion graphics and sourced data (8)

- `M09`: 12s, four scenes INTAKE/SORT/REPAIR/RETURN, four SVG diagrams and workshop texture.
- `M10`: library-book sorting with one shared fictional mascot, four SVG props and one library background.
- `M11`: glass-style water-filter diagram, SVG layers, sketch-to-render and one planned FLUX still.
- `M12`: 15s BEFORE/DURING/AFTER comparison, compare/list layouts, connectors and paper texture.
- `D13`: North=12, South=19, East=7; bar chart, big number and comparison share one user dataset.
- `D14`: `UPTIME 99.95%` and `42 INCIDENTS AVERTED`; exact precision and stat layouts.
- `D15`: North=1250, South=900, East=12, West=7; bar/stat/comparison/outro without comma parsing errors.
- `D16`: PAPER 40%, GLASS 35%, METAL 25%; exact percentages and no additional data/source claims.

For M09–D16, request four SVG assets and one planned still so the current non-film acceptance rule does not trigger an unrelated scripted fallback.

### Wordless and narrated generated films (8)

- `W17` H3: 12s, two shots, same brass robot opens door then places umbrella; native sound; no text.
- `W18` LTX: 15s, three scenery-only tide-pool shots; no people, narration, captions or text.
- `W19` Klein: 16s, four brass-string proportion shots; stills + code motion; no H3/LTX substitution.
- `W20` Auto: 18s, LTX reef then two H3 keeper shots; no narration/captions/text.
- `H21` Klein: 12s, two narrated brass-string shots; ratio labels and verbatim narration cues.
- `H22` H3: 12s, two narrated shopkeeper/umbrella shots; native foley and recurring identity.
- `H23` LTX: 10s, two narrated controlled-burn scenery shots; documentary readouts and cues.
- `H24` Auto: 18s, LTX lighthouse then two H3 keeper shots; compass readouts and verbatim cues.

Narrated cases (`NC`) require nonempty narration on every scene and nonempty `motion.cue_phrases`; every phrase must be a case-sensitive verbatim substring of that scene's narration. Enable Kokoro afterward with the package PATCH and require `voice.enabled:true`; do not require synthesized audio during planning.

Wordless cases (`W`) require no narration or narration assets. `X` additionally requires no `copy` or `lower_third`. Routes: K = FLUX/Klein stills + code motion, H = `fasth3-omni`, L = `ltx25`.

### Timing, aspect and density (6)

- `T25` H3: 7s, two 3.5s clay-fox shots; 210 total frames and 105/scene at 30fps.
- `T26` LTX: 21s, seven distinct 3s canal/paper-boat shots.
- `T27` H3: 8s portrait dancer; require 1080x1920 output and matching source aspect, not just portrait captions.
- `T28` Klein: 6s square paper flower; require 1080x1080 output and matching source dimensions.
- `T29` Auto: 18s, six briefing scenes, bounded dense copy, one six-item list, preserve 12/19/34/47 without truncation.
- `T30` Auto: 12s, three boat/reef shots, opening title on shot 1, no title-only scene, LTX then two H3.

### Expected actionable failures (6)

These pass only for a bounded 400/422-style response with clear actionable details. HTTP 200, silent fallback or generic 500 is a suite failure. Do not rerun deterministic negatives.

- `X31`: exactly 2 scenes and exactly 3 scenes in one brief.
- `X32`: 8s total but four 3s shots.
- `X33`: narrated with verbatim cues but also no narration.
- `X34`: synchronized spoken dialogue in an LTX-only shot; require H3 or wordless finishing.
- `X35`: one continuous 20s H3 shot; exceeds legal slot, request shorter/split coverage.
- `X36`: 8K/120fps/2.39:1 motion graphics; reject unsupported format rather than silently defaulting.

## Oracle requirements

1. Validate schema and production-intent classification.
2. Check scene counts, per-scene frames and compiled duration using `durationAcceptance()`/`durationWithinTarget()` from `apps/server/src/duration-policy.mjs`. Current policy is ±15%, minimum 2s and maximum 6s tolerance. Do not reintroduce exact-duration failures for small drift.
3. Resolve every `scene.media` plate to assets; check per-scene generator, workflow and required references.
4. Check narration/cues case-sensitively; separately check post-PATCH voice enablement.
5. Check wordless/no-caption constraints, dataset values/source, copy limits and output dimensions.
6. Treat scripted fallback as a positive-fixture failure even if the returned package looks valid.
7. Report negatives separately as `expected_refusal_pass` or `missing_actionable_refusal`.

Known gaps to expose, not hide:

- Generated-film completion does not consistently enforce requested scene count.
- `storyboard.propose` hardcodes 1920x1080 and generated-film tools cannot edit output format despite `Aspect:` guidance.
- Non-generated-film acceptance requires at least four SVG plus pending GPU and can substitute a deterministic script.
- Narration defaults disabled; planning must not require `a_narration`.
- Runtime package IDs are brief hashes; repeated prompts can overwrite packages. `a_finishing_mix.wav` is also a fixed runtime-wide filename. Never share a runtime between concurrent workers.
- Success responses omit motionModel and runner events; derive routes from package assets and use safe progress telemetry.
- HTTP timeout does not cancel server-side planning.
- Current production action estimates can omit startup overhead; do not use this planning-only suite to start paid runs.

## Isolation and credential safety

Use a detached latest-commit worktree under `/tmp/opencode/comfyrizz-planning-stress/src`, six independent runtimes and ports 4521–4526. Save worker PIDs and stop only those PIDs; never `pkill` or use port-wide kills.

Do not copy or read provider-settings files, HF tokens or existing server tokens. Supply the planning credential through the operator's environment/secret manager. Record only provider/model names such as `custom`/`deepseek-flash`, never environment values, authorization headers, token-bearing URLs or server logs.

Allowlist client requests to `/api/agent`, `/api/agent/progress`, `/api/agent/settings` and the narration package PATCH on isolated ports only.

## Implementation files and artifacts

Proposed implementation:

- `qa/planning-stress/fixtures.mjs`
- `qa/planning-stress/oracles.mjs`
- `qa/planning-stress/run.mjs`
- `qa/planning-stress/report.mjs`
- `qa/tests/planning-stress.test.mjs`

Also test aggregate initial+repair token accounting in `apps/server/src/agent-runner.mjs` and cross-phase cumulative usage in `apps/server/src/agent-progress.mjs`.

Artifacts under `/tmp/opencode/comfyrizz-planning-stress/results/<run-id>/`:

- `results.jsonl`: fixture, attempt, expected/actual outcome, timings, usage, routes and validation failures.
- `events/*.json`: re-sanitized tool names/timings only.
- `summary.json` and `summary.md`: category/model pass rates, negative results, repairs, invalid tools, fallbacks, reruns, token totals, p50/p95/max latency, concurrency history and >100k-token cases.
- `config.json`: commit/diff hash, fixture hash, provider/model, ports and limits—no environment dump.

Do not persist raw model text, reasoning, tool arguments, full generated packages, provider responses, credentials, videos or screenshots. Run offline tests first, then smoke, then main. Exit 2 for infrastructure failure and 1 for unexpected oracle results while still writing the complete report.
