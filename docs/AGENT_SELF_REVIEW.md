# Agent self-review and bounded repair

Research/implementation started 2026-10-30 from `de798c9` on
`feat/agent-self-review-and-repair` in a separate worktree.

## Answer to the product question

Yes: the agent should be able to inspect its work and perform authorized,
source-preserving corrections through tools. Prompting is necessary to explain
the workflow, but a prompt alone cannot supply observations of rendered media or
enforce revision, source-coverage, spending and iteration limits. Pi remains the
model/tool loop; deterministic server tools own measurements and mutations.

The useful loop is **inspect → identify a specific failed requirement → propose
an evidence-backed edit → apply under existing authorization → re-render →
inspect the new bytes**. A successful tool call or valid receipt is not proof
that the delivered film meets its brief.

## Primary-source research

1. Anthropic, [Building effective agents](https://www.anthropic.com/engineering/building-effective-agents)
   (2024-12-19): evaluator–optimizer loops work when evaluation criteria are
   clear and feedback improves the result. Agents need environmental ground
   truth, well-designed tools and stopping conditions. Application here: a
   small inspect/edit tool pair within the existing Pi harness, rather than a
   second unconstrained creative agent. The article now flags newer managed
   tooling; the cited design principles are independent of that tooling.
2. Anthropic, [Demystifying evals for AI agents](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents)
   (2026-01-09): grade the actual environment outcome, combine deterministic,
   model and human graders, calibrate model judges against people, and start
   with real production failures. Explicitly permit unknown judgments and test
   both when actions should and should not occur. Application here: regression
   fixtures for late speech and subtitle overlap, plus unavailable-evidence,
   stale-evidence and no-repair-needed cases. Source-media checks and subjective
   film acceptance are separate dimensions.
3. OpenAI, [Whisper model card](https://github.com/openai/whisper/blob/main/model-card.md):
   ASR can hallucinate text, omit/misrecognize words and vary by language/accent;
   evaluate in the intended domain. Application here: ASR observations carry
   provider identity and an explicit timing margin/limitation. A normalized
   transcript match is named `match_observed`, never “exact dialogue verified.”
   An empty transcript or failed provider is unknown, not silence or a pass.
4. FFmpeg, [ffprobe documentation](https://ffmpeg.org/ffprobe.html): structured
   stream/format metadata and frame counts are available independently of an
   LLM. Application here: inspect real local file bytes for duration, frame
   rate and audio-stream presence; do not substitute requested generation
   duration or conditioning duration for observed output.

## Implemented: first vertical slice

### Agent-facing source inspection

`project_inspect_source({packageId, expectedRevision, sceneId})` is available in
saved-package chat through `packages/agent/src/conversation.ts` and
`apps/server/src/agent-chat.mjs`. It reads the authoritative background asset;
the model cannot provide a path, transcript, timing observation or certificate.

`apps/server/src/source-review.mjs`:

- Resolves a ready, SHA-256-declared local video within the package store,
  including symlink containment, and hashes its bytes before and after analysis.
  Ordinary sources use `<packagesRoot>/<asset.file>`; selected `takes/...`
  sources use `<packagesRoot>/<pkg.id>/<asset.file>`, matching normal Keep
  storage. Selected takes must resolve inside the owning package, including
  when the owner directory itself is a symlink. Traversal, cross-package takes
  and shared-path aliases into package-owned takes are rejected. A missing
  owned take never falls back to a flat `<packagesRoot>/takes/...` copy.
- Uses the existing CPU ffprobe implementation (60-second video limit) and the
  actual compiled scene window, including transition overlaps. Files are capped
  at 512 MiB; each turn allows at most four inspections.
- Reports source duration/coverage and audio-stream presence. Stream presence
  deliberately does not assert non-silence, loudness or audible intelligibility.
- Optionally calls a **server-selected** ASR provider on the actual media without
  passing the expected dialogue as a prompt. Validates ordered, bounded source
  timestamps. Empty, failed and malformed observations become unknown.
- Computes detected speech coverage and possible transition/lower-third
  overlap. Overlay overlap is `needs_review`: the brief determines whether it
  is a defect. It does not rewrite the overlay's authored entrance.
- Accounts conservatively for half a project frame of source-in rounding in
  full Remotion playback, in addition to the provider's timestamp margin.
- Persists immutable, content-addressed reports under
  `<runtimeDir>/source-reviews/sr_<sha256>.json`. Each report binds package ID,
  revision, full package content hash, scene, asset ID and actual source hash.
  Failed findings are retained alongside subsequent observations.
- Reports visual capability as `unavailable`, final render as `not_inspected`,
  and human acceptance as `not_assessed`. There is no overall quality pass.

### Bounded source-in repair

`project_edit_package` now accepts:

```json
{
  "packageId": "pkg_example",
  "expectedRevision": 25,
  "edits": [{
    "sceneId": "s1",
    "backgroundSourceIn": {
      "inspectionId": "sr_<64-character hash from the inspection tool>",
      "inFrame": 18
    }
  }]
}
```

Source frames use **observed source fps**, not project fps. Eighteen frames at
24 fps is 0.75 s. The edit changes only `background.trim.startSeconds`, retaining
an existing end bound. The saved package is never reconstructed from a draft.

Repair currently supports unlocked, visible H3 background plates with explicit
`speed:1`, `loop:false`, `muted:false`, declared native audio, no independent
audio trim/drawing/composition/panel media and no master-music replacement.
Unsupported playback mappings are unknown rather than guessed. Detected speech
plus margins must fit outside the scene's transitions, and the entire unchanged
scene window must fit in the observed source. No stretching, looping, new source,
dialogue rewrite, conditioning change or authored timing rewrite is accepted.

The server reloads and hashes the inspection report and rehashes the media at
both stage and build. Stale revision/content, cross-project/scene evidence,
unknown IDs, changed source bytes and model-supplied observations are rejected.
The report hash detects modified saved evidence; the server filesystem remains
the trust boundary (this is not a signature against a hostile filesystem owner).

The existing before/after review, production-read/intent/target guards, package
CAS, history and journaled conversation commit still apply. The compiled shot
positions/durations/transitions must remain identical. At most **two applied
source-repair batches per conversation/project** are persisted across restarts;
idempotent replay does not consume another round. This is a bounded editing
primitive, not yet a cross-conversation production repair controller.

### Optional local ASR capability

By default, only probing is available. Configure a server with an existing
separate Python environment containing `openai-whisper`, `torch` and `numpy`,
plus ffmpeg on PATH:

```sh
export COMFYRIZZ_QA_WHISPER_PYTHON=/absolute/path/to/asr-env/bin/python
export COMFYRIZZ_QA_WHISPER_WEIGHTS=/absolute/path/to/base.en.pt
```

`local-speech-inspector.mjs` invokes `scripts/inspect-source-speech.py`. The
adapter loads only an existing weights file, runs on CPU with two Torch threads,
decodes PCM through ffmpeg, requests word timestamps, and disables conditioning
on prior text. It does not install packages, download weights or start GPU work.
It records Whisper version and weights SHA-256 in the provider identity. Its
100 ms timing margin is **heuristic, not calibrated confidence**. Process time is
capped at 90 seconds and inherits turn cancellation. Missing/invalid optional
configuration is reported as unknown by inspection, not a startup requirement.

Custom local providers can instead be injected as
`createApp({speechInspector})` / `createProjectChat({speechInspector})`. Contract:

```js
async function speechInspector({ file, sha256, durationSeconds, signal }) {
  // Observe the supplied bytes. No expected-dialogue prompt is provided.
  return {
    provider: 'provider/version/model-identity',
    uncertaintySeconds: 0.1,
    segments: [{ start: 4.4, end: 6.62, text: 'Observed speech' }],
  };
}
```

The injection is a trusted server capability, not a tool argument. Current
runtime integration supplies only the local CPU adapter. Adding a remote/paid
grader requires separate capability and spend authorization.

The existing live Spoon ASR environment uses **faster-whisper**, not the
`openai-whisper` API of this optional adapter. It must not be treated as an
already configured provider for this branch. No adapter inference is claimed
by the read-only smoke check below.

## Follow-up: selected takes and missing speech in delivered output

The live Spoon follow-up identified two related issues:

1. Normal Keep stores selected takes under
   `<packagesRoot>/<pkg.id>/takes/...`, while the original source inspector
   looked only under `<packagesRoot>/<asset.file>`. The follow-up resolver above
   fixes inspection and trim revalidation independently on this branch. The
   regression uses the actual `createTakeStore.addTake` and `selectTake` APIs,
   actual ffmpeg video/ffprobe, and unchanged approval/history sidecars.
2. The user reported a later successful render whose delivery staging omitted
   H3 take files: CPU ASR found no speech in the delivered video, while generated
   source clips still contained the full speech. This is a separate failure from
   late-speech clipping. A successful render return and a good source report
   cannot establish delivered speech. Main's analogous delivery-staging fix at
   `706d93a` was read for context; it was not merged or cherry-picked here.

This branch still does **not** implement automated final-render inspection.
The next stage must check staged active-media completeness and inspect the
receipt-bound final MP4's actual audio/speech, comparing it with observed source
speech and the authored requirements. A source-level pass must not substitute
for these output checks. Failed render evidence and existing approvals remain
separate from inspection reports and must be retained.

## Practical next stages

1. **Final-render inspection:** expose a read-only render inspector resolving
   render ID from the existing trusted render receipt and binding both rendered
   MP4 hash and package revision. Reuse `qa.mjs` frame QA/contact sheets and add
   final-audio signal measurements (not just streams), ASR and source-to-output
   utterance comparison. Retain all original renders and reports. Never point a
   “final QA pass” at a source report or a newer package with an older render.
2. **Production-scoped repair controller:** after render completion, run a
   deterministic inspection job and feed findings to Pi. Reserve at most two
   CPU correction rounds per production/output lineage, with a journaled
   operation ID, cancellation and runtime budget. Reuse existing authorized
   edit/CAS and CPU-export paths, then inspect new bytes. Stop on unknown
   required criteria, no feasible repair, no improvement, conflicting authored
   intent or exhausted budget. The current source-only tool cannot yet close
   this automatic render→review→repair→re-render loop.
3. **Brief-grounded criteria:** retain exact dialogue and explicit temporal
   requirements separately from model-generated plans. Align recognition to
   those requirements without prompting ASR to hear the expected line. Treat
   disagreement as uncertain evidence for review; do not silently change words.
   Evaluate margins/false positives on a labeled corpus of real native clips.
4. **Optional visual/multimodal graders:** capability registry with provider,
   cost, input hash, sampled frames/time ranges, rubric version and uncertainty.
   Judge concrete properties (missing character, obscured title, duplicate
   headline, visual continuity) with localized evidence. Calibrate against human
   acceptance; track dimensions independently rather than one model quality
   score. No multimodal capability means unknown, never implied visual approval.
5. **Paid repairs:** a source that cannot retain all required speech in authored
   timing must stop with evidence. Regeneration requires a fresh approved plan
   and spend reservation, visibly preserving verified hackathon model identity
   and byte-bound generation/render receipts. Inspection does not authorize it.

## Regression evidence / verification

`apps/server/test/source-review.test.mjs` encodes the reported failure arithmetic:
speech at 4.40–6.62 s in a 190-frame/30-fps scene, repaired by a 0.75 s source-in;
and admission at 2.74–4.08 s preceding a 104-frame lower third after the same trim.
These timestamp observations are explicit fixtures, not a claim that the tests
transcribed the live film. Tests include actual ffmpeg-produced media/ffprobe,
mock local ASR, normal HTTP chat tool execution, stage/restart/apply, immutable
assets, 900-frame timing, cross-project/stale/fabricated/tampered evidence,
unsupported mappings, unavailable ASR and repair-budget persistence.

The optional Whisper inference itself requires separately installed weights and
is not part of the default test suite. No paid provider or live production run is
needed for these regressions.

Initial-slice verification (`1afc1d0`):

- All workspace library builds passed using Node 22.19.0 and pnpm 10.27.0.
  Dependencies were installed in this worktree with the offline lockfile path;
  built agent/planner modules resolve here, not into the parent worktree.
- The seven new source-review tests passed, including real ffprobe and the
  mocked-provider HTTP tool loop. Existing focused package-edit, planning-timing
  and agent conversation/production-policy suites also passed.
- The expanded command below ran **64 tests: 62 passed, 2 failed**. Both failures
  in `finished-package-chat.test.mjs` reproduce on unchanged `de798c9` after a
  fresh independent worktree install/build: “a concurrent package edit defeats
  a staged drawing build without overwriting the editor” and “an attachment
  conversation adopts and edits the finished package with revision protection.”
  They exercise the existing drawing/no-compatible-draft path, not source trim.
- Python adapter syntax and `git diff --check` passed. Actual optional Whisper
  inference was not run; speech regressions use declared timestamp fixtures.

```sh
pnpm -r --filter './packages/**' --if-present run build
node --test \
  apps/server/test/source-review.test.mjs \
  apps/server/test/chat-package-edit-http.test.mjs \
  apps/server/test/finished-package-chat.test.mjs \
  apps/server/test/planning-timing-repair.test.mjs \
  packages/agent/dist/test/conversation.test.js \
  packages/agent/dist/test/conversation-production.test.js \
  packages/agent/dist/test/ux09-conversation-policy.test.js
```

### Selected-take follow-up verification

- `source-review.test.mjs` and `chat-package-edit-http.test.mjs`: **19 passed**.
  The five added regressions cover actual Keep storage, selected-file hash
  changes, missing-owner/no-flat-fallback behavior, traversal and cross-package
  paths, same-hash symlink escapes (including owner-directory aliases), and a
  permitted symlink that stays within its owning package. Escape checks also
  run on trim revalidation after an earlier successful inspection.
- Read-only actual ffprobe smoke against live package
  `pkg_42de342a7f5929c4` **revision 30** resolved both selected H3 takes:

  | Scene | Source SHA-256 | Observed duration | FPS | Audio stream |
  | --- | --- | --- | --- | --- |
  | `s1_statement` | `5d632fd84e77b5b40aab668439099946727261c5e501a1761bd4bdd403589b86` | 7.2916666667 s | 24 | present |
  | `s4_confession` | `be0484fa60cdeb83e22c91fe8f9eefcc03734966973a403de4b4af7c48fa7d38` | 8 s | 24 | present |

  Both source-coverage checks passed at the saved 0.75 s in-points. Speech
  timing/transcript comparison remained unknown, ASR and visual capabilities
  unavailable, final render `not_inspected`, acceptance `not_assessed`.
  Package bytes were identical before/after the check (package SHA-256
  `6b79b8f28fac30f238b503987bca5c96fa696cfab92ab0cdb13bad6ba1735f15`).
- Reports and `smoke-summary.json` were written only under
  `/tmp/opencode/comfyrizz-source-review-spoon-L5JzSA/`. The smoke ran with
  `transcribe:null`: no ASR inference, installs/downloads, generation/planning
  provider calls, Colab work, live-runtime writes or ledger/approval changes.
