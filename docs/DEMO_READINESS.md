# Demo readiness — project gallery, modes and chat

Updated 2026-10-30 for the owner demo. This page describes the navigation contract
and the exact checks run against it. It is not a claim of human audiovisual
acceptance.

## One path to saved work

| Entry | Address | What it opens |
| --- | --- | --- |
| Owner projects | `?view=projects` | Every saved package, newest first, from `GET /api/packages` |
| Hosted gallery | `?demo=1` → `./gallery/` | Only the invite-scoped shared gallery; never `/api/packages` |
| Super Easy | `?package=<id>&view=super-easy` | That project's Super Easy state and media |
| Easy | `?package=<id>` | That project, resumed at its derived step |
| Editor | `?package=<id>&view=editor` | That exact package in Studio |
| Chat with agent | `?package=<id>&view=editor&focus=chat` | The same project, composer focused |

Every mode header has a **Projects** link (owner) or **Gallery** link (hosted
guest). Links are real URLs, so a cold reload and a new tab behave the same. The
previous project's `package`, `chat` or `production` parameters never follow a new
selection.

## What was broken and fixed

- Explicit `?package=` failures used to fall back to the bundled **Pip's Night
  Shift** package. They now fail closed with the requested id and a retry action;
  only an unqualified visit may use the sample.
- Easy's Editor button and Studio switch passed no package. They now pass the
  live Easy package (`state.packageId` / `store.get().packageId`) through a
  serialized transition that flushes autosave, loads and validates the exact
  package, then changes mode.
- Browser back/forward across projects reloads the requested identity instead of
  leaving the previous document mounted. Unsaved changes block the switch.
- A cold Editor boot left the Easy shell unrendered; switching to Easy now paints
  the routed step.
- Chat is bound to the selected package and its revision. Saved chat storage is
  package-scoped, late responses cannot replace another project, and a reload
  restores that project's own conversation instead of a fresh Pip chat. Hosted
  guests do not get owner chat endpoints.
- The render gate's review drawer was unreachable after the review pill moved out
  of the topbar. Export MP4 is now enabled while the gate is blocked and opens the
  drawer, where blockers and the explicit override live.
- The private demo is served over plain Tailscale/LAN HTTP. Hosted-hardening CSRF
  logic rejected every same-host POST/PATCH there (saves, chat, generation, media
  tickets). Exact host:port remains the boundary, Tailscale encrypts transport,
  and the hosted public profile still requires HTTPS.
- Reopening a project in Super Easy on a fresh browser showed a blank new-film
  prompt. The owner package read now returns the bound production, and the client
  hydrates it so the saved plan, gallery and status resume. Hosted guests never
  receive another viewer's production identity.
- Stale takes still have real media. They now keep their previews after a
  reference change instead of disappearing, and each shot carries its exact saved
  prompt, model/workflow, dimensions, duration and seed. Conditioning images stay
  labelled as references, not generated clips.
- The Easy home's **New video** action previously called a step renderer with no
  shell mounted and did nothing. It now clears the old project from the address
  and opens the new film's idea step.

## Verification

Browser checks use the shipped Vite app and real local HTTP server. Only the LLM
is scripted on loopback; navigation itself is not intercepted except to block
generation POSTs. No GPU, model, Colab or paid call is made.

- `project-mode-continuity.spec.ts` — **9 passed**: gallery links, both saved
  projects, Super Easy → Easy → Editor, reload/back/forward, chat turn binding,
  conversation restore, missing-project errors, phone viewport.
- `default-project.spec.ts` — **3 passed**: first open, blocked-gate review drawer
  and take approval, recorded Colab history.
- `project-navigation.spec.ts` — **4 passed**; `super-easy-asset-detail.spec.ts`
  — **2 passed**; `super-easy-generation-status.spec.ts` — **1 passed**;
  `super-easy-film-review.spec.ts` — **2 passed**; `super-easy-landing.spec.ts`
  — **3 passed**; `super-easy-compute-recovery.spec.ts` — **1 passed**.
- Unit suite: **1,756 passed, 1 skipped, 0 failed**; TypeScript typecheck and the
  production build pass. Release scan is clean.
- Server suite: **2,436 passed, 0 failed, 8 skipped**.
- Deployed to the private demo at `<TAILNET_HOST>:4404` on `main`. The live
  Checkmate project opens with all ten shot previews, exact prompts/models, the
  failed-export status, and verified GPU shutdown; its package bytes were not
  modified.

## Known limits for the demo

- The existing **Checkmate at the Golden Arches** project completed 31 media jobs,
  but the long-running server that executed it predates trusted receipt
  collection. Its final export stays blocked by the verified-contribution gate.
  The media and failure evidence are preserved; the project does not fabricate
  receipts. A fresh trusted run is required for a new final film.
- Hosted invite runs without a final per-session usage receipt keep their CU
  reservation and are labelled **Usage indeterminate; CU reserved**. They are not
  reported as actual spend.
- Automated review, speech timing and browser checks are not human visual or
  lip-sync acceptance.
