# Hermes plugin and shared MCP setup

Comfyrizz ships a local Hermes plugin at [`plugins/comfyrizz`](../plugins/comfyrizz/README.md).
Hermes is the chat frontend for the product loop:

> brief → plan in chat → revise → explicit accept → generate (ComfyUI, Comfy API or Google Colab) → CPU assemble → share export → granular retake

The plugin bundles the `comfyrizz-film` skill and starts the `comfyrizz` MCP server from
[`packages/comfyrizz-mcp`](../packages/comfyrizz-mcp). This page covers the MCP contract,
installing it for Hermes, and attaching the same server to Cursor or another MCP client.

**Status: local install only, v0.1.0.** There is no Hermes plugin catalog entry and no catalog PR
has been opened. Install from a checkout; nothing here depends on a catalog listing.

## What Hermes loads

| File | Contract |
| --- | --- |
| [`plugin.json`](../plugins/comfyrizz/plugin.json) | name `comfyrizz`, version `0.1.0`, license MIT |
| [`mcp.json`](../plugins/comfyrizz/mcp.json) | one stdio MCP server named `comfyrizz` |
| [`skills/comfyrizz-film/SKILL.md`](../plugins/comfyrizz/skills/comfyrizz-film/SKILL.md) | skill `comfyrizz-film` |

`mcp.json` starts the server as:

```json
{
  "command": "node",
  "args": ["${PLUGIN_ROOT}/../../packages/comfyrizz-mcp/src/index.mjs"],
  "cwd": "${PLUGIN_ROOT}"
}
```

`${PLUGIN_ROOT}` is Hermes's plugin directory. The `../../packages/...` path assumes the plugin is
still inside `plugins/comfyrizz` in this monorepo. Keep it linked there. If your
`hermes plugins install` copies the plugin into the Hermes plugin directory, that relative path
breaks; apply the fix in the [install section](../plugins/comfyrizz/README.md#install-into-hermes).

## Install locally for Hermes

From the checkout root:

```bash
pnpm install
hermes plugins install ./plugins/comfyrizz
hermes plugins list
```

Or link the directory so edits are live:

```bash
mkdir -p ~/.hermes/plugins
ln -s "$PWD/plugins/comfyrizz" ~/.hermes/plugins/comfyrizz
```

Restart Hermes after either step. The detailed prerequisites, copy caveat and post-install check are
in the [plugin README](../plugins/comfyrizz/README.md#install-into-hermes).

## Start the engine first

The MCP server is a front for the Comfyrizz engine, not a replacement for it. Tools that need
state or generation return `stub: true` unless the engine is reachable at a loopback URL.

```bash
cd apps/server
npm start        # 127.0.0.1:4319 by default; COMFYRIZZ_PORT overrides
```

In the agent, call `comfyrizz_status`. A real engine answers with its status; a stubbed process
answers with `stub: true`.

Rules that apply to every client:

| Setting | Effect |
| --- | --- |
| `COMFYRIZZ_ENGINE_URL` set to a loopback origin, engine healthy | Real project, plan, job, take, assemble, export and retake results |
| `COMFYRIZZ_ENGINE_URL` unset, empty, non-loopback, or engine down | Tools that need the engine return `stub: true`; nothing generates and nothing spends |
| `COMFYRIZZ_TOKEN` set to the engine's token | Authenticates engine requests when the engine is token-protected |
| `COMFYRIZZ_MCP_HTTP=1` | Serves MCP over Streamable HTTP on `127.0.0.1` instead of stdio |

A non-loopback engine URL is refused. Do not expose the engine or the HTTP MCP transport on a LAN,
tailnet or public interface; both are local-only by design.

## One MCP server, several agents

All clients use the same server name (`comfyrizz`), the same tool names and the same environment
contract. Only the launch syntax differs.

| Client | Transport | Where the server comes from |
| --- | --- | --- |
| Hermes | stdio (default) | `plugins/comfyrizz/mcp.json` |
| Cursor (project config) | stdio | `.cursor/mcp.json` |
| Cursor (global config) | stdio | `~/.cursor/mcp.json`, with a checkout path |
| Other MCP clients | stdio | their own server config |
| Any Streamable HTTP client | HTTP on loopback | `node ... --http` |

Each stdio client spawns its own MCP server process. They can all talk to the same engine, but keep
one engine instance; the engine owns the state and the CPU render queue. For an HTTP client, start
the server once and register its loopback endpoint.

### Cursor

Create `.cursor/mcp.json` at the repository root. Cursor resolves `${workspaceFolder}` to the
project root and `${env:NAME}` to the environment of the Cursor process.

```json
{
  "mcpServers": {
    "comfyrizz": {
      "command": "node",
      "args": ["${workspaceFolder}/packages/comfyrizz-mcp/src/index.mjs"],
      "env": {
        "COMFYRIZZ_ENGINE_URL": "${env:COMFYRIZZ_ENGINE_URL}",
        "COMFYRIZZ_TOKEN": "${env:COMFYRIZZ_TOKEN}",
        "OPENCODE_API_KEY": "${env:OPENCODE_API_KEY}",
        "OPENCODE_GO_API_KEY": "${env:OPENCODE_GO_API_KEY}",
        "OPENROUTER_API_KEY": "${env:OPENROUTER_API_KEY}"
      }
    }
  }
}
```

Export `COMFYRIZZ_ENGINE_URL` (and a token, if the engine uses one) before launching Cursor, or set
them in the shell profile Cursor starts from. Do not replace `${env:...}` with literal credentials
in a file that can be committed. If a variable is not used in your setup, remove that line; an empty
value is treated as unset.

After saving, restart the MCP server from Cursor's MCP settings or reload the window, then ask for
`comfyrizz_status`.

For a global `~/.cursor/mcp.json`, `${workspaceFolder}` is not the Comfyrizz checkout. Use the
checkout's own path in `args`, or run the server with a `cwd` set to the checkout if your Cursor
version supports it.

### Other stdio MCP clients

Use the same command and environment in the client's `mcpServers` format. Most clients support this
shape:

```json
{
  "mcpServers": {
    "comfyrizz": {
      "command": "node",
      "args": ["<absolute-path-to-checkout>/packages/comfyrizz-mcp/src/index.mjs"],
      "env": {
        "COMFYRIZZ_ENGINE_URL": "http://127.0.0.1:4319"
      }
    }
  }
}
```

Replace `<absolute-path-to-checkout>` with the checkout root; after the repository's `pnpm install`,
the server runs directly from source with no build step. Some clients also accept a `cwd`, in which
case a relative `packages/comfyrizz-mcp/src/index.mjs` works. Clients that inject environment from
the parent process can omit `env` and inherit `COMFYRIZZ_ENGINE_URL` and `COMFYRIZZ_TOKEN` instead.

For a token-protected engine, never put the token in a project config. Export it in the environment
that launches the client, or use the client's own secret store. `COMFYRIZZ_TOKEN` belongs in the
server environment, not in `args` and not in chat.

### Shared Streamable HTTP

For clients that share one long-lived process instead of spawning one per client:

```bash
node packages/comfyrizz-mcp/src/index.mjs --http
```

`COMFYRIZZ_MCP_HTTP=1` is the environment-variable equivalent. Prefer `--http` for the shared
process: the variable is inherited by every child, so exporting it also switches Hermes's own
stdio server to HTTP. Do not export it in the environment that launches Hermes.

The process serves Streamable HTTP on `127.0.0.1`. Register its loopback endpoint as an HTTP or
Streamable HTTP server in each client:

```json
{
  "mcpServers": {
    "comfyrizz": {
      "url": "<loopback MCP endpoint>"
    }
  }
}
```

It binds loopback only and has no remote authentication; it is not a remote service. Do not proxy
it to another host. If a client only speaks stdio, use the stdio command instead; setting
`COMFYRIZZ_MCP_HTTP=1` in a stdio entry makes the process listen instead of speaking stdio.

## Spend, approvals and stub results

Every client gets the same approval gate.

1. `comfyrizz_plan` and revision happen in chat and do not spend generation money.
2. `comfyrizz_get_spend_card` shows the planned route and estimate.
3. `comfyrizz_accept_generation` records explicit acceptance and requires the pending `approvalId`.
   Without it the server returns `APPROVAL_REQUIRED`.
4. `comfyrizz_job_status` reports progress; `comfyrizz_list_takes`, `comfyrizz_assemble`,
   `comfyrizz_export` and `comfyrizz_retake` finish the loop.

Google Colab and Comfy Cloud spend always requires that explicit acceptance. A tool call, a retry,
or an agent's statement that the user "probably approves" is not acceptance. If the approval id is
missing, stop and ask; never invent one. The full tool list with exact names is in the
[plugin README](../plugins/comfyrizz/README.md#the-production-loop-and-tools).

`stub: true` means the MCP server could not reach a loopback engine. It is safe and free, but it is
not a production result. Start the engine and retry `comfyrizz_status` before treating missing data
as a plugin failure.

## Troubleshooting

| Symptom | Likely cause and fix |
| --- | --- |
| `stub: true` in every client | Engine is down, or `COMFYRIZZ_ENGINE_URL` is unset or not a loopback URL. Start `apps/server` and check the value. |
| Hermes lists no `comfyrizz` server | Plugin not installed, installed path is wrong, or Hermes was not restarted. Run `hermes plugins list`. |
| Server exits with `ENOENT` | The plugin was copied outside the monorepo and `${PLUGIN_ROOT}/../../packages/...` no longer resolves. Link it back or fix the installed `mcp.json` args. |
| Cursor does not show the tools | Check Cursor's MCP logs, confirm `.cursor/mcp.json` is valid JSON, and restart the server. |
| `401` from the engine | `COMFYRIZZ_TOKEN` is missing or does not match the engine's token. |
| `APPROVAL_REQUIRED` | Working as intended. Fetch the spend card, then call `comfyrizz_accept_generation` with the pending `approvalId`. |
| HTTP MCP connection refused | Start with `COMFYRIZZ_MCP_HTTP=1`, use its loopback endpoint, and do not use a LAN or public address. |

## Security and scope

- No secrets in plugin files. `mcp.json` forwards `${VAR}` references only, and external client
  configs should interpolate environment variables or use the client's secret store.
- `COMFYRIZZ_ENGINE_URL` and the optional MCP HTTP listener are loopback only.
- The engine must be running for non-stub tools; stubbed responses never generate or spend.
- Google Colab and Comfy Cloud spend always requires explicit acceptance; see above.
- There is no hermes-agent catalog PR for this plugin. Installation is from this repository only.

## See also

- [Comfyrizz Hermes plugin](../plugins/comfyrizz/README.md) — install, environment, tools,
  troubleshooting
- [`packages/comfyrizz-mcp`](../packages/comfyrizz-mcp) — server entry point and tool handlers
- [`skills/comfyrizz-film/SKILL.md`](../plugins/comfyrizz/skills/comfyrizz-film/SKILL.md) — the film
  skill
- [`apps/server`](../apps/server/README.md) — the Comfyrizz engine and its API
- [Production agent](features/production-agent.md) — plans, approvals, budget and spend cap
- [One prompt setup](ONE_PROMPT.md) — full local setup
