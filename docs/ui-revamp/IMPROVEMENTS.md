# UI improvements — second pass

*Source: [AUDIT-2.md](AUDIT-2.md). Base: `feat/iteration-levels` at `743f80c`. All items scope to `apps/web` unless noted.*

## Item table

| Id | P | Size | Summary |
|---|---|---|---|
| UI2-01 | P0 | M | Export step re-renders on re-entry from editor |
| UI2-02 | P0 | S | Editor run-panel empty state says "Pick a backend and press Run" |
| UI2-03 | P1 | S | Plan banner says "offline planner" — replace with plain language |
| UI2-04 | P1 | M | Template chips on Idea step are buttons; convert to a radio group |
| UI2-05 | P1 | S | Editor status bar spend meter still shows "GPU units (est.)" outside diagnostics |
| UI2-06 | P1 | S | Editor Jobs tab hint says "fallbacks active until approved" |
| UI2-07 | P1 | S | "Ask for changes" dialog missing a Connect button to Settings |
| UI2-08 | P1 | S | Editor player aria-label says "Remotion preview" |
| UI2-09 | P1 | S | Settings AI-provider section uses raw technical labels |
| UI2-10 | P1 | S | Export extras button label is unclear |
| UI2-11 | P2 | M | Early Easy steps waste the right side of the screen |
| UI2-12 | P2 | S | Settings keyboard-shortcuts section is incomplete |
| UI2-13 | P2 | S | Plan step preview is a blank frame with no explanation |
| UI2-14 | P2 | S | Three header buttons in Easy look identical |

## Items

---

### UI2-01 · Export step re-renders on re-entry from editor

**Problem.** Switching to the editor after exporting, then pressing "Back to studio", re-enters the Export step and starts a new render instead of restoring the done screen.

**Desired outcome.** When the Easy store already records a completed export whose revision matches the package, the Export step mounts in the done state without calling `host.renderMp4()` again.

**Files likely touched.**
- `src/easy/steps/export.ts` — `mountExport` / `bind`: check `state.exported` before calling `begin()`.
- `src/easy/mount.ts` — no change needed if the step handles it internally.

**Size:** M — needs state check, a unit test for the "already exported" path, and a Playwright test that toggles modes after export.

---

### UI2-02 · Editor run-panel empty state says "Pick a backend and press Run"

**Problem.** The editor's Activity → Run panel says "No backend run yet. Pick a backend and press Run." There is no "Run" button anymore; generation is started from the Generate inspector tab.

**Desired outcome.** The empty state reads "No generation yet." with no mention of a backend or a Run button.

**Files likely touched.**
- `index.html` — line 111, the `#run-panel` default content.
- `src/main.ts` — `renderRunPanel` reset path (line ~1617).

**Size:** S — two string replacements.

---

### UI2-03 · Plan banner says "offline planner" — replace with plain language

**Problem.** The Plan step shows "Written by the offline planner. Connect an AI provider for a script written from your idea." The phrase "offline planner" is developer jargon.

**Desired outcome.** The banner reads "Written from templates. Connect an AI provider for a script written from your idea." or similar plain copy.

**Files likely touched.**
- `src/easy/copy.ts` — `COPY.plan.offline` string.
- `test/easy-copy.test.ts` — banned-word scan already checks Easy strings; may need to add "planner" or just update the string.

**Size:** S — one string change.

---

### UI2-04 · Template chips on Idea step are buttons; convert to a radio group

**Problem.** The four "Start from" template chips (Product launch, Explainer, Brand teaser, Lesson recap) are `<button>` elements, each a separate tab stop. They add 4 tab stops to the path from the heading to Continue. The spec target is ≤5 total tab stops.

**Desired outcome.** Template chips render as a radio group (`<fieldset>` with `<input type="radio">`) so they contribute one tab stop and arrow keys move between them. The visual appearance stays the same (chip-styled labels).

**Files likely touched.**
- `src/easy/steps/idea.ts` — `templateChips()` function: change from `<button>` to radio-label pattern matching `lengthSegments()`.
- `src/easy/steps/idea.ts` — `bind()` event handler: replace click-on-button with change-on-radio.
- `test/easy-idea.test.ts` — update assertions.

**Size:** M — structural change to the template section, needs updated tests.

---

### UI2-05 · Editor status bar spend meter still shows "GPU units (est.)" outside diagnostics

**Problem.** The `#spend` element in the status bar (`index.html:159`) sits outside the Diagnostics disclosure and shows "0.0 GPU units (est.)" to every user, including first-time users who have no Google Colab connection.

**Desired outcome.** The spend meter moves inside the `#diagnostics-panel` alongside the other telemetry, or is hidden when no run is active and the mode is not advanced.

**Files likely touched.**
- `index.html` — move `#spend` inside `#diagnostics-panel`.
- `src/main.ts` — the `refreshSpend` function already guards on Easy mode; moving the element is sufficient.

**Size:** S — move one element in HTML.

---

### UI2-06 · Editor Jobs tab hint says "fallbacks active until approved"

**Problem.** The Jobs panel header in the right rail says "fallbacks active until approved" — pipeline jargon that survived the vocabulary cleanup.

**Desired outcome.** The hint reads "Pending and completed jobs" or is removed entirely.

**Files likely touched.**
- `index.html` — line 146, the `<span class="hint">` inside the Jobs panel header.

**Size:** S — one string change.

---

### UI2-07 · "Ask for changes" dialog missing a Connect button to Settings

**Problem.** Without an AI provider, the "Ask for changes" action opens a dialog saying "Connect an AI provider…" but offers only a Close button. The `COPY.ask.connect` string ("Connect") is defined but never rendered as a button.

**Desired outcome.** The dialog shows a "Connect" secondary button that opens Settings → AI provider (`?settings=ai`), then returns focus to the dialog opener.

**Files likely touched.**
- `src/easy/mount.ts` — `openAsk` function (~line 190): add a second action with `value: 'connect'` and handle it by calling `host.openAgentSettings()` or navigating to `?settings=ai`.

**Size:** S — add one button to the dialog actions array and handle its return value.

---

### UI2-08 · Editor player aria-label says "Remotion preview"

**Problem.** The `<div id="player">` has `aria-label="Remotion preview"`. "Remotion" is an internal library name.

**Desired outcome.** The label reads "Video preview".

**Files likely touched.**
- `index.html` — line 80.

**Size:** S — one attribute change.

---

### UI2-09 · Settings AI-provider section uses raw technical labels

**Problem.** The AI provider `<select>` in Settings shows "local · scripted model", "OpenCode Go", "Custom · OpenAI-compatible", "OpenRouter". The "Agent settings" button reopens the old agent-settings dialog.

**Desired outcome.** Options are labelled in plain language: "None (offline templates)", "OpenCode Go", "Custom (OpenAI-compatible)", "OpenRouter". The "Agent settings" button is removed or inlined.

**Files likely touched.**
- `src/settings/sections.ts` — `bodyFor('ai')` option labels.

**Size:** S — string changes.

---

### UI2-10 · Export extras button label is unclear

**Problem.** "Download captions and extras (ZIP)" doesn't tell users what "extras" includes.

**Desired outcome.** The label reads "Download captions, credits and project files (ZIP)" or "Download all files (ZIP)".

**Files likely touched.**
- `src/easy/copy.ts` — `COPY.export.extras` string.

**Size:** S — one string change.

---

### UI2-11 · Early Easy steps waste the right side of the screen

**Problem.** On the Idea and Characters steps at ≥1024px, the content sits in a max-880px centred column with the right ~40% of the viewport blank. The two-column layout (`.easy-two-col`) is available but only used from Plan onward.

**Desired outcome.** Idea and Characters use a wider single-column layout (max-width ~1000px or wider) or add a sidebar with contextual content (example video thumbnail, tips, or a look-preview image) on wide screens.

**Files likely touched.**
- `src/easy/easy.css` — `.easy-main` max-width or step-specific overrides.
- `src/easy/steps/idea.ts` — optional: render a preview/tip column.

**Size:** M — layout tuning, possibly new side content, needs responsive testing.

---

### UI2-12 · Settings keyboard-shortcuts section is incomplete

**Problem.** The Keyboard shortcuts section lists only "Space — Play or pause" and "? — Keyboard shortcuts". It misses Ctrl/Cmd+Shift+A (mode toggle), Ctrl/Cmd+Enter (primary action), Alt+← / Alt+→ (step navigation), and Esc (close dialog).

**Desired outcome.** All documented shortcuts from the spec (SPEC §10) are listed.

**Files likely touched.**
- `src/settings/sections.ts` — `bodyFor('shortcuts')`.

**Size:** S — add list items.

---

### UI2-13 · Plan step preview is a blank frame with no explanation

**Problem.** The Plan step shows a `[data-easy-player]` slot on the right column, but the preview renders a black rectangle. There is no label explaining that visuals appear after generation.

**Desired outcome.** When the player has no content, show a labelled placeholder: "Preview appears after you generate." or a muted icon.

**Files likely touched.**
- `src/easy/steps/plan.ts` — render a placeholder message inside the player slot when the player is empty.
- `src/easy/easy.css` or a step-specific CSS file — placeholder styling.

**Size:** S — conditional HTML in the render function.

---

### UI2-14 · Three header buttons in Easy look identical

**Problem.** Help, Settings, and "Open in editor" all use the same `btn btn-secondary` style. "Open in editor" is a navigation action and deserves visual distinction.

**Desired outcome.** "Open in editor" uses a ghost or outlined style, or is positioned separately (e.g. right-aligned with a divider), to signal that it leaves the studio.

**Files likely touched.**
- `src/easy/shell.ts` — change the class on the "Open in editor" button.
- `src/easy/easy.css` — optional separator or variant styling.

**Size:** S — one class change and minor CSS.
