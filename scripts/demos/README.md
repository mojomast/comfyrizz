# Rich-demo media runner

For new productions, use the [content-quality production playbook](../../docs/CONTENT_QUALITY_RESEARCH.md#production-playbook-for-the-next-film):
plan a narrated rough cut before final GPU coverage, then recheck coverage after
measured timing. The workflow below reproduces the original showcase batch; its
successful generation counts are not a creative-quality score.

The subsequent [Anonymous, in Triplicate demo](../../docs/ANONYMOUS_DEMO.md) uses
`anonymous.mjs` and `anonymous-score.py` for narration-first shot planning and a
scene-aware score. `render.mjs --only <package-slug>` also accepts follow-up package
slugs; `verify-published.mjs` accepts optional `production-name:player-directory`
pairs. `temporal-review.py` extracts opening/action/end samples for each scene.

The [five-film long-form collection](../../docs/LONGFORM_COLLECTION.md) adds
`longform-stories.mjs`, `longform.mjs`, and `longform-score.py` for distinct scripts,
styles, measured coverage, animated graphics and scores. `longform-assemble.mjs`
merges the independent editorial and GPU work; `longform-polish.mjs` applies the
review-selected crops. `longform-assets-review.py` produces source temporal sheets,
and `longform-gallery.mjs` builds the verified collection's landing page.

The collection is [public on GitHub Pages](https://mojomast.github.io/comfyrizz/).
`github-pages.mjs` packages verified publications as 720p web players with original
1080p/project downloads in GitHub Releases; `verify-pages.mjs` checks the gallery
and players in Chromium, including repository-subpath links and chapter seeking.
See [Pages deployment and verification](../../docs/GITHUB_PAGES.md) for commands.
Current cumulative generation spend is **10.62/30 credits**, leaving **19.38**;
historical batch budgets below must not be reused as a fresh campaign balance.

`scripts/demos/run.mjs` turns the three built package directories into GPU media sets in **one
managed Google Colab session**, then stops at collected/applied media. It does **not** narrate,
polish, render, verify, export or publish. Those are parent pipeline stages:

```text
score.py -> run.mjs (GPU media) -> polish.mjs -> render.mjs -> review.py -> publish.mjs
```

This is an orchestration layer over production modules, not a second pipeline:

| Used here | Production source |
|---|---|
| allocate / bootstrap / health / collect / verified stop | `packages/backends/src/colab-backend.mjs` |
| planning and manifest apply | `packages/jobs/src/index.mjs` |
| package validation | `packages/schema/src/index.mjs` |
| package input staging | `apps/server/src/pipeline-media.mjs` |
| budget formula / reserve / balance-delta estimate | `packages/backends/src/budget.mjs` |

The runner never starts a session on its own. A real run needs an approval hash printed by a dry run.
There is no interactive prompt.

## Source and output contract

The campaign's GPU phase completed **38/38 jobs** in one verified-stopped G4
session. Measured usage was **1.48 compute credits** (359.35 → 357.87), against
the separate 30-credit authorization. This describes that run; another run uses
its own current estimate, approval hash and cumulative ledger.

The expected build layout is:

```text
$DEMO_ROOT/
  source/
    ussy/
    hermes/
    ministry/
```

The current collection plans **21 fresh stills and 17 LTX plates in total** (38 GPU jobs across the
three films), plus ready SVG/score assets. The builder owns counts, prompts and `gen` fields; the
runner uses the package's actual plan. It refuses presenter packages before allocation because this
media-only path does not implement their narration/SyncNet preparation.

`score.py` adds the ready CC0 `a_original_score` WAV/music to each source package **before** the GPU
phase. It is staged on the host but is not a GPU job. The single-session bundle deliberately omits it
unless a job names it as a file input.

Runtime output stays outside the repository:

```text
$DEMO_ROOT/
  budget-ledger.json
  budget-ledger.md
  events.jsonl
  run-summary.json
  packages/
    <package-slug>/package.json          # applied package, media assets ready
  films/
    <package-slug>/result.json            # per-film controller-shaped result
    <package-slug>/script.md              # copied script.md/STORYBOARD.md/README.md, or generated brief
    <package-slug>/media-manifest.json    # this film's split manifest
  sessions/batch/...                      # collection and logs
  logs/...
```

Each `films/<slug>/result.json` is media-only:

```json
{
  "state": {
    "version": 1,
    "runId": "demo_ussy",
    "packageId": "pkg_...",
    "status": "gpu_complete",
    "phase": "gpu_complete",
    "next": "polish_render_review_publish",
    "stages": [
      { "id": "preflight", "status": "completed" },
      { "id": "media", "status": "completed" },
      { "id": "narration", "status": "pending" },
      { "id": "timing", "status": "pending" },
      { "id": "render", "status": "pending" },
      { "id": "verify", "status": "pending" },
      { "id": "export", "status": "pending" }
    ],
    "runtimes": { "media": { "state": "stopped", "ownership": "managed" } },
    "result": {
      "packageId": "pkg_...",
      "mediaManifest": "media-manifest.json",
      "packagePath": "../../packages/ussy/package.json"
    }
  },
  "runDir": "../../packages/ussy",
  "runtimeRoot": "../..",
  "packagePath": "../../packages/ussy/package.json",
  "scriptPath": "script.md",
  "publicationInputs": {
    "workDir": "../../packages/ussy",
    "script": "script.md",
    "mediaManifest": "media-manifest.json",
    "assets": ["../../packages/ussy/assets/..."],
    "audio": { "state": "provided_by_parent", "expectedAsset": "a_original_score" },
    "video": { "state": "pending_parent_pipeline" }
  }
}
```

Paths are relative to the directory that holds `result.json`; `runtimeRoot` points back to `--out`.
The parent uses `publicationInputs` for the polish/render/review/publish stages. The media runner never
claims a render, verification or export result.

## One session, three packages

The default `--session-mode single` merges all three plans into one `jobs.json` before allocation:

* every job id and dependency is prefixed with the package slug;
* every package-relative file input and every output path is under the slug;
* every cache key is salted with the slug, so one film cannot consume another film's cached file;
* the merged manifest is split back by slug and applied to each original package;
* `batches` is empty, so the production runner does one dependency-ordered pass and one collection
  instead of pausing between batches on a paid VM.

`colab/run_jobs.py` still writes the fixed `/content/comfyrizz/out` tree, but the tree is namespaced by
slug. `--session-mode per-package` is the conservative fallback: `runPackage` once per package, one
verified-stopped VM each, paying the cold start again (about 4 minutes / 0.59 units per extra package
on G4).

The app pipeline controller is not the session owner here: it is single-active-run and single-package,
and it starts narration before media. This runner uses the backend and planner directly.

## Budget ledger

The ledger is cumulative **within the 30-unit demo campaign**:

* `--cap 30` (default);
* `--prior-spend 0` by default. The earlier 10.22/20 work is a separate authorization; if the 30 units
  are meant to include it, pass `--prior-spend 10.22` and only 19.78 remain;
* the first real preflight records the account balance as the baseline. `colab usage` has no JSON
  mode; the existing backend parser reads its text output;
* each session records `balance before → after`, `balanceDelta`, elapsed minutes and the backend's
  estimate. The cap is charged from the positive balance delta. Missing/null/negative balance data
  never becomes a zero-cost session: it settles at the reserved allocation and is labelled
  `reserved_fallback`;
* a `pendingAllocation` is written before a session starts. On resume, an interrupted reservation is
  settled at its reserved cost after `colab sessions` confirms the session is absent;
* an allocation is refused **before** `ensureUp` if
  `prior + settled + unsettled + pending + this allocation > 30`;
* the stop-only watchdog deadline is bounded by the reserved runtime, retaining a minute for
  stop/verification.

Current 38-job estimate, using the backend's measured minutes:

| work | count | minutes each | minutes |
|---|---:|---:|---:|
| FLUX 3 Klein still | 21 | 0.15 | 3.15 |
| LTX-2.5 plate | 17 | 0.50 | 8.50 |
| bootstrap (one session) | 1 | 4.00 | 4.00 |
| **point estimate** | | | **15.65 min** |
| units at 8.90/h | | | **2.32** |
| upper bound (×1.35) | | | **3.13** |
| collect-and-stop reserve (6 min) | | | **0.89** |
| **reserved allocation** | | | **4.02 of 30** |

The measured balance delta decides the ledger entry. A split into three sessions adds about
**1.18 units** for two extra cold starts. If the builder's plan changes, the dry run prints the actual
reservation before anything is allocated.

Budget validation without a VM:

```bash
node --test scripts/demos/run.test.mjs
```

## Launch instructions

### 1. Preconditions

* Main has the verified integration/docs push.
* The builder produced all three packages with valid `gen.workflow_sha256` and prompts.
* `score.py` already added `a_original_score` (ready audio) to each package.
* Google Colab CLI is installed and signed in. Do not print or copy its token.
* The Hugging Face read token is a 0600 file referenced by `COMFYRIZZ_HF_TOKEN_FILE`.
* Gated FLUX 3 Image Klein and LTX-2.5 licences are accepted on that HF account.
* At least ~5 GB free on the runtime volume; GPU weights stay remote.
* `ffmpeg` and `ffprobe` are available for the backend/bundle tooling.

### 2. Dry run — no CLI, no allocation, no spend

```bash
# From the repository root; DEMO_ROOT points at the external artifact directory.
node scripts/demos/run.mjs \
  --package "$DEMO_ROOT/source/ussy" \
  --package "$DEMO_ROOT/source/hermes" \
  --package "$DEMO_ROOT/source/ministry" \
  --out "$DEMO_ROOT" \
  --cap 30 --prior-spend 0 --gpu G4 --rate 8.9 \
  --gpu-only --dry-run --json
```

Read `run-summary.json` for per-film job counts, reserved allocation, remaining cap and the
**approval hash**. A dry run stages packages and estimates; it does not call `colab`, allocate a VM or
download weights.

### 3. Real GPU phase — one session, then verified stop

```bash
export COMFYRIZZ_HF_TOKEN_FILE="$HOME/.config/comfyrizz-hf-token"
node scripts/demos/run.mjs \
  --package "$DEMO_ROOT/source/ussy" \
  --package "$DEMO_ROOT/source/hermes" \
  --package "$DEMO_ROOT/source/ministry" \
  --out "$DEMO_ROOT" \
  --cap 30 --prior-spend 0 --gpu G4 --rate 8.9 \
  --gpu-only \
  --approve <hash from step 2>
```

`--gpu-only` and `--no-render` are accepted aliases. This runner is always media-only; they exist for
compatibility. It writes each film's `result.json` with `state.status = "gpu_complete"` and stops
after the verified teardown.

If a stop cannot be confirmed the run fails with `stop_unconfirmed`, leaves the stop-only watchdog
armed and prints the exact manual command (`colab stop -s ...`). The watchdog is armed at allocation
and disarmed only after `colab sessions` no longer lists the session.

### 4. Parent pipeline after the media phase

The parent owns all remaining stages. The media result provides `runDir`, `packagePath`,
`mediaManifest`, `script` and asset paths through `publicationInputs`:

```bash
# Names are the parent pipeline's; arguments are intentionally generic.
node scripts/demos/polish.mjs ...
node scripts/demos/render.mjs ...
"$COMFYRIZZ_PYTHON" scripts/demos/review.py ...
node scripts/demos/publish.mjs ...
```

Do not treat the media result as a finished video: `render`, `verify` and `export` remain `pending`
until those parent stages run.

### 5. GPU resume

`--resume` reuses this `--out` directory's staged packages after an interrupted **media** run. An
applied package with no pending GPU jobs plans zero jobs, so no session is allocated. Generate a new
approval hash from a `--resume --dry-run` first.

### 6. Per-package fallback

```bash
node scripts/demos/run.mjs ... --session-mode per-package --gpu-only --approve <hash>
```

One verified-stopped VM per film. Safest isolation; costs the additional cold starts.

## Potential blocks

* **Package validity** — the builder must produce `gen.workflow_sha256`, relative workflow paths and
  prompts that pass the current planner. The runner refuses before allocation; it does not patch a
  builder package.
* **Presenter packages** — refused before allocation. This media-only runner does not implement the
  narration-before-presenter or SyncNet correction path.
* **Bundle ceiling** — `jobs.zip` is limited to 128 MB. The single-session batch ships only
  `package.json`, repo workflows and files named by `fileInputs.from === "package"`, not the whole
  package. The bundle is checked before allocation.
* **One long exec** — the merged plan shares the backend's 3600 s exec timeout. The current estimate
  is ~16 minutes plus cold loads.
* **G4 capacity** — `colab new` can answer 503; the backend retries three times, then refuses without
  allocating. Nothing is billed on that path.
* **HF gating** — missing licence acceptance or a missing/read-protected token file fails preflight.
* **Audio/music inputs** — `a_original_score` must be `status: "ready"` with a real relative file.
  Pending audio is not inferred by the media phase.
* **Parent-owned CPU stages** — polish, render, review and publish are not verified by this runner.
  Their dependencies and checks belong to the parent scripts.
* **Other sessions** — balance deltas are account-wide. The ledger labels the estimate and is more
  conservative when another assignment is running; it does not stop other people's sessions.

## Credentials and git hygiene

No token value is printed, placed in argv, or written to the ledger. The token path is checked for
group/world-readable permissions; events pass through `redactForLog`. All runtime output must be
outside the repository (`--out` is refused if it resolves inside the repo). The runner does not stage
or commit anything.
