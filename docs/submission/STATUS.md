# Hackathon submission status

**Current 2026-10-29 deadline triage:** see [Super Easy 24-hour reliability plan](SUPER_EASY_24H_PLAN.md) for the current keep/cut candidates, reduced prompts, live-test criteria and remaining blockers. The dated verification and four-route campaign below are historical; they do not establish current end-to-end mode readiness. The newer eight-film campaign has its own 60-credit ledger and must not be combined with the older 40-credit campaign described below.

Updated 2026-10-27 on `feat/hackathon-submission` / draft PR #53.

## 2026-10-30 Super Easy landing refresh

- UI commit `51fbc33` adds the new responsive prompt-first landing, quieter
  optional references and fine-tuning, and a native video-type disclosure that
  starts collapsed and displays the selected type. Keyboard selection preserves
  the typed prompt and continues to reveal music-video controls normally.
- An HTML-level launch screen prevents the editor from flashing before startup.
  Bare visits open the landing even after an editor session; explicit editor
  links still open the editor. Startup failure keeps an accessible reload action.
- The UI is served at the existing Tailscale instance `http://100.72.41.9:4404/`.
  Entry requires its authenticated `#token=` launch link, which was supplied
  privately to the user. A plain URL does not create a session. Tokens are not
  recorded here. Existing hashed web assets were retained and the new index
  published atomically; the server and production runtime were not restarted or
  modified.
- Verification: **61 focused tests, 9 Chromium browser tests, TypeScript check
  and production build passed**. Real-instance desktop/mobile checks verified
  collapsed types, updated selection summary, hidden editor, no horizontal
  overflow and an authenticated read returning HTTP 200. Generate sent the
  correct session header; that POST was intercepted before model/generation
  work. This does not constitute a new paid-film run.
- Evidence: `/tmp/opencode/super-easy-ui-deployment-51fbc33/`, including deployment
  hashes, previous index, live screenshots and `live-browser-verification.json`.
- **Review and repair is not yet wired into Super Easy.** Its backend and genuine
  live-Pi evidence remain on the separate self-review branch. This UI change does
  not add automatic repair or represent ordinary studio Review as Pi inspection.

## 2026-10-30 speaking teaser — production closed, delivery failed review

- **Terminal production:** `run_80f94fc29fbf`, production
  `prod_1a4cc5f43ee161269f222c5e`, package `pkg_cd5718a31d8fe41f`, frozen
  `3e9e609`. All 16 jobs succeeded; run `done`, production action `completed`,
  teardown `stopped`, watchdog disarmed. This is technical completion, not
  exact-monologue or audiovisual acceptance.
- **Settled actual spend: 1.99 credits**, account **205.11 → 203.12**. The
  9-credit reservation is released; campaign **9.99 spent / 0 reserved / 50.01
  remaining**. Settlement CLI evidence confirms zero assignments, no sessions
  and 0.00/hour. Review and cleanup initiated no further paid work.
- **Original and reload Download match:** both are 32,943,736 bytes, 45 seconds,
  1,350 frames, 1920×1080/30 fps with audio and verified generation/render
  receipts. SHA-256:
  `3101eb6973267361803d92e9dca068d4872d98ef391af96a623b9fca9419905b`.
- **Failed content review:** cached, offline CPU ASR of final/source shot windows
  finds eight of nine dialogue windows incomplete or different. Actual generated
  speech starts late or extends beyond planned cuts; the entire trick and slept
  lines are outside their retained windows. Source ASR also detects an unwanted
  spoken “Mara Vale” and repeated “But a minute ago”. Final/source PCM matches at
  1× speed; conditioning duration alone did not establish generated speech fit.
  Sampled frames show the MARA VALE label on the forehead rather than as a
  lower-third, plus a headset-like microphone appearing in the closing close-up.
  **No accepted publication**; user human acceptance is unknown and lip-sync is
  not certified.
- **Cleanup complete:** documented root `stop` closed the browser/controller and
  owned server with exit code 0. Server PID 1248850 is gone, port 4670 is closed,
  and copied runtime credentials were removed; none remain in the checked frozen
  runtime/app credential locations. Original/reload MP4s, source media, failed
  verifier output and review evidence are preserved.
- Evidence root:
  `/home/mojo/comfyrizz-gallery-tests/speaking-teaser-reviewed-3e9e609/evidence/`.
  See `delivery-preliminary-review.md`, `delivery-speech-timing-review.json`,
  `delivery-final-asr.json`, `delivery-source-*-asr.json`,
  `delivery-final-window-asr.json`, `delivery-final-contact-sheet.jpg`,
  `delivery-reloaded-byte-identity.json`, `speaking-terminal-settlement.json`,
  `closed.json` and `delivery-cleanup-verification.json`. Failed artifacts:
  `speaking-terminal-download.mp4` and `delivery-reloaded-download.mp4`.

### 2026-10-30 follow-up — source-aware assessment complete

- **Unchanged timing: five viable / two uncertain / two impossible.** Existing
  source ASR and frame-aligned bounds support intro, trick, storm (excluding its
  unwanted spoken-name prefix), silent and slept. Name and switched remain
  uncertain because of “it”/“it's” and the low-confidence repeated opening.
  Notes needs **7.10s versus 5.90s** available; like-me needs **7.12s versus
  4.50s before the outgoing fade**, with possible restarted dialogue unresolved.
  Timing viability is not actual-speech or audiovisual acceptance.
- **Conditional 45-second salvage:** source-in changes alone cannot repair all
  scenes. A minimum **127-frame reallocation at 30 fps** (+42 notes, +85 like-me;
  −46 trick, −40 silent, −41 slept) can retain 1,350 frames, natural speed and
  source ends. Calculations include 0.100s speech-boundary uncertainty and project
  rounding. **Listen to the existing speech first**; no timing changes were applied.
- **Forehead label confirmed native:** matching source/final samples and renderer
  code identify the omitted position's default `top`, not generated lettering.
  Explicit bottom placement is a possible fix, **not applied**; the requested
  mask-rise/spring entrance also remains unfulfilled.
- Evidence: `/tmp/opencode/teaser-feasibility-ESwU3BDN/assessment.md` and
  `assessment.json`, with source/final PNGs and `input-integrity.json` confirming
  30 read-input hashes unchanged. **No new paid generation, inference, package
  edits or render; teaser remains unaccepted.** Pi self-repair proof belongs to
  the separate self-review branch and does not establish teaser delivery.

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

Historical approval/progress entries below are preserved. The terminal teaser
review above supersedes their pending-production and reservation status.

- **Speaking teaser approved and running:** normal full-plan controls saved r61 in isolated `speaking-teaser-reviewed-3e9e609` (frozen `3e9e609`), then Super Easy re-reviewed the revision. All eleven H3 shots now share `a_img_70b7d3645507e649` as their identity image; shot 6's composition image and direction show face/mouth while speaking. Scene timing/copy and every conditioning asset remain byte-for-byte unchanged. Deterministic preflight verifies all exact monologue words in order, only opening/final THE LAST SIGNAL and one MARA VALE overlay, no music/detached narration, and 1,350 frames at 30 fps. The final whole-film plan is **16 jobs: five Klein images and eleven H3 clips**, one candidate per shot, quote **5.42**. Fresh CLI confirmed 205.11 credits and no sessions; the campaign atomically reserved **9 credits** before releasing approval for `prod_1a4cc5f43ee161269f222c5e`. Campaign at reservation: **8.00 spent / 9 reserved / 43.00 remaining**. Actual generated speech/visuals, completed export and shutdown/settlement remain pending. Evidence: `/home/mojo/comfyrizz-gallery-tests/speaking-teaser-reviewed-3e9e609/evidence/`.

- **Corrected Spoon delivered for audiovisual review:** a separate CPU-only runtime frozen at `706d93a` exported `pkg_42de342a7f5929c4` r31 as `r_b1a650b70c84`. Final **1920×1080, 30 fps, 900 video frames / 30 seconds**, 15,565,063 bytes; SHA-256 **`94115740340c6f124cc845fe5c2909ef67fdce0e8462167f4798c0a3923f1742`**. The final receipt includes visible H3, LTX and Klein contributions. Both native-source trims remain 0.75 seconds; every media hash is unchanged. Unprompted CPU Whisper recognizes “At 903, the office spoon vanished. It was in my pocket.” Final-file samples show the confession before CASE CLOSED and the correct end card. Fresh-browser Download and subsequent reload/re-Download are byte-identical; automated 1× playback reached the end. Both Spoon-owned servers/browsers closed and isolated credentials removed. Human listening/lip-sync acceptance remains pending. Share: http://100.72.41.9:8766/the-spoon-files.mp4 . Evidence: `/home/mojo/comfyrizz-gallery-tests/spoon-files-corrected/evidence/`. Actual spend stays **1.88 credits**; campaign **8.00 spent / 0 reserved / 52.00 remaining** before teaser approval.
- **Speaking teaser pre-approval review:** the unchanged 45-second brief planned eleven H3 shots and exact 1,350/30 timing in `speaking-teaser-ready`, package `pkg_cd5718a31d8fe41f` r60, with zero paid requests. Review found a hands-only framing for the longest spoken line and independent identity images. Its unapproved checkpoint/runtime is preserved for full-plan correction in a new frozen namespace. Full-plan controls now expose existing image/identity and composition-reference asset IDs (`3e9e609`); six full-plan tests and web typecheck pass. No teaser generation or charge has been authorized at this boundary.
- **Self-review follow-up:** separate branch commit `6302f3b` fixes inspection of package-owned selected takes, rejects missing/cross-package/escaping paths, and retains hash revalidation. Nineteen tests pass. A read-only smoke probed both genuine Spoon selected sources at r30, verified their hashes and coverage, and wrote reports only to `/tmp/opencode/comfyrizz-source-review-spoon-L5JzSA/`. No ASR was configured for that smoke; it makes no speech/final-render acceptance claim. Branch remains pushed and unmerged.

- **Corrected-export failure preserved, repair awaiting fresh UI replay:** the first override export was correctly refused on a stale package revision. A fresh browser then exported r30 as `r_897f316633f2` (`ace7a0ed474ef07bf275aad07b1f9c6bdb159a7f0c733259024f308b7b8ccd75`), but CPU ASR detected no speech. Investigation found delivery staging looked only in the shared packages directory, omitting the two selected H3 takes stored under the owning package directory. This MP4 is failed evidence, not a delivery. Staging now resolves package-owned takes, preserves their relative paths, checks byte identity, and rejects escaping paths. Final preflight blocks missing active media rather than merely warning. A separate current-revision artifact lookup lets Super Easy reopen a verified later editor export without falling back to obsolete original-run bytes. Focused snapshot/artifact tests (12), restoration/client tests (7), web typecheck, and render-admission tests (7) pass; four additional export/audio/delivery suites completed 31 passing tests. The initial combined run timed out because admission fixtures lacked their declared demo media; the fixture now copies those sources and all seven admission tests pass.
- **Separate self-review branch:** `feat/agent-self-review-and-repair`, commit `1afc1d0`, worktree `/home/mojo/projects/comfyrizz-self-review`, pushed and unmerged. It adds source-byte inspection and evidence-bound source-in repair with revision/hash checks and a two-batch persistent limit. Seven new tests pass; expanded agent checks report 62 passing and two failures reproduced on unchanged `de798c9`. Optional Whisper inference and automatic final-MP4 review/re-render were not exercised or implemented respectively. See that branch's `docs/AGENT_SELF_REVIEW.md` for primary-source research and boundaries.

- **Spoon generation completed; speech correction under review:** run `run_8b3abf9d8459` completed all ten jobs and exported 900 frames at 30 fps with verified model/render receipts. Normal Download and completed-page reload/re-Download returned identical original bytes (`58e0c33a657cdcfc9d1d7a492bdf22cc2f16ce7da1f05b3c214dc6a7e9198180`). Actual account spend **1.88 credits**, 206.99 → 205.11; the 9-credit reservation is settled and fresh CLI confirmed no assignments/sessions and 0.00/hour. CPU ASR of the native sources found complete lines, but the first final export clipped “vanished”; preserve it as failed audio evidence. Editor Source in controls saved two 0.75-second trims, retaining source out points, natural speed/native audio, unchanged media hashes, scene windows `[190,170,179,203,194]`, and exact 30 seconds. The corrected export is not yet accepted.
- **Partial-preview take fingerprint defect:** a per-shot preview can omit its already-generated image dependencies, recording a hash-less source fingerprint which later appears stale. Both Spoon H3 takes were kept through the UI but still show stale. Read-only `corrected-input-verification.json` binds unchanged source/conditioning bytes and captured workflow receipts to the original run. The existing editor written render override records this diagnosis for the CPU-only corrected export; no take fingerprint or receipt was rewritten. Future ingestion now defers takes with pending conditioning references until collection resolves them. **16 focused ingest/recovery tests pass**, plus an isolated offline replay of the genuine Spoon outputs: four partial motion previews deferred, ten completed takes ingested, all four motion takes fresh and unreviewed. This is offline replay evidence, not another live production. Frozen live runtimes were not hot-swapped.

- **Live Spoon run in progress, frozen at `35a2572`:** `pkg_42de342a7f5929c4` r23 survived actual normal-UI cold proposal reload. Editor chat `project_edit_package` → `project_build` saved r24, removing the duplicate early CASE CLOSED headline while preserving the delayed lower third, all media/conditioning, and exact 900/30 timing. Return-to-proposal reviewed r24. Normal Make this film produced final quote 2.734; fresh CLI showed 206.99 credits and no sessions, then the campaign atomically reserved 9 credits before approval. Production `prod_e63b9c1a3aea37cb3ca8839f`; ten planned jobs (six Klein images, two H3, two LTX), one candidate per motion shot. Evidence: `/home/mojo/comfyrizz-gallery-tests/spoon-files-ready/evidence/`. This is not a delivery or audiovisual acceptance yet.
- Live review also found that cold proposal restoration needed a compiled timeline (`35a2572` fixes it), and the Review & edit full plan route had stale package-existence facts. Latest source refreshes those facts, binds checkpoints to motion model/conversation as well as revision/inputs, and rejects an early duplicate of an otherwise delayed punchline. Those follow-ups are outside the frozen Spoon run.

- The `bb88da2` Spoon retry passed the mixed-media/speech/after-admission completion checks but exhausted its three timing-tool turns: submitted 890, then 938, then 938 frames for a 900-frame target. Preserved at `/home/mojo/comfyrizz-gallery-tests/spoon-files-delivery/`; zero paid requests. Timing repair now receives a **read-only validated suggestion**, which the model must explicitly submit through the existing atomic tool. It preserves measured speech, delayed-overlay holds, source bounds, transition types and authored/locked timing restrictions; it performs no generation or automatic retiming.

- Completed-run reopening fixed in `28a901a`, `5200c9b`, `db1ec01`. A fresh headless browser opened the actual saved *Tea at the Helm* runtime copy, downloaded the receipt-verified MP4, reloaded, and downloaded identical bytes again (`c89d74ef5d59e5de7f6669f1c19f37eeb227eeb63aa635297bd9e9517d42b216`). No planning, generation, or render requests. Evidence: `/home/mojo/comfyrizz-gallery-tests/presentation-final-v2/evidence/reopen-result.json`. Original runtime preserved.
- Fresh Spoon UI attempt reached a five-shot, exact-30-second proposal. Correct H3 speech and native still comparison were present. Review found a duplicated end-card line (corrected through proposal revision), an early punchline overlay, and procedural audio interpreting “no music” as score. Stopped before approval: **zero paid requests**, account 206.99, 0.00/hour. Evidence: `/home/mojo/comfyrizz-gallery-tests/spoon-files-final/evidence/`.
- Follow-up source changes persist an unapproved proposal checkpoint with revision/input guards; exclude music from explicit no-music finishing synthesis; and support a scene-local lower-third entrance frame and bottom placement for after-dialogue copy. The mixed-media completion gate now checks the requested after-admission overlay against measured conditioning duration. These changes still require fresh live acceptance; neither Spoon nor the speaking teaser is delivered yet.
