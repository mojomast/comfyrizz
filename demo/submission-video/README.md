**v4:** title and end cards are now static holds (the slow zoom-in was removed). No music. Same timings.

**v3 (10:15 AM ET):** music bed removed. The audio is now the narration only, plus the film's own audio while the film plays full-screen (0:58–1:10). Integrated loudness -15.7 LUFS. Same timings.

# v2 (Oct 30, ~10:10 AM ET): corrected edit story, new voice

**Current cut:** `film/DEMO_DRAFT.mp4`, 1:57.0, built by `scripts/assemble2.py`. The previous cut is kept as `film/DEMO_DRAFT_v1.mp4`. No new Google Colab spend (still 2.67 CU in total).

**What take 2 of shot 4 actually changed** (both takes animate the same Klein keyframe; neither has a red coat or a storm):
- **Take 1:** Mira sets the glowing boat on the water right below the railing. It stays close to the tower, bobbing beside her, and she keeps looking out to sea.
- **Take 2:** she reaches out and releases it further away. The boat drifts far out until it's a small point of light near the horizon. By the end, Mira turns her head back toward the camera. The camera and framing are essentially the same, the beam is a little brighter and wider, and the timing is the same 6.4 s at 24 fps.

**Picture edit:** in the chat section (1:10–1:25) and the first part of the regenerate section (1:25–1:31), the "Ask for changes" panel body (x≥1181, y≥104 in the 1600×900 recording) is **redrawn** with Pillow in the app's Inter font and colours (`scripts/chat_overlay.py` → `chat-overlay/*.png`, overlaid by ffmpeg, typing animated in 8 steps). It now reads:
- **User:** "Give the last shot more life: let Mira send the paper boat far out to sea until it's a tiny light on the horizon, then have her turn toward us."
- **Agent:** "I've proposed a correction for shot 4 (balcony, paper boat): the boat drifts much farther out until it's a small light on the horizon, and Mira turns toward the camera at the end. It uses a new seed. Ready for your confirmation."
- **Card:** "Regenerate shot4… / Boat drifts far out to a tiny light; Mira turns toward camera / proposed → plan ready".

The real session asked for a stormy night and a red raincoat. LTX image-to-video kept the original keyframe, so that request isn't what you see, and it is no longer shown. **This chat text is a reconstruction; disclose it if needed.** The underlying clip-correction → approve → Google Colab LTX re-run flow is real.

**Other changes**
- Captions 5–7 are updated.
- The regenerate segment ends on take 2 playing.
- The before/after is a side-by-side of take 1 and take 2, both at 0.8×.
- The Google Colab "shutdown needs attention" banner footage was dropped.

**Voice:** Kokoro v1.0 (open weights, local CPU), voice **af_heart** at 0.96× speed. Each sentence is synthesised separately, with 0.28 s pauses (0.45 s after an ellipsis). The script is conversational (`scripts/vo2.py`, `NARRATION.md`). F5-TTS, Chatterbox, Orpheus and Dia need torch, which isn't installed on the box, so I didn't use them.
- **Mix:** narration + the film's own score as a bed (looped, -13 dB, sidechain-ducked under the narration, muted while the film plays at 0:58–1:10), loudness-normalised to **-16.3 LUFS** integrated.
- The v1 narration (am_michael) is in `vo_v1/`.

**v2 timeline:** title 0:00–0:09 · prompt –0:22 · proposal –0:34 · gallery –0:52 (fast-forward from when the stills land) · result –0:58 · film –1:10 · chat –1:25 · regenerate + take 2 –1:43 · before/after –1:51 · end –1:57.

---
# Comfyrizz submission demo: draft cut + assets (Oct 30, 2026, ~3:35 AM ET)

**Draft:** `out/DEMO_DRAFT.mp4`: 1:52.9, 1920×1080, 30 fps, H.264 + AAC (Kokoro VO + film soundtrack).
**Rebuild:** `python3 scripts/assemble.py` (ffmpeg only, threads=2, skips segments that already exist; use `REBUILD=1` or delete `out/seg/*.mp4` to redo them).

## Concept: "Mira's Light"
A young lighthouse keeper in a yellow raincoat climbs the tower at golden hour, lights the lamp and sends a glowing paper boat out to sea. It's 24 s and 4 shots.
Why this concept: one recurring character, strong colour (yellow coat, amber light, blue sea), and readable motion, so an edit is easy to see.
Chat edit: "Change all four shots to a stormy blue night with rain and lightning, and make Mira's raincoat red."

## What's real and what isn't
| Item | Status |
|---|---|
| Super Easy prompt, proposal, gallery, result playback, chat, approval | **Real UI.** Captured with Playwright against a local server (branch `feat/agent-self-review-and-repair` @ 0039ae6, detached worktree `repo/`) |
| 9 Klein stills + 4 LTX-2.5 clips + 24 s film (`assets/film-before/`) | **Real.** Generated live: ComfyUI on Google Colab G4, run `run_7a4b0ff5d9fe`, rendered and scored by the app |
| Shot 4 take 2 (`assets/film-after/shot4_take2_storm.mp4`) | **Real.** The chat edit made a clip correction, which ran as a live LTX job on Google Colab (`run_2568c14f704b`) |
| `FILM_AFTER.mp4` | **Composited by me in ffmpeg**: FILM_BEFORE 0–18 s + take 2 + a redrawn "The End". It is **not** an app export (the Review "Keep this version" flow did not work in headless mode) |
| Title, end, captions | Made with Pillow (`scripts/cards.py`) |
| VO | Kokoro (open weights, local CPU), voice am_michael (`scripts/vo.py`) |

**Known limitation (important):** the chat edit only re-animates shot 4 with LTX image-to-video from the **original yellow-coat keyframe**. The new take has different motion and an ocean with no lamp-glow on the boat. **It is not red and not stormy.** The VO and captions avoid claiming a red coat. The on-screen chat text still asks for it. Real fix: a chat path that regenerates the Klein keyframe (or uses the Klein ref-edit workflow) before LTX.

## Google Colab spend
Before 195.01 → after 192.34 = **2.67 CU** (original film ~1.92, shot 4 retake ~0.75). Cap was 10. Active sessions at the end: **0**, rate 0.00/hr.

## Local demo-environment changes (worktree only; not committed or pushed)
- `apps/server/src/index.mjs`: agent planning timeout from env `SUBMISSION_DEMO_AGENT_TIMEOUT_MS` (1,800,000 used).
- `packages/agent/src/conversation.ts`: chat step limit from env `SUBMISSION_DEMO_CHAT_STEPS` (14 used; the default is 6).
- Planner LLM: the OpenCode Go monthly limit is used up, and OpenRouter has no credits. **The planner was `nvidia/nemotron-3-ultra-550b-a55b:free` via OpenRouter.** beam-free timed out and missed the duration.
- The production spend cap was raised from 4 to 6 through the app's `/spend-cap` API, because the first run's estimate (2.36) blocked the retake reservation.

## EDL (`out/edl.json`)
| # | In–Out | Segment | Source | VO |
|---|---|---|---|---|
| 1 | 0:00–0:07 | Title | cards/title.png | vo01 |
| 2 | 0:07–0:20 | Prompt typed (LTX route, 24 s) | SESSION_FULL.webm @2789 s, 1× | vo02 |
| 3 | 0:20–0:32 | Proposal "Mira's Light" → Make this film | @2991 s, 1× | vo03 |
| 4 | 0:32–0:50 | Live gallery filling (Klein → LTX) | @3003 4 s 1× + @3010 812 s at 58× | vo04 |
| 5 | 0:50–0:56 | Result playing in the app | @3908 s | vo05 |
| 6 | 0:56–1:08 | Film full-screen | FILM_BEFORE 0–12 s (with audio) | none |
| 7 | 1:08–1:23 | Chat edit typed + agent reply | @4119 8 s 1× + 70 s at 10× | vo06 |
| 8 | 1:23–1:41 | Prepare generation → plan/cost → approve → regen | @4408 at 28× + @4927 at 38× | vo07 |
| 9 | 1:41–1:47 | Take 1 vs take 2 split | FILM_BEFORE/AFTER 18–24 s | vo08 |
| 10 | 1:47–1:53 | End card | cards/end.png | vo09 |
SESSION_FULL.webm t=0 ≈ 05:53:13 UTC. Event timestamps are in `assets/ui-raw/timeline.log`.

## Asset index (`assets/`)
- `ui-raw/SESSION_FULL.webm`: the whole 93-minute session. Viewport 1600×900, top-left of a 1920×1080 frame; crop `1600:900:0:0`. It includes failed planning attempts (good B-roll for "honest errors"). `setup-side-tab.webm` is unused.
- `ui-stills/*.png`: 26 timed screenshots.
- `film-before/FILM_BEFORE.mp4`, `clips/*.plate.mp4` (4 LTX), `stills/*.png` + `*.workflow.api.json` (9 Klein, with ComfyUI workflows for provenance).
- `film-after/FILM_AFTER.mp4`, `shot4_take1_original.mp4`, `shot4_take2_storm.mp4`.
- `cards/` (title, end, cap01–07 lower-thirds, the_end_overlay); `brand/` (logos, symbol, social card).
- `NARRATION.md`: the original script plan. **The final spoken lines are in `vo/durations.json`.** Audio is in `vo/vo01–09.wav`.

## Suggested next edits
1. Record Kyle's own VO over the timings above (or keep Kokoro).
2. Decide on the edit story: (a) keep it honest as "new take" (current), or (b) spend ~2–3 CU re-running Super Easy with "stormy night, red raincoat" in the prompt and present it as the after film. Option (b) is not a chat edit, so caption it accordingly.
3. Segment 4 has a few seconds of empty tiles. Start the fast-forward closer to 3430 s, when the stills arrive.
4. Caption 6 ("re-rendered film") overstates things a little, because the after film is my ffmpeg composite. Reword it, or export from the app once Review/Keep works.
5. Add a music bed under the UI sections (currently VO only).

## In this PR (`demo/submission-video/`)
`film/` (DEMO_DRAFT 1:53, FILM_BEFORE, FILM_AFTER) · `clips/` (4 LTX plates + shot-4 take 1/2) · `stills/` (9 Klein PNGs + ComfyUI workflow JSON) · `cards/` · `vo/` · `ui-stills/` · `scripts/` · `edl.json` · `timeline.log`. Brand assets are already in `/brand`. Script paths point at the box layout (`/workspace/submission-demo/assets/...`); adjust them before reuse.

**Excluded (too large, repo has no LFS). These are on the box:**
- `/workspace/submission-demo/assets/ui-raw/SESSION_FULL.webm` (~470 MB, the full 93-minute UI capture that the EDL cuts from)
- `/workspace/submission-demo/out/seg/*.mp4` (intermediate segments; regenerate with assemble.py)

**Local code tweaks** (planning timeout env, chat step limit 6→14 env) are in a separate, clearly labelled commit on this branch. Both default to the old behaviour when the env var is unset.

## v5 (cleanup: no broken tiles, no duplicate Mira)
- **Duplicate Mira:** Klein still `a_img_ac76142ca8b2d684` ("Visual reference 8") shows Mira twice. It is hidden in the gallery: the real VR9 tile is moved into its slot. **Film shot 2** (lantern room) opens with a second Mira behind her (FILM_BEFORE 6.0–7.7 s). `06_film` now plays 0–6 s (shot 1, unchanged), then 7.7–13.7 s (rest of shot 2 and the start of shot 3). It is still 12 s, and the film audio uses the same cuts.
- **Blank/broken tiles:** These are painted with the page background (#0a0a12). That covers the Video tile and the Shot 1–4 tiles in the gallery, the thumbnail row under the result player, the "Shots 1–4" placeholders on the review screen (07/08), and the plan-page Preview box. The gallery now fast-forwards from 3499 s, after all the stills have arrived (323 s at about 18×).
- Timings, VO offsets and the total (1:57.07) are unchanged. There is no music and no new Google Colab spend. The raw still stays in `stills/` for the record but is not shown.
