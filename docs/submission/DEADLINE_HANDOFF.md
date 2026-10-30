# Deadline submission handoff

Prepared **2026-10-29**, with the latest delivery update below. This is a submission handoff, not submission approval. Recording instructions: [DEMO_TAKE_PLAN.md](DEMO_TAKE_PLAN.md).

## Latest delivery update — supersedes the earlier pending-film snapshot

**Neon After Rain completed actual Colab generation, render and UI Download.**
It is 12.000 seconds, 1920×1080, 360 frames at 30 fps, silent, with three LTX motion
shots and native animated headlines/transitions. Six generation receipts and its
byte-bound render receipt were verified. Movie SHA-256:
`34f989fa8067638b4e0e2a506950f06f571d4fbe806ebd069258058d81366cd5`.
Evidence: `/tmp/opencode/easy-colab-acceptance/motion-type-effects-fixed/PARENT-HANDOFF.md`.
The actual UI transition correction, saved-revision re-review and approval are
recorded. Full 1× playback executed; visual assessment used sampled captures and
decoded frames rather than continuous human viewing. Brief title overlap during
the first wipe is recorded. Actual spend was 1.14 credits, and shutdown was verified.

The optional caption edit saved, but its revised export remains blocked by the
production-selection API's missing command/idempotency key. The original movie
is the delivered artifact. Citrus and both 45-second character/credits films
remain blocked during planning. The documentary is also unfinished. Latest full
agent/web results are **578/1,642 passing tests**; broad server sign-off remains
unconfirmed. Last settled campaign: **2.83 spent / 0 reserved / 57.17 remaining**
of 60 credits, with zero active sessions/assignments/usage. Private Tailscale
sharing is available, but public artifact/demo publication and full human
acceptance remain pending. The dated tables below preserve the earlier handoff
snapshot; use this update and [the reliability log](SUPER_EASY_24H_PLAN.md) for
current outcomes.

## Deadline and submission owner

- **Kyle:** final media upload, public-link checks, social post and form submission.
- Deadline: **2026-10-30 09:00 PT / 16:00 UTC**. The [official event page](https://comfy.org/open-source-higgsfield/) was fetched once for this handoff on October 29 and confirms October 30, 9am PT and the [submission form](https://form.typeform.com/to/V1dSQrkS).
- Carry forward the form requirements recorded in [CHECKLIST.md](CHECKLIST.md): public code/workflows, open-source licence and setup instructions; lawful/SFW assets; demo **at most two minutes** explaining the build and innovation; social post with `#OpenSourceHiggsfield`; form fields and four agreements; one submission per person. The current fetch did not expose all collapsed requirement text or form fields; verify the actual form before sending. Live app/endpoint is recorded as optional.
- The **120-second documentary candidate** and the **≤120-second submission demo** are distinct artifacts. Neither duration nor completion is established for the pending candidate.

## The three blocking actions

1. **Finish release evidence.** Obtain the server reconciliation outcome, classify remaining failures, and identify the exact source revision/manifest used for the accepted run and public handoff. Current checkpoint is `75133c2` (`feat: migrate production agents to Pi and require ComfyUI media`); subsequent working-tree changes exist. It is neither an all-uncommitted tree nor a committed final release. Public availability of that checkpoint/new work is unverified.
2. **Accept at least one real generated film.** Choose the reviewed candidate and applicable spend authorization; collect actual ComfyUI output, trusted generation/render receipts, UI Export and **Download**, and normal-speed visual/audible review. The pending documentary is a candidate only. Every final film included must independently meet the contribution requirement below. If no candidate meets it, there is no compliant final-film submission to claim.
3. **Package and submit the accepted evidence.** Fill the artifact slots, record/upload the truthful ≤2-minute demo, verify public repo/media access, publish the required social post and submit the form before the deadline. Publication requires the user's authorization; this handoff performs none.

## Hard contribution rule and model mapping

**Every final video must actually use output generated through ComfyUI by an officially verified hackathon model, with trusted receipts.** This is the user's product requirement; do not describe it as a universal event mandate. Existing CPU-only movies, pending/orphan assets, model-authored provenance and conditioning-only images do not satisfy it.

Mappings below are documented and source-backed in [PI_PIPELINE_MIGRATION.md](../PI_PIPELINE_MIGRATION.md). They establish accepted model families, not a completed job or bonus award.

| Family | Committed workflow examples | Pinned weight / registry |
| --- | --- | --- |
| FLUX 3 Image Klein | `workflows/flux3_klein_t2i.api.json`, `flux3_klein_img2img.api.json`, `flux3_klein_ref_edit.api.json`, `flux3_klein_ref2_edit.api.json` | `flux-3-image-klein-bf16.safetensors`; `colab/models.lock.json` |
| LTX-2.5 | `workflows/ltx25_t2v_2stage.api.json`, `ltx25_i2v_2stage.api.json`, `ltx25_a2v_2stage.api.json` | `ltx-2.5-22b-distilled-transformer-comfy-int8-convrot.safetensors`; `colab/models.lock.json` |
| MiniMax H3 | `workflows/fasth3_omni_ref2v_noclip.api.json`, `fasth3_omni_ref2va.api.json` | `fasth3_omniref_8step_pruned_int8_convrot.safetensors`; `colab/fasth3-models.lock.json` |

Exact graph hashes, loader identities and connections must match allowed workflows. The H3 mapping is the pinned **FastH3 Omni** model card, not older V2/Ref2VA assumptions. Klein's FLUX.3 family mapping is now documented; older central-doc uncertainty should not be repeated as an unresolved family identity question.

Receipt acceptance requires server-owned evidence from `colab` or `byo-comfyui`: submitted graph, jobs hash, completed job/attempt, output SHA-256 and measured dimensions. A supported visible placement must cover at least 5% of the frame for at least one second after conservative transition allowance. Final `.comfy-provenance/renders/<video-sha256>.json` binds movie bytes, package/timeline hashes and contribution. Editable sidecars cannot certify the movie. Geometry checks do not prove semantic relevance or nonblank imagery; inspect the final picture.

**Bonus is a separate decision:** the official event requires LTX to be the *core video model*, FLUX 3 the *core model*, or MiniMax H3 the *core model* in the claimed workflow. One qualifying asset does not automatically establish this. Select only a supported bonus after reviewing the final workflow. Best Overall is automatic; explain a specific innovation without “first ever” claims. Do not claim Open Weights Only for a closed-provider agent path or assume all dependencies qualify.

## Fill-in artifact inventory — no placeholder is a result

All `/tmp/opencode/...` paths below are **local evidence, not public judge URLs**. Retain originals and publish only reviewed, credential-free copies through an authorized owner.

| Required handoff field | Value to fill from the accepted run |
| --- | --- |
| Candidate/title/brief | `[PENDING: exact title, brief file + SHA-256; documentary outcome]` |
| Source identity | `[PENDING: accepted revision + dirty-source manifest/hash; public revision URL]` |
| Package and timeline | `[PENDING: package ID/revision, package SHA-256, timeline SHA-256]` |
| Final film | `[PENDING: local MP4 path, SHA-256, actual frame count/fps/duration/resolution/audio]` |
| UI delivery evidence | `[PENDING: raw recording/log, Export completion, actual Download event/path, downloaded-byte SHA match]` |
| Public film URL | `[PENDING: externally accessible URL; signed-out playback/download checked by + time]` |
| Thumbnail | `[PENDING: frame timestamp from accepted MP4, PNG/JPEG path + SHA-256, public URL if needed]` |
| Generated contribution | `[PENDING: exact model/workflow, scene ID/slot, visible interval, generated output path + SHA-256]` |
| Trusted generation receipt | `[PENDING: server-owned receipt path, jobs/graph hashes, run/job/attempt IDs, measured dimensions, receipt SHA-256]` |
| Trusted render receipt | `[PENDING: .comfy-provenance/renders/<MP4-SHA>.json path + SHA-256, matching package/timeline]` |
| Quote and approval | `[PENDING: final-run quote ID/revision/hash, displayed ceiling, approval record/time; not an earlier shot-plan quote]` |
| Actual spending | `[PENDING: settlement/account evidence incl. setup, failures/retries, teardown; provider fees separately measured or unknown]` |
| Human acceptance | `[PENDING: reviewer/time; full normal-speed watch, heard audio or intentional silence, copy/source/credits, limitations]` |
| Submission demo | `[PENDING: local edited MP4 + SHA-256, measured duration ≤120s, thumbnail, public playback URL]` |
| Repository/setup/workflows | `[PENDING: public revision containing accepted implementation; signed-out access verified]` |
| Social/form | `[PENDING: #OpenSourceHiggsfield post URL, submitted form confirmation/time]` |
| Optional managed app | `[PENDING or OMIT: verified public endpoint; actual availability/caps; do not promise preconfigured access before validation]` |

The last reported campaign ledger is **60 authorized / 0.42 spent / 0 reserved / 59.58 remaining**, not a fresh account balance or this film's cost. Older 40-credit comparison plans are separate. The previous ≤10-credit anchor authorization was shot-specific; do not reuse it as blanket approval or invent documentary spend.

## Claim and evidence inventory

Evidence snapshot, not a final monorepo sign-off:

| Claim | What is supported / current limit | Local evidence |
| --- | --- | --- |
| Pi is the default production runtime across agent decision paths | Implemented; existing provider transport, validation and spending controls retained. End-to-end film acceptance pending | `/tmp/opencode/pi-pipeline-migration/REPORT.md`; [runtime inventory](../PI_PIPELINE_MIGRATION.md) |
| Agent checks | **530 pass** | Migration `agent-final.log` |
| Web reconciliation | **1,607 pass, 0 skipped**; typecheck/build pass | `/tmp/opencode/pi-pipeline-reconcile/web/REPORT.md`, `full-suite.log` |
| Jobs/backends reconciliation | Jobs **135 pass**; backends **174 pass, 2 existing skips** | `/tmp/opencode/pi-pipeline-reconcile/backends/REPORT.md`, `jobs-full.log`, `backends-final.log` |
| Full server readiness | **PENDING**. Prior broad run timed out at 120s with 121 `not ok` records and no complete summary; do not call this 121 final failures or all tests green | Migration `pi-server-full.log`, `pi-server-workflows.log`; `[PENDING: reconciliation report]` |
| Real planning through UI | Ocean Notes reached correct 300-frame/30fps review with one pending Klein background; no approval; export correctly blocked | Migration `live-plan-4/`; not a delivered movie |
| Actual ComfyUI final movie | **NOT VALIDATED** | `[PENDING: generated-media acceptance report]` |
| Bounded measured feedback | Direct Title experiment: **26.67% → 60.73% lossless-render width**, two calls, 14,149 reported tokens; only size/revision changed | `/tmp/opencode/pi-title-runner/live-visual-v2/REPORT.md`; [experiment guide](../experiments/PI_TITLE_RUNNER.md) |

### Retain meaningful failures

- Web's original three failures were reproduced, then reconciled; jobs/backends retained stale-reachability/golden failures, a real BYO collected-directory/receipt bug and a watchdog fixture race. Passing reports explain the changes rather than deleting failed evidence. Existing backend skips are Windows APPDATA discovery on Linux and the explicitly configured Python whole-run fixture.
- Migration planning trials include wrong duration/inset (`live-plan-2`) and rejected invalid background references (`live-plan-3`). A correct review screen in `live-plan-4` does not erase these or demonstrate export.
- Title's first live request failed on missing adapter tool declarations: `/tmp/opencode/pi-title-runner/live-deepseek/`. Visual-v2 then succeeded at bounded width correction, but **full brief failed**: blue rule missing, words entered together; both features are deferred. Final MP4/lossless-preview mean delta **2.023132 > 2.0** also failed unchanged. The width claim applies to lossless frames, not certified MP4 glyph bounds. This is a CPU-only direct experiment, neither UI Download nor a compliant final film nor controlled Pi superiority evidence.
- Earlier CPU Title/Sketch/Music/Custom/Data probes remain diagnostic failures/partial results documented in [SUPER_EASY_24H_PLAN.md](SUPER_EASY_24H_PLAN.md). Never relabel them as generated final deliverables. No broad universal quality, reliability or cost-saving claim follows from these samples.

### Known hashes (reference evidence only)

Title visual-v2 root: `/tmp/opencode/pi-title-runner/live-visual-v2/`.

| Object | SHA-256 |
| --- | --- |
| Experimental `export.mp4` — **not final submission film** | `36d8abf48e99da25b3b410ac47ba151d57f3c8e1b235e52ac2a4b3910e5dbe56` |
| Experimental source/build manifest | `41133191d6575ec83d22ff31cbc70b9dc62ad087916ccc28142b875c01a596e0` |
| Unchanged Title brief | `63871d3d2c17e40615acb66742327763c5d8dadd3b74c275ccb805456809ecae` |
| Authorized Anton font | `a4ba3a92350ebb031da0cb47630ac49eb265082ca1bc0450442f4a83ab947cab` |

Official-source retrieval URLs/timestamps/hashes: `/tmp/opencode/pi-pipeline-migration/sources/index.json`. Saved event source hash: `a6438f94b399302a3fa89457cf2043c44a821dc074e1013653c52c9f3a304229`. These identify source snapshots, not generated-media receipts.

## Local repository/link sanity and scope cuts

- Git remote is `https://github.com/mojomast/comfyrizz`; remote public accessibility and submitted revision were not tested here.
- Local targets exist: [README](../../README.md), [MIT LICENSE](../../LICENSE), [NOTICE](../../NOTICE), [CREDITS](../../CREDITS.md), [third-party licences](../../THIRD_PARTY_LICENSES.md), [setup](../ONE_PROMPT.md), [workflows directory](../../workflows/), [model lock](../../colab/models.lock.json), [H3 lock](../../colab/fasth3-models.lock.json). There is **no `workflows/README.md`**; link the actual directory/graphs and migration mapping.
- Say **application code is MIT**, not that all dependencies/models are MIT or open source. NOTICE identifies Remotion's source-available licence and separately licensed weights.
- README and setup docs now require **Node ≥22.19.0** and explain default managed
  Colab inference for users without local GPUs, Pi production orchestration,
  exact custom durations and final contribution checks. The
  [Colab guide](../features/google-colab.md) cites Google's current AI Pro allowance
  (200 CCUs as checked 2026-10-29) separately from Colab Pro's 100 units/month.
  Native-Windows smoke and managed-demo readiness remain unverified.
- **Cut first:** four-route comparison/contact sheet, additional mode showcases, original Pérez data stress test, original multi-shot olive action, singing/multiple music deliveries, cat-animation promise, unvalidated product walkthrough, cutdown, blue rule/word reveal, live editing and optional Pi experiment segment. Keep one reviewed model-backed film and its real UI delivery.
- A managed deployment is optional; omit its URL/promise if unavailable. Native-Windows validation is not required for a Linux-only demonstrated claim. Extra fresh-session passes/recovery evidence are needed only if claiming reliability; one accepted run supports “this run,” not “reliable across modes.”

## Ready-to-fill submission copy

**Current factual description:** “ComfyRizz is an MIT-licensed application combining a Pi-backed creative agent, pinned ComfyUI workflows and deterministic Remotion finishing. The user reviews a proposal and generation quote; server-owned evidence binds generated media to its use in a final export. Real final-film acceptance is still pending.”

**Replace the last sentence only after acceptance:** “In the recorded run, `[EXACT MODEL]` generated `[VISIBLE CONTRIBUTION]` through ComfyUI. The app exported `[ACTUAL TITLE / DURATION]`, and we downloaded and reviewed the resulting MP4. `[VERIFIED LIMITATION, if relevant]`.”

**Innovation:** “Creative planning, generated media and exact editorial finishing have distinct roles. The app prices reachable work and ties a finished export to verified generated output.” Show the actual quote, visible asset and receipt before extending this to the submitted film.

**Accessibility:** “The default managed path deploys the ComfyUI inference stack
on Google Colab for you. You can direct a film from a computer without a GPU;
ComfyRizz handles cloud setup, job execution, collection and confirmed shutdown
within the approved production budget.” Distinguish this implemented lifecycle
from the still-pending acceptance of the current final film.

**Final status line:** “Validated on `[SOURCE ID]`: `[SERVER RESULT]`; final media review `[RESULT]`; public demo `[URL]`; source/workflows `[PUBLIC REVISION URL]`.” Unfilled fields block this final-status claim.
