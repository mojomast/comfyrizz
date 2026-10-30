# Agent provider settings

Open **Agent settings** in the top bar to configure the agent. The provider and
model used for each brief are visible beside the button.

## Production runtime and output allowance

**Pi 1.4 is the default production agent runtime**, covering initial planning,
project chat, proposal/narration revisions, repairs and continuation. It uses the
configured ComfyRizz transport for model requests, credentials, streaming, tool
validation and usage reporting. Node.js **22.19.0+** is required. See the
[runtime and trust-boundary reference](PI_PIPELINE_MIGRATION.md).

The language-model provider is separate from ComfyUI media inference. On the
default managed media path, ComfyRizz deploys the GPU inference stack on Google
Colab; see [Colab automation](features/google-colab.md). Planning/revision calls
can incur provider charges even before any Colab generation is approved.

The shared preset now supplies **65,536 output tokens** for these exact routes:

| Connection | Model | Default reasoning effort |
| --- | --- | --- |
| OpenCode Go | `deepseek-v4.1-flash` | `low` |
| Custom, `https://api.deepseek.com/v1` | `deepseek-flash` | `low` |

The limit applies with thinking enabled or disabled. Reasoning and emitted output
share the allowance; an earlier 8,192-token thinking run exhausted it before any
tool call. This is a ceiling, not a requirement to spend 64K tokens per turn.
Other providers/models retain their own configuration, and specialized tasks can
apply smaller bounds. Thinking is not universally better: choose it for the task
and inspect latency, usage and results. The experimental Pi Title CLI also reads
the resolved preset limit; historical trials retain their recorded 8K settings.

Source: [DeepSeek Chat Completions API](https://api-docs.deepseek.com/api/create-chat-completion).
Transport tests verify the outgoing allowance; they do not prove live provider
acceptance or successful film production.

## OpenCode Go

1. Select **OpenCode Go** in Agent settings.
2. Paste your Go API key. The base and models URLs are preconfigured.
3. Use `deepseek-v4.1-flash` (the preset default), or press **Fetch models** and
   choose a Chat Completions model with tool calling. You can also type a model ID.
4. Press **Test connection & tools** to verify a tool call and a tool-result
   follow-up. This sends a small request to the selected model.
5. Press **Save & use**. New briefs immediately use that provider and model.

The Go catalog also includes models using Responses, Anthropic, or Google APIs.
This adapter uses OpenAI-compatible **Chat Completions**; use a model supporting
that endpoint. The connection test checks actual tool use rather than treating a
successful model-list request as proof that a model can run the agent.

Go requests retain Comfyrizz's User-Agent and stable `x-opencode-session` header.
See [Go's integration documentation](https://opencode.ai/v2/docs/console/go).

## Other providers

OpenRouter has a built-in preset. To add another OpenAI-compatible service:

1. Press **+ Add provider**.
2. Give the connection a name and choose **OpenAI-compatible**.
3. Enter its API base URL (for example, `http://127.0.0.1:11434/v1` for a local
   compatible service), optional API key, and exact model ID.
4. Fetch models, test, and save. Under **Advanced**, you can override the models
   endpoint when it differs from `<base-url>/models`.

Multiple named connections can coexist, including multiple instances of one
provider. Switching the top-bar provider restores that connection's last model.
The model field supports both discovered IDs and manual entry for services that
do not expose model discovery. Fetching models and testing save the edited
connection first. **Save & use** also selects it for new briefs.

## Storage and environment variables

Profiles and the selected provider/model persist in
`<COMFYRIZZ_RUNTIME>/provider-settings.json` (default:
`apps/server/.runtime/provider-settings.json`). This file is git-ignored, written
atomically with mode `0600`, and contains the saved API keys. Keys are accepted
only on writes; settings responses contain key-presence/source metadata.
The UI does not put provider keys in browser storage or URLs. Closing the dialog
clears the password field. A blank key preserves an existing key; the explicit
remove-key checkbox clears the saved override.

Saved keys override the existing environment variables. Removing a saved key
restores the environment key if one is available. Existing
`OPENCODE_API_KEY` / `OPENCODE_GO_API_KEY`, `OPENROUTER_API_KEY`, and
`COMFYRIZZ_CUSTOM_API_KEY` / `COMFYRIZZ_CUSTOM_BASE_URL` setups still work.

Settings are read dynamically; no restart is needed after edits. The scripted
offline model remains available as **local · scripted model**.

## Integration points

- `apps/server/src/provider-settings.mjs`: profile persistence, validation,
  credential-free metadata, model discovery and tool-use probing.
- `apps/server/src/index.mjs`: shares one settings instance with the HTTP app
  and the agent runner.
- `createCpuAgentRunner({ resolveProviderConfig })`: optional resolver injection;
  legacy preset/override callers keep working.
- `apps/web/src/agent-settings.ts` and `.css`: self-contained settings UI.
- `apps/web/src/main.ts`: passes the selected provider **and model** to the agent.
- `apps/web/vite.config.ts`: shares the renderer's public assets so every preview
  font (including JetBrains Mono) is present in the web build.

The authenticated, same-origin API adds:

| Endpoint | Purpose |
| --- | --- |
| `GET /api/agent/settings` | Profiles without keys; active provider/model |
| `POST /api/agent/settings` | `action: save`, `select`, or `delete` |
| `GET /api/agent/models?provider=<connection-id>` | Discover model IDs |
| `POST /api/agent/probe` | `{provider, model?}` tool-use test |

`GET /api/providers` remains compatible and reports current connection readiness.
`POST /api/agent` continues to accept `{brief, provider?, model?}`; an omitted
provider retains the scripted API behavior. Credentials never go in agent bodies.

New preset definitions belong in `packages/llm/src/presets.ts`, with a display
label in the server settings module and a template option in the UI. Providers
using another wire protocol need an adapter in `packages/llm`; a custom URL
alone does not translate a non-OpenAI protocol.

Run the targeted server coverage with:

```bash
TMPDIR="$(mktemp -d)" node --test apps/server/test/provider-settings.test.mjs apps/server/test/server.test.mjs
```
