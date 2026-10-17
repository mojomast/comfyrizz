# `@comfyrizz/llm` — provider layer (C3)

Thin OpenAI-compatible chat-completions adapter used by the agent. It owns provider
presets, streaming, usage and the setup probe; it never exposes provider details to
the model or to the browser.

## Presets

| Preset | Endpoint | Key | Notes |
| --- | --- | --- | --- |
| `openrouter` | `https://openrouter.ai/api/v1` | `OPENROUTER_API_KEY` | Baseline; optional `X-Title` header |
| `custom` | configurable (`http://127.0.0.1:8000/v1` default) | `COMFYRIZZ_CUSTOM_API_KEY` or none | Baseline; local vLLM/Ollama or any compatible proxy |
| `opencode-go` | `https://opencode.ai/inference/go/openai/v1` | `OPENCODE_API_KEY`, fallback `OPENCODE_GO_API_KEY` | Conditional; sends `User-Agent: comfyrizz/0.1` and `x-opencode-session: <conversation>` |

`resolveProvider(name, { env, model, baseUrl, apiKey })` reads keys from the environment.
Errors name the expected environment variable and never include the key value. The
OpenCode session header is added per request from `ChatRequest.sessionId`; the adapter
does not identify as another client.

## Stream contract

`createOpenAICompatibleModel(resolved)` returns a `ChatModel` whose `stream()` yields
`text`, `tool_call`, `usage`, `error`, `done`. Tool arguments are accumulated across SSE
fragments and parsed only after the provider finishes the call. A partial JSON fragment
becomes `invalid_tool_arguments` with the call id; it is never executed. Tool names are
mapped to the provider pattern `^[a-zA-Z0-9_-]+$` (`storyboard.propose` →
`storyboard_propose`) and mapped back on the response. `429`/`5xx` are retried once,
honouring `Retry-After` up to 2 s. `stream_options.include_usage` is requested; a missing
usage report is simply absent, not zero.

## Probe

`probeToolUse(config)` lists models (best effort), asks for one `comfyrizz_probe_ping`
call, then sends the tool result and requires a follow-up. A text-only model is refused.
Live check against OpenCode Go (`deepseek-v4.1-flash`, 2026-10-17): **ok**, 37 models,
tool call `{value:"pong"}`, follow-up received.

```bash
npm test                 # 9 tests with a mock fetch
npm run probe            # live opencode-go probe; reads the key from env, never prints it
```

## Files

- `src/presets.ts` — the three presets and key resolution.
- `src/openai-compatible.ts` — streaming adapter, model list, retry, tool-name mapping.
- `src/probe.ts` — setup capability probe.
- `src/types.ts` — `ChatModel`, messages, chunks, tool definition.
