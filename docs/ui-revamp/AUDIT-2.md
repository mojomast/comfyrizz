# Comfyrizz web UI audit — second pass

*Branch: `feat/iteration-levels` at `743f80c` (2026-10-24), after PR #35 (render-worker cancel/export) and PR #37 (UR70 docs vocabulary). First audit: [AUDIT.md](AUDIT.md). Revamp spec: [SPEC.md](SPEC.md). Task list: [TASKS.md](TASKS.md).*

## 1. Method

Same setup as the first pass: real server (`apps/web/e2e/serve.mjs`), Vite dev server on `:4175`, API proxied to `:4391`, CPU backends only, offline scripted model, no Google Colab session, no paid calls. Walked the studio (Easy) and editor (Advanced) at 1440×900, 1024×768, and 390×844 with Chromium. Keyboard-tabbed through every step.

Since the first audit the entire Easy studio has been built and mounted (UR01–UR38, UR40–UR66, plus the home screen and settings dialog). The editor has been restructured with renamed tabs, a proper settings dialog, and the mode toggle now uses "Studio" / "Editor" vocabulary per UR70. This second pass focuses on residual issues.

## 2. What landed and works

The UR revamp delivered most of what the spec asked for:

- **Easy studio is its own shell**, not a CSS filter. Seven wizard steps render in a centred column with a sticky action bar, a real stepper, and a single primary button per step.
- **One path**: Idea → Characters → Iteration level → Plan → Generate → Review → Export.
- **Vocabulary**: the copy catalogue (`src/easy/copy.ts`) uses "Shot", "Version", "Keep", "Export", "This computer", "Google Colab", "Spend cap", "AI provider" throughout. The banned-word scanner enforces it.
- **Editor restructured**: top bar has "Export MP4" + "More ▾" (Export bundle, Open in studio). Right rail tabs renamed to Activity / Files / Jobs. Status bar has a Diagnostics disclosure. Inspector tabs renamed to Scene / Voice / Animation / Generate / Production.
- **Settings dialog**: AI provider, Google Colab and spend, My ComfyUI, Appearance, Keyboard shortcuts — all in one dialog.
- **Mode toggle**: "Open in editor" / "Back to studio" with Ctrl/Cmd+Shift+A.
- **Home screen**: new-video link, recent videos, "Try the example".
- **Google Colab banner**: session state banner with stop_unconfirmed alert.
- **Export step**: progress bar, done screen with player, download, extras, QA notes, stale detection.

## 3. Residual findings

Severity: **S0** blocks making a video; **S1** major confusion or dead end; **S2** friction or inconsistency; **S3** polish.

### S1: major

**B01. "Back to studio" from the editor re-triggers the export render.** Clicking "Back to studio" after completing an export in the studio (then switching to the editor to inspect) re-enters the Export step and starts a new render. The resume logic in `mount.ts` calls `showStep(route.step)`, which re-runs the export `bind()` and `begin()`. Expected: return to the done screen. Code: `src/easy/steps/export.ts:656` (bind always calls `begin()`), `src/easy/mount.ts:344` (pop-state re-derives and re-shows the step).

**B02. Plan step shows the bundled example's scenes, not the user's idea.** The offline planner still fills scenes from the "Pip's Night Shift" example data, not from the user's idea text. This was noted as A04 in the first audit; UR12b (offline planner writes scene copy from the user's idea) has not merged. The plan info banner says "Written by the offline planner" but the disconnect is still jarring.

**B03. Idea step has ~12 tab stops before Continue.** The spec target is ≤5 from the step heading to the primary action (SPEC §10). The actual count: textarea (1) + 4 template buttons (4) + length group (1) + shape group (1) + look group (1) + "More options" disclosure (1) + any question groups (1–3) + Continue (1) = 10–14. Template chips are `<button>` elements, each a tab stop, instead of a chip-style radio group.

**B04. The right ~40% of the screen is empty on every Easy step at desktop widths.** The `.easy-main` column is capped at `max-width: 880px` (1120px at ≥1440px) and centred. Steps that could use a two-column layout with a preview (Plan, Review) do use `.easy-two-col`, but on the Idea and Characters steps the content occupies a narrow strip with nothing beside it.

**B05. "Written by the offline planner. Connect an AI provider" leaks jargon into Easy.** "Offline planner" is on the banned-word list conceptually (SPEC §9) though not literally since "offline" and "planner" are separate words. The banner is confusing: users don't know what an "offline planner" is. The "Connect" button leads to Settings → AI provider, which is fine, but the label needs plain language.

### S2: moderate

**B06. Editor status bar still shows "0.0 GPU units (est.)" and "0 queued" to everyone.** The spend meter in `index.html` says `0.0 GPU units` and `main.ts:1884` writes `GPU units (est.)`. The Diagnostics disclosure hides "ctx 0 / 200k" and "Events connected" correctly, but the top-level `#spend` meter and `#render-state` are still visible. First audit A30 flagged this; the spend meter was moved into diagnostics by some tasks but the `#spend` element in the footer is still outside.

**B07. Editor run-panel empty state says "No backend run yet. Pick a backend and press Run."** This copy predates the UR rename: there is no "Run" button anymore (it's "Generate" or "Export MP4"). The phrasing should say "No generation yet." Code: `index.html:111`, `main.ts:1617`.

**B08. Editor Jobs tab hint says "fallbacks active until approved."** This is internal pipeline vocabulary that survived the cleanup. Code: `index.html:146`.

**B09. Settings dialog AI provider section still has "Agent settings" button and raw `<select>` with "local · scripted model" option.** While the settings dialog exists (UR62), the AI provider section is still a raw form with `<select id="llm">` showing technical option labels ("local · scripted model", "OpenCode Go", "Custom · OpenAI-compatible", "OpenRouter"). The "Agent settings" button re-opens the old agent-settings dialog. Code: `src/settings/sections.ts:26–35`.

**B10. "Ask for changes" opens a dialog that says "Connect an AI provider" with only a Close button.** Without a provider key, the Ask drawer (UR30) is replaced by a dialog that shows "Connect an AI provider to ask for changes in your own words. You can still edit words and use Try again." but offers no link to Settings → AI provider — only a "Close" button. The "Connect" action described in `COPY.ask.connect` is defined but not wired as a button.

**B11. Export "Download captions and extras (ZIP)" is unclear.** "Extras" is undefined — users don't know what's in the ZIP. The label could say "Download captions, credits and project files (ZIP)".

**B12. Editor Remotion player still has `aria-label="Remotion preview"`.** "Remotion" is a library name users don't know. Should be "Video preview". Code: `index.html:80`.

**B13. Plan step preview area shows a blank frame.** The `[data-easy-player]` slot is present but the player shows a black rectangle. For CPU builds with no AI-generated assets, users see shots described in text beside a blank preview — there's no feedback that a visual will appear later.

### S3: polish

**B14. Three header buttons (Help, Settings, Open in editor) are visually identical.** All use `btn btn-secondary easy-header-button`. "Open in editor" is the only navigation action; it could be visually distinct (outlined or ghost) to separate it from local actions.

**B15. Settings dialog Keyboard shortcuts section is a bare `<ul>` with two items.** It lists "Space — Play or pause" and "? — Keyboard shortcuts" but misses Ctrl/Cmd+Shift+A (mode toggle), Ctrl/Cmd+Enter (primary action), and Alt+arrows (step navigation). Code: `src/settings/sections.ts:60`.

**B16. Stepper "Iteration level" is the longest label.** At narrow widths the stepper already collapses to "Step N of 7 · Iteration level", but when visible it pushes other labels out. A shorter label like "Level" would fit better, though "Iteration level" is the spec term.

**B17. Export done screen shows "Pip's Night Shift" project name.** The video title comes from the loaded package, which is still the bundled example when the offline planner doesn't overwrite it. Related to B02.

**B18. Characters step narration toggle uses a native checkbox without an explicit on/off label.** The spec calls for "[on]" toggle style (SPEC §3.4). The current implementation uses `<input type="checkbox">` which works functionally but doesn't match the visual spec.

## 4. First-audit issues: status after UR

| First audit | Status | Notes |
|---|---|---|
| A01 Override reason | **Fixed** | Easy never asks for an override; the render gate is bypassed for CPU-only assets per UR31. |
| A02 Plan cards unmounted | **Fixed** | Plan card is mounted in the Plan step; progress card drives the Generate step. |
| A03 Run on backend dead end | **Fixed** | Removed. Easy uses "Approve and generate"; editor uses the Generate inspector tab. |
| A04 Offline build ignores brief | **Open (B02)** | UR12b not merged. |
| A05 No home / project list | **Fixed** | Home screen shows recent videos and "Try the example". |
| A06 Five competing start paths | **Fixed** | Easy has one path; editor has Chat with "Skip questions". |
| A07 Easy is a CSS filter | **Fixed** | Easy is its own shell with `src/easy/`. |
| A08 Eleven render/export points | **Mostly fixed** | Easy has one Export step. Editor has "Export MP4" + "More ▾ › Export bundle". The editor still has "Render changes" storyboard button if scenes are dirty. |
| A09 Spend cap scattered | **Mostly fixed** | Easy step 3 has one cap input. Settings has a read-only cap. Editor still has `#spend` meter outside diagnostics (B06). |
| A10 Characters four entry points | **Fixed** | Easy step 2 has one "Add a character" button with a menu. Editor has one "Characters" button. |
| A11 Bundled example errors | **Improved** | The home screen no longer auto-loads the example. Cast error still appears when the example is opened via "Try the example". |
| A12 Brief card in 280px column | **Fixed** | Easy Idea step is full width. |
| A13 Iteration levels no UI | **Fixed** | Easy step 3 has a level picker. Editor has the iteration level host. |
| A14 Progress not shown | **Fixed** | Easy Generate step shows per-shot status. Export step has a progress bar and done screen. |
| A15 Agent settings dialog leaks | **Fixed** | Agent settings folded into Settings dialog. |
| A16 Stepper is decoration | **Fixed** | Easy stepper has real navigation with done/current/available/locked states. |
| A17 Keyboard path long | **Improved (B03)** | Down from 43 to ~12 stops, but still above the 5-stop target. |
| A18 Small screens break | **Fixed** | Mobile CSS (`easy-mobile.css`) handles 360px+. Editor shows "larger screen" message. |
| A19 Duplicate presenter controls | **Fixed** | Presenter controls moved to editor only. |
| A20 Three Saved indicators | **Fixed** | One "Saved" in the header. |
| A21 Two transports disagree | **Fixed** | Easy has one preview; editor hides duplicate Play/scrub when the timeline is visible. |
| A22 Two mode toggles look identical | **Fixed** | Chat/Express replaced by "Skip questions" checkbox. Mode toggle uses distinct labels. |
| A30 Status bar is telemetry | **Mostly fixed** | Moved to Diagnostics disclosure. But `#spend` meter still visible (B06). |
| A33 "Colab" naming | **Fixed** | Always "Google Colab" in Easy copy. |
| A38 Dead link `/tts-expression/` | **Fixed** | Link removed. |

## 5. Summary

The UR revamp solved the structural problems: Easy is a real guided studio, not a CSS filter; the editor is reorganised with clean vocabulary; and the path from idea to video is linear. The remaining issues are in three categories:

1. **Studio polish**: template chips add keyboard stops, the offline planner still ignores the idea, the plan banner leaks jargon, the export step re-renders on re-entry, and half the screen is empty on early steps.
2. **Editor remnants**: a few strings ("GPU units", "Pick a backend and press Run", "fallbacks active until approved", "Remotion preview") survived the vocabulary cleanup.
3. **Cross-mode handoff**: returning from editor to studio restarts the export.

See [IMPROVEMENTS.md](IMPROVEMENTS.md) for the actionable list.
