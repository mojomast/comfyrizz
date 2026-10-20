# Spec: CASSETTE, record and replay for the chat agent

Status: draft v1 (Oct 20, 2026). Branch: `feat/agent-cassette`, off `main`.

## 1. Why this feature
The chat agent is model-agnostic (any OpenAI-compatible provider). A live demo that depends on a free provider's rate limits can fail on stage, and "model-agnostic" is a claim judges cannot see. Cassettes record one agent session's LLM traffic (redacted) and replay it with no network, so the demo and tests are deterministic, and two recordings from different models can be diffed into a side-by-side table that shows the same tools and package coming out of different models. The server hook is opt-in through one env var and changes nothing when unset.

## 2. Boundaries
- No changes to HyperFrames, Google Colab, renderer, GPU or composition code; another agent owns those areas. Checks and hooks never call or inspect Google Colab.
- No overlap with DEMO-WEBAPP (`apps/web/src/demo/**`, `apps/web/demo.html`) or SUBMISSION (README, CREDITS, docs/submission, CI).
- Pure `.mjs` modules with injected dependencies; tests are `node --test <file>` with no network, GPU, server or built packages.
- Secret values are never printed, stored or returned; only env var names and set/unset. No paid providers.
- Nothing is merged to main by the workers; the branch is reviewed by Kyle.

## 3. Tasks
Tiers: **simple** runs on the free model pool; **standard** runs on `deepseek-v4.1-flash`. Files live under `scripts/cassette/` except the server hook (C08) and `docs/AGENT_CASSETTE.md` (C10).

| Task | Title | Tier | Files | Depends on | Acceptance |
|---|---|---|---|---|---|
| C01 format | Cassette format and request key | simple | `scripts/cassette/format.mjs`, `scripts/cassette/format.test.mjs` | - | key stable under key order and trailing whitespace; key ignores model; validator rejects missing schema / bad entries with path-specific errors |
| C02 redact | Cassette redaction | simple | `scripts/cassette/redact.mjs`, `scripts/cassette/redact.test.mjs` | - | fake key in a message removed; headers gone; absolute paths replaced; input unchanged |
| C03 recorder | Recording fetch wrapper | standard | `scripts/cassette/recorder.mjs`, `scripts/cassette/recorder.test.mjs` | C01, C02 | fake upstream: two calls -> two entries with correct keys; non-chat URL not recorded; saved file passes validateCassette and contains no fake key; upstream error recorded and rethrown |
| C04 player | Replay fetch | simple | `scripts/cassette/player.mjs`, `scripts/cassette/player.test.mjs` | C01 | strict hit returns recorded body; strict miss error lists previews; sequential order and exhaustion; stats counts |
| C05 diff | Cassette diff for model comparison | simple | `scripts/cassette/diff.mjs`, `scripts/cassette/diff.test.mjs` | C01 | identical -> no changes; different tool call names detected; markdown has one row per changed key; pure, no fs |
| C06 fixture | Sample cassette fixture | simple | `scripts/cassette/fixtures/launch-brief.cassette.json`, `scripts/cassette/fixtures/fixture.test.mjs` | C01 | passes validateCassette; every tool name used exists in packages/agent/src/tools.ts (test reads the file); < 30 KB |
| C07 cli | Cassette CLI | simple | `scripts/cassette/cli.mjs`, `scripts/cassette/cli.test.mjs` | C02, C04, C05 | test spawns validate on a temp valid and invalid file; diff --md output; redact output passes validate and drops a fake key |
| C08 server-hook | Opt-in server hook | standard | `apps/server/src/cassette-hook.mjs`, `apps/server/test/cassette-hook.test.mjs`, `apps/server/src/provider-settings.mjs` | C03, C04 | unset env -> identical fetch object; play: serves fixture; record: writes a valid cassette; provider-settings.mjs diff is <= 3 lines |
| C09 replay-smoke | Replay smoke loop | simple | `scripts/cassette/replay-smoke.mjs`, `scripts/cassette/replay-smoke.test.mjs` | C04, C06 | fixture replays with 0 misses; tool calls parsed; corrupted fixture -> clear error |
| C10 docs | Cassette documentation | simple | `docs/AGENT_CASSETTE.md` | C07, C08 | commands match cli.mjs and the env var in cassette-hook.mjs; states that recordings must be reviewed before committing |

Details:

- **C01** comfyrizz.cassette/v1: {schema, createdAt, model, provider, entries:[{key, request:{model,messages,tools?,tool_choice?,temperature?}, response:{status, body}}]}. validateCassette(obj) -> {ok, errors[]}; requestKey(request) = sha256 of a canonical JSON (sorted keys, model excluded so replays work across models, whitespace-trimmed message content); emptyCassette(meta).
- **C02** redactEntry(entry) and redactCassette(c): drop all request headers, strip api keys / bearer tokens / sk-, hf_, ghp_ strings and any env-provided secret values from message text and response bodies, replace absolute filesystem paths with '<path>'. Never mutates input.
- **C03** createRecorder({fetch, meta}) -> {fetch, cassette(), save(path, fs)}. The wrapped fetch forwards OpenAI-chat POSTs to .../chat/completions unchanged, records {key, request, response} (JSON bodies; streaming responses: record the assembled final body and note stream:true), passes other URLs through unrecorded, and redacts on save. Errors from the real fetch are recorded as status + message and rethrown.
- **C04** createPlayer(cassette, {mode:'strict'|'sequential'}) -> fetch. strict: serve by requestKey, miss -> throw CassetteMiss with the 3 closest keys' first user message preview (no secrets); sequential: serve entries in order regardless of key, error when exhausted. Returns real Response objects. stats() -> {served, misses}.
- **C05** diffCassettes(a, b) -> {sameKeys, onlyA, onlyB, changed:[{key, toolCallsA, toolCallsB, textChanged}]} comparing assistant tool calls (names + arg keys) and text per key; renderDiffMarkdown(d) for a judge-readable 'model A vs model B' table.
- **C06** Hand-write a small (3-5 entry) cassette for a launch-video brief conversation whose responses use the tool names the agent really exposes (read packages/agent/src/tools.ts; cite names in the test). Clearly synthetic text, no real keys or paths.
- **C07** node scripts/cassette/cli.mjs validate <file> | stats <file> | diff <a> <b> [--md] | redact <in> <out>. Exit 1 on invalid. Never prints request bodies in full (previews <= 80 chars).
- **C08** cassetteFetch(env, fetchImpl) -> fetchImpl unchanged unless COMFYRIZZ_LLM_CASSETTE='play:<file>' (player, strict) or 'record:<file>' (recorder, saved on process exit and after each entry). Wire it in provider-settings.mjs with the smallest possible change: wrap the default fetchImpl in createProviderSettings. The test imports only cassette-hook.mjs (provider-settings imports built packages). Off by default; refuses a record path outside the repo's runtime dir or cwd.
- **C09** A minimal OpenAI-chat client loop (no packages imported) that replays the fixture through createPlayer in sequential mode and asserts each assistant turn is valid JSON-shaped (tool calls parse, finish_reason present). Exported runReplay(cassette) -> {turns, toolCalls}.
- **C10** How to record a session with a free provider, replay it for a no-network demo, diff two models' runs (model-agnostic story for judges), the redaction guarantees and limits, and the env var. Every command must exist.


## 4. Done when
The fixture replays with zero misses, a recorded cassette passes validation and contains no secrets, the server behaves identically with the env var unset, and the docs commands all run.
