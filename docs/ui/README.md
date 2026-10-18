# Comfyrizz web UI — U1 before/after

Screenshots captured with headless Chrome (1440×900) against `apps/server`
serving a production `apps/web` build. `u1-before.jpg` is the pre-U1 shell;
the `u1-after*.jpg` shots are the U1 polish pass.

| File | What it shows |
| --- | --- |
| `u1-before.jpg` | Pre-U1: stale "C1 shell · agent in C3" copy, `local · scripted` with no provider status, no GPU queue, light empty states. |
| `u1-after.jpg` | U1: agent-facing copy, server-side provider status (`OpenCode Go · configured`), GPU queue + empty states, scene card selection. |
| `u1-after-agent.jpg` | U1 after submitting a brief: the composer ran the local agent, the storyboard/assets refreshed, and the GPU-pending asset is carded with its procedural fallback and `pending spend` chip. |
| `r2-plan-mode.png` | R2 Plan mode: the composer asked two chip questions (look + real numbers) before building anything; every chip has a **Decide for me** default. |

Reproduce:

```sh
npm --prefix apps/web run build
COMFYRIZZ_RUNTIME=/tmp/comfyrizz-ui node apps/server/src/index.mjs   # prints /#token=…
# open the printed URL, send a brief, then compare against these shots
```

Notes:

- Provider keys never reach the browser. The header only reports the *presence*
  of a server-side key via `GET /api/providers` (authenticated, booleans only).
- GPU-pending assets are shown with their procedural fallback preview and a
  `pending spend` chip; nothing is approved or spent by opening the page.

## R2 plan mode

`r2-plan-mode.png` is the **Plan** composer after one brief. The Plan/Express toggle sits next to
the send button; Plan posts the prompt to `POST /api/brief` (no model, no spend) and shows the top
≤3 chip questions with a **Decide for me** default per question. Nothing is built until **Looks
right** is pressed; Express skips the questions and builds immediately. The screenshot was captured
the same way as the U1 shots (headless Chrome 1440×900 against the production build).
