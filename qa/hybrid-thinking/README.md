# Hybrid planning-thinking experiment

Planning-only A/B/C harness. It does not start image/video/audio generation, a
production, a run, a paid GPU job, or Google Colab.

See `PLAN.md` for arm definitions, predeclared targets, and the fixture matrix.

## Reproduction

Offline unit and integration tests (no provider, no live model):

```bash
pnpm run build:libs
pnpm test:qa
# or just this file:
node --experimental-strip-types --test qa/tests/hybrid-thinking.test.mjs
pnpm --dir apps/server test -- test/hybrid-planning-correction.test.mjs
```

The opt-in correction path is disabled unless the isolated worker sets
`COMFYRIZZ_HYBRID_PLANNING_CORRECTION=1`. Production defaults are unchanged.

### Live smoke (2 fixtures, 1 rep, arms A+B and conditional C)

Requires a provider key in the **operator environment** (never from another
process or a settings file):

- Direct DeepSeek (experiment default): `COMFYRIZZ_CUSTOM_API_KEY` or
  `DEEPSEEK_API_KEY`
- Or the existing OpenCode Go DeepSeek path: `OPENCODE_GO_API_KEY` or
  `OPENCODE_API_KEY`

```bash
pnpm run build:libs
node qa/hybrid-thinking/run.mjs
```

Sanitized artifacts write under `/tmp/opencode/comfyrizz-hybrid-thinking/results/<run-id>/`.
Set `HYBRID_THINKING_SMOKE=0` if you only want the offline tests.

Optional overrides (identical for every arm):

```bash
HYBRID_THINKING_PROVIDER=custom \
HYBRID_THINKING_MODEL=deepseek-flash \
HYBRID_THINKING_BASE_URL=https://api.deepseek.com/v1 \
node qa/hybrid-thinking/run.mjs
```

### Main run (gated — do not start without Kyle's approval)

Predeclared budget from `budget.mjs`:

- 12 fixtures × 3 reps
- Arms A and B always: 72 requests
- Arm C at most +36 requests
- **Hard request cap: 108**
- **Hard token budget: 20,000,000** provider tokens
- Estimated envelope: see `MAIN_TOKEN_ESTIMATE` in `budget.mjs`

```bash
# This exits 2 and writes a gated report unless explicitly approved.
node qa/hybrid-thinking/run.mjs --main

# Only after operator approval (none has been given):
HYBRID_THINKING_MAIN=1 node qa/hybrid-thinking/run.mjs --main
```

Do not claim hybrid feasibility from the preliminary single A/B sample.

## Isolation

- Ports `4531–4536`, workspace `/tmp/opencode/comfyrizz-hybrid-thinking`
- Same brief → same package ID; concurrent arms use different runtimes
- C reuses A's worker/runtime and package ID
- Allowlisted client routes: `/api/agent`, `/api/agent/progress`,
  `/api/agent/settings`, package PATCH, `/api/health`
- `/api/run` and `/api/pipeline` are refused by the harness
