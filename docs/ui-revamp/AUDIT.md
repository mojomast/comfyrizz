# Comfyrizz web UI audit (UI revamp, Easy mode first)

*Status: audit for the UR revamp. Branch audited: `feat/iteration-levels` at `0d5cb4d` (2026-10-23). Companion docs: [SPEC.md](SPEC.md) (target design) and [TASKS.md](TASKS.md) (UR task breakdown). An independent Easy-mode flow audit is being written separately at `docs/ui-revamp/easy-flow-sonnet.md`; reconcile it with this one when it lands.*

## 1. Method

- Built the workspace libraries (`pnpm install`, `pnpm run build:libs`), started the real server (`apps/server/src/index.mjs`) against a throwaway runtime directory, and ran the Vite dev server with `/api` proxied to it. This is the same arrangement as `apps/web/e2e/serve.mjs`.
- CPU backends only. No provider keys exist in the environment, so the LLM is the offline scripted model. No Google Colab session was started and no paid call was possible.
- Walked every screen with headless Chromium (Playwright) at 1440×900, 1024×768 and 390×844, in Easy and Advanced. Ran Axe (WCAG 2.0/2.1 A and AA tags) on first load in both modes, and counted keyboard Tab stops.
- Screenshots are in [`screens/`](screens/). File names start with a number so they sort in walk order.

What a first-time user did in the walk:

1. Opened the app (lands on the bundled example "Pip's Night Shift").
2. Typed a bakery brief, answered the plan questions, edited the Brief card, pressed **Build video**.
3. Pressed **Render**, then **Approve all visible**, then **Render** again.
4. Pressed **Run on backend**.
5. Opened **Characters**, started a new character.
6. Opened the Google Colab popover and the Google Colab runs drawer.
7. Switched to **Express** and built a second brief.
8. Rendered the untouched example end to end (this one works).
9. Repeated the inventory in Advanced; opened every inspector tab, every rail tab, Run settings and Agent settings.

## 2. Headline numbers

| Measure | Easy | Advanced |
|---|---|---|
| Visible interactive controls on first load (inside scroll areas) | **128** | 162 |
| ...in the top bar / left pane / centre pane / timeline / status bar | 7 / 39 / 55 / 24 / 2 | n/a |
| Tab stops before the composer (the only way to start) | **43** | 44 |
| Tab stops before Play | 47 | 48 |
| Axe serious or critical violations on first load | 0 | 0 |
| Entry points that render or export a video | 11 | 11 |
| Surfaces that show or set Google Colab spend | 9 | 9 |
| Ways to start building a video from text | 5 | 5 |
| UI modules built and tested but not mounted in the app | 8 | 8 |

Axe is clean, which is a real strength. The problems are structural: the number of controls, duplicated paths, dead ends, and states that only show in hidden panels.

## 3. Inventory

### 3.1 Routes and pages

| Route | What it is | Notes |
|---|---|---|
| `/` (`index.html`, `src/main.ts`) | The whole product: one grid page | With no `?package=` it always opens the bundled example. There is no home, no project list, no way to open another video except by editing the URL. |
| `/?package=<id>` (`src/default-project.ts`) | A stored project | Optional `&chat=<chat id>`. |
| `#token=<token>` | Session bootstrap | Read into `sessionStorage`, then stripped from the URL. |
| `/demo.html` (`src/demo/main.mjs`) | Two-minute live-demo page | `?fixture=1` runs offline. A separate design and component set ([67](screens/67-demo-page-fixture.png)). |
| `/ui-kit.html` | Component kit | Dev only; the e2e suites use it as a harness. |
| `/tts-expression/index.html` | Linked from Voice settings ("Hear the comparisons") | **Dead link**: no such page; Vite serves the app again. |

### 3.2 Regions of the main page

| Region | Easy | Advanced | Contents |
|---|---|---|---|
| Top bar (`#topbar`) | shown | shown | Logo, project name, **static** stepper (Brief · Storyboard · Takes · Render), Run settings (Advanced), Characters, Run on backend, "N/M approved" review chip, Render, Export ▾, Easy/Advanced switch |
| Left pane (`#chat-pane`) | shown | shown | Chat transcript, suggested prompts, "Start a new video", References (drop zone, per-reference role select **and** 10 role chips, usage note, delete), Cast strip (count, error, empty state, Create character), composer (textarea, Chat/Express toggle, Send) |
| Centre pane (`#work-pane`) | shown | shown | Preview (Remotion Player, Play, scrub, time), Easy actions bar (Easy only: Generate, Preview, "custom" chips, Advanced settings), Inspector tabs (Advanced: Scene, Voice, Animation, Agent, Takes), Frame QA, Theme (4 colour inputs), spend card, Storyboard (AI presenter bar, Sound design toggle, scene cards) |
| Scene card (×N) | shown | shown | Headline, Sub/body, chart values, Presenter select, Re-render scene, Regenerate media, 4 edit chips (Warmer, Calmer motion, More depth, Less busy) |
| Right rail (`#activity-pane`) | **hidden** | shown | Tabs: Run (filters, run log, Google Colab card, gauge, Export bundle), Activity, Assets (type/licence filters, pager), GPU queue |
| Timeline dock (`#scene-timeline`) | shown | shown | Full multi-track editor: play/step, zoom, fit, snap, undo/redo, move, duplicate, delete, trims, Scenes/Narration/Captions/Presenter/Music tracks, clip inspector (preferred frames, transition), Keyboard help, a second "Saved" badge |
| Status bar (`#statusbar`) | shown | shown | open weights, provider status, `ctx 0 / 200k`, EVENTS CONNECTED, N QUEUED, GPU units (est.), Google Colab sign-in popover, Google Colab runs drawer, render state text, Space hint, Saved |

### 3.3 Popovers, drawers and modals

| Surface | Opened from | Notes |
|---|---|---|
| Run settings popover | Top bar (Advanced only) | Backend, LLM, Model + Agent settings, Budget, Render location ([53](screens/53-advanced-run-settings.png)) |
| Agent settings (`<dialog>`) | Run settings › Agent settings; Inspector › Agent tab | Provider connections and keys. While "closed" it is rendered below the fold and its Close button is a Tab stop. |
| Export menu | Export ▾ | Export MP4 (same function as Render), Export bundle ([28](screens/28-easy-export-menu.png)) |
| Review takes drawer | "N/M approved" chip, Render when the gate blocks | Filters, search, sort, rows, Approve all visible, Render anyway, override reason ([26](screens/26-easy-render-after.png)) |
| Characters overlay | Top bar Characters | Library + editor drawer, 30 fields, 2,573 px tall ([30](screens/30-easy-characters-overlay.png), [31](screens/31-easy-character-editor.png)) |
| Google Colab popover | Status bar | Sign-in and test connection ([34](screens/34-easy-google-colab-popover.png)) |
| Google Colab runs drawer | Status bar | Run history and gauges ([35](screens/35-easy-google-colab-runs.png)) |
| Recovery prompt | Boot, when a local draft is newer | Not triggered in this walk; code in `src/main.ts` `showRecoveryPrompt` |
| Brief panel (Plan mode) | Composer Send in Chat mode with the scripted model | Questions, then the Brief card; lives inside the 280 px left column ([21](screens/21-easy-plan-questions.png), [22](screens/22-easy-brief-card.png)) |

### 3.4 Built but not mounted

These modules have render functions, controllers and passing tests, but nothing in `src/main.ts` (or anything it imports) mounts them, so no user can reach them:

| Module | What it does | Evidence |
|---|---|---|
| `src/productions/cards/plan-card.ts` (IP29) | **Shot plan, cost and Approve plan** | Imported only by `e2e/a11y-production.spec.ts` and `e2e/production-spine.spec.ts` through dynamic import ([66](screens/66-production-plan-card-unmounted.png)) |
| `src/productions/cards/script-card.ts` | Treatment, script and shot list editing | Same |
| `src/productions/cards/progress.ts` | Shot progress, pause/resume/cancel | Same |
| `src/characters/audition-panel.ts` (IP46, IL20) | Voice audition comparison and **Voice A/B** | Only `test/audition-*.test.ts` import it |
| `src/characters/consent.ts`, `speaker-picker.ts`, `sheet-button.ts` | Consent, speaker picker, turnaround sheet | Only their tests import them |
| `src/ui/palette.ts` (DN08) | Command palette (Ctrl/Cmd+K) and shortcut sheet | Ctrl+K does nothing ([55](screens/55-advanced-ctrl-k.png)) |
| `src/colab-history.ts` | Google Colab run history | Only its test imports it |
| `src/animation-settings.ts` | Scene animation settings | Superseded by `editor/inspector/animation.ts`, still in the tree |

The iterative production agent's plan approvals, the voice A/B work and the iteration levels therefore have **no reachable UI**. The iteration policy exists only as a server contract (`apps/server/src/productions/iteration.mjs`).

### 3.5 Duplicate and conflicting entry points

| Job | Entry points today |
|---|---|
| Start building from text (5) | Composer Send in Chat mode (scripted model: questions, then Brief card, then **Build video**); Send in Express; Send with a live provider (project chat, **Build this project**); Easy **Generate** (just submits the composer, or focuses it when empty); production agent plan (not mounted) |
| Render or export (11) | **Render** (top bar); Export ▸ **Export MP4** (same function); Export ▸ **Export bundle**; **Export bundle** (Run rail); **Render changes** (Storyboard); **Re-render scene** (each card); **Regenerate media** (each card); **Run on backend** (top bar); Voice tab **Generate video** / **Approve ceiling & generate**; review drawer **Render anyway** / **Render with override**; **Download run MP4** (Run rail) |
| Google Colab and spend (9) | Run settings Backend; Run settings Budget; Run settings Render location; Voice tab Visual generation; Voice tab Total compute-unit ceiling; Voice tab Qwen allocation ceiling; Voice tab Final render (a second render-location select); status bar Google Colab popover; status bar Google Colab runs drawer; Run rail Google Colab card and gauge; centre spend card; status bar "GPU units (est.)" |
| Create a character (4) | Top bar Characters › New character; Characters overlay empty state › Create character; Cast strip › Create character; (agent cast proposals in chat) |
| Pick an LLM (3) | Run settings LLM + Model; Agent settings dialog; Inspector › Agent tab |
| Presenter (4) | Brief card Presenter; Storyboard presenter coverage (None / Intro + outro / All scenes); presenter "quick" presets (Intro/outro / All scenes / None, the same three again); per-scene Presenter select |
| Play the video (2) | Preview Play + scrub; timeline play/step with its own time readout |
| Saved state (3) | Timeline toolbar SAVED; status bar Saved; inspector "Saved" |
| Mode toggles (2) | Easy/Advanced (view) next to Chat/Express (composer), both segmented controls |
| Reference role (2 per reference) | A role `<select>` and 10 role chip buttons for the same value |

## 4. Findings by severity

Severity scale: **S0** blocks a first-time user from finishing a video; **S1** major confusion, a hidden dead end, or a missing core capability; **S2** friction or inconsistency; **S3** polish.

### S0: blockers

**A01. A first-time render needs an "override reason".** After building a brief, **Render** opens Review takes with four rows labelled `a_svg_319c…b84ee3 · foreground:0 · no takes · NEEDS REVIEW` and an Override reason box. **Approve all visible** goes through a native `confirm()`; the rows have no takes to approve. The only way to get a video is to write a justification for overriding the gate. Screens: [25](screens/25-easy-render-click.png), [26](screens/26-easy-render-after.png), [37](screens/37-easy-approve-all.png), [39](screens/39-easy-render-finished.png). Code: `src/takes/render-bar.ts`, `src/takes/review-drawer.ts:1127`, server gate under `apps/server/src/takes/`. CPU-made SVG stills count as reviewable clips even though nothing was generated on a GPU.

**A02. The production agent's plan approval has no UI.** The plan card (shot plan, upper bound, Approve plan), script card and progress card are complete and Axe-tested, but are mounted only inside e2e harness pages ([66](screens/66-production-plan-card-unmounted.png)). "Plan cards and approvals" do not exist for users. Voice A/B (IL20) and audition comparison are in the same state (section 3.4).

**A03. "Run on backend" is a silent dead end in Easy.** With the default CPU backend it writes "CPU is not a GPU backend" to Activity, which Easy hides. With Google Colab selected, the spend approval card renders in the centre pane below the Theme section, and run progress goes to the hidden right rail. The backend selector itself lives in Run settings, which Easy hides. Screen: [29](screens/29-easy-run-on-backend.png). Code: `src/main.ts:1472` `runOnBackend`.

**A04. The offline build ignores the brief.** Prompt: "A 30 second video for my bakery, Crumb & Co, announcing our new sourdough subscription." Plan questions asked "Do you have the real numbers?" and offered CTAs "star the repo / book a demo / sign up for the beta" ([21](screens/21-easy-plan-questions.png)). The built package's scenes were "CPU time for this slice" and "Where the example minutes went", and the project stayed named "Pip's Night Shift" ([24](screens/24-easy-built.png)). Without a provider, which is every first-time user, the product appears not to listen. Code: `packages/agent/src/brief.ts:149-171`, the scripted plan in `packages/agent`.

**A05. No home, no project list, no way back to a video.** The app always opens the bundled example. "Start a new video" resets the chat but not the package on screen. A second project is reachable only through `?package=`. There is no server route that lists packages.

### S1: major

**A06. Five competing ways to start, and the composer changes behaviour invisibly.** With the scripted model, Chat (internally `plan`) asks questions and shows a Brief card; with a live provider, the same Send button runs the project-chat builder with a different UI and a "Build this project" button; Express skips both; Easy **Generate** just presses Send ([20](screens/20-easy-generate-empty-prompt.png)). The provider that decides which path runs is set in Run settings, which Easy hides. Code: `src/main.ts:2782-2804`.

**A07. Easy is a CSS filter, not a mode.** `html[data-mode='easy']` hides the right rail, Run settings and `[data-adv]` nodes. Everything else stays: the full multi-track timeline with trim, duplicate and delete; Theme colour inputs; the presenter bar; Sound design; per-scene Re-render, Regenerate and four chips; references with ten role chips each. That is 128 controls on first load ([01](screens/01-first-load-easy.png), [11-01…05](screens/11-easy-center-pane-02.png), [12](screens/12-easy-timeline-dock.png)). `e2e/default-project.spec.ts:187` says Easy hides the cast strip; it is visible ([10-05](screens/10-easy-left-pane-05.png)).

**A08. Eleven render and export entry points with overlapping meaning.** See section 3.5. **Render** and **Export ▸ Export MP4** call the same `beginExport`. Render means "download an MP4" while Re-render scene means "rebuild one segment" and Regenerate media means "plan GPU jobs (dry run)".

**A09. The Google Colab spend cap is scattered and invisible in Easy.** Budget (Run settings), Total compute-unit ceiling and Qwen allocation ceiling (Voice tab), the spend card, the status-bar estimate and the Google Colab card all describe money. Two separate Render location selects exist (Run settings and Voice tab). None of these show in Easy, yet Easy can still start paid work through Run on backend. The production ledger supports a user-set ceiling (`apps/server/src/productions/ledger.mjs` `setCeiling`), but no HTTP command exposes it.

**A10. Characters: four entry points, two states at once, no short path.** The overlay shows the "No characters yet" empty state and the editor at the same time, repeats its own title and description, and the editor is one 2,573 px column with 30 fields (Identity, Look, Wardrobe, Expressions, Voice, Bible). The cast strip's Create character button does nothing visible ([31](screens/31-easy-character-editor.png), [31-scroll-2](screens/31-easy-character-editor-scroll-2.png), [33](screens/33-easy-characters-after-escape.png)). The voice A/B panel that would help choose a voice is not mounted.

**A11. The bundled example errors on first load.** "Could not load the cast: conversation chat_pipnightshift01 does not exist" shows in red in the left pane, and both reference thumbnails return 404 ([10-05](screens/10-easy-left-pane-05.png)). Console: `GET /api/chat/chat_pipnightshift01/cast 404`, `GET …/references/ref_…/thumb 404`.

**A12. The Brief card is a 2,028 px form inside a 280 px column.** Key message is the raw prompt pasted back, CTA is empty, the six look thumbnails stack one per row, and the Brand kit asks for a "Font file" path and a "Font licence" ([22](screens/22-easy-brief-card.png), [22b](screens/22b-easy-brief-card-pane.png)).

**A13. Iteration levels have no UI.** Draft, Balanced, Director and Custom exist only in `iteration.mjs`. Nothing tells a user how many versions will be tried, what they will be asked to pick, or what it costs.

**A14. Progress, success and failure are not shown where the user looks.** Render progress is one truncated status-bar string ("recompiling + rendering on CPU (~90 s)…") and a disabled Render button ([40](screens/40-easy-default-render-click.png)). Success is a silent browser download plus "exported 3.0 MB" in the status bar, with no "Your video is ready" and no player of the result ([42](screens/42-easy-default-render-60s.png)). Run failures and refusals go only to Activity. Pending GPU work appears as "PLANNED foreground 0" chips on the timeline and "1 QUEUED" in the status bar, with the explanation in the hidden GPU queue tab ([24](screens/24-easy-built.png)).

**A15. The Agent settings dialog leaks.** The closed `<dialog>` is drawn below the app and its Close button is reachable with Tab. The chat welcome says "Open **Agent settings**", but that is bold text, not a link, and Agent settings are hidden in Easy.

**A16. The stepper is decoration.** "Brief · Storyboard · Takes · Render" is hard-coded in `index.html`. Storyboard is always the current step; the steps are not buttons and never update.

**A17. Keyboard path is long and repetitive.** 43 Tab stops before the composer. Each reference contributes a role select plus ten chip buttons for the same choice. There is no skip link, and focus is not moved when panels open (Characters, review drawer).

**A18. Small screens break.** At 1024 px the top bar clips "Advanced" and status-bar items overlap ([62](screens/62-tablet-easy-first-load.png)). At 390 px the page is 5,538 px tall, the preview sits about a third of the way down, and Render is clipped off the top bar ([60](screens/60-mobile-easy-first-load.png), [61](screens/61-mobile-easy-full.png)).

### S2: moderate

**A19. Duplicate presenter controls.** Coverage chips (None / Intro + outro / All scenes) sit beside "quick" chips with the same three choices, plus a per-scene Presenter select and a Brief card Presenter select ([11-02](screens/11-easy-center-pane-02.png)).

**A20. Three "Saved" indicators** (timeline toolbar, status bar, inspector).

**A21. Two transports that disagree.** After building, Preview reads `00:00 / 00:19` while the timeline reads `00:00:00 / 00:36:15` ([24](screens/24-easy-built.png)).

**A22. Two segmented mode toggles.** Easy/Advanced (view) and Chat/Express (composer) look identical. "Chat" is called `plan` in code and "Plan mode" in the panel it opens.

**A23. Inert chips that look like buttons.** The Easy bar's "Custom transition / Custom timing / Custom motion" are labels, not controls.

**A24. Frame QA reads "QA pass" beside "4 findings"** with no explanation ([42](screens/42-easy-default-render-60s.png)).

**A25. Review rows show asset hashes** (`a_svg_d3d1…a8d5e4 · s_hero · foreground:0`) instead of scene names ([26](screens/26-easy-render-after.png)).

**A26. Native `confirm()`** for Approve all and reference deletion.

**A27. Chat is a sliver.** After a build the transcript is not scrolled to the reply; references and cast push the messages into a small area above the composer ([24b](screens/24b-easy-built-chat.png)).

**A28. Without a session token, Send greys out and nothing explains why** ([64](screens/64-no-token-send.png)).

**A29. Theme is four unnamed colour inputs** ("Palette 1–4") with the hint "palette changes the procedural backgrounds".

**A30. The status bar is developer telemetry**: "open weights", "offline", "ctx 0 / 200k", "EVENTS CONNECTED", "0 QUEUED", "0.00 GPU units (est.)" ([14](screens/14-easy-statusbar.png)).

**A31. Two places to sign in or check Google Colab** (popover and runs drawer) sit side by side in the status bar ([34](screens/34-easy-google-colab-popover.png), [35](screens/35-easy-google-colab-runs.png)).

### S3: polish

**A32. Jargon in user copy.** See section 6.

**A33. Naming rule.** `src/demo/activity-panel.mjs:221` says "allocating a Colab session"; the rule is always "Google Colab". "Google Colab G4" exposes a GPU SKU.

**A34. Inconsistent verbs and casing**: "Run on backend", "Render changes", "Export bundle", "BYO ComfyUI", "LLM".

**A35. Pane hints are implementation notes**: "brief → local agent → package", "compiled timeline", "generated-first", "backend lifecycle".

**A36. Timeline "Keyboard" disclosure and clip inspector (Preferred frames, Speech minimum, readable floor) show in Easy.**

**A37. The "0/0 approved" review chip shows on a fresh project in Easy.**

**A38. Dead link** to `/tts-expression/index.html` in Voice settings.

## 5. Missing states

| Surface | Empty | Loading | Error | Pending GPU |
|---|---|---|---|---|
| Start / brief | No first-run state; the example is always loaded | "planning the brief…" in the composer hint only | Falls back silently to Express on failure (`planBriefFlow`) | n/a |
| Build | n/a | Streaming bubble (good) | Chat message (good) | "N GPU needs pending" sentence; no action |
| Characters | Present, but shown together with the editor | None | Raw server error text (A11) | Look generation and turnaround sheet not reachable |
| Plan approval | Defined in plan card, unmounted | Defined, unmounted | Defined, unmounted | n/a |
| Generation progress | "No backend run yet" in hidden rail | Hidden rail only | Activity only | GPU queue tab, hidden in Easy |
| Preview | Never empty | None while compiling | None | Procedural fallback with no label in the Player |
| Review | "No reviewable clips" (good) | None | Inline text | Rows "no takes" with no next step |
| Render / export | n/a | Truncated status-bar text | Status-bar text only | Google Colab VM state only in hidden rail |
| Google Colab | "Not signed in" (good) | "Test connection" | Popover text | `stop_unconfirmed` banner promised by SPEC §3.9, not visible in Easy |
| Offline / no token | n/a | n/a | Send disabled, no message | n/a |

## 6. Jargon to replace

| Today | Problem | Easy copy (see SPEC §9) |
|---|---|---|
| package, revision, compiled timeline | internal model | your video, saved version |
| Render, Re-render scene, Render changes | three meanings | Export video (final file); preview updates automatically |
| Regenerate media | dry-run GPU plan | Try again (one shot) |
| Run on backend, backend | implementation | Generate |
| Takes, clips, `a_svg_…`, `foreground:0` | internal ids | versions of a shot, "Shot 2: Hands knead dough" |
| GPU units, compute-unit ceiling, Qwen allocation ceiling | three units | Google Colab units, one spend cap |
| Google Colab G4, BYO ComfyUI, Kokoro, Qwen, Remotion, LLM, ctx | vendor and model names | Google Colab, My ComfyUI, voice names, "AI provider" |
| procedural fallback, pending spend, PLANNED | pipeline states | "Placeholder until generated" |
| Express / Chat (plan) | modes | one input; "Skip questions" in Advanced |
| open weights, EVENTS CONNECTED | telemetry | move to a diagnostics popover in Advanced |
| layout `TITLE · CENTERED`, `HERO · SPLIT`, `s1_dawn` | ids | "Title", "Hero", "Shot 1" |

## 7. What works and should stay

- Axe-clean first load in both modes, focus rings, `aria-live` regions on save state and mode changes.
- Design tokens (`src/ui/tokens.css`) and a component layer (`src/ui/components.css`) that a new shell can reuse.
- Pure `render…()` + controller modules with node tests (plan card, script card, progress, review drawer, audition panel). The revamp can mount these instead of rewriting them.
- The production client (`src/productions/client.ts`) already handles gaps, resets and stale cards; cards define loading, empty, error and stale states (SPEC invariant I8).
- Spend is never approved implicitly; approvals cite a plan hash. Keep this exactly.
- The look picker thumbnails and the four scene edit chips are good ideas in the wrong place; both move into Easy.
- The example renders to MP4 on CPU in about a minute ([42](screens/42-easy-default-render-60s.png)).

## 8. Screenshot index

| File | Shows |
|---|---|
| [01-first-load-easy](screens/01-first-load-easy.png) | Easy on first load: 128 controls, timeline, theme, storyboard |
| [03-advanced-default](screens/03-advanced-default.png) | Advanced on first load |
| [10-easy-left-pane-01…05](screens/10-easy-left-pane-01.png) | Left pane scrolled: chat, prompts, references with role chips, cast error |
| [11-easy-center-pane-01…05](screens/11-easy-center-pane-01.png) | Centre pane scrolled: preview, Easy bar, theme, presenter bar, scene cards |
| [12-easy-timeline-dock](screens/12-easy-timeline-dock.png), [13-easy-topbar](screens/13-easy-topbar.png), [14-easy-statusbar](screens/14-easy-statusbar.png) | Regions |
| [20-easy-generate-empty-prompt](screens/20-easy-generate-empty-prompt.png) | Easy Generate with an empty prompt only focuses the composer |
| [21-easy-plan-questions](screens/21-easy-plan-questions.png) | Irrelevant plan questions for a bakery |
| [22-easy-brief-card](screens/22-easy-brief-card.png), [22b](screens/22b-easy-brief-card-pane.png) | Brief card squeezed into the left column |
| [24-easy-built](screens/24-easy-built.png), [24b](screens/24b-easy-built-chat.png) | Built package ignores the brief; chat not scrolled |
| [25](screens/25-easy-render-click.png), [26](screens/26-easy-render-after.png), [37](screens/37-easy-approve-all.png), [39](screens/39-easy-render-finished.png) | Render blocked by the review gate |
| [28-easy-export-menu](screens/28-easy-export-menu.png) | Export menu duplicates Render |
| [29-easy-run-on-backend](screens/29-easy-run-on-backend.png) | Run on backend: nothing visible happens |
| [30](screens/30-easy-characters-overlay.png), [31](screens/31-easy-character-editor.png), [31-scroll-2](screens/31-easy-character-editor-scroll-2.png), [33](screens/33-easy-characters-after-escape.png) | Characters overlay and editor |
| [34](screens/34-easy-google-colab-popover.png), [35](screens/35-easy-google-colab-runs.png) | Two Google Colab surfaces in the status bar |
| [36-easy-express-built](screens/36-easy-express-built.png) | Express build |
| [40](screens/40-easy-default-render-click.png), [42](screens/42-easy-default-render-60s.png) | Example render: progress and silent success |
| [51-advanced-inspector-1…5](screens/51-advanced-inspector-1-scene.png) | Inspector tabs: Scene, Voice, Animation, Agent, Takes |
| [52-advanced-rail-*](screens/52-advanced-rail-run.png) | Right rail tabs |
| [53-advanced-run-settings](screens/53-advanced-run-settings.png), [54-advanced-agent-settings](screens/54-advanced-agent-settings.png) | Run settings and Agent settings |
| [55-advanced-ctrl-k](screens/55-advanced-ctrl-k.png) | Ctrl+K does nothing (palette not mounted) |
| [60](screens/60-mobile-easy-first-load.png), [61](screens/61-mobile-easy-full.png), [62](screens/62-tablet-easy-first-load.png) | 390 px and 1024 px |
| [63](screens/63-no-token-first-load.png), [64](screens/64-no-token-send.png) | No session token |
| [66-production-plan-card-unmounted](screens/66-production-plan-card-unmounted.png) | Plan and progress cards rendered in a harness (not reachable in the app) |
| [67-demo-page-fixture](screens/67-demo-page-fixture.png) | The separate demo page |
