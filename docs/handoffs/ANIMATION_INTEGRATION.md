# Handoff: animation/storytelling integration

Prepared 20 October 2026 for the agent integrating this work with its own branch.

## Source and merge

- Repository: `https://github.com/mojomast/comfyrizz`
- Source branch: **`feat/pipeline-observability`**
- Research commit: **`af71b62`**
- Implementation and verified showcases: **`1394399`**
- Agent-knowledge/documentation follow-up: the subsequent commit containing this
  handoff. Merge the remote branch tip to include it.
- The production commit preceding this work was `2d4d88b`; inspect your target's
  ancestry before choosing a selective integration. The source branch also carries
  earlier pipeline/voice work, so a branch merge may include that history.

From the receiving agent's own integration branch, with its work committed:

```bash
git fetch origin
git log --oneline HEAD..origin/feat/pipeline-observability
git diff --stat HEAD...origin/feat/pipeline-observability
git merge --no-ff origin/feat/pipeline-observability
```

Resolve conflicts in context. If only the animation series is wanted, inspect
the three commits above and their dependencies before cherry-picking in order.
This handoff does not perform a merge into the receiving agent's branch.

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

- App: <https://mail.tailec998.ts.net:8451/>
- Landscape + same-audio baseline: <https://mail.tailec998.ts.net:8451/animation-showcase/index.html>
- Portrait: <https://mail.tailec998.ts.net:8451/animation-showcase-portrait/index.html>
- Both players offer MP4 and editable ZIP downloads.
- Evidence: `/home/mojo/comfyrizz-gpu-tests/animation-implementation-20261020`;
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

Credentials, model weights, runtime outputs and the local untracked
`pnpm-lock.yaml` are excluded from this series. Resolve lockfile policy with the
receiving branch rather than replacing its lockfile with this host's local one.
Animation work used no Colab units: prior cumulative usage is **10.22/20**, with
**9.78 remaining**. No new GPU allocation is required for this integration.

Broader outstanding work from previous production: combined paid cloud-pipeline
validation, general low-resolution caption scaling and human review of the Hermes
presenter tail. These are not completion claims of this animation series.
