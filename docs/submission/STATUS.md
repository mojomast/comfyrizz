# Hackathon submission status

**Current 2026-10-29 deadline triage:** see [Super Easy 24-hour reliability plan](SUPER_EASY_24H_PLAN.md) for the current keep/cut candidates, reduced prompts, live-test criteria and remaining blockers. The dated verification and four-route campaign below are historical; they do not establish current end-to-end mode readiness. The newer eight-film campaign has its own 60-credit ledger and must not be combined with the older 40-credit campaign described below.

Updated 2026-10-27 on `feat/hackathon-submission` / draft PR #53.

## 2026-10-30 character-reference delivery

- **Delivered via Super Easy:** user-supplied character photo → Klein reference
  edit → LTX motion → render → Download. *Tea at the Helm* is six seconds,
  1080p/30 fps, silent, with a spaceship teacup sip and camera glance.
  [Private Tailscale video](http://100.72.41.9:8766/character-reference-space-tea.mp4).
- Exact original-image consumption, both generated outputs and the final
  downloaded MP4 are backed by verified generation/render receipts. Actual spend
  was **0.97 credits**; Colab shutdown confirmed. Campaign: **6.12 spent,
  0 reserved, 53.88 remaining**. Sampled frames retain the reference's distinctive
  beard, glasses, hat and shirt, with facial-detail changes and tighter framing.
- **Remaining UI defect:** cold root-page reload loses the completed final-run
  Download state, despite restoring generated gallery entries. Initial Download
  passed; reopened Download did not. This differs from the verified durable
  editor-export/reopen journey recorded for revised Neon.
- Character-reference wiring is pushed in **8f4c635**. **4452117** integrates the
  later mixed-media, dialogue-intent and exact-timing fixes: 60 server, 57 agent
  audio/intent and 33 UI tests passed, plus agent build and web typecheck.
  Those later fixes were not injected into the running reference-film build.
- The speaking teaser and Spoon showcase remain undelivered after pre-spend
  planning failures; later passing offline checks do not establish live delivery.

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
- **Presentation fixes:** exact-duration repair, measured H3 dialogue conditioning,
  production-bound Keep requests and historical take-freshness recovery are
  implemented. Neon now passes actual browser Keep → Export → Download → reload
  with its revised caption, a trusted final receipt and durable artifact.
  Reopened Download returns identical bytes without another render. The accepted
  revised film is 12.000 seconds, 1080p/30 fps, silent; all six generated-media
  hashes and saved r14 remain unchanged. The private Tailscale share is verified.
- **45-second show films:** credits now plan exactly 45 seconds and all 12 image/
  video outputs were generated and collected with matching hashes. Three missing
  workflow sidecars initially blocked import/export. Explicit CPU-only recovery
  from verified embedded MP4 workflow metadata now completed actual render,
  Download and fresh-browser reopen. THE LAST SIGNAL has all six motion shots and
  credits, an instrumental soundtrack, 12 generation receipts and a final render
  receipt. Video is exactly 45.000 seconds; AAC/container is 45.100 seconds.
  Recovery used zero additional GPU credits. Human listening quality remains
  unassessed, and brief credit overlap at circular transition midpoints is noted.
  Bundled collection is implemented for subsequent multi-shot runs. The latest
  speaking plan prepared real conditioning and seven H3 shots but was stopped
  before spending because native audio remained muted, detached narration was
  enabled and saved-project correction failed. Those paths are being fixed;
  45 seconds at 24 fps is valid and is not itself a brief failure. The speaking
  film is not yet generated.
- **Verification:** full agent/web/server checks passed **578 / 1,645 / 2,132**
  tests, with one web and four server skips. Bundled collection separately passed
  **230 backend tests**, one Windows-only skip. Later recovery/export UI changes
  need their own checks. Public-demo validation, full audiovisual acceptance and
  submission packaging remain outstanding; details and source boundaries are in
  the reliability log.

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
# 2026-10-30 — reload repair and Spoon pre-approval review

- **Live Spoon run in progress, frozen at `35a2572`:** `pkg_42de342a7f5929c4` r23 survived actual normal-UI cold proposal reload. Editor chat `project_edit_package` → `project_build` saved r24, removing the duplicate early CASE CLOSED headline while preserving the delayed lower third, all media/conditioning, and exact 900/30 timing. Return-to-proposal reviewed r24. Normal Make this film produced final quote 2.734; fresh CLI showed 206.99 credits and no sessions, then the campaign atomically reserved 9 credits before approval. Production `prod_e63b9c1a3aea37cb3ca8839f`; ten planned jobs (six Klein images, two H3, two LTX), one candidate per motion shot. Evidence: `/home/mojo/comfyrizz-gallery-tests/spoon-files-ready/evidence/`. This is not a delivery or audiovisual acceptance yet.
- Live review also found that cold proposal restoration needed a compiled timeline (`35a2572` fixes it), and the Review & edit full plan route had stale package-existence facts. Latest source refreshes those facts, binds checkpoints to motion model/conversation as well as revision/inputs, and rejects an early duplicate of an otherwise delayed punchline. Those follow-ups are outside the frozen Spoon run.

- The `bb88da2` Spoon retry passed the mixed-media/speech/after-admission completion checks but exhausted its three timing-tool turns: submitted 890, then 938, then 938 frames for a 900-frame target. Preserved at `/home/mojo/comfyrizz-gallery-tests/spoon-files-delivery/`; zero paid requests. Timing repair now receives a **read-only validated suggestion**, which the model must explicitly submit through the existing atomic tool. It preserves measured speech, delayed-overlay holds, source bounds, transition types and authored/locked timing restrictions; it performs no generation or automatic retiming.

- Completed-run reopening fixed in `28a901a`, `5200c9b`, `db1ec01`. A fresh headless browser opened the actual saved *Tea at the Helm* runtime copy, downloaded the receipt-verified MP4, reloaded, and downloaded identical bytes again (`c89d74ef5d59e5de7f6669f1c19f37eeb227eeb63aa635297bd9e9517d42b216`). No planning, generation, or render requests. Evidence: `/home/mojo/comfyrizz-gallery-tests/presentation-final-v2/evidence/reopen-result.json`. Original runtime preserved.
- Fresh Spoon UI attempt reached a five-shot, exact-30-second proposal. Correct H3 speech and native still comparison were present. Review found a duplicated end-card line (corrected through proposal revision), an early punchline overlay, and procedural audio interpreting “no music” as score. Stopped before approval: **zero paid requests**, account 206.99, 0.00/hour. Evidence: `/home/mojo/comfyrizz-gallery-tests/spoon-files-final/evidence/`.
- Follow-up source changes persist an unapproved proposal checkpoint with revision/input guards; exclude music from explicit no-music finishing synthesis; and support a scene-local lower-third entrance frame and bottom placement for after-dialogue copy. The mixed-media completion gate now checks the requested after-admission overlay against measured conditioning duration. These changes still require fresh live acceptance; neither Spoon nor the speaking teaser is delivered yet.
