# Comfyrizz web UI

Easy is the studio. Its steps are Idea, Characters, Iteration level, Plan, Generate, Review and Export. Advanced is the editor: chat, preview, inspector and timeline. The studio header says **Open in editor**. The editor top bar says **Back to studio**. Both open the same video.

Words in this note follow that vocabulary. An **Idea** is what the user typed, plus length, shape and look. A **Plan** is the script, the shot list, what will be made, and the most it can cost. A **Shot** is one scene of the video, numbered from 1. **Generate** makes the planned shots. **Export** makes the final MP4 and files. **This computer** is free motion graphics with no network. **Google Colab** is the rented GPU and spends Google Colab units, up to the video's **spend cap**. The **AI provider** is the service that writes scripts and chats.

To film a Generate run for a demo, see [PROCEDURE_CAPTURE.md](PROCEDURE_CAPTURE.md).

For the editor work behind these shots, see the [frontend editor research and implementation plan](../FRONTEND_EDITOR_PLAN.md): linked shot tracks, preview and Export staying in step, undo and autosave, preparation before any Google Colab spend, and overall usability.

The images are the U1 and R2 captures (headless Chrome, 1440×900) of `apps/server` serving a built `apps/web`. `u1-before.jpg` is the shell before U1. The `u1-after*.jpg` images are the U1 polish pass. Button labels drawn on those images are the ones the shell used then. This note names the same controls with the studio and editor words.

| File | What it shows |
| --- | --- |
| `u1-before.jpg` | Before U1: stale "C1 shell · agent in C3" copy, `local · scripted` with no AI provider status, no Google Colab queue, light empty states. |
| `u1-after.jpg` | U1: agent-facing copy, server-side AI provider status (`OpenCode Go · configured`), a Google Colab queue, empty states, and shot selection. |
| `u1-after-agent.jpg` | U1 after an idea is sent: the composer ran the local agent, the plan and assets refreshed, and the asset still waiting on Google Colab is carded with its procedural fallback and a chip showing that the Google Colab spend has not started. |
| `r2-plan-mode.png` | The plan questions: the composer asked two chips (look and real numbers) before making anything. Every chip has a **Decide for me** default. |
| `r2-brief-card.png` | The editable Plan after those chips. Seven fields, then the script (hook, point, proof and CTA, with seconds per beat, the target and the fit). The image labels the actions **Update outline** and **Build video**; those actions refresh the plan and **Generate**. |
| `r2-style-presets.png` | The six bundled looks (Clay, Glass, Editorial flat, Isometric tech, Paper cut, Cinematic dark) as thumbnails drawn on this computer, chosen on the Plan before any Google Colab spend. |
| `r2-scene-chips.png` | Per-shot edit chips (Warmer, Calmer motion, More depth, Less busy) on every shot in the plan. A tap applies a fixed edit on that shot and tries that shot again. |

Reproduce:

```sh
npm --prefix apps/web run build
COMFYRIZZ_RUNTIME=/tmp/comfyrizz-ui node apps/server/src/index.mjs   # prints /#token=…
# open the printed URL, send an idea, then compare against these shots
```

Notes:

- AI provider keys stay on the server. The header only reports that a key is present, via `GET /api/providers` (authenticated, booleans only).
- An asset still waiting on Google Colab is shown with its procedural fallback and a chip for spend that has not started. Opening the page does not start Google Colab spend.

## Plan questions

`r2-plan-mode.png` is the composer after one idea, on the older Plan/Express control beside the send button. Plan posts the idea to `POST /api/brief` (no AI provider call, no spend) and shows up to 3 chip questions, each with a **Decide for me** default. Nothing is made until **Looks right** is pressed. Express skips the questions and Generates immediately. The screenshot was captured the same way as the U1 shots (headless Chrome, 1440×900, against the built app).

### The editable Plan

Once the chips are answered, `r2-brief-card.png` is the editable Plan: key message, audience, seconds, call to action, shape, look and narration, then the script. Each beat shows its role, on-screen words, narration line and estimated spoken seconds, followed by the on-screen estimate, the target, a `short` / `on-target` / `long` fit, and honest notes (a missing fact is a visible placeholder; a missing call to action still closes). **Update outline** on the image re-posts the edited idea to `POST /api/brief/outline` and refreshes the plan. **Build video** on the image is **Generate**: it sends the plan to `POST /api/agent`. Express still Generates straight from the idea.

### The six looks, drawn on this computer

`r2-style-presets.png` shows the look picker on the Plan: the six bundled looks (Clay, Glass, Editorial flat, Isometric tech, Paper cut, Cinematic dark) as tappable 160×90 thumbnails. The SVGs are drawn on this computer from each look's own palette in `packages/agent` and shipped by `GET /api/brief/presets` (also inlined in every `/api/brief` and `/api/brief/outline` reply), so the look is chosen and locked before any Google Colab spend. Tapping a thumbnail updates the hidden `style.preset` field the Plan already reads. Moodboards made on Google Colab can replace the thumbnails later without changing the ids.

### Per-shot edit chips

Every shot in the plan carries four fixed edit chips: **Warmer**, **Calmer motion**, **More depth** and **Less busy** (`r2-scene-chips.png`). They map to deterministic edits on that shot in `packages/agent` (`applySceneChip`): warming the shot's procedural palette, softening entrances to a fade, adding a parallax drift with a higher `z`, or trimming bullets, overlays and a busy pattern. The server (`POST /api/scene/chip`, `GET /api/scene/chips`) saves the edit through the validating store, and the web then tries that shot again through the C11 path. Because the edit leaves `theme`, `preferredFrames` and the format untouched, every other shot keeps its cached segment.
