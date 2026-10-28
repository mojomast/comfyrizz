# Managed hackathon demo — deployment contract

Status: deployment pending. No public URL is claimed yet.

## Judge experience

The judge opens the supplied private link and immediately enters a prompt. Agent
inference, Google Colab and model access are already configured. There is no API
key, Google Colab CLI, Hugging Face token or installation step. The judge selects
Auto/H3/LTX/Klein-only, reviews or revises the proposal, chooses Make this film,
watches the live gallery and downloads the result. Advanced editing remains
available with the same project.

The self-host setup in `docs/ONE_PROMPT.md` is a separate path and is not shown to
judges as a prerequisite.

## Server-owned demo policy

The deployment must enforce limits on the server, not trust browser preferences:

- a small per-run credit ceiling and a separate total demo credit ceiling;
- a maximum number of planning/generation runs and LLM requests per visitor and
  across the deployment, sufficient for roughly 5–10 judge runs;
- server-selected inference credentials and model-access tokens, never returned
  in API responses, pages, logs, exports or recording journals;
- no provider/HF settings mutation, OAuth start, custom ComfyUI destination or
  arbitrary backend selection in demo mode;
- no arbitrary agent-selected budget increase, retry, dependency installation or
  workflow graph execution;
- bounded prompt/asset sizes, request timeouts and concurrent jobs;
- normal package/production revision checks and a final estimate that includes
  bootstrap overhead;
- truthful failure and teardown states, with reconciliation before another paid
  attempt.

A changed `localStorage` value, API body or agent message must not raise any cap.
The production ledger and account-balance delta are the spending evidence.

## Privacy and safety

- Keep the application server loopback-only and publish through the existing
  authenticated reverse proxy; distribute the judge link only through the form.
- Do not expose account balance, credential paths, provider settings, runtime
  paths, server tokens or other users' prompts/assets.
- Disable settings writes, OAuth and custom provider endpoints in demo mode.
  Readiness responses contain only the minimum necessary state.
- Keep generated prompts/assets private to their session where practical, with a
  short documented retention period and cleanup after judging.
- Rate-limit expensive endpoints before model calls. Do not rely on a hidden UI
  button as the enforcement mechanism.
- Do not record the judge's screen or enable procedure capture by default.

## Publication gate

1. Complete the four real route examples and review output quality and spend.
2. Exercise demo-mode API tests for cap bypass, settings writes, custom backends,
   repeated runs, concurrent jobs, failure recovery and secret-free responses.
3. Deploy the tested branch, run one managed generation, and verify the served
   MP4, account delta and zero active runtime afterward.
4. Supply the private link only in the hackathon form. Keep the two-minute video
   as a fallback and do not publish credentials in the public repository.

Exact per-run/total ceilings and retention are chosen before deployment and must
be documented here and in `docs/submission/STATUS.md`.
