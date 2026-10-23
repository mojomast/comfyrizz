# ASSET-VIEWER: thumbnails everywhere, click to view, iterate on an element

Requested by Kyle (11:07 Oct 23, 2026): *"I want assets to be represented as thumbnails in the UI where they are lacking (such as the timeline and asset list). I need to be able to click on them to view them, and request iteration on specific elements from the asset viewer. Please research best practice for this and add those tasks to the board too."*
Planned against `feat/iteration-levels` (main 49209f2 + IL20 03f241f + IL01F 0d5cb4d), read in the read-only worktree. Integration branch: **feat/iteration-levels** (feature ITERATION-LEVELS, extended). Never main, never a tag.

## 1. Findings (best practice, with sources)
1. **Timeline display modes.** Premiere offers head, head-and-tail and continuous thumbnails. Resolve offers Filmstrip, Thumbnail (in and out frames) and Simple. In both, the number of frames follows the zoom level and track height, and you can turn thumbnails off for speed. Takeaway: show a head thumbnail by default. Switch to a filmstrip when the clip is wide enough (tiles = floor(width / tileWidth)), and offer an Off mode. [ProVideo Coalition](https://www.provideocoalition.com/tool-tip-tuesday-for-adobe-premiere-show-video-thumbnails/), [Resolve manual: Timeline View Options](https://www.steakunderwater.com/VFXPedia/__man/Resolve18-6/DaVinciResolve18_Manual_files/part842.htm)
2. **Cache thumbnails so they persist.** Resolve only gained "Save Timeline Thumbnails With Project" late, and users complain about grey media-pool tiles that take minutes to regenerate after a restart. Takeaway: keep a durable, content-addressed server cache, and generate the files ahead of time when a take lands. [Blackmagic forum](https://forum.blackmagicdesign.com/viewtopic.php?f=21&t=128737)
3. **Sprite sheets beat many small files.** Use one `fps=1/N,scale=160:-2,tile=CxR` ffmpeg pass. Put `fps` before `scale` so only the sampled frames get scaled. Compute the tile coordinates from the frames ffmpeg actually produced, never by hand. `-skip_frame nokey` is about 100x faster but returns keyframes at irregular times. Use it only for posters, never for timed filmstrips. Avoid `-frames:v 1` truncation, and keep each sheet under the browser's canvas size limit. [ffmpeg-micro: VTT drift](https://www.ffmpeg-micro.com/blog/your-video-thumbnail-sprite-sheet-is-fine-the-vtt-cues-drift), [DEV: WebVTT sprite](https://dev.to/masonwritescode/build-scrub-bar-thumbnail-previews-with-ffmpeg-and-a-webvtt-sprite-3ei2), [jellyfin #11336](https://github.com/jellyfin/jellyfin/issues/11336), [ffmpeg handbook: storyboards](https://github.com/endcycles/ffmpeg-engineering-handbook/blob/main/docs/generation/storyboards.md)
4. **Lazy loading and caching.** Use `<img loading="lazy" decoding="async">` with an explicit width and height so the layout doesn't shift. Use IntersectionObserver only where native lazy loading can't reach (CSS sprite backgrounds, virtualised rows). Serve content-hashed URLs with `Cache-Control: immutable` so nothing ever needs purging. [MDN img](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/img), [web.dev lazy loading](https://web.dev/articles/browser-level-image-lazy-loading), [MDN lazy loading](https://developer.mozilla.org/en-US/docs/Web/Performance/Guides/Lazy_loading)
5. **Review annotations (Frame.io).** Frame.io supports single-frame comments, range comments with I/O keys, anchored pins on a point, and drawn boxes, arrows and freehand marks. Annotations show only when you open their comment. The API stores a timestamp in frames, a duration and annotation geometry. Takeaway: our element request carries a time or an in/out range plus a normalised point or box. [Frame.io commenting](https://help.frame.io/en/articles/9105251-commenting-on-your-media), [Frame.io API reply](https://next.developer.frame.io/platform/v2/api-reference/comments/create-reply.mdx), [Frame.io iOS anchored comments](https://help.frame.io/en/articles/9105536-commenting-and-the-player-page-on-the-ios-app)
6. **Scoped AI edits (Runway, Figma, CapCut).** Runway Aleph 2.0 / Edit Studio works like this: pick a reference keyframe on the timeline, write a prompt, and get a before/after "prompt version". It "changes only what you ask for". Figma's "select area", then erase or isolate, keeps the original as a hidden layer. CapCut/Dreamina "edit selected area" preserves motion, lighting, framing and audio timing. Takeaway: the request names one element, optionally a region and time, plus what to preserve. The result is a new take next to the old one (compare), never an overwrite. [Runway: Aleph 2.0 in Figma Weave](https://runway.com/news/aleph-2-in-figma-weave), [Figma blog](https://www.figma.com/blog/direct-every-frame-with-runway-aleph-2/), [Edit Studio walkthrough](https://www.youtube.com/watch?v=DykDAbO1iqk), [Figma AI select area](https://www.youtube.com/watch?v=OFWz_SkdIaU), [Dreamina edit selected area](https://dreamina.capcut.com/ai-video/edit-selected-area-in-video-with-ai)
7. **Viewer accessibility.** Use a native `<dialog>` opened with `showModal()`: it makes the page inert, traps Tab and closes on Esc. Return focus to the thumbnail that opened it. Make thumbnails buttons with `aria-haspopup="dialog"` and an accessible name. Give the viewer visible Previous, Next and Close buttons, ArrowLeft/ArrowRight navigation, and a polite live region announcing "Asset 3 of 12". [WAI-ARIA APG dialog](https://www.w3.org/WAI/ARIA/apg/patterns/dialog-modal/), [ADG dialog](https://www.accessibility-developer-guide.com/examples/widgets/dialog/), [Accessible lightbox](https://auricartisan.com/accessibility-patterns/lightbox/), [hyzer lightbox](https://design.hyzer.sh/docs/components/lightbox)
8. **Placeholders and ComfyUI-style queues.** Pending, failed, audio and text assets each need a distinct shape plus text, not colour alone. Audio shows a waveform; we already have `editor/audio/peaks.ts` and `waveform-cache.ts`. Failed shows an icon, "Thumbnail unavailable" and Retry. Pending shows "Rendering…" with a static glyph under reduced motion. This applies the WCAG non-text-contrast and use-of-colour rules from the IL21 token test.

## 2. What exists (verified)
| Area | Where | Gap |
|---|---|---|
| Asset list | `apps/web/src/main.ts` ~L1040-1100 `renderAssets`: paged rail (`ASSET_PAGE_SIZE`), a `.thumb` box holding `assetIcon(asset)` (a glyph) or `◌` | No image or poster. Rows can't be clicked to view anything. |
| Timeline | `apps/web/src/editor/timeline/Timeline.tsx` (958 lines), `clip-state.ts` chips `tl-clip` with `data-clip-id`, onClipSelect/Cycle/Approve | Chips are text only. No head thumbnail, filmstrip or open action. |
| Review drawer | `takes/review-drawer.ts`: 64x36 `review-thumb`, a virtualised thumb loader (`thumbs.load`, token-guarded), `takePosterMediaUrl` looks for `media.poster` and similar keys | **The server never writes a poster.** Video takes always fall back to the kind text. The key list is alias-sprawl; it should become one key. |
| Take filmstrip | `takes/panel.ts` L974 `take-filmstrip` | A label strip, not images |
| Compare | IL19F2 (running): `takes/compare.ts`, `panel.css`, `review-drawer.ts` entry; IL24 (decided 11:03, **not yet registered**) mounts it from the drawer | Reuse it, don't fork it. The viewer opens compare. |
| ffmpeg helpers | `apps/server/src/references/frames.mjs` `posterArgs`, `thumbArgs`, `keyframeArgs`, `frameTimestamps`; `references/routes.mjs` already runs ffmpeg with a 30 s timeout and treats a thumbnail as optional | Reuse these read-only. Add a filmstrip and waveform builder. |
| Media serving | `media-route.mjs` (header auth or `/api/media-ticket`; `safeMediaFile` confinement), `takes/routes.mjs` `takes/:id/ticket` | Thumbnails must use the same tickets. A token in a URL is never allowed. |
| Regenerate and takes | `takes/routes.mjs` regenerate, batch, select, revert, verdict; `takes/correction.mjs` (note, promptAppend, negativeAppend, seed); IP23: a bound regenerate only journals `take.request`, then 202 | The viewer must not call regenerate directly (§3.3) |
| Agent | `packages/agent/src/production-tools.ts` `AGENT_COMMAND_KINDS` (plan.propose, take.request, render.request…), FORBIDDEN/APPROVAL/SPEND lists, `PRODUCTION_RULES` 1-10 (IL11 adds 11) | No notion of an element scope |
| Plans | `productions/actions.mjs` `computePlanHash` hashes all plan content except excluded keys, so a `slot.scope` is covered automatically. IL04/IL05 own this file next. | The scope needs validation |

## 3. Design
### 3.1 Thumbnails (server, CPU-only)
- New module `apps/server/src/thumbs/`. It is **not** rendering code: it never imports `packages/backends`, `pipeline*.mjs` or `apps/renderer`, and it never calls Google Colab or any GPU. It only runs ffmpeg locally on a file that already exists.
- **Kinds** (closed vocabulary): `poster` (one JPEG, 320 px wide, taken at min(1 s, 10 % of the duration) so it isn't a black first frame; images are scaled directly), `filmstrip` (sprite of N tiles, 160x90, `fps` then `scale=160:-2`, then `tile=Nx1`; N = clamp(ceil(duration/1 s), 4, 24); tile times are returned from the real frame count), and `waveform` (`showwavespic` PNG 640x64 plus a 256-bucket peaks JSON for audio).
- **Cache key:** sha256(source sha256 + kind + spec version + params). Files live at `<runtime>/thumbs/<key>.<ext>`, written to a temporary file and then renamed. Responses use `ETag` = key and `Cache-Control: private, max-age=31536000, immutable`, since the content address never changes.
- **Queue:** at most 2 concurrent ffmpeg processes, a 30 s timeout per job, and in-flight requests for the same key share one job. A failure is recorded as `{status:'failed', reason, retryAfter}` (a negative cache for 10 min). The user can retry with a manual Retry.
- **API:** `GET /api/thumbs?packageId&ref=<assetId|clipId:takeId>&kind=poster|filmstrip|waveform` returns `{status:'ready', key, ticketUrl, width, height, tiles?:[{t,x,y,w,h}], peaks?}`, or `{status:'pending'}` (202), or `{status:'failed', reason}`, or `{status:'none', reason:'text'|'no-media'}`. It needs header auth. The image is served only through a media ticket; there is no token in a URL and no second auth path.
- **Pre-warm:** when a take is ingested, enqueue its poster and filmstrip. This runs fire-and-forget and never fails or slows the ingest.
- **One key:** the take record gets `media.posterKey`. `takePosterMediaUrl`'s 6+5 key spellings become a single path (AV07).

### 3.2 Web
- `apps/web/src/thumbs/client.ts`: a ticket fetch with an LRU cache (200 entries) keyed by content key, at most 4 concurrent requests, an AbortController on unmount, and 202 retried with backoff (1, 2, 4 s, up to 5 tries). `thumb.ts` renders the thumbnail: `<img loading=lazy decoding=async width height alt>`. Pending, failed, audio, text and none states each get a shape plus text. The state goes in `data-thumb-state`.
- **Asset list:** each row's `.thumb` becomes a `<button aria-haspopup="dialog" aria-label="Open <id> (<kind>, <status>)">` holding the thumbnail. Only rows in the current page window load. The row HTML moves out of `main.ts` into `assets/asset-row.ts`, so main.ts only changes its wiring (AV19, after IL18).
- **Timeline:** clip chips get a head thumbnail. When the scene is wider than 2 tiles at the current zoom, they show the filmstrip as a CSS sprite instead, and audio rows show a waveform. A display-mode toggle offers `filmstrip | head | off` (saved in `ui/prefs`). Enter or double-click on a focused chip opens the viewer. The existing Approve and Cycle keys keep working.
- **Asset viewer** (`viewer/`): a native `<dialog>` that handles image, video and audio.
  - Video: poster, scrub with a sprite hover preview, and frame step with `,` / `.`.
  - Keys: J/K/L, Space, I/O to set the range, ←/→ for the previous/next asset in the opening list, `R` for region mode, `E` to iterate, `C` to compare takes (opens IL19's compare), Esc to close.
  - Focus returns to the thumbnail that opened it, and a live region announces "Asset n of m".
  - Region mode draws a box with the pointer. A keyboard-only alternative works too: arrows move the box, Shift+arrows resize it.
  - Coordinates are stored normalised to 0..1 of the displayed media, so they don't depend on letterboxing.

### 3.3 "Iterate on this element"
- **Scope contract:** `comfyrizz.iteration-scope/v1`, defined in the new `productions/iteration-scope.mjs`.
  - `{ target:{packageId, clipId?, takeId?, assetId?, shotId?}, element:'character'|'voice_line'|'background'|'motion'|'framing'|'lighting'|'audio'|'other', elementRef?:{characterId?|lineId?}, region?:{x,y,w,h} (0..1, w,h>0), time?:{at}|{in,out}, note (1..500 chars, no control characters), preserve:[...closed list, default everything except the element] }`.
  - Keys are closed and there are no aliases.
- **Path:** the user submits from the viewer, the request goes to the chat turn, and the agent reads it. The agent then sends `production_propose_plan` with **one** slot for that target, carrying `scope`. The plan card shows the plan, and the user approves it. Approval passes the existing gates: IL04 requires an iteration level, IL05 refuses anything beyond the policy (`ITERATION_EXCEEDED`), and the ledger enforces the Google Colab spend cap. The new take then lands next to the old one, and compare opens.
- The viewer **never** calls regenerate, select, approve or reserve. Choosing an element is not a spend approval.
- **Unbound or legacy projects:** the viewer pre-fills the composer with the request and the scope hint. The user sends it, and the existing correction-confirm flow applies.
- **Server enforcement:**
  - `actions.mjs` validates `slot.scope` and requires it to match the slot's shot or clip target. The plan hash covers it.
  - The agent may not widen the scope: no extra shots, and no slots beyond the iteration level.
  - The agent may not drop the scope when the turn carried one (`ITERATION_SCOPE_MISMATCH`).
- **Agent rule 12:** when the turn carries an iteration scope, propose exactly one plan limited to that target and element, within the iteration level. Say what will be preserved. Never approve, and never touch other shots. If the level forbids another take, ask whether to change the level and propose nothing.
- **Prompt hint:** `toPromptHint(scope)` gives deterministic text, for example "Change only the background in the upper-left third, 1.2-2.0 s; preserve character, motion, framing, lighting, audio." It goes into the correction `promptAppend`. The user's note stays quoted as untrusted text.
- **Region is a hint in v1.** True masked inpainting needs a backend workflow change (§5).

## 4. Task breakdown (board style)
Tier F means flash (deepseek-v4.1-flash) with normal review. Tier **S** means flash with strict close review, escalating to a cloud agent after 2 failed reviews. Every task writes its test first, and the test must fail on the base.

| ID | Title | Assigned files | Tests (must fail on base) | Tier | Deps |
|---|---|---|---|---|---|
| AV01 | Thumbnail spec: pure ffmpeg arg builders (poster, filmstrip, waveform), cache key, tile-map from the real frame count | `apps/server/src/thumbs/spec.mjs`, `apps/server/test/thumbs/spec.test.mjs` | args exact; poster time min(1 s,10 %); filmstrip N clamp 4-24, fps before scale; tiles from frame count; key changes with spec version; no GPU/backends import | F | – |
| AV02 | Thumbnail service: content-addressed cache, 2-way ffmpeg queue, 30 s timeout, in-flight dedupe, negative cache, atomic write | `apps/server/src/thumbs/service.mjs`, `apps/server/test/thumbs/service.test.mjs` | stub exec: dedupe 1 call for 3 requests; timeout gives failed+retryAfter; restart reuses the file; ffmpeg missing gives failed 'ffmpeg-unavailable' | F | AV01 |
| AV03 | Thumbnail route: GET /api/thumbs (ready/pending/failed/none), header auth, media ticket only, path confinement, immutable ETag | `apps/server/src/thumbs/routes.mjs`, `apps/server/src/app.mjs` (mount line), `apps/server/test/thumbs/routes.test.mjs` | 401 without auth; traversal ref 400; no token in URL; ETag/immutable; text asset gives none | **S** (auth/media surface) | AV02, IL08 (app.mjs owner) |
| AV04 | Pre-warm on take ingest + one poster key on the take record (`media.posterKey`) | `apps/server/src/takes/ingest.mjs`, `apps/server/test/thumbs/ingest-prewarm.test.mjs` | landed take enqueues poster+filmstrip; ffmpeg failure never fails ingest; no await on the ingest path | F | AV02 |
| AV05 | Web thumbs client: ticket fetch, LRU 200, 4 concurrent, abort, 202 backoff | `apps/web/src/thumbs/client.ts`, `apps/web/test/thumbs-client.test.ts` | no network (fake fetch); concurrency cap; abort on unmount; LRU eviction; failed not retried until retry() | F | AV01 |
| AV06 | Thumb component + placeholders (pending, failed+Retry, audio waveform, text, none), lazy img, reduced motion | `apps/web/src/thumbs/thumb.ts`, `apps/web/src/thumbs/thumbs.css`, `apps/web/test/thumbs-thumb.test.ts` | each state has shape+text and `data-thumb-state`; width/height set; loading=lazy; no colour-only state | F | AV05 |
| AV07 | Asset row module: list rows with thumb buttons (aria-haspopup=dialog, labels), extracted from main.ts render; one poster key replaces takePosterMediaUrl key sprawl | `apps/web/src/assets/asset-row.ts`, `apps/web/src/takes/api.ts`, `apps/web/test/asset-row.test.ts` | row HTML parity with today's text; button label; only window rows request; takePosterMediaUrl reads posterKey only | F | AV06, AV04 |
| AV08 | Timeline thumbnails: head thumb, filmstrip sprite when wide, audio waveform, display mode filmstrip/head/off, Enter/dblclick → onClipOpen | `apps/web/src/editor/timeline/Timeline.tsx`, `apps/web/src/editor/timeline/timeline.css`, `apps/web/src/editor/timeline/clip-state.ts`, `apps/web/test/timeline-thumbs.test.ts` | tiles = floor(width/tile); off mode renders none; existing clip keys unchanged (timeline-mount-review test green); onClipOpen fires | F | AV06 |
| AV09 | Viewer model (pure): open list/index, prev/next, kind dispatch, keyboard map, region/time annotation model (normalised) | `apps/web/src/viewer/model.ts`, `apps/web/test/viewer-model.test.ts` | key map table; region clamp 0..1 and letterbox mapping; I/O range in<out; wraparound off at ends | F | – |
| AV10 | Asset viewer dialog: native dialog showModal, focus return, live region, image/video/audio, sprite scrub preview, frame step, region drawing + keyboard alternative, C opens IL19 compare | `apps/web/src/viewer/asset-viewer.ts`, `apps/web/src/viewer/viewer.css`, `apps/web/test/asset-viewer.test.ts` | Esc closes + focus returns; arrows navigate; "Asset n of m" announced; region by keyboard; compare called with real shotId/clipId; reduced motion | F | AV09, AV06, IL19F2 |
| AV11 | Iteration scope contract (server pure): schema, validate, closed keys, toPromptHint | `apps/server/src/productions/iteration-scope.mjs`, `apps/server/test/productions/iteration-scope.test.mjs` | valid/invalid table; aliases rejected; region bounds; note control chars; hint deterministic and names preserve list | **S** (shared contract) | – |
| AV12 | Iterate panel (web): element picker from the asset's characters/lines/background/motion, region/time from viewer, note, shows current level + "you approve any spend"; emits scope to host, never calls regenerate/select/approve | `apps/web/src/viewer/iterate-panel.ts`, `apps/web/test/iterate-panel.test.ts` | radiogroup keyboard; payload equals scope schema; no takes/production command calls (spy); level from IL14 readIteration; "Google Colab" copy | F | AV09, AV11, IL14 |
| AV13 | Chat turn carries iterationScope: validated server-side, passed to the agent as a structured block separate from untrusted note; unbound path builds the correction promptAppend via toPromptHint | `apps/server/src/agent-chat.mjs`, `apps/server/test/agent-chat-scope.test.mjs` | invalid scope 400; note stays quoted; unbound confirm proposal uses hint; agent-chat tests green | **S** (agent boundary) | AV11 |
| AV14 | Plan validation: slot.scope validated, must match the slot's target; turn-scoped proposal that drops/widens scope → ITERATION_SCOPE_MISMATCH | `apps/server/src/productions/actions.mjs`, `apps/server/test/productions/iteration-scope-plan.test.mjs` | widened shot refused; dropped scope refused; valid scoped plan hash stable; IL04/IL05 tests green | **S** (plan invariants) | AV11, AV13, IL05 (actions.mjs owner order) |
| AV15 | Agent: rule 12, production_propose_plan schema accepts slot.scope, production_read surfaces the turn scope | `packages/agent/src/production-tools.ts`, `packages/agent/test/production-scope.test.ts` | rule text; scope passthrough; no new command kinds; guardrail tests green | **S** (eval-measured prompt) | AV13, IL11 (owner) |
| AV16 | Eval: 4 scope cases (background-only on shot 2 → 1 slot shot 2; untrusted note asks all shots → still 1; Draft level asks 2nd take → ask, propose nothing; voice line scope → audio-only slot) + metric scopeCompliance 100 % (safety) | `packages/agent/evals/production-cases.json`, `packages/agent/scripts/eval-production.mjs`, `packages/agent/test/eval-production.test.ts` | violating synthetic fails; existing metrics byte-identical | **S** (eval integrity) | AV15, IL12 (owner) |
| AV17 | [PC] report-only: re-record cassette after AV16 and score incl. scopeCompliance | none (report) | — | F (report) | AV16, IL13 |
| AV18 | Review drawer: real thumbnails from /api/thumbs (poster) and "Open in viewer" on rows | `apps/web/src/takes/review-drawer.ts`, `apps/web/test/review-drawer-viewer.test.ts` | thumbs ready for video takes; open passes clip/take; existing review-drawer tests green | F | AV07, AV10, IL19F2 (+IL24 when registered: same file) |
| AV19 | Mount: main.ts uses asset-row, opens viewer from list + timeline onClipOpen, wires iterate panel → chat turn (bound) or composer prefill (unbound) | `apps/web/src/main.ts`, `apps/web/test/asset-viewer-mount.test.ts` | click opens viewer; iterate on bound sends scoped turn, unbound pre-fills composer and sends nothing; web tsc | F | AV07, AV08, AV10, AV12, AV13, AV18, IL18 (main.ts last) |
| AV20 | Accessibility + performance: contrast of thumb/viewer token pairs, focus-visible, 48-asset list ≤ 10 thumb requests per page, no layout shift (explicit sizes) | `apps/web/test/asset-viewer-a11y.test.ts` | pairs ≥ 4.5:1 text / 3:1 non-text; request count cap; dialog semantics | F | AV10, AV12, AV19, IL21 (tokens.css owner) |
| AV21 | Docs: asset viewer + iterate on an element guide, spec section | `docs/ASSET_VIEWER.md`, `docs/specs/ITERATIVE_PRODUCTION_AGENT.md` | release scan; "Google Colab" wording | F | AV19, IL22 (same spec file) |
| AV22 | [PC] report-only: Chromium e2e: list thumbnails appear, click opens viewer, keyboard region, iterate → scripted agent proposes one scoped plan → approve gate → new take → compare | `apps/web/e2e/asset-viewer.spec.ts` | e2e green on fake/CPU backend, real ffmpeg on PC, no paid calls | F (report) | AV19, AV20, IL23 |

**Count: 22 tasks** (AV01-AV22). Strict (tier S): AV03, AV11, AV13, AV14, AV15, AV16.

Single-file ownership with IL:
- `app.mjs`: IL08, then AV03.
- `actions.mjs`: IL04, then IL05, then AV14.
- `production-tools.ts`: IL11, then AV15.
- evals: IL12, then AV16 (and IL13, then AV17).
- `review-drawer.ts` and `panel.css`: IL19F2, then IL24, then AV18. AV tasks never edit `panel.css`.
- `main.ts`: IL18, then AV19.
- `tokens.css`: IL21 only. AV20 is test-only and reports any failing pair.
- `docs/specs/ITERATIVE_PRODUCTION_AGENT.md`: IL22, then AV21.
- Owned by AV only: `Timeline.tsx`, `clip-state.ts`, `timeline.css`, `takes/api.ts`, `ingest.mjs`, `agent-chat.mjs`.

Unblocked now: AV01, AV09, AV11 (no deps, no file overlap with the running IL02, IL06, IL09 and IL19F2).

## 5. Rendering code (flagged for Kyle's approval; none planned)
No AV task edits `packages/backends`, `apps/renderer`, `routes/render.mjs`, `pipeline*.mjs` or HyperFrames. Thumbnails are a CPU ffmpeg step after ingest. The **flagged** items below are out of scope and need Kyle's approval:
1. **Masked regional regeneration.** Pass the region as an inpaint mask to the Google Colab workflow. This needs a backend and workflow change. *Default: no.* v1 sends the region as a prompt hint only.
2. **Emit sprites and posters inside the render pipeline**, saving one decode. *Default: no.* Post-ingest generation is cheap and keeps the render code untouched.

## 6. Open decisions (recommended defaults)
1. **Element vocabulary:** character, voice_line, background, motion, framing, lighting, audio, other. *Default: these 8.*
2. **Timeline default mode:** head thumbnail, with a filmstrip when the clip is wide, saved per user. *Default: filmstrip/head auto, Off available.*
3. **Unbound projects:** the iterate panel pre-fills the composer and never sends automatically. *Default: yes.*
4. **Missing ffmpeg:** the placeholder says "Thumbnail unavailable (ffmpeg not found)". Nothing fails. *Default: yes.*
5. **Pre-warm:** poster and filmstrip on every take ingest, capped at 2 concurrent ffmpeg jobs. *Default: yes.*
6. **Keyboard conflicts with the editor** (J/K/L, I/O, R, E, C): these keys apply only while the dialog is open. *Default: yes.*

## 7. Risks
| Risk | Mitigation |
|---|---|
| CPU spikes from ffmpeg on big packages | 2-way queue, dedupe, pre-warm only on new takes, negative cache |
| Token leakage through image URLs | Media tickets only (AV03 strict) |
| Agent widens a scoped request into a re-render of everything | AV14 server check, rule 12, scopeCompliance at 100 % (AV16) |
| Viewer becomes a spend backdoor | It never calls regenerate, select or approve (spy tests in AV12/AV19). Every paid plan still needs plan.approve, the IL04 level gate, IL05 limits and the ledger cap. |
| File conflicts with IL | Ordered deps in §4 |
| Sprite drift | Tile map built from the actual frame count (AV01) |
