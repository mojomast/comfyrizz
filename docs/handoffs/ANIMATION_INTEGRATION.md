# Handoff: animation/storytelling integration

Updated 20 October 2026. The animation source series is integrated with the
timeline editor on `integ/animation-editor`. Kyle subsequently requested that the
verified integration, refreshed README and current screenshots be merged and
pushed to `main`; this supersedes the original PR-only delivery instruction.

## Source and merge

- Repository: `https://github.com/mojomast/comfyrizz`
- Animation foundation branch: **`feat/pipeline-observability`**
- Editor integration branch: **`integ/animation-editor`**, based on `d25bdef`
  and integrating `origin/integ/editor` at `ca517c9`.
- Research commit: **`af71b62`**
- Implementation and verified showcases: **`1394399`**
- Agent-knowledge/documentation follow-up: **`d25bdef`**.
- The production commit preceding this work was `2d4d88b`; inspect your target's
  ancestry before choosing a selective integration. The source branch also carries
  earlier pipeline/voice work, so a branch merge may include that history.

From the receiving agent's own integration branch, with its work committed:

```bash
git fetch origin
git log --oneline HEAD..origin/integ/animation-editor
git diff --stat HEAD...origin/integ/animation-editor
git merge --no-ff origin/integ/animation-editor
```

Resolve conflicts in context. If only the animation series is wanted, inspect
the three commits above and their dependencies before cherry-picking in order.
The commands above are for other receiving branches; the main integration is
performed separately under Kyle's updated instruction.

## Editor integration resolutions

The integration keeps the CA-1/2/3 editor store, timeline, Script/Audio/Media
inspector, revision-aware autosave and Playwright harness. Animation edits use
store commands, undo/redo and the same save acknowledgement as other edits.
The existing voice presets, blends, Qwen controls, scene delivery directions and
full narrated-generation panel remain available through the same store. Voice
freshness fingerprints include the additional production parameters; changing a
blend or delivery setting invalidates the old take and undo restores freshness.
Selection/playhead changes do not discard a checked generation plan.

The five textual conflicts from the initial editor merge were resolved as follows:

- `apps/web/src/main.ts`: retain the editor/store boot and bind animation controls
  to the selected scene; retain existing production functionality through store
  adapters rather than direct package mutation.
- `apps/server/src/app.mjs`: combine compile/editor/media ticket routes with
  pipeline, voice catalogue and authenticated animation catalogue setup.
- `packages/planner/src/index.ts`: union browser/compiler exports and animation
  types, including caption overrides and cue diagnostics.
- `packages/planner/src/timeline.ts`: use the browser-safe hash and floored-fps
  timing helpers while retaining cue resolution. Resolve motion against spoken
  captions before applying display-only caption corrections.
- `apps/renderer/scripts/render-package-lib.mjs`: use the shared durations mapper;
  move provenance preservation into that mapper so the browser and server have
  the same semantics as export.

`apps/renderer/src/components.tsx`, `packages/agent/src/conversation.ts` and
`apps/server/src/chat-project.mjs` had no textual conflicts. Review additionally
corrected chat compilation to read the actual flat PackageStore sidecar directory.

Security/integration corrections include token-free preview source maps (blob or
short-lived media ticket URLs), header-authenticated package media, blob-backed QA
contact sheets, redacted E2E server bootstrap logs, and realpath containment for
pipeline artifact downloads, including a replaced export-directory symlink.
`SetTransition(null)` retains the incoming cut/zero-overlap contract. The new
`ResetSceneTransition` command intentionally removes an override to use compiler
defaults. Editor sidecar word timing keeps its provenance through compilation and
word-based splits.

### Additional branch review

- `origin/q/editor-phase0` (`03b428d`) has the Pi fixtures and original phase-0
  document. `integ/editor` already incorporated its behavior manually; preserve
  the reconciled phase-0 decisions and fuller test command when closing ancestry.
- PR #14 (`b6b25b1`) needed hardening before integration: it accepted truncated
  narration prefixes. The follow-up `bd9e0d8` requires the complete active span,
  includes a partial final envelope window, uses waveform corroboration for very
  short spans, and requires a fresh report consistent with the checker exit code.
  Its 16 Python regressions and a check against the real narrated showcase passed.
- At initial fetch, `po/docs-hygiene`, `po/files-realpath`, and commit `ea4257a`
  (Q-P2) were absent. GitHub also could not resolve `d1601b2`, `fbd79d0` or
  `ea4257a`. The files-route containment correction was implemented locally with
  regression coverage; this is not a claim that an unavailable branch was merged.
  The paired documentation-hygiene/Q-P2 series must be integrated when published.
- The published Hermes history contains only the older dangling-link attempt;
  the new G6-13/Q-H2 relinking fix was not available and was left untouched.

The `q/editor-phase0` ancestry merge (`512f711`) conflicted in
`apps/web/package.json` and `docs/editor/PHASE0.md`. Both retained the already
reconciled editor versions: the complete test command/dependencies and the newer
editor decisions. The reviewed PR #14 plus hardening merged as `a33c3d7`.

### Integrated verification

Delivered on `main` by merge **`663c72e`**, pushed after verification. The
integration branch tip is `57e0d03`. [PR #16](https://github.com/mojomast/comfyrizz/pull/16)
remains open against `integ/editor`; that branch has not been rewritten or merged.

Suites were run sequentially. Shared packages passed **521** tests (agent 110,
backends 119, jobs 61, LLM 11, planner 39, schema 140, sources 12, TTS 17,
vector 12). Renderer passed **216**, server **174**, and web **82**. Python passed
**357**, with one existing optional real-MP4 probe skipped because its example
file was absent. Web and renderer TypeScript checks passed. The real published
narration mix also passed the hardened checker (envelope correlation 0.99999544).

New browser coverage exercises animation persistence and undo, reveal transitions,
compatibility/locked controls, invalid focus, rejected saves, voice blend
preservation through the compact editor, delivery directions, generation-plan
revision checks, token-free QA sheets and failed scene-render recovery.
All **30 Chromium E2E tests** passed (17 incoming editor tests plus 13 integration
tests). The timeline's compact transition selector also shares the complete
transition catalogue with the animation inspector, so selecting a reveal never
appears as a cut or carries an inapplicable direction. Current README screenshots
are captured from the running editor with a six-scene animation project.

## Delivered capability

- CPU Remotion recipes: `sketch`, `paper-cut`, `morph`, `technical-flow`, `focus`,
  `kinetic`; optional `scene.motion.recipe` preserves legacy rendering when absent.
- Reveals: `paper-reveal`, `draw-reveal`, `shape-reveal`.
- Seed/intensity, bounded morph shapes, normalized whole-frame focus rectangle,
  phrase anchors and existing explicit-second anchors.
- Scene editor controls, compatibility filtering, input validation, lock/final-scene
  handling, persistence and responsive UI.
- Conversational authoring for title, hero, stat, chart, list, split, compare and
  code, including datasets/provenance, paired plates and real code content.
- Deep motion patches with explicit `null` clearing; three-way merge preservation
  of manual copy/media/data/timing and locked scenes.
- Reproducible CPU showcase, same-audio baseline, guarded publication and software
  notices. New libraries: Rough.js 4.6.6, perfect-freehand 1.2.3, Flubber 0.4.2,
  `@dagrejs/dagre` 3.1.1.

## Integration contracts and likely conflicts

| Area | Files / merge requirement |
|---|---|
| Shared capability contract | `packages/schema/src/animation.mjs`, JSON schema, generated `types.ts`, fixtures; Python mirror in `pipeline-py/comfyrizz_pipeline/schema.py` and `motion_lint.py`. Keep vocabulary and bounds in sync. |
| Timing | `packages/planner/src/timeline.ts`, `package-types.ts`, `packages/tts/src/index.ts`, `apps/renderer/scripts/render-package-lib.mjs`. Retain word-timing provenance end to end. |
| Rendering | `apps/renderer/src/components.tsx`, `recipes/`, `motion/transitions.js`, `Root.tsx`. Preserve existing layout, presenter, caption, audio and media layering when combining renderer changes. |
| Authoring | `packages/agent/src/conversation.ts`, `skills/`, `apps/server/src/chat-project.mjs`. Merge expanded schemas/tool descriptions and three-way field merging together. |
| Editor | `apps/web/src/main.ts`, `animation-settings.ts`, `animation-controls.mjs`, CSS. Retain other agent's UI work while preserving mounting, focus restoration and validation/save wiring. |
| Server | `apps/server/src/app.mjs`, `animation-options.mjs`, `pipeline-worker.mjs`. Keep catalogue behind existing auth; preserve timing warning events and text MIME. |
| Build | `apps/renderer/package.json`, `apps/web/package.json`, `scripts/animation/licenses.mjs`. Vite shares **renderer/public**, not web/public; the notice file belongs there. |

Important details:

1. The catalogue endpoint is authenticated `GET /api/animation-options`; it returns
   `{version:1, recipes:[{id,label,description,layouts}], transitions:[...]}`.
   It is discovery for the UI/integrations, not a model tool.
2. Planner-resolved anchors live in `timeline.scenes[].motionCues`, not in editable
   motion settings. They include absolute `frame`, scene-local `seconds`, source,
   estimated flag and optional timing provenance. Renderer `mergeScenes` must keep
   them. Explicit `cue_seconds` wins. Keep `motionCueDiagnostics` and pipeline warnings.
3. Kokoro `syllable-fallback` is estimated inside measured audio. Preserve known
   aligner metadata; unknown word timing must not be called forced alignment.
4. `project_patch_plan` merges omitted motion fields, including nested focus/morph;
   `null` clears a token/object. Preserve both tool JSON schema and runtime behavior.
   `{recipe:null}` keeps entry/easing; switching to phrases requires clearing old seconds.
5. Phrase anchors affect sketch items, flow nodes, morph and kinetic. Focus and
   paper-cut enter at scene start. Technical-flow is recommended for hero/list/chart,
   not code. Morph supports circle/square/triangle/blob; equal shapes are static.
6. Reveals are non-directional masks, not shared-element continuity. Lottie,
   Three.js/shaders and Motion Canvas/Manim adapters are follow-up work.

## Agent knowledge

The runtime sends tool descriptions plus three selected bundled skills per turn.
Prompt **2.2.0**, catalogue **1.2.0**, storyboard skill **1.2.0**, revision skill
**1.1.0** cover the new features. The storyboard includes the recommended layout
matrix, executable argument examples, timing precedence/provenance and limitations;
the revision skill explains partial patches and null clearing. Other skill versions
remain 1.0.0. Preserve canonical Markdown under `packages/agent/src/skills/` when
packaging; TypeScript compilation alone does not copy it.

`apps/server/test/animation-tool-contract.test.mjs` checks actual model requests in
Chat/Express and drafting/revision against the shared catalogue. The live case
`express-animation-build-revise` exercises all six recipes and scoped edits through
OpenCode Go / `deepseek-v4.1-flash`. Other provider integrations continue using the
same instructions/tools; preserve their settings and DeepSeek reasoning continuation.

## Build and verification after merge

Use Node >=20, the project's pnpm installation, `.venv`, ffmpeg and installed
Remotion headless Chromium. On the current host:

```bash
export COMFYRIZZ_PYTHON="$PWD/.venv/bin/python"
export REMOTION_BROWSER="$PWD/apps/renderer/node_modules/.remotion/chrome-headless-shell/linux64/chrome-headless-shell-linux64/chrome-headless-shell"
export TMPDIR=/tmp/opencode
export PATH="$PWD/.runtime/tools/node_modules/.bin:$PATH"
pnpm install
pnpm --filter './packages/**' -r --if-present run build
npm --prefix packages/schema test
npm --prefix packages/planner test
npm --prefix packages/agent test
npm --prefix packages/tts test
npm --prefix apps/renderer test
node --test apps/server/test/*.test.mjs
npm --prefix apps/web run typecheck
npm --prefix apps/web test
.venv/bin/python -m pytest -q pipeline-py/tests
npm --prefix apps/web run build -- --emptyOutDir false
git diff --check
```

The full suites above are appropriate after merging another agent's changes.
The implementation passed schema 140, planner 32, renderer 213, agent 110, web 19,
TTS 17 and server 157 tests, plus later tool-contract checks. Both complete CPU
productions and the same-audio landscape baseline passed. The knowledge follow-up
passed agent 110 and all five targeted catalogue/tool-contract tests.
Its live DeepSeek evaluation passed **2/2 turns**: six-recipe creation followed by
scoped morph, phrase-timing and recipe-removal edits. Evidence is
`.runtime/evals/animation-handoff.json` on the current host.

Optional live model evaluation (billable model requests, no GPU):

```bash
node packages/agent/scripts/eval-conversation.mjs \
  --case express-animation-build-revise --label merged-animation \
  --output .runtime/evals/merged-animation.json
```

The runner reads server-owned credentials, creates isolated projects, redacts
output and cleans its temporary runtime. Never copy keys into the handoff or repo.

## Deployment and evidence

- App: the deployment's configured base URL (`APP_URL`).
- Landscape + same-audio baseline: `$APP_URL/animation-showcase/index.html`.
- Portrait: `$APP_URL/animation-showcase-portrait/index.html`.
- Both players offer MP4 and editable ZIP downloads.
- Evidence: the deployment's external `animation-implementation-20261020` directory;
  portrait artifacts are in its `portrait/` subdirectory. Runtime evidence is
  host-local, not in Git. Reproduction/publication commands are in
  `docs/ANIMATION_STORYTELLING.md`.

The test service is `comfyrizz-test.service` (user systemd, server port 4319),
served over Tailscale port 8451 through the existing proxy. Before restarting,
check the authenticated `/api/pipeline` list for active productions. Restart after
the build with `systemctl --user restart comfyrizz-test.service`.

Use **`--emptyOutDir false`** on live frontend builds. Preserve published directories
`hermes-release`, `cpu-pipeline`, `ussy-profile`, `kokoro-expression`, `tts-expression`,
`animation-showcase` and `animation-showcase-portrait`. Ordinary frontend builds
otherwise empty dist. Verify both new players, previous players, downloads and
authenticated catalogue after deployment.

Integration deployment completed after an idle-production check and backups of
the frontend/server runtime. The frontend was built with `--emptyOutDir false`,
the service restarted, and app/catalogue/pipeline/run/notices endpoints returned
200. All seven existing media pages played successfully in headless Chromium;
all **153 published artifact files** retained their pre-deployment hashes.
Local evidence: `.runtime/integration-animation-editor/deploy-verification.json`.

Credentials, model weights, runtime outputs and the local untracked
`pnpm-lock.yaml` are excluded from this series. Resolve lockfile policy with the
receiving branch rather than replacing its lockfile with this host's local one.
Animation work used no Colab units: prior cumulative usage is **10.22/20**, with
**9.78 remaining**. No new GPU allocation is required for this integration.

Subsequent authorization: Kyle approved **up to 30 Colab credits total for three
new rich demo productions** (ussy.host, Hermes Agent and an absurdist comedy),
after the verified integration/docs push to main. This is a separate new demo
budget; track measured spend and confirmed teardown in an external runtime ledger.

### Rich demo follow-up delivery

The three requested films are complete and published at `/rich-ussy/index.html`,
`/rich-hermes/index.html` and `/rich-ministry/index.html` on the application host.
They contain 36 scenes, 21 fresh stills and 17 LTX plates, plus original SVGs,
scores, measured narration and editable ZIP exports. Actual GPU spend was
**1.48 of 30 credits**, with verified shutdown and **28.52 remaining**. See
[the collection report](../DEMO_COLLECTION.md) for durations and verification.

Scene review found and fixed the non-looping video background flex-flow bug at
`0e9ae49`. The fix was pushed to main, backed up and deployed; 217 renderer tests,
web/renderer typechecks and 30 Chromium editor tests passed. The new production
tooling was pushed at `cfc74fd`; subsequent delivery commits record the final
gallery, caption-safe comparisons and published-download verification.

Broader outstanding work from previous production: combined paid cloud-pipeline
validation, general low-resolution caption scaling and human review of the Hermes
presenter tail. These are not completion claims of this animation series.
