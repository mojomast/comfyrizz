# UX-RESULTS capability and review status

This note is the reader-facing summary of the UX-RESULTS remediation. It is
deliberately narrower than the packet catalog: a feature appears here only when
its adapter is mounted in `apps/server/src/app.mjs` or `apps/web/src/main.ts`, or
is marked **component only** so it is not mistaken for a finished journey.

The integration details are in
[`docs/UX_RESULTS_INTEGRATION_LOG.md`](../UX_RESULTS_INTEGRATION_LOG.md).

## Keep four states separate

Every visible result keeps these independent. A later state never implies an
earlier one by accident, and an unknown state is never shown as approval.

| State | What it means | What it does not mean |
| --- | --- | --- |
| **Generated** | Bytes exist because a CPU or GPU job returned them. | That the clip was selected, checked or watched. |
| **Auto-selected** | The take controller chose the current candidate by its deterministic rule. | That a person approved the performance. |
| **Technically checked** | Frame/QA, caption, aspect, hash or readiness checks passed. | That the acting, pacing or look is good. |
| **Human-reviewed** | A person recorded an explicit verdict. | That an automatic check exists, or that unrelated shots were reviewed. |

The final delivery gate keeps unreviewed takes visible as unreviewed. It does
not turn a technical pass or an automatic selection into a human verdict.

## Mounted in this slice

| Area | Visible behavior | Status |
| --- | --- | --- |
| Generation admission | A package owned by a production starts only from the approved production action. A bound regenerate, batch, queue drain or chat correction refuses instead of falling back to legacy execution. | Mounted |
| Run cancellation | `POST /api/run/:runId/cancel` asks the controller to abort the run. Requested, stopped and unconfirmed shutdown remain separate. | Mounted |
| Production execution | A committed action dispatch is drained by the server-owned outbox executor. Startup reconciles actions that already claimed execution; a merely queued action waits for its dispatch. | Mounted |
| Budget and cap | The production spend cap and budget summary are served by the existing production routes. A level choice is not spend approval. | Mounted |
| Snapshot and reset | The production snapshot, event sequence and new-project reset are served by the existing production routes. | Mounted |
| Save truth | The editor header reads the save-state snapshot. A revision appears only after the server acknowledges the current edit; offline, conflict and rejected stay distinct. | Mounted |
| Easy Studio | Super Easy opens by default; Easy Studio keeps the seven steps and hands off to Advanced. | Mounted |
| Scoped turns | A chat turn sends explicit targets only when the visible chips name a clip. No selection omits targets; it never sends an empty list by accident. | Mounted |
| Take selection and delivery | A production-bound select, revert, regenerate or export goes through the production command path. An unbound package keeps the legacy path. | Mounted |
| Audit and voice | A Kokoro character audition uses the production ledger when it is bound. Google Colab is never contacted by the audition path itself. Native/prompt voice is not claimed because no video-model context is mounted. | Mounted (Kokoro) |
| Export integrity | The four export/render routes share the final delivery gate and now carry the production binder for bound packages. Delivery snapshot and preflight are mounted; versioned bundle publication is not. | Mounted (core) |
| Easy export record | The export step persists the canonical delivery record by name and bytes. It never stores a blob, path or expiring URL. | Mounted |
| Shell notices | The non-obstructing shell toast is the one notice surface. Export failure keeps a Retry action; focus or pointer pauses dismissal. | Mounted |
| Timeline efficiency | Scene cards are cached and the active class changes only when the active scene changes. This is the shell efficiency fix, not media hydration. | Mounted |

## Component only or intentionally unbound

These are not counted as fixed user journeys.

| Area | Why |
| --- | --- |
| Timeline media hydration | The expiry-aware ticket resolver and timeline hydrator exist, but no mounted host calls them; the timeline host adapter also does not forward its thumbnail/open hooks. The component is not a mounted journey. |
| Native/prompt audition | The worker accepts a model capability object, but the app has no selected video-model context. Passing a fabricated capability would be dishonest. |
| Native-transfer continuity | The native-transfer validator and voice-reference helpers exist, but no exported route or Characters host hook is mounted. Paid native dispatch stays off. |
| Reopened export after reload | The export record can be saved, but the server exposes no stable artifact lookup route. The step shows `not-connected` rather than a fabricated download. |
| Versioned bundle publication | `createDeliveryStore` exists but no mounted route consumes it. The export directory and snapshot are written; immutable bundle publication is not a delivered journey. |
| Scratch-space preflight | The renderer helper is not consumed by an assigned app or web file in this packet. |
| Browser and human acceptance | Typecheck and local fakes pass. Real Chromium/Firefox/WebKit journeys, assistive technology and human acting/voice review remain manual checks. |

## Reconciled claims

- **Default mode:** a bare visit opens **Super Easy**, which starts on **This
  computer** and Draft. Easy Studio and Advanced remain available; no default
  path silently spends Google Colab units.
- **Iteration:** Draft, Balanced, Director and Custom are estimates and
  trade-offs. They are not approvals, and the agent cannot set or raise them.
- **Voice:** a character speaks with the video model's native voice only when
  that model declares the capability; otherwise the local Kokoro path is used.
  Voice cloning is not supported.
- **Quality:** frame QA, caption/aspect checks, hashes and delivery preflight are
  technical evidence. They do not approve acting, voice quality or creative
  intent, and they never replace a human verdict.
- **Export:** draft and final intent stay distinct. A technical pass can prepare
  a draft without presenting it as a reviewed final. Missing evidence is shown
  as unknown, never as approved.
