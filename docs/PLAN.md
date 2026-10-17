# Comfyrizz: compressed parallel plan

*Companion to SPEC.md revision 4 (§10 now points here). Written Sat Oct 17, 2026, 12:30 am Toronto time (UTC-4) by DOLAN for Kyle Durepos. Replaces the one-person day-by-day table with parallel workstreams run by two Orbit agents (Pi and Hermes) plus Kyle.*

Deadline: **Thu Oct 30, 9:00 am PT = 12:00 pm Toronto**. Submit the evening of **Wed Oct 28** (one day earlier than the spec), with Oct 29–30 as buffer.

## Key dates (Toronto time)

| Milestone | Target | Exit check |
|---|---|---|
| M0 Kickoff | Sat Oct 17 | Repo `/home/box/comfyrizz` scaffolded; Pi and Hermes started on A1/A2 and B1/B2/B3 |
| **M1 CPU vertical slice** | **Sun Oct 18, evening** | `examples/launch-demo` (5 layouts) previews in Remotion Studio/Player and exports a valid MP4 on CPU with no LLM or GPU; package validates against `comfyrizz.package/v1`; timeline compiler unit tests green; `pipeline-py` passes against a fake Comfy v2 server; Google Colab lifecycle passes against a fake `colab` CLI |
| M2 Web shell + edit loop | Mon Oct 19 | Edit a headline and a chart value in `apps/web` → preview updates → MP4 (spec's old Day 2 check) |
| M3 GPU spike (Kyle-gated) | Mon Oct 19 – Tue Oct 20 | Needs Kyle: HF licence acceptance + read token + approved unit budget. Two `.api.json` workflows (Klein still, LTX 97-frame 960×544 plate); model size, VRAM and times recorded |
| M4 LLM agent | Tue Oct 20 | Agent builds and edits a package by tools on 2 providers (OpenRouter + custom) |
| **M5 Full slice, both backends** | **Thu Oct 22** | One chat prompt → storyboard → spend card → Google Colab run → collect → verified stop → MP4 with generated plates; same package through BYO ComfyUI URL |
| M6 Narration + rights | Fri Oct 23 – Sat Oct 24 | Narrated 45 s video, sentence captions + SRT/VTT; Openverse CC BY asset with attribution; blocked licence refused; `package.zip` rights filter |
| M7 Hardening + polish | Sun Oct 25 – Mon Oct 26 | Failure injection → VM verifiably stopped; budget refusal; per-scene re-run; ×2 upscale finals; 3 good examples |
| **M8 Feature freeze** | **Mon Oct 26, evening** | Clean-clone test: fresh clone opens and exports the bundled example |
| M9 Demo | Tue Oct 27 | Demo footage recorded (open-weights mode) |
| M10 Submit | **Wed Oct 28, evening** | ≤ 2 min video edited, v0.1.0 tagged, form sent (social post only with Kyle's go-ahead) |
| Buffer | Thu Oct 29 – Fri Oct 30 noon | Fixes only |

Rule kept from the spec: GPU work starts only after the CPU product exists, and every Google Colab runtime needs Kyle's explicit approval.

## Owners and directory ownership (no collisions)

| Owner | Owns (writes) | Reads only |
|---|---|---|
| **Pi** (`pipi`) | `apps/renderer/`, `packages/planner/` (timeline compiler), `examples/`, later `packages/tts/` | `packages/schema/` |
| **Hermes** | `packages/schema/`, `pipeline-py/`, `packages/backends/`, `packages/jobs/` (package → `jobs.json`), `colab/`, `workflows/`, `scripts/setup-local-comfy.sh` | `examples/` (as test fixtures) |
| Unassigned (next free agent) | `apps/web/`, `apps/server/`, `packages/llm/`, `packages/agent/`, `packages/sources/` | everything |
| DOLAN / Kyle | root files (`package.json`, `pnpm-workspace.yaml`, `LICENSE`, `NOTICE`, `README.md`, `docs/`) | — |

- Root-level changes (new workspace deps, root scripts): ask in a board check-in; DOLAN or Kyle applies them. Each package keeps its own `package.json`, tests and README.
- Deviation from spec §7: the package → `jobs.json` planner lives in `packages/jobs/` (Hermes) instead of `packages/planner/` (Pi's timeline), so the two agents never edit the same package.
- Contract between the two sides: `packages/schema/package-v1.schema.json` + generated `packages/schema/types.ts`. Until Hermes lands it (target: first 2–3 hours), Pi codes against the §6.3 example and switches to the generated types when they land.
- Commits: small, local, prefixed with the task id (`A1:`, `B2:` …). Never push. Never rewrite another agent's commits.

## Hard rules (in every task)
1. **Do not spend Google Colab units or start Google Colab runtimes.** No `colab new`, `exec`, `run`, `ssh` or `stop` against real sessions. There is no HF token yet; Kyle approves GPU runs separately. Test against a fake `colab` binary / fake Comfy v2 server only. Read-only `colab --help` / `colab version` is fine.
2. **Do not modify or restart live Orbit**, and do not edit anything in `/home/box/orbitdesktop`. Copy code out (and add the MIT relicence header + NOTICE line).
3. **Work only inside `/home/box/comfyrizz`.** Commit locally; don't push; don't create GitHub repos.
4. Write "Google Colab", never bare "Colab", in prose, UI copy and docs (identifiers like `colab/`, `colab-plan` are fine).
5. Never print or commit secrets (ORBIT_TOKEN, app keys, Google Colab tokens, HF or LLM keys). No secrets via `colab exec --env`.
6. No cloud agents or extra workers.

## Workstream A: renderer and timeline (Pi). Due M1 (Sun Oct 18)

**A1. Remotion renderer + 5 layouts** (`apps/renderer/`; spec §6.3, §6.9)
- Remotion project (pin the version; decide `<OffthreadVideo>` vs `@remotion/media` `<Video>` for loops and record it in `apps/renderer/README.md`). Compositions driven by `timeline.json` + `package.json`.
- Layouts `Title` (centered, outro), `Hero` (full-bleed, split), `Stat`, `Chart` (bar, zero baseline, SVG + d3-scale), `List` (bullets, quote). Procedural backgrounds when no plate exists; Ken Burns on stills; `@remotion/transitions` fades.
- Deterministic: frame = f(timeline, local assets, frame number). No CSS time animation, no network. Local pinned fonts (Inter, OFL), awaited before measuring. Copy that doesn't fit is a visible fail state, never silent clipping.
- Accept: each layout renders a still for frame 0/mid/last via `npx remotion still`; a lint/test confirms no network imports in compositions.
- Remotion vs Motion Canvas decision recorded by Sun Oct 18 (spec §6.9: default Remotion).

**A2. Timeline compiler** (`packages/planner/`; spec §6.8)
- Pure TS: package (+ optional narration chunk durations) → `timeline.json` (hashed). Integer frames at 30 fps; scene length = max(preferredFrames, narration frames + padding) within layout limits; transitions overlap; `target` and `flexible` (≤ 2700 frames) modes; provisional flag when narration is missing; plate trim/loop/retime records (24 → 30 fps); sentence-level caption cues.
- Accept: unit tests (node:test or vitest) incl. **six 150-frame scenes with five 15-frame fades = 825 frames**; transition longer than a neighbour fails; target-mode deviation is reported; deterministic hash for identical input.

**A3. Bundled CPU example + export** (`examples/launch-demo/`; spec §3 step 1, §6.9)
- Hand-written `package.json` (schema v1, ~6 scenes covering all 5 layouts, 30–45 s, one dataset, procedural backgrounds, voice disabled), compiled `timeline.json`, `pnpm render:example` script.
- Accept: `npx remotion render` exports 1920×1080 30 fps H.264 MP4; ffprobe check of frame count = compiled timeline, dimensions, duration; no LLM, no GPU, no network; package passes Hermes's validator once B1 lands. Render time on the box recorded in README.

**A4 (after M1). Kokoro TTS on CPU + captions** (`packages/tts/`; §6.8, §6.9): `kokoro-onnx` pinned, per-sentence synthesis, measured durations → cues, SRT/VTT, ffmpeg `loudnorm` mix. Accept: narrated example whose frame count matches the compiled timeline.

## Workstream B: schema, pipeline, backends (Hermes). Due M1 (Sun Oct 18)

**B1. Package schema `comfyrizz.package/v1` + validation** (`packages/schema/`; spec §6.3). **Do first; Pi depends on it.**
- `package-v1.schema.json` (JSON Schema 2020-12), generated TS types, a TS validator (ajv) and a Python validator (`jsonschema`) for `pipeline-py`.
- Semantic checks: unique ids, resolvable refs (assets, datasets, scenes), finite bounded numbers, relative paths only (no absolute/traversal), layout/variant enum, `model_license` separate from output `license`/`redistributable`.
- Accept: valid/invalid fixtures with tests in both languages; spec §6.3 example validates (with placeholders filled); a check-in on the board telling Pi the types are ready.

**B2. `pipeline-py` runner** (`pipeline-py/`; spec §6.4)
- `comfy-sdk` runner: reads `jobs.json`, submits API-format workflows to `COMFY_BASE_URL`, JSON-lines progress (`{"v":1,"attempt":…,"job":…,"seq":…,"event":…}`), atomic `attempts/<id>.json` written *before* submit and updated with `job_id` immediately, states incl. `submission_unknown` (never auto-resubmitted), atomic `out/manifest.json` (tmp + rename) that alone decides success, reconcile mode (poll known job ids), hash cache key, `health.py`.
- `packages/jobs/` (TS): package → ordered, hashed `jobs.json` (still → plate → upscale), LTX dims multiple of 32, frames 8n+1.
- Accept: pytest against a **local fake Comfy v2 server** (no GPU, no network): success path writes manifest; killed-mid-run leaves attempt records and reconcile polls instead of resubmitting; `submission_unknown` is surfaced, not retried; jobs planner unit tests (8n+1, ×32).

**B3. Backends: Google Colab lifecycle + BYO ComfyUI URL** (`packages/backends/`, `colab/`; spec §6.5, §6.6, §6.7)
- Copy (don't edit) `/home/box/orbitdesktop/server/colab-plan.mjs` helpers (`parseUsage`, `parseSessions`, `parseStatus`, `parseLs`, `parseNvidiaSmi`, `catalogFromHelp`, `redactSecrets`, `blockedLocalPath`, argv planning) and the detached worker / job-log pattern from `colab-orchestrator.mjs` / `colab-job-worker.mjs`; add the MIT relicence header.
- `Backend` interface (§6.5). Google Colab: argv arrays, no shell; preflight; **no secrets via `--env`** (HF token as a 0600 file via `colab upload`); manifest decides success; attempt-record download + reconcile; teardown verified via `colab sessions` → `stopped`, else retry + **`stop_unconfirmed`**; reserve formula `spent + committed + next_upper + collect_and_stop_reserve ≤ budget` checked before each job, warn at 80%; wall-clock cap; orphan reaper offers, never auto-deletes; spend labelled "estimate".
- BYO: start `comfy-api-proxy --comfyui <url> --port <free>` locally, health (`/object_info` node types, models, smoke job), cancel only our own job.
- `colab/bootstrap.py`, `health.py` drafted from `/workspace/comfy-hackathon/test/s2–s7*.py` (not executed on Google Colab).
- Accept: tests with a **fake `colab` executable** on PATH covering: happy path; lost exec → reconcile; stop not confirmed → `stop_unconfirmed`; budget reserve refuses the next job; a test asserting no `--env` argv ever carries a token; redaction test. Zero real Google Colab calls.

## Generated-first assets (Kyle's direction, Oct 17)

Asset priority, decided per asset by an **asset-type router** in the agent:
1. **Procedural vector (default for icons, diagrams, simple charts, pattern backgrounds, animated vector parts)**: the agent LLM writes SVG (or a small Lottie-style JSON / animated SVG described as keyframes) as code. Free (CPU, no GPU), licence-clean: recorded as `origin: "generated"`, `gen.generator: "llm-svg"`, output licence CC0 (our generated output; repo code MIT). Pipeline: **sanitize → render-check on CPU (resvg) → auto-fix loop (max 2 repairs, errors fed back to the LLM) → rasterise or pass through to Remotion**.
2. **FLUX 3 Klein images (illustrative / photo-like art, textures, backgrounds, hero stills)**: the agent plans and **batches** all image jobs per package (one GPU session, stills before plates). Transparent-PNG cutouts where feasible (background-removal node in the ComfyUI graph or prompt-for-plain-background + alpha matting; **[unverified]** which node; GPU spike M3 decides). Recorded as `origin: "generated"`, `gen.generator: "flux3-klein"`, with `model_license`.
3. **LTX-2.5 plates** for moving backgrounds (unchanged).
4. **Openverse search / user upload**: fallback only, with licence approval cards (unchanged).

Agent tool table addition (spec §6.2): `assets.route(scene_id, need)` → one of `generate_svg`, `generate_image`, `search_openverse`, `upload`; `assets.generate_svg(scene_id, kind, intent, palette)` (no approval card; free); `assets.generate_image` = the existing `assets.generate` for FLUX (batched, spend card on Google Colab).

**A5. Procedural SVG assets: generator contract + sanitizer + render-check** (Pi, part of M1; `packages/vector/`; feeds the renderer)
- `sanitizeSvg(src)`: allow-list elements/attributes (shapes, paths, text, gradients, patterns, `<animate>`/`<animateTransform>` only if the renderer honours them deterministically); strip `<script>`, `<foreignObject>`, event handlers, external `href`s, `@import`, external fonts/images, `data:` except small images; enforce `viewBox`, size and node-count limits.
- `renderCheck(svg)`: rasterise with `@resvg/resvg-js` (CPU) at target size; fail on parse error, empty/blank output, out-of-palette or near-invisible content; return structured errors.
- `autoFix(generate, intent, maxRepairs=2)`: loop that feeds sanitizer/render errors back to a supplied generator function (the LLM later; a stub now). Deterministic animated vector parts are driven by the Remotion frame, not SMIL clocks.
- Remotion `VectorAsset` component (icons, diagrams, pattern backgrounds) used by the layouts.
- Accept: unit tests (malicious SVG fixtures stripped; broken SVG fails render-check with a usable message; auto-fix loop with a stub generator repairs within 2 tries); **the bundled `examples/launch-demo` uses at least 4 LLM-style SVG assets (icon set, a diagram, a pattern background, one animated part)** stored as files with provenance `origin: generated, generator: llm-svg`, and still exports on CPU.

Schema impact (B1, Hermes): asset `kind` adds `svg` (and `vector-anim` for keyframed parts); `gen.generator` enum (`llm-svg`, `flux3-klein`, `ltx25`, `kokoro`); `gen.sanitizer_version`, `gen.render_check` result; generated outputs default `license.id: "CC0-1.0"`, `redistributable: true`.

Jobs impact (B2, Hermes): `packages/jobs/` batches every FLUX still in a package into one ordered batch before plates; optional `cutout: true` per image job producing an alpha PNG (workflow TBD in M3).

## Workstream E (experimental): SVG-guided generation

Goal: precise composition (from agent-written SVG) with model-quality pixels. The agent writes SVG for a scene's layout role (hero subject, background, texture), it is rasterised on CPU, turned into guidance inputs, and fed to FLUX 3 Klein (stills) and LTX-2.5 (motion). Spec §6.11.

Approaches to spec and test (each is a separate ComfyUI API workflow + `params.json`):
1. **img2img / denoise sweep**: rasterised SVG (optionally blurred/noised) as the init latent; denoise 0.35 → 0.85 in steps.
2. **Klein reference / edit conditioning**: the rasterised SVG as one of Klein's reference images (model card: up to 10 references, bounding boxes in the prompt **[verified, model card]**). Exact ComfyUI node path **[unverified]**: check in M3.
3. **ControlNet-style (canny / depth / lineart from the SVG)**: **only if compatible ControlNet or control-LoRA weights for FLUX 3 Klein exist** with a licence we can use. Not assumed; E1 records what exists (with source links) or marks it "none found". No substituting another model's ControlNet silently.
4. **LTX-2.5 i2v from the SVG-guided still** as first frame (optionally SVG-derived last frame for motion targets).

Prompt-template library (`workflows/templates/`): per layout role (hero subject, background plate, texture, icon-illustration) × style × lighting × material, with text-safe regions and the palette injected; versioned and stored with each generated asset (`gen.template_id`, `gen.template_version`).

Evaluation rubric (`pipeline-py/eval/`): **layout fidelity** (edge-map IoU / chamfer distance between SVG edges and output edges; mask IoU for subject regions; palette ΔE) vs **aesthetic/prompt quality** (CLIP score against the caption; optional aesthetic predictor, licence checked), plus a human 1–5 rating sheet. Output: a CSV + contact sheet per sweep so Kyle can pick defaults.

**E1. CPU prep (Hermes, after B1; no GPU)** (`workflows/svg-guided/`, `pipeline-py/svgguide/`, `pipeline-py/eval/`)
- SVG → raster (resvg, via Pi's `packages/vector` sanitizer when available, or the same allow-list in Python) → control maps on CPU (canny/lineart with OpenCV, a flat "depth" from SVG layer order/z, region masks from SVG ids).
- ComfyUI API workflow JSON drafts for approaches 1, 2 and 4 (and 3 only if weights exist) with `params.json`, validated structurally (node graph well-formed, inputs wired) without a GPU; a sweep spec `sweeps/e2.json` (seeds, denoise grid, reference weights, templates) with a unit estimate using the reserve formula.
- Prompt-template library v0 + renderer of templates → full Klein captions (same expansion rules as §6.4; LLM expansion stubbed).
- Evaluation scripts runnable on CPU against fixture images (edge IoU, palette ΔE; CLIP score optional/CPU-slow is fine).
- Research note `workflows/svg-guided/README.md`: what Klein's model card says about references/editing, whether any Klein ControlNet exists (links), LTX first/last-frame conditioning support, all marked [verified]/[unverified].
- Accept: `pytest` green on CPU; 3 sample scenes (hero, background, texture) each produce raster + control maps + filled workflow JSON + caption; sweep spec with a unit estimate; no Google Colab calls.

**E2. GPU sweep (Kyle-gated; waits for HF token + explicit approval of session and unit budget)**: run `sweeps/e2.json` on one approved Google Colab G4 session inside the M3 spike if possible (same bootstrap, watchdog armed), collect outputs + metrics, contact sheets, pick defaults per layout role, and write results into the spec. Not started by any agent until Kyle approves on record.

Cut order: E is experimental and is cut before any core feature; if it wins, the router (C3) uses SVG-guided FLUX for hero/background roles.

## Workstream C: frontend, server and agent (unassigned; next free agent, queued)

**C1. Web shell port** (`apps/web/`): lift from `/home/box/orbitdesktop/apps/grokbots/index.html` (copy, don't edit): chat layout/CSS, `md()`/`esc()`, composer, cards, Activity panel, context meter; React island with the Remotion Player; storyboard card with inline edits (headline, chart values, palette). Accept: M2 check.
**C2. Local server** (`apps/server/`): 127.0.0.1, token in fragment, Host/Origin checks, `/api/package/:id` with base revision, `/api/render`, `/api/events` SSE.
**C3. LLM layer + agent tools** (`packages/llm/`, `packages/agent/`): AI SDK wrapper, 3 presets (OpenCode Go headers), probe, zod tools + repair loop, **asset-type router**, `generate_svg` via A5's `autoFix`, FLUX caption expansion. Accept: M4 check; agent picks SVG for an icon/diagram and FLUX for an illustration in a test brief.
**C4. Openverse + uploads + licence policy + CREDITS + `package.zip` filter** (`packages/sources/`): M6.

## Workstream D: Kyle-gated

- D1 (Kyle, today if possible): accept FLUX 3 Image Klein and LTX-2.5 licences on Hugging Face; create a read token; say where it lives (0600 file); set a per-session unit budget.
- D2 GPU spike (M3): only after Kyle approves a specific session and budget. Hermes runs `colab/bootstrap.py` with the watchdog armed, builds the Klein t2i (+ cutout) and LTX i2v workflows, records sizes/VRAM/times, pins `colab/models.lock.json`.
- D3 Decisions: demo LLM (§9 Q1), strict open-weights path (Q2), Build Night (Q5), Comfy Discord questions (Q6).

## Later (both agents, by milestone)
- M5 (Thu Oct 22): integrate C + B + A; full slice on both backends (BYO tested against the dev live link only with Kyle's approval).
- M6–M7: A4 narration; C4 rights; Google Colab hardening (failure injection, orphan reaper); per-scene re-run; ×2 upscale finals; 3 examples (mostly SVG + FLUX).
- M8–M10: README, setup scripts, clean-clone test, demo, submission.

Cut order if behind (unchanged from spec): live-link opt-in → seamless loop → ×2 upscale → third example → BYO v2-endpoint mode → OpenCode Go preset; then cutouts and animated vector parts before any editability or honesty feature.

## Orbit board (group "Comfyrizz build", `dba10adc-e6a5-42ff-b174-9d21d3cc5691`)
The original group board (THE INSANE ASSYLYM) is at Orbit's 100-entry cap, so a dedicated board-only group "Comfyrizz build" (members: Hermes, pipi) holds the Comfyrizz tasks. CLI: `~/bin/collab-board dba10adc-e6a5-42ff-b174-9d21d3cc5691 list`.

| Task | Owner | Board id |
|---|---|---|
| A1+A3 Remotion renderer, 5 layouts, CPU example + export | pipi | `t_f21519e48db54eef` |
| A2 Timeline compiler + tests | pipi | `t_cee6f8f11cd8483f` |
| A5 Procedural SVG: sanitizer, resvg render-check, auto-fix | pipi | `t_157a386a4ae646d9` |
| B1 Schema `comfyrizz.package/v1` + validation | hermes | `t_7f17d1e7ca4c41bd` |
| B2 `pipeline-py` runner + `packages/jobs` | hermes | `t_eb6ef8f70ed24632` |
| B3 Backends: Google Colab lifecycle + BYO ComfyUI | hermes | `t_395e787180e447f1` |
| C1–C3 Web shell + server + LLM agent/router (queued) | unassigned | `t_d1dfd1f883de4f03` |
| D Kyle-gated: HF licences/token, GPU spike approval | kyle | `t_dddec6e24e254b75` |
| E1 SVG-guided generation: CPU prep (experimental) | hermes | `t_5f7f30a026174551` |
| E2 SVG-guided GPU sweep (Kyle-gated) | kyle | `t_28128f96b4974069` |
