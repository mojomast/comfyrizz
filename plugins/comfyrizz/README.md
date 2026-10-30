# Comfyrizz Hermes plugin

The Comfyrizz Hermes plugin puts character-film production in chat. A run moves through one loop:

> brief → plan in chat → revise → explicit accept → generate (ComfyUI, Comfy API or Google Colab) → CPU assemble → share export → granular retake

Hermes is the frontend on this happy path; the web app remains available. The plugin does not
contain a second engine. It exposes the Comfyrizz MCP server, which calls the running Comfyrizz
engine, and bundles the `comfyrizz-film` skill that teaches Hermes the loop.

**Status: local install only, v0.1.0.** The plugin is not in the Hermes plugin catalog, and no
catalog PR has been opened for it. Install it from a checkout as described below; do not wait for a
catalog entry.

## What is in the plugin

| Path | Purpose |
| --- | --- |
| `plugin.json` | Hermes manifest: name `comfyrizz`, version `0.1.0`, MIT |
| `mcp.json` | stdio MCP server named `comfyrizz` |
| `skills/comfyrizz-film/SKILL.md` | the `comfyrizz-film` skill: the chat production loop |
| [`packages/comfyrizz-mcp`](../../packages/comfyrizz-mcp) | MCP server implementation (stdio by default; optional loopback HTTP) |

The plugin's `mcp.json` starts the server with `node` and the plugin-relative path
`${PLUGIN_ROOT}/../../packages/comfyrizz-mcp/src/index.mjs`, with `${PLUGIN_ROOT}` as cwd. That
assumes the plugin still lives at `plugins/comfyrizz` in this monorepo; see the copy caveat below.

## Install into Hermes

Prerequisites: Node 22, pnpm, a Comfyrizz checkout, and a Hermes version with plugin and MCP
support.

```bash
pnpm install
```

### Option A — install from the checkout path

```bash
hermes plugins install ./plugins/comfyrizz
hermes plugins list
```

Restart Hermes after installing so it reloads plugins and MCP servers. If your Hermes build does
not expose `hermes plugins install`, use the link option below.

### Option B — link into the Hermes plugin directory

Use a link while developing the plugin; edits are picked up on the next Hermes restart.

```bash
mkdir -p ~/.hermes/plugins
ln -s "$PWD/plugins/comfyrizz" ~/.hermes/plugins/comfyrizz
```

If a link already exists, replace it deliberately with `ln -sfn` after checking what it points at.

### Copy caveat

`mcp.json` resolves the server relative to `${PLUGIN_ROOT}`, two levels below the checkout root.
A plain copy into `~/.hermes/plugins/comfyrizz` breaks
`${PLUGIN_ROOT}/../../packages/comfyrizz-mcp/src/index.mjs`. Use the symlink above when you want
that relative path guaranteed. If your `hermes plugins install` copies rather than links, edit the
installed copy's `mcp.json` `args` to the checkout's
`packages/comfyrizz-mcp/src/index.mjs`, or replace the copy with a link.

### Check it

In a new Hermes chat, ask for `comfyrizz_status`. A healthy engine reports its status; a server
with no reachable engine returns `stub: true` (see below), which still proves the plugin loaded.

## Environment

`mcp.json` forwards only `${VAR}` references, so no credential is committed. Export these in the
environment that launches Hermes:

| Variable | Required | Meaning |
| --- | --- | --- |
| `COMFYRIZZ_ENGINE_URL` | for real tools | Loopback origin of the running Comfyrizz engine, for example `http://127.0.0.1:4319`. Unset or non-loopback: tools that need the engine return `stub: true`. |
| `COMFYRIZZ_TOKEN` | if the engine is token-protected | Engine access token. Use the token the engine prints or writes; never paste it into `mcp.json`. |
| `COMFYRIZZ_MCP_HTTP` | no | Set to `1` to serve MCP over Streamable HTTP on `127.0.0.1` instead of stdio. The plugin's `mcp.json` leaves it unset, so Hermes uses stdio. |
| `OPENCODE_API_KEY` | optional | Model-provider credential forwarded when the planning path needs OpenCode. |
| `OPENCODE_GO_API_KEY` | optional | Model-provider credential forwarded when the planning path needs OpenCode Go. |
| `OPENROUTER_API_KEY` | optional | Model-provider credential forwarded when the planning path needs OpenRouter. |

Model keys are not needed for planning against a stubbed server. The engine may hold its own
provider credentials instead; do not duplicate secrets into the plugin.

Do not export `COMFYRIZZ_MCP_HTTP=1` globally when Hermes launches the stdio plugin: the server
would listen on loopback instead of speaking stdio. For a standalone HTTP server, prefer the
`--http` flag described in [`docs/hermes-plugin.md`](../../docs/hermes-plugin.md).

The engine is the local server in [`apps/server`](../../apps/server/README.md):

```bash
cd apps/server
npm start        # 127.0.0.1:4319 by default; COMFYRIZZ_PORT overrides
```

`COMFYRIZZ_ENGINE_URL` must stay loopback. A URL for another host is refused and the server stays
in stub mode, so the MCP server never becomes a remote spend or data path.

## Stub mode vs. the real engine

| Condition | Behavior |
| --- | --- |
| `COMFYRIZZ_ENGINE_URL` set to a loopback origin and the engine is healthy | Tools call the engine and return real project, plan, job, take, assemble, export and retake data. |
| variable unset, empty or not loopback; engine down or unreachable | Tools that need the engine return `stub: true` instead of failing the chat. No generation starts and no spend is created. |
| `COMFYRIZZ_MCP_HTTP=1` | The same tools, served over Streamable HTTP on `127.0.0.1` only. |

Stub results are for wiring and demos, not a substitute for a run. Start the engine before expecting
real takes.

## The production loop and tools

Tools are named exactly as below; do not rename them in prompts or configs.

| Tool | Role |
| --- | --- |
| `comfyrizz_status` | Engine reachability, status and stub indicator |
| `comfyrizz_create_project` | Create a project for a film |
| `comfyrizz_list_projects` | List projects |
| `comfyrizz_plan` | Turn a brief into a plan in chat |
| `comfyrizz_get_plan` | Read the current plan |
| `comfyrizz_get_spend_card` | Show the spend card for the planned generation |
| `comfyrizz_accept_generation` | Record explicit acceptance for one approval; requires `approvalId`, otherwise `APPROVAL_REQUIRED` |
| `comfyrizz_job_status` | Progress for a generation job |
| `comfyrizz_list_takes` | Takes produced for the project |
| `comfyrizz_assemble` | CPU assembly of takes into the film |
| `comfyrizz_export` | Share-ready export |
| `comfyrizz_retake` | Granular retake of one shot or take |

A typical chat: `comfyrizz_create_project` → `comfyrizz_plan` → revise in chat →
`comfyrizz_get_spend_card` → `comfyrizz_accept_generation` with the pending `approvalId` →
`comfyrizz_job_status` → `comfyrizz_list_takes` → `comfyrizz_assemble` → `comfyrizz_export`, with
`comfyrizz_retake` for one shot that needs another pass.

Planning is free of generation spend. A generation that could spend on Google Colab or Comfy Cloud
starts only after a human explicitly accepts the spend card. Calling `comfyrizz_plan` or
`comfyrizz_get_spend_card` is not acceptance. `comfyrizz_accept_generation` must carry the pending
`approvalId`; without it the server returns `APPROVAL_REQUIRED`. If an agent cannot obtain a real
id, it must stop and ask, never invent one. There is no silent spend.

## The `comfyrizz-film` skill

The skill lives at [`skills/comfyrizz-film/SKILL.md`](skills/comfyrizz-film/SKILL.md). It keeps the
conversation on the loop above: plan first, revise on request, show the spend card, wait for an
explicit accept, then route generation and finish on CPU. If Hermes lists skills, confirm
`comfyrizz-film` appears next to the `comfyrizz` MCP server.

Using the same MCP server from Cursor or another agent is documented in
[`docs/hermes-plugin.md`](../../docs/hermes-plugin.md).

## Troubleshooting

| Symptom | Check |
| --- | --- |
| Tools return `stub: true` | `COMFYRIZZ_ENGINE_URL` is unset, not loopback, or the engine is not running. Start `apps/server` and retry `comfyrizz_status`. |
| `APPROVAL_REQUIRED` | Expected until a human accepts. Fetch the spend card and pass the pending `approvalId` to `comfyrizz_accept_generation`. |
| Server exits with `ENOENT` | The plugin was copied out of the monorepo, so the relative `${PLUGIN_ROOT}/../../packages/...` path no longer resolves. Link it back or fix the installed `mcp.json` args. |
| Hermes does not list the plugin | Run `hermes plugins list`, confirm the path passed to `hermes plugins install`, and restart Hermes. |
| MCP HTTP connection refused | Start the server with `COMFYRIZZ_MCP_HTTP=1` and use its loopback endpoint. It does not listen on other interfaces. |
| Engine rejects requests with `401` | `COMFYRIZZ_TOKEN` is missing or does not match the engine token. |

## Security

- Plugin files contain no secrets. `mcp.json` forwards `${VAR}` references only.
- Credentials stay in the launching environment or the engine, never in committed files or tool
  arguments.
- The engine URL must be loopback, and the optional MCP HTTP transport binds `127.0.0.1` only.
- Treat `APPROVAL_REQUIRED` as a gate, not an error to work around. Google Colab and Comfy Cloud
  spend always needs explicit acceptance.

## See also

- [`packages/comfyrizz-mcp`](../../packages/comfyrizz-mcp) — MCP server; exact tool implementations
- [`docs/hermes-plugin.md`](../../docs/hermes-plugin.md) — Cursor and other MCP clients, transports
- [`apps/server`](../../apps/server/README.md) — the Comfyrizz engine
- [`docs/ONE_PROMPT.md`](../../docs/ONE_PROMPT.md) — full Comfyrizz setup
- [`docs/features/production-agent.md`](../../docs/features/production-agent.md) — plans, approvals
  and spend in the production agent
