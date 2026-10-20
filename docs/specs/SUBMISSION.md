# Spec: SUBMISSION, the hackathon submission package

Status: draft v1 (Oct 20, 2026). Branch: `feat/submission`, off `feat/demo-webapp` (which already includes `chore/quick-wins` and the `feat/lw-*` branches).

## 1. Why this feature
The deadline is Oct 30, 2026, 9am PT. The official rules (https://comfy.org/open-source-higgsfield/) require:
- an open-source licence and setup instructions;
- a demo video that shows the work in action and explains how it was built;
- for Most Innovative, an explanation of why the entry is innovative;
- for Open Weights Only, no partner nodes and no closed APIs.

The repo already has the product, but the submission material is missing:
- no CI (there is no `.github/`);
- no CREDITS or third-party licence file;
- no writeup, checklist or demo script;
- no gallery;
- a README that is engineering notes, not an entry page.

Judges read the repo first, so this package is the cheapest way to raise the score of what is already built. It is docs and tooling only, so it can't break the product or the in-flight HyperFrames and Google Colab work.

## 2. Boundaries
- No changes to HyperFrames, Google Colab, GPU or rendering code. Another agent owns those, and its merge to main is in progress.
- No changes to anything `feat/demo-webapp` is changing: `apps/web/src/demo/**`, `apps/web/demo.html`, `apps/web/vite.config.ts`, `apps/web/e2e/demo.spec.ts`, `apps/web/README.md`, `docs/DEMO_WEBAPP_RUNBOOK.md`, `docs/specs/DEMO_WEBAPP.md`.
- `README.md` is touched by one task only (S14), and only its top section, to keep conflicts with main small.
- Facts come from the repo. Anything unverified is marked [unverified]. `scripts/release-scan.mjs` must stay clean.

## 3. Tasks
Tiers: **simple** tasks run on the free `deepseek-v4.1-flash-free`; **standard** tasks run on `deepseek-v4.1-flash`.

| Task | Title | Tier | Files | Depends on |
| --- | --- | --- | --- | --- |
| S01 | Clean-clone CI workflow | standard | `.github/workflows/ci.yml` | - |
| S02 | CI documentation | simple | `docs/CI.md` | S01 |
| S03 | CREDITS audit script | standard | `scripts/credits-audit.mjs`, `scripts/credits-audit.test.mjs` | - |
| S04 | Third-party licences | simple | `THIRD_PARTY_LICENSES.md` | - |
| S05 | CREDITS.md from the audit | simple | `CREDITS.md` | S03 |
| S06 | Licence and rights audit | simple | `docs/submission/LICENSE_AUDIT.md` | - |
| S07 | Hackathon writeup | simple | `docs/submission/WRITEUP.md` | - |
| S08 | Demo video script | simple | `docs/submission/DEMO_SCRIPT.md` | - |
| S09 | Gallery manifest generator | simple | `scripts/gallery-manifest.mjs`, `scripts/gallery-manifest.test.mjs` | - |
| S10 | Static gallery page | simple | `docs/gallery/index.html`, `docs/gallery/gallery.css`, `docs/gallery/gallery.js` | S09 |
| S11 | Committed gallery.json | simple | `docs/gallery/gallery.json` | S09 |
| S12 | Submission checklist | simple | `docs/submission/CHECKLIST.md` | - |
| S13 | Contributor files | simple | `CONTRIBUTING.md`, `.github/pull_request_template.md`, `.github/ISSUE_TEMPLATE/bug_report.md`, `.github/ISSUE_TEMPLATE/feature_request.md` | - |
| S14 | README overhaul (top section) | standard | `README.md` | S02, S05, S07, S08, S10, S12 |

### S01 Clean-clone CI workflow (standard)
**Files:** `.github/workflows/ci.yml`  
**Depends on:** none

GitHub Actions workflow on push/pull_request: ubuntu-latest, actions/checkout@v4, pnpm/action-setup@v4 with version 10.34.6, actions/setup-node@v4 node 22 with pnpm cache, astral-sh/setup-uv@v6 python 3.12; steps exactly mirror docs/RELEASE_CHECK.md: pnpm i --frozen-lockfile, uv venv .venv -p 3.12 && uv pip install -p .venv -r pipeline-py/requirements-dev.txt -e pipeline-py, pnpm test:all (which includes test:scan). Second job 'cpu-export' (needs: test) installs ffmpeg and runs pnpm --filter @comfyrizz/renderer render:example, then uploads examples/launch-demo/out/launch-demo.mp4 as an artifact. No secrets, no GPU, no Google Colab. concurrency group per ref with cancel-in-progress; permissions: contents: read.

**Acceptance:**
- valid YAML (parse it with node: e.g. a tiny inline parser is NOT required; check with `python3 -c 'import yaml,sys;yaml.safe_load(open(sys.argv[1]))' .github/workflows/ci.yml` if PyYAML exists, else describe)
- every command it runs exists in package.json scripts or docs/RELEASE_CHECK.md
- no secrets referenced
- only the assigned files change
- `node scripts/release-scan.mjs` stays clean

### S02 CI documentation (simple)
**Files:** `docs/CI.md`  
**Depends on:** S01

Explain the two CI jobs, how to reproduce them locally (same commands), expected durations from docs/RELEASE_CHECK.md, the release scan and its allowlist, and what CI deliberately does not run (GPU, Google Colab, paid runs).

**Acceptance:**
- commands match .github/workflows/ci.yml
- links resolve to files that exist
- only the assigned files change
- `node scripts/release-scan.mjs` stays clean

### S03 CREDITS audit script (standard)
**Files:** `scripts/credits-audit.mjs`, `scripts/credits-audit.test.mjs`  
**Depends on:** none

Node script that reads every examples/*/package.json (Comfyrizz package format: read packages/schema/types.ts and packages/sources/src/types.ts for asset/licence fields), lists each asset with source, creator, licence id, approval and redistributable status, and flags problems (non-redistributable asset that would ship, missing attribution for CC BY, unknown licence). Outputs markdown (--md, default) or JSON (--json); --check exits 1 on problems. Pure functions exported (auditPackage(pkg, dir), renderCredits(rows)) for tests. No network.

**Acceptance:**
- test with a temp dir fixture: CC BY approved -> credited; CC BY-NC -> flagged only if it would ship; unknown licence flagged
- runs on the real repo and exits 0 with --check or lists real problems in its summary
- no absolute paths in output
- only the assigned files change
- `node scripts/release-scan.mjs` stays clean

### S04 Third-party licences (simple)
**Files:** `THIRD_PARTY_LICENSES.md`  
**Depends on:** none

Root THIRD_PARTY_LICENSES.md: model weights (FLUX 3 Klein, LTX-2.5, any TTS/ASR models named in the repo) with licence names and links from docs/SPEC.md Appendix A; Remotion's licence terms (company licence note) from docs/SPEC.md; fonts under apps/web/public/fonts (OFL); key npm/python dependencies with licences read from package.json/pyproject files present in the repo (no node_modules scanning). Mark anything not stated in the repo as [unverified].

**Acceptance:**
- every licence claim cites a repo file or the SPEC appendix URL
- Remotion terms included
- no invented licences
- only the assigned files change
- `node scripts/release-scan.mjs` stays clean

### S05 CREDITS.md from the audit (simple)
**Files:** `CREDITS.md`  
**Depends on:** S03

Generate CREDITS.md by running `node scripts/credits-audit.mjs --md` and add a short header (what is credited, how to regenerate, link to THIRD_PARTY_LICENSES.md and packages/sources/README.md licence policy). If the audit reports problems, list them in an 'Open issues' section instead of hiding them.

**Acceptance:**
- content matches the script's output
- regeneration command documented
- only the assigned files change
- `node scripts/release-scan.mjs` stays clean

### S06 Licence and rights audit (simple)
**Files:** `docs/submission/LICENSE_AUDIT.md`  
**Depends on:** none

Audit for the 'Open Weights Only' category and the repo licence requirement: repo licence (LICENSE, NOTICE), every model used and whether it is open weights, any partner nodes or closed APIs (OpenCode Go/LLM agent is an LLM, not an image model: state clearly how it is used and that it is model-agnostic), stock-asset policy (packages/sources README), what is exported in package.zip and CREDITS. End with a pass / needs-work table per category.

**Acceptance:**
- each row cites files
- no claims beyond the repo
- only the assigned files change
- `node scripts/release-scan.mjs` stays clean

### S07 Hackathon writeup (simple)
**Files:** `docs/submission/WRITEUP.md`  
**Depends on:** none

The submission writeup (600-900 words): what Comfyrizz is, who it is for, how it is built (Comfy SDK workflows, FLUX 3 Klein stills, LTX-2.5 plates, Remotion for exact text/charts, model-agnostic chat agent, Google Colab or your own ComfyUI), why it is innovative, which categories and bonuses it targets and why, what works today vs. post-hackathon (respect docs/PLAN.md SCOPE FREEZE), and how to run it. Facts only from the repo.

**Acceptance:**
- word count 600-900
- every capability claimed is present in the repo or marked [unverified]
- SCOPE FREEZE items listed as post-hackathon
- only the assigned files change
- `node scripts/release-scan.mjs` stays clean

### S08 Demo video script (simple)
**Files:** `docs/submission/DEMO_SCRIPT.md`  
**Depends on:** none

Two-minute demo script from docs/SPEC.md section 11: a shot list table (time, on screen, voiceover line, UI action, fallback if live step fails), recording checklist (resolution, fixture mode ?fixture=1 of the demo page per docs/specs/DEMO_WEBAPP.md, no secrets on screen, label sped-up footage), and the 'why it is innovative' explanation the Most Innovative category requires.

**Acceptance:**
- 7 beats map 1:1 to SPEC section 11 and total <= 2:00
- innovation explanation present
- secret-safety checklist present
- only the assigned files change
- `node scripts/release-scan.mjs` stays clean

### S09 Gallery manifest generator (simple)
**Files:** `scripts/gallery-manifest.mjs`, `scripts/gallery-manifest.test.mjs`  
**Depends on:** none

Script that scans examples/*/ (package.json title/description, timeline duration, out/*.mp4 or poster if present, README first paragraph) and writes docs/gallery/gallery.json [{id,title,description,durationSec,video,poster,readme,tags}] with repo-relative paths; missing media -> null (renders are gitignored). Export buildManifest(rootDir) for tests. --stdout prints instead of writing.

**Acceptance:**
- test on a temp fixture tree
- runs on the real repo listing every examples/* dir
- paths repo-relative
- only the assigned files change
- `node scripts/release-scan.mjs` stays clean

### S10 Static gallery page (simple)
**Files:** `docs/gallery/index.html`, `docs/gallery/gallery.css`, `docs/gallery/gallery.js`  
**Depends on:** S09

Static, dependency-free page (works on GitHub Pages, see docs/GITHUB_PAGES.md) that fetches gallery.json and renders cards: title, description, duration, video element when a video exists else a placeholder with 'render locally: <command>', link to the example README. Escape all text. Accessible (alt text, keyboard focus, prefers-reduced-motion stops autoplay).

**Acceptance:**
- opens from file:// with a clear message if fetch is blocked
- no external CDNs
- escaping
- only the assigned files change
- `node scripts/release-scan.mjs` stays clean

### S11 Committed gallery.json (simple)
**Files:** `docs/gallery/gallery.json`  
**Depends on:** S09

Run `node scripts/gallery-manifest.mjs` and commit the generated docs/gallery/gallery.json unchanged.

**Acceptance:**
- equals script output byte for byte
- only the assigned files change
- `node scripts/release-scan.mjs` stays clean

### S12 Submission checklist (simple)
**Files:** `docs/submission/CHECKLIST.md`  
**Depends on:** none

Checklist against the official rules (https://comfy.org/open-source-higgsfield/: open-source licence + setup instructions, demo video showing work in action and how it was built, innovation explanation for Most Innovative, open weights only, LTX core for the VFX bonus, FLUX 3 core for the FLUX bonus, deadline Oct 30 9am PT): each item with status, evidence file and owner (Kyle for the form submission and video upload).

**Acceptance:**
- every official requirement listed
- evidence links point to existing or planned docs/submission files
- only the assigned files change
- `node scripts/release-scan.mjs` stays clean

### S13 Contributor files (simple)
**Files:** `CONTRIBUTING.md`, `.github/pull_request_template.md`, `.github/ISSUE_TEMPLATE/bug_report.md`, `.github/ISSUE_TEMPLATE/feature_request.md`  
**Depends on:** none

CONTRIBUTING.md (setup from docs/RELEASE_CHECK.md commands, tests, release scan, licence/credits rules for new assets, no secrets), a PR template with the checks, and two issue templates with YAML front matter.

**Acceptance:**
- commands exist in package.json
- front matter valid
- only the assigned files change
- `node scripts/release-scan.mjs` stays clean

### S14 README overhaul (top section) (standard)
**Files:** `README.md`  
**Depends on:** S02, S05, S07, S08, S10, S12

Rewrite only the top of README.md (above the first existing '## ' section that documents packages in detail; keep everything below unchanged): one-line pitch, a 20-second hook (link the hook-20s example), Quick start (clean-clone commands), Demo (docs/submission/DEMO_SCRIPT.md, demo page), Gallery (docs/gallery/), How it is built, Hackathon submission links (WRITEUP, CHECKLIST, LICENSE_AUDIT, CREDITS, THIRD_PARTY_LICENSES, CI badge for .github/workflows/ci.yml), licence. Update the unchecked 'Committed pnpm-lock.yaml' item to checked (it is committed). Keep it concise.

**Acceptance:**
- diff touches only the top section plus the one checkbox
- all links resolve
- no claims beyond the repo
- only the assigned files change
- `node scripts/release-scan.mjs` stays clean

## 4. Definition of done
- All tasks are merged on `feat/submission`.
- `pnpm test:all` and the release scan are green.
- The CI workflow passes on GitHub after push.
- Kyle reviews the writeup, demo script and checklist before he submits the form.
- No merge to main and no tag without Kyle.
