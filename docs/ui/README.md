# Comfyrizz web UI — U1 before/after

For the next editor iteration, see the [frontend editor research and implementation
plan](../FRONTEND_EDITOR_PLAN.md): linked scene tracks, preview/export parity,
undo/autosave, pre-GPU preparation and overall usability improvements.

Screenshots captured with headless Chrome (1440×900) against `apps/server`
serving a production `apps/web` build. `u1-before.jpg` is the pre-U1 shell;
the `u1-after*.jpg` shots are the U1 polish pass.

| File | What it shows |
| --- | --- |
| `u1-before.jpg` | Pre-U1: stale "C1 shell · agent in C3" copy, `local · scripted` with no provider status, no GPU queue, light empty states. |
| `u1-after.jpg` | U1: agent-facing copy, server-side provider status (`OpenCode Go · configured`), GPU queue + empty states, scene card selection. |
| `u1-after-agent.jpg` | U1 after submitting a brief: the composer ran the local agent, the storyboard/assets refreshed, and the GPU-pending asset is carded with its procedural fallback and `pending spend` chip. |
| `r2-plan-mode.png` | R2 Plan mode: the composer asked two chip questions (look + real numbers) before building anything; every chip has a **Decide for me** default. |
| `r2-brief-card.png` | R2 step 4: the editable Brief card after those chips — seven fields plus the script-first outline (hook/point/proof/CTA with per-beat seconds, the target and the fit), with **Update outline** and **Build video**. |
| `r2-style-presets.png` | R2 step 5: the six bundled looks (Clay, Glass, Editorial flat, Isometric tech, Paper cut, Cinematic dark) as CPU/SVG thumbnails in the Brief card, chosen before any GPU spend. |
| `r2-scene-chips.png` | R2 step 5: the per-scene edit chips (Warmer, Calmer motion, More depth, Less busy) on every storyboard card; a tap applies a fixed scene-local edit and re-runs only that scene. |

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

### Step 4: the editable Brief card and the script-first outline

Once the chips are answered, `r2-brief-card.png` is what the composer shows: an editable Brief card
(key message, audience, seconds, CTA, aspect, look, narration) above a script-first outline. Each
outline beat shows its role, headline, narration line and estimated spoken seconds, followed by the
on-screen estimate, the target and a `short`/`on-target`/`long` fit plus honest notes (a missing
fact is a visible placeholder; a missing CTA still closes). **Update outline** re-posts the edited
brief to `POST /api/brief/outline`; **Build video** serialises the card into the existing
`POST /api/agent` brief. Express still builds straight from the prompt.

### Step 5: the six style presets (CPU/SVG thumbnails)

`r2-style-presets.png` shows the Look picker inside the Brief card: the six bundled looks (Clay,
Glass, Editorial flat, Isometric tech, Paper cut, Cinematic dark) as tappable 160×90 thumbnails. The
SVGs are generated on the CPU from each preset's own palette in `packages/agent` and shipped by
`GET /api/brief/presets` (also inlined in every `/api/brief` / `/api/brief/outline` reply), so the
look is chosen and locked **before** any GPU spend. Tapping a thumbnail updates the hidden
`style.preset` field the card already reads. GPU-rendered moodboards can replace the thumbnails
later without changing the ids.

### Step 5b: the per-scene edit chips

Every storyboard card now carries four fixed edit chips — **Warmer**, **Calmer motion**, **More
depth**, **Less busy** (`r2-scene-chips.png`). They map to deterministic, scene-local edits in
`packages/agent` (`applySceneChip`): warming the scene's procedural palette, softening entrances to a
fade, adding a parallax drift with a higher `z`, or trimming bullets/overlays/a busy pattern. The
server (`POST /api/scene/chip`, `GET /api/scene/chips`) saves the edit through the validating store
and the web then re-runs only that scene through the C11 incremental renderer. Because nothing
touches `theme`, `preferredFrames` or the format, every other scene keeps its cached segment.
