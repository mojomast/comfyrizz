# Comfy quality and Super Easy review integration

Research date: 2026-10-30. Integration combines current hosted `main` (`61c5d5d`),
production hardening/UI recovery (`804d7c2`), and bounded Pi review/repair (`0039ae6`).
The research compares production and `origin/main`, rather than assuming findings
from one branch apply unchanged to the other.

## Nine recommendations

| # | Recommendation | Decision and evidence |
| --- | --- | --- |
| 1 | Valid LTX stage-1 dimensions | Fix template defaults to **512×288 → 1024×576**. Keep the upscale generation raster on the lattice before delivery framing. Validate half-size geometry in JS and Python. Ordinary plate planning already normalized output to multiples of 64. |
| 2 | Change refinement start from `.85` to `.909375` | **Defer pending matched clip A/B.** The official Comfy built-in template uses `.85`; the official Lightricks advanced/Python route uses `.909375`. Neither is universally incorrect. |
| 3 | Richer Klein captions, framing early | Replace the restrictive 40–70-word rule with concrete scene guidance and early medium/framing. BFL suggests **100–350 words for T2I**, not a mandatory 80–150-word quota. Preserve exact supplied copy and avoid invented detail. |
| 4 | Finished-image edit descriptions and reference tokens | Distinguish full new compositions from bounded edits with explicit end states and preserved identity. BFL allows edit instructions; Comfy recommends finished-image captions. Tokens follow zero-based **connected conditioning order**: composition `<ref_image_0>`, identity `<ref_image_1>` in the LTX start-frame pair. |
| 5 | Klein negatives at CFG 1 | Use positive surface descriptions for distilled Klein. Remove the incorrect blanket claim that every model lacks working negative conditioning; retain LTX/H3-specific behavior. |
| 6 | Focused LTX prompting and `8n+1` | Use a continuous shot with focused action/camera guidance and separate finishing sound. Normalize legacy A2V narration frames upward, validate frames, and synchronize graph FPS. The single-shot rule is application policy: LTX itself supports more. |
| 7 | Eight-step drafts/repairs, sixteen-step finals | **Defer automatic reduction.** Official distilled default is 16; Base is 50. This app's draft iteration level limits candidates and can directly produce the final film. Explicit step overrides remain available. |
| 8 | Official int8 Klein weights | **Defer executable profile.** Transformer + local encoder + VAE save exactly **9,286,689,837 bytes** without an upsampler. Runtime/quality compatibility, authenticated weight hashes, and explicit profile-specific receipts still need verification. |
| 9 | SageAttention for LTX stage 1 | **Defer optional performance experiment.** Exact GPU/kernel compatibility, memory/time measurements and matched quality evidence are required. No installation or runtime flag changes. |

Primary-source links, pinned upstream revisions, source discrepancies, exact weight
sizes, and focused test results are recorded in:

- [LTX geometry, frames and schedules](COMFY_LTX_QUALITY.md)
- [Klein/LTX prompt guidance](COMFY_PROMPT_QUALITY.md)
- [Klein steps, weights and reference integrity](COMFY_KLEIN_RUNTIME.md)

No paid inference, model-weight downloads or live runtime mutations were used for
this research. CPU contract checks establish wiring and geometry, not improved
visual quality. LTX text encoding remains local.

Integration also closes the unsupported-reference path: local Klein tools and
execution accept at most two connected conditioning images, including implicit
cast references. Third/higher sources and conflicting aliases fail before
generation rather than being uploaded and claimed as consumed. Historical LTX
receipt reading recognizes only the three explicitly pinned prior graph hashes
from `804d7c2`, backed by existing trusted completed receipts. New receipt creation
and pending jobs still require current workflow bytes; no package hashes are
silently upgraded.

## Super Easy review and repair

The finished-video flow offers owner-authenticated review of the actual saved MP4.
`POST /api/render-reviews` takes exactly `{packageId, expectedRevision, renderId}`.
It verifies original render inputs, media hashes and trusted generation/render
receipts, then returns a durable report. Inspection does not invoke Pi or edit the
package. A package change during inspection makes the result stale.

Repair remains a separate explicit authorization using the existing
`POST /api/self-repairs` contract and durable attempt polling. Pi can stage a
source-in timing correction, subject to journal/CAS commit and guarded CPU export;
the newly exported bytes are inspected again. The package has a persistent
two-round budget, each run has at most two CPU renders and a 15-minute limit, and
each Pi turn has a 120-second limit. No generation or take-approval authority is
granted by repair. Provider usage may incur its configured model-provider cost.

Review findings are automated evidence, not human visual or lip-sync acceptance.
Local speech analysis is optional and uses explicitly configured offline/local
files. Unavailable analysis remains unknown. Lower-third overlap alone remains
informational, and audiovisual acceptance remains `not_assessed`.

Supported evidence identities are normal `r_<12 hex>` final artifacts and completed
`run_<12 hex>` runs with their original inputs, completion state and trusted receipt.
Missing historical evidence is not replaced. Hosted invite guests cannot access
the owner review/repair endpoints; hosted production spending remains on its
existing guarded outbox path.

## Verification and release

Focused implementation results are recorded in the component research documents.
Final integration checks and merge information will be recorded below before release.

Completed checks before the shared-invite-gallery merge:

- Rebuilt workspace libraries; agent suite **592 passed**; jobs suite **172 passed**.
- Full Python suite **455 passed, 1 skipped**, using the existing local development
  interpreter. Its cast fixture now stages the actual selected two-reference
  graph and verifies both submitted image-node bindings, not just uploads.
- Schema/backend checks **447 passed, 1 skipped**. The schema cross-language
  test now honors the repository's portable Python resolver.
- Other library suites: compositions **15**, MCP **10**, LLM **16**, planner **62**,
  TTS **17**, sources **16**, vector **12**, all passed.
- QA **41 passed** after migrating two already-fixed known-defect checks to
  regressions and updating admission coverage for the current contribution gate.
- Genuine Spoon read-only receipt/root smoke **38 passed** with original input,
  completion state, video and receipt hashes/mtimes unchanged.
- Web's first broad run had **1,691 passed, 2 failed, 1 skipped**. Both failures
  were corrected (plain-language export error copy and a missing test temp-root
  directory); their focused rerun passed. Later lifecycle and gallery integration
  require the final web checks below.

The user subsequently requested integration of `feat/shared-invite-gallery`
through `f396974`: shared generation gallery, automatic hosted DeepSeek/Colab
setup, concurrent hosted generation, and editing/CPU rendering after invite
credits are exhausted. Its merge and affected-surface verification are part of
this same release; earlier test counts above are not presented as validation of
those later changes.

## Generation observability and demo navigation

The subsequent user report exposed a real ten-shot mapping case: all 31 media
jobs completed, but only the two scenes with foreground stills showed previews.
The gallery now resolves scene backgrounds, media and foreground placement, and
labels conditioning previews separately from generated clips. The authenticated
asset inspector exposes available exact prompts, model/workflow metadata, size,
duration and seed, with scoped media loading and cleanup.

Execution status now comes from the saved run or a sanitized, invite-bound result:
stage, job/model, completed count, observed timestamps, terminal failure and
shutdown state. A failed export cannot remain an apparently running generation.
See [the read-only run diagnosis](GENERATION_OBSERVABILITY.md).

Five Chromium flows passed after integration: desktop/mobile ten-shot asset
inspection, verified/missing bounded-repair output, and failed-export reload with
31/31 media jobs complete and verified shutdown. These use scripted backend
responses and do not constitute human audiovisual acceptance.

The user then prioritized demo-ready project continuity: gallery → selected
project → chat/Super Easy/Easy/editor, including reload and browser navigation.
Verification of those later navigation changes is recorded separately; the five
flows above do not establish that coverage.

## Hosted admission and accounting

Pipeline capacity refusals cannot adopt another invite's run. Successful
admission verifies origin and package identity. A proven non-submission releases
only the matching reservation; uncertain submission retains it. The assembled
correction-adapter/spend-guard path is covered, not just the raw adapter.

Parallel work requires server-verified invite ownership; private-owner work
remains exclusive. A reference-counted operation lease survives cancellation of
one parallel run. Account authentication is excluded during active execution,
reconciliation, unconfirmed shutdown and durable unresolved holds.

Account-wide balance changes are not attributable concurrent-run usage. Hosted
settlement requires final session-bound usage evidence and verified shutdown.
The current CLI does not supply that receipt, so allocated hosted runs normally
retain their CU reservations even after successful delivery. The gallery and
dashboard explicitly show **Usage indeterminate; CU reserved**. Historical
reservation-based charges remain labeled estimates; genuine CPU-only editing is
zero-CU. This is an operational limitation, not verified actual reconciliation.

## Additional verification notes

- Renderer full run after fixes: **339 passed, 2 failed, 2 skipped**. Both remaining
  failures were intermittent `QA_FLASH` findings and passed in the focused run;
  their investigation remains separate from a green full-suite claim.
- The preceding server broad run had **2,363 passed, 12 failed, 8 skipped**.
  Follow-up staging/reference fixes and saved-drawing CAS coverage addressed the
  remaining failures; hosted HTTP checks passed **3/3** on the merged branch.
  A fresh full run is required before recording a green integration result.
- Saved-drawing changes passed **42 agent checks** and **4 finished-package chat
  checks**, including preserving concurrent edits on CAS conflict.
- Release scan passed after integration; final navigation changes require another
  scan before release.

Research and fixture verification above used no paid inference. The user later
authorized a separate **10-credit cumulative maximum** for demo end-to-end
testing, including failed attempts. Authorization is not a claim of execution or
spend; any live run must have its own reservation, evidence and verified shutdown.
