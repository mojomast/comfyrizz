# Hackathon submission status

**Current 2026-10-29 deadline triage:** see [Super Easy 24-hour reliability plan](SUPER_EASY_24H_PLAN.md) for the current keep/cut candidates, reduced prompts, live-test criteria and remaining blockers. The dated verification and four-route campaign below are historical; they do not establish current end-to-end mode readiness. The newer eight-film campaign has its own 60-credit ledger and must not be combined with the older 40-credit campaign described below.

Updated 2026-10-27 on `feat/hackathon-submission` / draft PR #53.

## 2026-10-29 update

- **Default managed Colab inference:** the README, setup guide and
  [Colab feature guide](../features/google-colab.md) now explain deployment of
  ComfyUI, dependencies and pinned models, job execution, collection and confirmed
  shutdown for users without a local GPU. They cite current Google AI Pro/Colab
  allowances and distinguish runtime units from agent API charges.
- **Pi production migration:** Pi 1.4 owns the model/tool loop for planning, chat,
  revisions and repairs; Node 22.19.0+ is required. Configured DeepSeek Flash routes
  now receive a 65,536-token output allowance.
- **Final-video contribution gate:** visible eligible ComfyUI output and trusted
  generation/render receipts are required, including cached exports and final
  pipeline downloads. CPU-only films are historical development evidence.
- **Duration:** custom whole-second targets from 1–120 seconds are supported,
  retaining the existing presets and exact-duration validation.
- **Delivered generated film:** Neon After Rain completed actual UI planning,
  native transition correction, explicit re-review/approval, Colab generation,
  render and Download. It is exactly 12 seconds at 1920×1080/30 fps, silent, with
  three LTX motion shots, native animated headlines and wipe/push transitions.
  Six generation receipts and the byte-bound render receipt match the downloaded
  movie. Actual account delta was 1.14 credits; runtime shutdown was confirmed.
  Full 1× player execution and sampled visual inspection are recorded, not
  continuous human viewing. Local evidence is linked from the reliability plan;
  a private Tailscale link is not a judge-accessible public artifact.
- **Remaining acceptance gaps:** the Neon caption-only chat edit saved correctly,
  but revised export is blocked by a production-selection request missing its
  command/idempotency key. Citrus and both 45-second show videos remain planning
  failures; H3 exact-line audio conditioning and exact timeline repair need work.
  Broad server-suite sign-off, public-demo validation and submission packaging
  remain outstanding. Latest full agent/web checks passed 578/1,642 tests.

Current details and artifact placeholders: [Deadline handoff](DEADLINE_HANDOFF.md).
The sections below retain the earlier implementation/verification snapshot.

## Implemented

- One prompt to a concise creative proposal with title, logline, look, duration
  and soundtrack. Free revisions preserve the original prompt/notes; no production
  exists before **Make this film**.
- Motion selector before planning: **Auto**, **H3**, **LTX** and **Klein only**.
  Auto includes Klein identity/keyframe art, LTX camera/scenery shots and H3
  character/native audio. Klein-only is explicitly stills plus code motion.
- One server-priced final action using the same dry-run estimate as execution,
  including setup overhead, then one final run and authenticated MP4 playback.
- Persistent, credential-free backend/cap preference after one-time setup;
  per-production server authorization and ceilings remain enforced.
- Live character/shot/audio gallery fed by real clip/take routes, with safe media
  tickets, stable cards and no invented ready states.
- Guided agent provider, Google Colab CLI/OAuth and Hugging Face model-access
  setup for Klein, LTX and H3, with OS-specific instructions and server-held secrets.
- Result-page agent composer, same-package chat adoption, Advanced timeline/take
  editing and visible example revision requests.
- CPU clip-list/final-gate consistency and cross-platform browser resolution.
- PR #52 procedure capture integrated, including the proposal checkpoint and
  corrected complete-journal fixtures.

The model-route UI/setup is complete. Generated-film planner tools and semantic
validation are being finished before real route examples; do not infer their
output quality from the selector alone.

## Verified locally

- Web unit suite: **1,453/1,453 passed** before the latest planner/model-route
  additions; rerun on the final submission commit is still required.
- Proposal and mounted-flow suites: **69 focused tests passed**.
- Auto/H3/LTX/Klein setup, persistence and planner-handoff suites: **109 focused
  tests passed**; the Klein-only selector also passes.
- Focused server setup/adoption/take suite: **41/41 passed**.
- Bound final-run lifecycle: **7/7 passed**, including one run, one render and one
  ledger settlement in final mode.
- Full nine-stage pipeline suite: **17/17 passed**, including required native
  audio for a wordless film.
- Targeted Super Easy and procedure-capture browser tests: **9/9 passed**, including
  the proposal and one-time credit-cap setup.
- Real Easy Studio no-GPU flow: brief → Review → Export → downloaded MP4 passed,
  with no paid calls.
- Headless fixture recording: valid 1280×720 H.264, all 16 expected steps and no
  failure entry; no paid calls.
- Web TypeScript check, production build and release scan passed. The release
  scan used project-local scratch because the host `/tmp` is full.

These checks do not start a paid runtime.

## Four real examples and managed demo

Authorized total: **40 credits** across four examples, including setup, failures
and retries, with at most 10 credits per example. They will run sequentially with
separate proposals, recordings, result logs and MP4s:

1. Klein only;
2. H3 only;
3. LTX only;
4. Auto (Klein + H3 + LTX).

No example is marked complete until its actual output and account spend have been
reviewed. Proposal approval happens before each paid run.

The hackathon submission will also provide a **managed judge deployment with
inference baked in**. Judges will not install anything or enter keys. Agent/model
access and server-side rate/credit limits will be preconfigured and cannot be
raised through browser storage. Deployment is pending real generation and safety
verification. Self-host instructions are a separate path in `docs/ONE_PROMPT.md`.

## Still required

1. **Planner/output validation and real route runs.** Finish generated-film
   intent, motion/native-audio tools, reachable-asset checks and mixed-model
   execution, then review actual visual and audible quality. The previous Last
   Light movie was assembled outside this app and is not proof of this flow.
2. **Native Windows smoke.** Code and unit tests cover Windows commands and paths,
   but no physical Windows run has been performed. BYO proxy setup and descendant
   process-tree cleanup remain separately scoped.
3. **Managed-demo safety and availability.** Verify server-side caps, settings
   restrictions, no-secret responses and reliable operation for several judge runs.
4. **Full monorepo check on the final commit.** Focused passing counts are not a
   substitute for a complete check.
5. **Submission assets.** Curate the four-example gallery and licence audit,
   record the two-minute-maximum demo, publish the social post with
   `#OpenSourceHiggsfield`, and complete the form before 2026-10-30 09:00 PT.

## Submission position

Lead with **one prompt → an impressive film → change anything with the agent**.
The proposal and model choice make the first result intentional; live assets make
generation visible; Advanced mode preserves control. Do not claim completion on
the basis of fixtures, a successful video encode, or the earlier external film.
