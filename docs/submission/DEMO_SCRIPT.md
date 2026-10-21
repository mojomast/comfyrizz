# Demo video script (S08)

Demo video for the Comfy Open Source Higgsfield hackathon entry. The seven beats
map 1:1 to the outline in `docs/SPEC.md` section 11, with its exact time ranges.
Total runtime: **2:00** (the section 11 ceiling; the beats sum to exactly
10+20+20+20+20+15+15 = 120 s).

The official rules require the video to show the work in action and explain how
it was built, and — for Most Innovative — to explain why the entry is innovative
(`docs/specs/SUBMISSION.md` §1). Beat 5 is that spoken explanation; §3 below is
the same argument in writing for the form.

**Sources:** `docs/SPEC.md` §11 (beats), `docs/specs/DEMO_WEBAPP.md` (demo page
regions and fixture mode), `docs/specs/SUBMISSION.md` (deliverable), repo files
cited inline. Anything the repo does not confirm is marked [unverified].

## 1. Shot list

| # (SPEC §11) | Time | On screen | Voiceover | UI action | Fallback if the live step fails |
| --- | --- | --- | --- | --- | --- |
| 1 — Hook | 0:00–0:10 | The finished 20 s launch hook full screen: `examples/hook-20s` (566 frames @ 30 fps, 18.867 s, 1920×1080, CPU export per `apps/renderer/README.md`) | "This is Comfyrizz: describe a launch in chat, get a finished, narrated motion-graphics video — open source, on your compute." | Open the demo page and press play in the preview player, which loads the hook example (`docs/specs/DEMO_WEBAPP.md`, beat 1) | Cut in the pre-rendered clip `examples/hook-20s/out/hook-20s.mp4`, produced offline with `node apps/renderer/scripts/render-package-example.mjs --example examples/hook-20s` |
| 2 — Brief | 0:10–0:30 | Chat panel: the brief is typed; model badge reads "<model> - any OpenAI-compatible model works"; storyboard appears with 6 scene chips (`examples/launch-demo`: title, hero, stat, chart, list, outro); a chart value is edited and the preview redraws | "You type the brief. The agent — any OpenAI-compatible model — proposes a six-scene storyboard. Change one chart value and the preview updates instantly. No GPU." | Type the brief in the chat panel and send; when the storyboard renders, edit the chart value on the chart scene and watch the preview update in place | Re-record from fixture mode (deterministic canned agent reply — `apps/web/test/demo-fixture.test.mjs` asserts two runs are equal), or cut to the earlier capture of the same sequence |
| 3 — Assets with receipts | 0:30–0:50 | Licence-chip row: approved **CC BY** Openverse chip with creator and source link, refused **CC BY-NC** chip with its reason, and a generated (CC0) chip; then a scene marked "generate" showing the short intent and its expanded FLUX 3 Klein caption | "Assets arrive with receipts. A CC BY image from Openverse, approved with its credit; a non-commercial one refused with the reason. A generate scene shows the short intent and its expanded FLUX 3 Klein caption." | Focus the licence chips (approve the CC BY candidate, show the blocked NC reason), then open the generate scene's asset card (intent → expanded caption) | Cut to a capture from the live app for the expanded caption (fixture mode returns `routes: []`, so it cannot show one — see §4); licence chips fall back to the `examples/licensing-demo` fixture (approved CC BY 4.0, refused CC BY-NC 4.0) |
| 4 — Compute | 0:50–1:10 | Backend picker on Google Colab; spend card with job count, budget and every number labelled "estimate"; Activity panel stepper: VM up → health → jobs → collected → VM stopped (verified), units spent (estimate) — **sped up and labelled** | "Pick Google Colab and approve a spend card — every number an estimate. The VM goes up, gets healthy, runs the jobs, is collected, then stopped and verified. Or point it at your own ComfyUI." | Choose Google Colab in the backend picker, approve the spend card, let the activity stepper run; then show (without running) the "My ComfyUI URL" option while saying the last line | Cut to the fixture event stream: `fixtureEvents()` replays the full five-phase Google Colab run offline, ending at "VM stopped (verified)" — never show a real run failing or a real account screen |
| 5 — How it's built / innovation | 1:10–1:30 | Narration beat (the demo page shows nothing new here — `docs/specs/DEMO_WEBAPP.md`: "Beat 5 is narration only"): slow push-in on the preview, or an overlay card listing the pipeline: Comfy SDK → ComfyUI workflow → LTX-2.5 plates + FLUX 3 Klein stills → Remotion | "How it's built: every GPU job is a ComfyUI workflow run through the Comfy SDK. LTX-2.5 makes the moving plates, FLUX 3 Klein the stills, Remotion draws text and charts exactly. All open weights — and no tunnel on Google Colab." | No live UI. Hold the preview or lay in the pipeline overlay card in the editor | If the overlay is not ready, hold the preview longer and let the voiceover carry the beat; nothing here is a live step |
| 6 — Iterate | 1:30–1:45 | Chat: "make scene 3 warmer"; scene 3's chip goes **rerendering** then **ready**; every other chip is untouched | "Now: 'make scene 3 warmer.' Only scene 3 re-renders — a package diff and hash cache, not the whole video." | Type the instruction in the chat panel (or, if the page shell renders them, click the **Warmer** scene chip on scene 3 — `FIXTURE_SCENE_CHIPS`; [unverified] until T13 lands) and watch only scene 3's status change | Cut to a pre-captured rerun, or use the fixture backend: `scenePlan`/`sceneRender` are canned and only the requested scene transitions (`apps/web/test/demo-scene-rerun.test.mjs`) |
| 7 — Open source | 1:45–2:00 | Repo panel: MIT `LICENSE`, `workflows/` (the API-format workflow JSON the jobs submit), `CREDITS`, and the export bundle `video.mp4`, `captions.srt/.vtt`, `CREDITS.md`, `package.zip`; line "open the example with zero setup" | "It ships as an MIT repo: the workflows folder, CREDITS, a portable package.zip — and a bundled example you can open with zero setup." | Click the open-source links and the package.zip export entry (`docs/specs/DEMO_WEBAPP.md` beat 7, existing `/api/export`) | Show the links only: `LICENSE`, `workflows/` and the committed example credits (`examples/hook-20s/CREDITS.md`) are in the repo today, so the beat works without a live export; root `CREDITS.md` lands with S05 (see §4) |

**Runtime check:** beats 1–7 use the exact section 11 ranges (0:00–0:10,
0:10–0:30, 0:30–0:50, 0:50–1:10, 1:10–1:30, 1:30–1:45, 1:45–2:00); total
**2:00**, at the ceiling. If the cut runs long, trim words inside a beat, never
the beat boundaries.

## 2. Recording checklist

### 2.1 Resolution and format
- [ ] Record the browser at **1920×1080, 30 fps** — the `format` of every
      example package (e.g. `examples/launch-demo/package.json`) and the export
      resolution of the renderer (1920×1080 H.264, `docs/RELEASE_CHECK.md`).
- [ ] Deliver **H.264 MP4, total ≤ 2:00** (7 beats, exactly 2:00 as scripted).
- [ ] Browser full screen at 100 % zoom so licence chips, scene badges and the
      "estimate" labels on the spend card are legible at 1080p.
- [ ] Voiceover read at ~2.5 words/s (the repo's English narration estimate,
      `apps/server/README.md`); if a line does not fit, cut words — not a beat
      and not its SPEC time range.

### 2.2 Fixture mode of the demo page (`?fixture=1`)
- [ ] Record from `apps/web/demo.html?fixture=1`. Per `docs/specs/DEMO_WEBAPP.md`
      §3 the fixture query swaps the API and SSE events for a deterministic
      offline backend, so the whole seven-beat script runs **with no server, no
      GPU and no network** and replays identically on every take.
- [ ] Pre-flight on the loaded page (the T14 acceptance in
      `docs/specs/DEMO_WEBAPP.md`): storyboard shows 6 chips; licence chips show
      1 ok + 1 blocked; typing in chat gets a reply; a chart-value edit updates
      the preview without a network render; re-run marks only scene 3
      rerendering then ready; the activity stepper reaches
      "VM stopped (verified)".
- [ ] Confirm the page booted in fixture mode before rolling (no server
      required — the fixture backend is the canned `apps/web/src/demo/fixture.mjs`).
- [ ] **Status:** `apps/web/demo.html`, `apps/web/src/demo/main.mjs`,
      `apps/web/e2e/demo.spec.ts` and `docs/DEMO_WEBAPP_RUNBOOK.md` are not in
      the repo as of Oct 20, 2026 (tasks T13–T15 in `docs/specs/DEMO_WEBAPP.md`).
      Record only after the page shell lands; the fixture modules and their
      tests (`apps/web/test/demo-fixture.test.mjs`) are already in the repo.
- [ ] If a take must use the live local server instead
      (`cd apps/server && npm start`, loopback on port 4319), note it in the
      edit notes and apply every item in §2.3 — the server prints a URL that
      carries a session fragment.

### 2.3 No secrets on screen (every frame)
- [ ] No keys, tokens, passwords or `.env` contents visible in a browser,
      editor, terminal, settings panel or Google Colab screen. Provider key
      fields stay closed or masked.
- [ ] Never record the printed server URL (it contains a session fragment):
      open it off-screen, and check the address bar is clean before rolling.
- [ ] Do not record browser devtools: the SSE stream can carry a `token` query
      parameter and API requests carry an auth header.
- [ ] No private hosts or personal filesystem paths in frame: terminals start
      in the repo root; no home-directory or user-folder paths, no tailnet host
      names, no personal e-mail or account IDs on any Google Colab screen
      (crop or blur if unavoidable).
- [ ] Terminal scrollback checked for key material before each take; provider
      settings and `.env`-style files never opened on camera.
- [ ] Before publishing: `node scripts/release-scan.mjs` (part of
      `pnpm run test:scan`) prints `clean:` — it scans tracked files for
      secrets, private hosts and personal paths, and the same rule applies to
      what ends up in the video.

### 2.4 Label sped-up footage
- [ ] Beat 4's activity run is the segment SPEC marks "(sped up, labelled)":
      keep the Activity panel's built-in **"sped up"** label visible
      (`apps/web/src/demo/activity-panel.mjs`) and add an editor overlay with
      the factor actually used (e.g. "sped up 8×").
- [ ] Every other accelerated segment — the scene re-render wait in beat 6, any
      export or render wait cut for time — gets the same on-screen label with
      its factor. Nothing is silently sped up.
- [ ] Beats 1–3, 5 and 7 are recorded and played at normal speed; narration is
      never sped up.

### 2.5 Pre-flight (repo, before recording day)
- [ ] `node scripts/release-scan.mjs` clean.
- [ ] `cd apps/web && npm test` green (covers the demo modules that exist).
- [ ] Hook clip rendered so beat 1's fallback exists:
      `node apps/renderer/scripts/render-package-example.mjs --example examples/hook-20s`.
- [ ] `examples/launch-demo` (6 scenes) and `examples/hook-20s` load in the
      preview player.
- [ ] Kyle reviews this script (and the cut built from it) before submission —
      the definition of done requires it (`docs/specs/SUBMISSION.md` §4).

## 3. Why it is innovative (Most Innovative)

The category rule asks for an explanation of why the entry is innovative; beat 5
(1:10–1:30) says it out loud. The written version for the form:

1. **ComfyUI as a plate generator inside a deterministic motion-graphics
   engine.** The heavy pixels — moving plates and hero stills — come from
   inspectable ComfyUI API workflows, while everything that must be exact
   (text, numbers, charts, timing) is rendered deterministically by Remotion on
   CPU: frame = f(timeline, local assets, frame number)
   (`docs/SPEC.md` §1, §6.9). Editing a headline or a chart value never starts
   a GPU job — beat 2 shows the preview updating with no GPU. Generated content
   and exact content are separated instead of being re-rolled together, so the
   model never gets to redraw your numbers.
2. **One Comfy SDK pipeline, two backends.** Every GPU job is the same
   API-format workflow submitted by the same Python runner built on the Comfy
   SDK, on either an auto-managed Google Colab VM (start → health → jobs →
   collect → **verified** stop, inside a reserve-checked unit budget) or your
   own ComfyUI (`docs/SPEC.md` §11 beat 5, §4 design rules). No tunnel on
   Google Colab; spend is shown as an approved estimate card, and "VM stopped"
   is only ever displayed after verification — beat 4 shows all of it.
3. **A licence-tracking agent with receipts.** Every asset carries its
   provenance and a licence decision: the v0.1 policy allows CC0, PDM and
   approved CC BY and blocks NC, ND, SA and unknown with a reason
   (`packages/sources/README.md`); exports ship `CREDITS.md` and a
   rights-filtered `package.zip` (`apps/server/README.md`, C10). The approval
   and refusal are visible on screen in beat 3, not buried in a README.
4. **Model-agnostic agent over open weights.** The agent is any
   OpenAI-compatible endpoint (badge: "<model> - any OpenAI-compatible model
   works"), and image, video and TTS are open weights — FLUX 3 Klein,
   LTX-2.5 and Kokoro — with no partner nodes and no closed model APIs in the
   render path (`docs/SPEC.md` §2, §8). The same package runs on your Google
   Colab units or your own machine; nothing is locked to a hosted service.

Where it is said: beat 5 is the spoken version (the demo must explain the
innovation — `docs/SPEC.md` §2), and beats 2–4 are the receipts for claims 1–3.
Category targets per `docs/SPEC.md` §2: **Open Weights Only** is the primary main
prize, **Most Innovative** secondary (this section), plus the **VFX (LTX)** and
**FLUX** bonuses — [unverified] whether judges count motion-graphics plates as
"VFX" (SPEC §2). Caveat to state honestly if asked: the agent LLM is the open
question for strict Open Weights Only (`docs/SPEC.md` §8.3, §9 Q1); the image,
video and TTS models are open.

## 4. Open issues and status

- **Demo page shell is not in the repo yet.** As of Oct 20, 2026 the repo has
  `apps/web/src/demo/*` modules and `apps/web/test/demo-*.test.mjs`, but no
  `apps/web/demo.html`, no `apps/web/src/demo/main.mjs`, no
  `apps/web/e2e/demo.spec.ts` and no `docs/DEMO_WEBAPP_RUNBOOK.md` (tasks
  T13–T15, `docs/specs/DEMO_WEBAPP.md`). Recording in `?fixture=1` mode is
  blocked until that lands.
- **Expanded FLUX caption in fixture mode:** the canned agent reply returns
  `routes: []` and `generatedAssets: {}` (`apps/web/src/demo/fixture.mjs`), so
  beat 3's intent → expanded-caption shot needs a live-app capture or an
  on-screen claim carried by the voiceover alone. [unverified] whether the demo
  page surfaces the expanded caption at all — the beat row in
  `docs/specs/DEMO_WEBAPP.md` lists licence chips only.
- **Root `CREDITS.md` does not exist yet** (task S05); beat 7's fallback uses
  committed example credits (`examples/hook-20s/CREDITS.md`) and the export
  bundle's generated `CREDITS.md` until it does.
- **Demo LLM choice still open** (`docs/SPEC.md` §9 Q1). The model badge
  wording is fixed regardless, so the script does not name a provider.
- **Verified in the repo:** `apps/web/test/demo-scene-rerun.test.mjs`,
  `apps/web/test/demo-fixture.test.mjs` and the rest of the `apps/web/test/demo-*`
  suite are present, so the fixture-mode and scene-rerun fallbacks in §1 rest on
  tests that already exist.
