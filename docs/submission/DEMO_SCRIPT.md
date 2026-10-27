# Demo video plan: one prompt to a finished film (≤2:00)

**Status:** planned recording script. Replace bracketed placeholders with the
actual accepted outputs. Do not record this as a claim until the four real routes
have been reviewed. The official maximum is two minutes.

## Goal

Show a judge that ComfyRizz is easy to use and produces a strong result, then
explain enough of the build to make the innovation and model choices verifiable.
The managed demo already has inference configured; there is no setup montage.

## Cut

| Time | Picture | Voice / purpose |
| --- | --- | --- |
| **0:00–0:08** | Best finished shot from the Auto film, with its actual sound. Then the title **The Last Light** (or the accepted example title). | “One prompt becomes this film. Here is how ComfyRizz makes it—and lets you change it.” Lead with output, not a logo animation. |
| **0:08–0:20** | Managed demo home. Enter the same short brief. Select **Auto** and show the other options: H3, LTX and Klein only. | “The agent, model access and Google Colab are already configured. Auto uses Klein for identity art, LTX for camera and scenery, and H3 for character acting and native sound.” |
| **0:20–0:34** | The real concise proposal appears. Read the title/logline. Show duration, look, soundtrack and model route. Click **Make this film**. | “Before any GPU work, you get a short proposal. You can revise it, or approve it. No storyboard JSON and no per-shot spending dialog.” |
| **0:34–0:54** | Real-time or clearly labelled timelapse of the gallery: character/keyframe art, motion clips and sound arriving. Include one asset opening in its player. | “You watch the actual work arrive. These are collected assets, not placeholders or a simulated progress bar.” |
| **0:54–1:12** | Play the finished MP4 with sound, including a strong character action and the payoff. Show Download. | “The app finishes and plays the MP4 here. Klein, LTX and H3 each have a specific role; code handles exact text, timing and finishing.” |
| **1:12–1:30** | In **What would you like to change?**, enter a small real revision. Show the same project updating, then open Advanced mode with agent, preview, shots and takes. | “You can keep directing. The agent edits this project with stable scene IDs; Advanced mode gives you takes and the timeline. Paid regeneration stays scoped.” |
| **1:30–1:46** | Four-route contact sheet: Klein-only, H3-only, LTX-only and Auto. Include each real duration/cost result from the ledger, not estimates. | “You can also choose one model throughout. These four films used the same brief, so the tradeoffs are visible. Total test spend stayed within forty credits, including failures and retries.” |
| **1:46–1:58** | Small build diagram: proposal → pinned ComfyUI jobs → live assets → deterministic finishing → editable package. End on managed demo and public repo URLs. | “Pinned ComfyUI workflows, server-priced runs and verified teardown. MIT, with setup for Linux and native Windows. Try the managed demo or run it yourself.” |
| **1:58–2:00** | End card: **One prompt. Your film. Change anything.** `#OpenSourceHiggsfield` | No extra feature list. |

## Recording evidence

- Record the managed judge path at 1920×1080; use **Record this run** for real
  screen capture and the redacted step log.
- Keep the final film's actual sound. Muted playback or ASR is not listening
  approval.
- Label timelapse and any mocked capture fixture. `pnpm capture:procedure` is a
  fixture test, never evidence of real generation.
- Use exact measured credit deltas from the four result logs. If the total is
  different, change the script before recording; never read a stale figure.
- Do not show API keys, tokens, provider settings, private account balance,
  personal paths or server token fragments. The managed judge view needs none.
- Preserve each route's proposal, result log and MP4 so every on-screen claim can
  be checked.

## Innovation explanation (spoken or one caption)

“ComfyRizz turns a creative plan into per-shot ComfyUI workflows: Klein identity
art, LTX camera motion and H3 acting/native sound. Only reachable assets are
priced. Code renders exact type and charts, and the agent keeps editing the same
package. It is a complete, controllable film app—not a prompt box over one model.”

This is a specific claim. Do not say agentic video editing or code plus models
has never been done.

## Fallback

If a live judge run fails, show the accepted recorded output and the real error
state only if useful. Never replace failed H3/LTX footage with FLUX stills and
call it a motion-model success. The two-minute video is the fallback when the
managed app cannot be run.
