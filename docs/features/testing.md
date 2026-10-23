# Testing

| Command | Runs |
| --- | --- |
| `pnpm test` | Builds the libraries, then every workspace package's suite |
| `pnpm --filter @comfyrizz/server test` | Server suite (`apps/server/test`, including productions, characters, takes) |
| `pnpm --filter @comfyrizz/agent test` | Agent suite (tools, production guardrails, planner, eval CLI) |
| `pnpm --filter @comfyrizz/web test` | Web unit suite |
| `pnpm --filter @comfyrizz/web typecheck` | Web TypeScript check |
| `pnpm run test:browser` | Playwright e2e (Chromium, loopback only) |
| `pnpm run test:py` | `pipeline-py` pytest (needs the dev virtualenv) |
| `pnpm run test:scan` | Release scan for secrets and personal paths |
| `pnpm run check` | `test`, web typecheck and the scan |
| `node packages/agent/scripts/eval-production.mjs` | Production-agent behavioural eval (cassette replay) |
| `node packages/agent/scripts/eval-conversation.mjs` | Conversation eval |

Run the server locally with `cd apps/server && npm start` (or `npm run dev` to watch). GPU paths
use a fake `colab` CLI and a fake Comfy server, so no suite spends anything.
