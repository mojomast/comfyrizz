# Comfyrizz: Reference Watch (RW): review stills before LTX

Branch `feat/ref-watch` from origin/main `ba16d378` (PR #64). Never main, never tag. Plan written 2026-10-30 (America/Toronto).
Rules: no Google Colab CU in tests (fakes only), no Orbit edits, no secrets in code/logs, "Google Colab" never bare. Box checks: each task's own test file + `tsc`, `PATH=<node22>/bin:$PATH`. Heavy suites go to the PC bees.

## 0. What already exists (reuse it, don't rebuild it)
| Need | Already on main |
|---|---|
| Per-image arrival event | `packages/backends/src/live-previews.mjs` `createLivePreviewCollector`. It downloads manifest-confirmed outputs mid-batch and sha-checks them. `colab-backend.mjs:1291` emits `preview_ready`. |
| Dependency order | `pipeline-py/comfyrizz_pipeline/runner.py` `_order_by_dependencies`. i2v jobs read stills through `fileInputs {from:"job"}`. |
| Identity score | `apps/server/src/characters/identity-qa.mjs` `reviewIdentity` scores embedding cosine against the character's primary image (threshold 0.75). It only proposes verdicts and never writes them. |
| Film review/repair | `self-repair.mjs`, `self-repair-integration.mjs`, `source-review.mjs`, `render-review.mjs`: a receipt-bound, bounded final-film review and repair (PRs #59–#63). It runs AFTER video. RW is the pre-video gate and must reuse its budget and receipt idioms. |
| Cost estimate | `apps/server/src/productions/iteration-estimate.mjs` ("an estimate is never an approval") |
| Story bible / character lock | `packages/agent/src/character-tools.ts` (bible) and `packages/jobs/src/klein-references.mjs` |
| Prompt policy | `packages/agent/src/prompts/model-quality.ts`, docs/research/COMFY_{KLEIN_RUNTIME,LTX_QUALITY,PROMPT_QUALITY}.md |

## 1. Architecture
```
plan(jobs) -> [stills batch] --preview_ready--> RefWatcher -> ReviewQueue -> Reviewer (VLM + embed)
                                                                              |
                         Decision: accept | reprompt+regen | replace-ref | escalate-user
                                                                              |
     regen jobs (same batch if runtime is alive, capped) <-------------------+
     all keyframes accepted/overridden  ==>  LTX gate opens  ==> [video jobs]
```
1. **RefWatcher** (server, pure and injectable) subscribes to `preview_ready` for image outputs (`png|jpe?g|webp`) of jobs that some video job consumes as a keyframe. It dedupes on `job:sha256`.
2. **Reviewer** (decided 2026-10-30): the judge is the **Pi production agent** (deepseek-v4.1-flash over OpenCode Go, with vision). There is no separate VLM backend and no Google Colab judge. It works in two tiers per still:
   - T0, cheap and deterministic: dims/aspect against the plan, blank or flat detection, and identity cosine via `reviewIdentity` when embeddings are available.
   - Pi review: a Pi tool/skill `ref-review`. Pi gets the still as an image input (the `ImagePart` on a user message, as in pi-runtime), the shot prompt and the story-bible lock (identity string and wardrobe state). It answers decomposed, open-ended questions (identity, anatomy, framing, prompt deductions in WeGen categories, text artifacts) and returns one `RefVerdict` JSON. The reply is validated with `validateRefVerdict`; it is repaired once, then fails closed to `overall: error`. Tests use a scripted fake. An optional second Pi sample on hard fails serves as a cheap consistency check.
3. **Decision** (pure function `decide(review, policy, history)`):
   - `accept`: everything passes, or only the soft dimensions fail.
   - `reprompt`: a hard fail with a fixable cause. The steering prompt is rewritten as an end-state caption that keeps what passed and states the fix positively. It never uses negatives, then regenerates the same job with a new seed and the same refs.
   - `replace-ref`: identity fails twice. Switch the reference (primary image, or a ref2 edit from an accepted still).
   - `escalate`: the caps are hit. Show the user the still, the reasons, and an estimate; the user picks override-accept, regen, or edit.
4. **LTX gate**: video jobs whose keyframe isn't `accepted|overridden` are held. There are two run modes. Prefer (A): split the plan into a stills batch and a video batch on the same runtime, so the GPU never idles while waiting on the judge. (B) is a later option: a runner gate file (`gates/<job>.json`) with a timeout. The default timeout is fail-closed: hold the shot and render the others.
5. **Caps**: per still `maxRegens` = 2. Per production `maxRegenJobs` = min(6, 25% of stills) and `maxRegenCU` comes from the iteration policy. Judge calls: at most 1 + regens per still. Every regen shows an estimate first (iteration-estimate), and the regen budget is reserved in the same ledger as self-repair.
6. **Observability**: there are events `ref_review_started|verdict|regen_queued|gate_open|gate_held`. A UI strip on the production view gives each keyframe a badge (pending / ok / regenerating n/2 / held / overridden) and lists the reasons. The strip has a "why" drawer (judge JSON), an override button, and a CU-so-far vs cap meter. Evidence is persisted next to the run receipts.
7. **Keyframe staleness (known failure)**: a chat edit re-animated an old keyframe because the approval plan covered only the video shot. The fix adds a dependency closure. Any edit that changes a shot's still inputs (prompt, refs, character, wardrobe) marks the keyframe stale, and the approval plan must include `regen still -> review -> video` with a combined estimate. A video job whose keyframe sha belongs to a stale revision is refused.

## 2. Workflow improvements (each one is a separate A/B; defaults stay until measured)
| Item | State on main | Action |
|---|---|---|
| LTX stage-1 height 272 | Fixed: graphs use 288 and plan.mjs enforces the 64/32 lattice (480x272 rejected) | Regression test only (RW-W1) |
| LTX stage-2 sigmas `.85,.725,.4219,0` | Still `.85`. It matches the Comfy-Org built-in template; Lightricks' advanced workflow and the native constants use `.909375` | Make it a param (`stage2_sigmas`) and A/B it on one approved run. Don't flip blindly (RW-W2) |
| Klein bf16, 16 steps | bf16 `flux-3-image-klein-bf16` at 16 steps | Add an int8-convrot profile (official files are hashed in COMFY_KLEIN_RUNTIME.md). Drafts use 8 steps (Comfy: 4–16 allowed); finals use 16 (RW-W3/W4) |
| Klein negatives | All Klein graphs wire a `negative` | Klein has no negative lever. Empty it, and move any "avoid X" wording to positive phrasing (RW-W5) |
| Prompt length 40–70 words | Too short for Klein, which expects full scene captions (or its upsampler) | Raise the planner target to about 90–150 words (subject, wardrobe lock, setting, light, lens). Add a lint (RW-W6) |
| Edit prompts | Often say "change X" | Write the finished image with the edit folded in, plus a keep-list. Use `<ref_image_n>` addressing (RW-W7) |
| SageAttention | Recommendation only in the repo doc | Opt-in perf flag. Benchmark it later on an approved run (RW-W8, needs approval) |
| Last frame -> next first frame | Not wired | Optional chaining: extract the accepted clip's last frame, review it as a keyframe, then feed it. Guide strength about 0.7, never 1.0. A true latent extend is a later item (RW-W9) |
| Story bible | Exists in character tools | Feed a verbatim identity string and wardrobe state into every Klein prompt and into the judge questions (RW07) |

## 3. Tasks
Tier: **B** = DeepSeek bee (deepseek-v4.1-flash, fallback beam-free); **C** = Cursor cloud agent (keep these minimal); **K** = needs Kyle (GPU/CU approval).
Every bee task is test-first: write the test, show it red on base, then make it green. It changes only its assigned files and runs only its own test plus tsc.

| ID | Tier | Deps | Files (new unless noted) | Deliverable / acceptance |
|---|---|---|---|---|
| RW00 | **done (box)** | – | `docs/tasks/RW00_CONTRACTS.md`, `packages/schema/src/ref-review.mjs` + test | Freeze the contracts: ReviewRequest, Verdict JSON schema (dimensions, severity, evidence), Decision, events, policy/caps, and the lease table for RW01–RW14. AC: the schema test validates 6 fixtures, good and bad. The only Cursor task that must happen. |
| RW01 | B | RW00 | `apps/server/src/ref-watch/watcher.mjs` + test | Subscribes to `preview_ready`, filters keyframe-consumed images, dedupes, and enqueues. AC: a fake event stream with 5 images (1 duplicate, 1 non-keyframe, 1 video) yields 3 enqueues. |
| RW02 | B | RW00 | `ref-watch/t0-checks.mjs` + test | Dims/aspect, blank/flat detection, and a `reviewIdentity` adapter. AC: fixtures cover a pass, a wrong aspect, a flat grey image, and low cosine (vectors injected). |
| RW03 | B | RW00 | `packages/agent/src/ref-review.ts`, `skills/ref-review/SKILL.md` + test | Pi review tool/skill: builds the message (image part, prompt, bible lock, open-ended questions), calls an injected Pi model, and parses/validates the verdict with the RW00 contracts (repairs once, then `overall:error`). AC: with a fake model, the image is attached, the questions include the identity lock, malformed replies give `error` (never pass), and no key appears in logs. |
| RW04 | – | – | *(merged into RW03: there is no separate judge backend)* | – |
| RW05 | B | RW00 | `ref-watch/decide.mjs` + test | Pure decision table with caps. AC: a table test with 12 rows (accept / reprompt / replace-ref / escalate, cap exhaustion, judge error leading to escalate). |
| RW06 | B | RW05 | `ref-watch/steer.mjs` + test | Steering rewrite: end-state caption, keep-list, no negative words ("no", "without", "avoid" are linted out), length 90–150 words. AC: 5 fixtures, plus a lint test. |
| RW07 | B | RW00 | `ref-watch/bible-lock.mjs` + test | Pulls the verbatim identity string and wardrobe state for a shot from character tools. AC: two characters plus a wardrobe change mid-film give the correct per-shot lock. |
| RW08 | **C** | RW01–06 | `ref-watch/controller.mjs` + test; wiring in `colab-backend.mjs`/`pipeline-colab-render.mjs` (coordinator-owned) | Orchestrates queue, review, decision, regen jobs and the gate. Uses split stills/video batches (mode A), shares the budget ledger with self-repair, and reserves budget before each regen. AC: an end-to-end fake (fake colab + fake Comfy + scripted judge): 4 stills where 1 fails and then passes after regen, and 1 fails twice and escalates. Video jobs are submitted only for accepted keyframes, and the CU ledger never exceeds the cap. Cross-module and touches hot files, hence Cursor. |
| RW09 | B | RW08 | `ref-watch/events.mjs` + `routes/ref-review.mjs` + test | SSE/events and a GET review evidence route. Override POST is receipt-bound. AC: route tests for list, evidence and override (stale sha rejected). |
| RW10 | B | RW09 | `apps/web/src/productions/ref-strip.ts` (+css) + test | Badge strip, why-drawer, override, CU meter. AC: DOM unit test for all 5 states plus a11y labels. No `main.ts` edit (the coordinator wires it). |
| RW11 | B | RW00 | `apps/server/src/productions/keyframe-staleness.mjs` + test | Dependency closure for chat edits: still-input change marks the keyframe stale, the approval plan includes regen still, review and video with a combined estimate, and video is refused on a stale sha. AC: reproduces the old-keyframe incident red on base, green after. |
| RW12 | B | RW05 | `ref-watch/estimate.mjs` + test | Per-step estimate shown before each regen, via iteration-estimate. AC: the estimate is labelled "estimate", is never treated as approval, and a cap breach yields escalate. |
| RW13 | B | RW08 | `docs/ref-watch.md` | User and dev doc, judge calibration how-to (run the judge on known-good and known-bad stills, blacklist biased question/model pairs). |
| RW14 | B | RW03 | `scripts/ref-watch/calibrate.mjs` + test | Offline calibration over a labelled folder of past stills (no GPU). It reports per-question accuracy and writes the reliability matrix. |
| RW-W1 | B | – | `packages/jobs/test/ltx-lattice.test.mjs` | Lock the 288/32-lattice and 8n+1 rules (regression). |
| RW-W2 | B | – | ltx25_*_2stage params.json + `defaults.mjs` + test | `stage2_sigmas` param, default unchanged (`.85`), `.909375` profile selectable. AC: workflow hash table updated in model-contribution.mjs; param test. |
| RW-W3 | B | – | klein params + `defaults.mjs` + test | `draft` profile with 8 steps; final stays at 16. AC: plan test shows previews/drafts at 8 and finals at 16. |
| RW-W4 | B→K | – | klein int8 profile JSON + lock entry + test | int8-convrot loader profile behind a flag. AC: static graph test. A live A/B needs Kyle's CU approval. |
| RW-W5 | B | – | 4 klein `.api.json` + test | Negative conditioning is empty/zeroed. AC: graph test shows no non-empty Klein negative text, and hashes are updated. |
| RW-W6/W7 | B | – | `prompts/model-quality.ts` + test | Klein caption length target, end-state edit form, `<ref_image_n>`. AC: prompt lint tests. |
| RW-W8/W9 | K | RW08 | – | SageAttention benchmark and last-frame chaining A/B on one approved Google Colab run. |

**RW00 was done on the box (no Cursor). The only remaining Cursor candidate is RW08, and Kyle decides it.** Everything else goes to bees. An agy/Opus reviewer is used only after two failed bee reviews.

## 4. Waves
W0: RW00 (done), plus RW-W1/W2/W3/W5 in parallel (B, independent). W1: RW01–RW07, RW11, RW12 (B). W2: RW08 (C). W3: RW09, RW10, RW13, RW14 (B). W4: one approved live run (K): calibrate the judge, A/B sigmas and int8.

## 5. Acceptance (feature)
- With fakes, no video job is submitted before its keyframe verdict is accepted or overridden. The gate is fail-closed.
- No more than `maxRegens` per still, and the production regen CU never exceeds the cap. Every regen is preceded by a visible estimate.
- Each verdict persists its judge JSON and the image sha. The UI shows its state, and an override is receipt-bound.
- The old-keyframe incident is reproduced as a test and fixed (RW11).
- Workflow changes are param-gated, with default behaviour unchanged until the A/B on an approved run.

## 6. Open questions for Kyle
1. ~~Judge backend~~ DECIDED: Pi on deepseek-v4.1-flash (vision).
2. ~~Key~~ DECIDED: a new working key is in `the Hermes env file` (`OPENCODE_GO_API_KEY`). The PC bees have their own key.
3. ~~Caps~~ DECIDED: 2 per still, min(6, 25%) per production.
4. OPEN: RW08 to Cursor or not (Kyle).
5. OPEN: the PC bee project syncs `feat/character-creator`, which is not an ancestor of `feat/ref-watch`. See the dispatch blocker in the report.

## Sources
- Comfy docs, FLUX 3 Image Klein (16-step distilled, 4–16 range, cfg 1, "write the result, not the change", `<ref_image_n>`): https://docs.comfy.org/tutorials/flux/flux-3-klein
- Diffusers FLUX 3 Klein (full captions, prompt upsampler): https://huggingface.co/docs/diffusers/api/pipelines/flux3
- SGLang FLUX.3 cookbook (edit = full caption with the edit folded in): https://docs.sglang.io/cookbook/diffusion/FLUX/FLUX.3
- No negatives, positive phrasing: https://batchbanana.com/docs/models/flux , https://deapi.ai/blog/prompting-flux-2-klein-what-works-what-doesnt-and-why
- LTX two-stage sigma variants (repo research with pinned refs): docs/research/COMFY_LTX_QUALITY.md. Lightricks workflow: https://github.com/Lightricks/ComfyUI-LTXVideo ; LTX-2 skill notes: https://unpkg.com/comfyui-mcp@0.52.99/plugin/skills/ltxv2-video/SKILL.md
- Chaining/extension, guide strength 0.7: https://github.com/jlucasmcrell/ltx23-multishot-lite ; keyframe continuity tips: https://github.com/farazshaikh/LTX-2.3-Workflows ; 8k+1 grid: https://comfy.icu/node/Difforum_Keyframes
- VLM gates (identity, anatomy, framing; consensus; bias calibration): https://safaia.net/Booyaka101/comfyui-vlm-gates
- VLM-judge failure modes: https://cspaper.org/open-problems/systematically-benchmarking-and-calibrating-vlm-as-a-judge-failure-modes-in-imag-4bba7d2747f9
- Qwen3-VL: https://github.com/qwenlm/qwen3-vl ; WeGen consistency judge (Qwen3-VL-8B FT, deduction taxonomy): https://huggingface.co/yinggzhang/WeGenBench-Consistency-COT ; Q-Judger: https://huggingface.co/Qwen/Qwen-Image-Bench
- Generate, verify, refine loops: PRIS CVPR 2026 https://openaccess.thecvf.com/content/CVPR2026/papers/Kim_Rethinking_Prompt_Design_for_Inference-time_Scaling_in_Text-to-Visual_Generation_CVPR_2026_paper.pdf ; VisionDirector https://arxiv.org/html/2512.19243v3 ; Iterative refinement https://arxiv.org/html/2601.15286
- Story bible / character lock: https://www.agentvolt.ai/marketplace/ai-film-story-bible , https://videoany.io/blog/posts/story-world-bible-for-ai-film ; Kinoloom: https://shadowgraph.io/harlixay7/Kinoloom
- SageAttention (perf only, LTX-2.5 unverified): https://github.com/thu-ml/SageAttention
