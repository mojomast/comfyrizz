# Licence and rights audit — S06

Audit date: 2026-10-20. Scope: the "Open Weights Only" category and the
hackathon's repo-licence requirement. This is a documentation audit of the
repository only: no network calls, no model cards re-read, and no claim about
anything outside the files cited. `[unverified]` means the repository itself
marks the fact as unchecked.

Rule used for "Open Weights Only": the submission spec says it requires
**no partner nodes and no closed APIs** (`docs/specs/SUBMISSION.md:10`). The
repo's own interpretation of the model side is in `docs/SPEC.md:434-437`.

## Verdict at a glance

| Area | Verdict | Why |
| --- | --- | --- |
| Repository licence | **Pass** | MIT `LICENSE`, `NOTICE`, MIT package metadata, setup instructions. |
| Image / video / TTS weights | **Pass with caveats** | All are separate downloads of open weights; gated community licences and some TTS/encoder terms are `[unverified]`. |
| Agent LLM | **Needs work** | Model-agnostic LLM, but the shipped presets include hosted closed APIs; strict-mode demo evidence is not in the repo. |
| Partner nodes / closed APIs | **Needs work** | Workflows use core ComfyUI nodes only; the optional hosted LLM presets are closed APIs. |
| Stock-asset policy | **Pass** | CC0 / PDM / approved CC BY / MIT only; NC, ND, SA, unknown refused. |
| `package.zip` rights filter | **Pass** | Code gates on licence, approval, sha256 and `redistributable`; excluded assets are listed and the zip is marked incomplete. |
| `CREDITS` | **Needs work** | Export generates `CREDITS.md`, and an example has one, but the root `CREDITS.md` and `THIRD_PARTY_LICENSES.md` are not yet in the repo. |
| Metadata consistency | **Needs work** | `examples/data-story` names FLUX.1-schnell / LTX-Video and Apache-2.0, which contradicts the models the same package says it uses. |

## 1. Repository licence and setup

| Requirement | Evidence | Status |
| --- | --- | --- |
| OSI-approved repo licence | `LICENSE:1-21` (MIT, Copyright 2026 Kyle Durepos); `README.md:369`; `docs/SPEC.md:423` | Pass |
| Third-party / provenance notice | `NOTICE:1-59`, including Orbit-derived portions relicensed MIT by the owner (`NOTICE:4-7`) | Pass |
| Package metadata | Root `package.json` has `"license": "MIT"`; every `packages/*/package.json` and `apps/renderer/package.json` / `apps/server/package.json` read in this audit declares MIT. `apps/web/package.json` has no `license` field, but the root licence and `LICENSE` still cover the repo. | Pass, minor metadata gap |
| Setup instructions | `README.md:179-219` (requirements, CPU quickstart, narration setup); `docs/RELEASE_CHECK.md:5-20` (clean-clone, install, test, CPU export) | Pass |
| Non-OSI renderer dependency disclosed | `NOTICE:13-15` and `README.md:374`: Remotion is source-available under the Remotion License, not OSI; free for individuals and organisations up to 3 people, larger companies need a Company License. `apps/renderer/package.json:7` still declares the package MIT. | Pass with disclosure |
| Consolidated third-party licence file | `THIRD_PARTY_LICENSES.md` does not exist at audit time. It is an open submission task (`docs/specs/SUBMISSION.md:35`, `docs/specs/SUBMISSION.md:85-89`). | Needs work |

The repo licence therefore satisfies "open-source licence and setup
instructions". The Remotion note matters for downstream redistribution, not for
the MIT licence of Comfyrizz's own code.

## 2. Models used

Models are **not distributed in this repository**. `NOTICE:44-46` says FLUX 3
Image Klein, LTX-2.5 and Kokoro-82M are downloaded by each user under their own
licences. The Colab download pins are in `colab/models.lock.json:10-26` and
`colab/models.lock.json:28-82`; both model hosts are marked `gated: auto`
(`colab/models.lock.json:15`, `colab/models.lock.json:23`).

| Model | Used for | Open weights? | Licence basis in repo | Status |
| --- | --- | --- | --- | --- |
| **FLUX 3 Image Klein** (5.6B transformer) | Stills, reference edits, sketch-to-render (`README.md:380`; `workflows/flux3_klein_t2i.api.json`, `flux3_klein_img2img.api.json`, `flux3_klein_ref_edit.api.json`) | Yes — weights are a separate gated download; not vendored (`NOTICE:44-46`) | FLUX Kommunity License v1.0 (`NOTICE:44-46`; `README.md:380`; `docs/SPEC.md:429`; pin: `colab/models.lock.json:11-17`) | Pass; not OSI, commercial-output conditions apply |
| **Qwen3-VL-4B-Instruct** | FLUX 3 Klein text encoder (`docs/SPEC.md:275`; `docs/SPEC.md:429`; merged pin `colab/models.lock.json:84-95`) | Yes | Apache-2.0 per `docs/SPEC.md:275` and `docs/SPEC.md:429` | Pass |
| **LTX-2.5** (22B distilled transformer) | Text/image-to-video plates and ×2 upscale (`README.md:381`; `workflows/ltx25_t2v_2stage.api.json`, `ltx25_i2v_2stage.api.json`, `ltx25_a2v_2stage.api.json`) | Yes — separate gated download; not vendored (`NOTICE:44-46`) | LTX-2.x Community License (`NOTICE:44-46`; `README.md:381`; `docs/SPEC.md:430`; pin: `colab/models.lock.json:19-25`) | Pass; revenue threshold and terms apply |
| **Gemma 4 12B** | LTX-2.5 text encoder (`docs/SPEC.md:278`; pin `colab/models.lock.json:59-64`) | Yes — part of the gated LTX pack | `docs/SPEC.md:430` records "possible Gemma terms on the encoder [unverified]". `NOTICE` does not name Gemma separately. | **Needs work**: document the encoder terms or mark them `[unverified]` in the consolidated licence file |
| **Kokoro-82M** | Default CPU narration (`packages/tts/README.md:42-63`; `examples/hook-20s/CREDITS.md:27-31`) | Yes — ONNX weights fetched to a local cache, not committed (`packages/tts/README.md:42-54`) | Apache-2.0 in `packages/tts/README.md:60-63` and `examples/hook-20s/CREDITS.md:29-31`; marked `[unverified]` in `docs/SPEC.md:431` and `NOTICE:16-17` | Pass with `[unverified]` caveat |
| **Qwen3-TTS 1.7B** (Base / VoiceDesign / CustomVoice) | Optional narration (`packages/tts/README.md:69-95`; `docs/VOICE_GENERATION.md:7-14`) | Yes — optional downloads, not in the default install (`NOTICE:48-54`) | `colab/qwen-models.lock.json:6-11` says public Apache-2.0; `NOTICE:53-54` marks Apache-2.0 `[unverified]` | Pass with conflicting provenance; needs one authoritative statement |
| **Qwen3-ForcedAligner-0.6B** | Optional word/forced alignment (`packages/tts/README.md:88-95`; `packages/tts/py/qwen.py:29`) | Yes | Apache-2.0 per `colab/qwen-models.lock.json:6-12`; `NOTICE:55` marks it `[unverified]` | Pass with `[unverified]` caveat |
| **Qwen3-ASR-0.6B** | Optional narration QA / WER (`packages/tts/README.md:97-100`; `packages/tts/py/qwen.py:30`) | Yes | Apache-2.0 per `colab/qwen-models.lock.json:6-12`; `NOTICE:56-57` marks it `[unverified]` | Pass with `[unverified]` caveat |
| **VoxCPM2 (2B)** | Documented alternative only; no code in this repo | Not used | `NOTICE:58-59` (Apache-2.0 `[unverified]`, documented alternative only) | Not applicable |
| **Falconsai/nsfw_image_detection** | Candidate classifier mentioned in the spec, not implemented in a repo code path found by this audit | n/a | `docs/SPEC.md:221` says licence `[unverified]` | Not used |
| **Agent LLM** (OpenCode Go / OpenRouter / custom) | Chat, copy, storyboard/tool calls and FLUX caption expansion; **not** an image, video or TTS model | Depends on the chosen provider | `packages/llm/src/presets.ts:3-26`; `packages/llm/README.md:7-13`; `docs/SPEC.md:432-437` | **Needs work** — see §3 |

No model weights, ONNX files, `.safetensors` files or downloaded voice packs are
tracked in the repository. Tracked media is limited to example narration and
test fixtures under `scripts/gpu6/fixtures/`, plus documentation screenshots and
example stills under `docs/media/` and `docs/ui/`. The zip writer also states
that it writes no model weights (`packages/sources/src/package-zip.ts:112-117`,
`packages/sources/src/package-zip.ts:218`).

## 3. The agent LLM, stated explicitly

The agent model is an **LLM**, not an image model. It is model-agnostic and is
used for text/tool work:

- chat and brief interpretation, copy and storyboard proposal/edit;
- tool calls that plan assets and write SVG;
- FLUX prompt expansion (caption writing), which is still text generation
  (`docs/SPEC.md:276`).

It does **not** generate pixels, video or speech. Pixels and video come from
ComfyUI workflows using FLUX 3 Klein and LTX-2.5; narration comes from Kokoro or
the optional Qwen3-TTS models (§2).

Model-agnostic evidence:

- The adapter is a generic OpenAI-compatible chat-completions client
  (`packages/llm/src/openai-compatible.ts`; `packages/llm/README.md:3-5`).
- The three presets are OpenRouter, a configurable custom endpoint (default
  `http://127.0.0.1:8000/v1`, i.e. local vLLM/Ollama or a compatible proxy), and
  OpenCode Go (`packages/llm/src/presets.ts:4-26`; `packages/llm/README.md:9-13`).
- `docs/SPEC.md:436` states that the agent is model-agnostic and that the export
  badge follows the actual lineage recorded in the run.

Open-weights caveat:

- OpenRouter and OpenCode Go are **hosted APIs**, even when the model they serve
  has open weights. `docs/SPEC.md:437` calls a hosted API serving open weights a
  judgment call and says the strict reading is the `custom` preset on vLLM or
  Ollama.
- The committed examples record `llm.provider: "local-agent"` and
  `closed_apis_used: []` (for example `examples/brand-kit/package.json`,
  `examples/showcase-gpu3/package.json`), but the repository does not record
  which provider the live demo session will use. This audit cannot verify the
  demo's agent provider from the repo alone: **[unverified]**.

For a strict "Open Weights Only" claim, the demo must use the `custom` preset
with a local open-weights LLM (or otherwise record that the hosted LLM is
accepted by the organisers). As shipped, the presets alone do not prove that.

## 4. Partner nodes and closed APIs

| Item | Evidence | Status |
| --- | --- | --- |
| ComfyUI partner nodes | None in the workflow graphs. The API workflows use core ComfyUI classes only: `UNETLoader`, `CLIPLoader`, `VAELoader`, `CLIPTextEncode`, `KSampler`, `VAEDecode`, `SaveImage`/`SaveVideo`, LTX and Flux core nodes (`workflows/flux3_klein_t2i.api.json`, `workflows/flux3_klein_img2img.api.json`, `workflows/flux3_klein_ref_edit.api.json`, `workflows/ltx25_t2v_2stage.api.json`, `workflows/ltx25_i2v_2stage.api.json`, `workflows/ltx25_a2v_2stage.api.json`). `colab/bootstrap.py:263` clones upstream ComfyUI and installs no partner-node pack. | Pass |
| Comfy Router | Not implemented; listed as post-hackathon in `README.md:364` and as closed/partner in `docs/SPEC.md:499`. | Pass (not used) |
| Comfy Cloud | Not implemented; deferred in `README.md:363` and `docs/SPEC.md:498`. The two shipped backends are Google Colab and BYO ComfyUI (`README.md:137-138`). | Pass (not used) |
| fal / Replicate hosted endpoints | Not implemented; listed as closed "hosted model" adapters in `docs/SPEC.md:500`. | Pass (not used) |
| Google Colab as a backend | Runs our own workflows on a G4 VM; it is compute, not a model API. The repo treats it as user-owned compute (`docs/SPEC.md:439-440`; `colab/bootstrap.py`). | Pass |
| BYO ComfyUI | User's own ComfyUI plus `comfy-api-proxy`; no model service is resold or proxied by the repo (`packages/backends/README.md:1-10`; `packages/backends/src/byo-backend.mjs:1-15`). | Pass |
| Hosted agent LLM | OpenRouter and OpenCode Go presets are closed APIs (`packages/llm/src/presets.ts:5-25`). Strict mode needs the local `custom` preset (`docs/SPEC.md:437`). | **Needs work/conditional** |

The image, video and TTS path is clean: core nodes, our own workflows, open
weights. The only open "Open Weights Only" question is the agent LLM provider.

## 5. Stock-asset policy

Policy source: `packages/sources/README.md:6-29`.

| Licence / origin | Search | May ship in `package.zip` | Evidence |
| --- | --- | --- | --- |
| CC0-1.0, PDM-1.0 | Yes | Yes | `packages/sources/README.md:10`; `packages/sources/src/licenses.ts:83-85` |
| CC-BY-* | Yes | Only after user approval **and** stored attribution | `packages/sources/README.md:11`; `packages/sources/src/licenses.ts:86-99` |
| MIT | Not an Openverse filter | Only when policy allows MIT, attribution is stored, and the full notice is bundled | `packages/sources/README.md:12`, `packages/sources/README.md:24-27`; `packages/sources/src/licenses.ts:65-75` |
| CC-BY-SA-* | No | No — share-alike obligations are not implemented | `packages/sources/README.md:13`; `packages/sources/src/licenses.ts:100` |
| CC-BY-NC-* / CC-BY-ND-* | No | No | `packages/sources/README.md:14`; `packages/sources/src/licenses.ts:101-102` |
| Unknown / all rights reserved | No | No | `packages/sources/README.md:15`; `packages/sources/src/licenses.ts:103` |
| Generated output | n/a | Yes; defaults to CC0-1.0 | `packages/sources/README.md:16`; `packages/sources/src/licenses.ts:76-78` |
| User upload | n/a | Only when the user marks it shareable | `packages/sources/README.md:17`; `packages/sources/src/licenses.ts:79-82` |

Additional controls:

- Openverse is only a search index; the source page, licence version and creator
  are stored (`docs/SPEC.md:443`; `packages/sources/README.md:31-38`).
- Blocked candidates are not silently dropped; they keep a blocked reason
  (`packages/sources/README.md:35-38`).
- Pexels originals can never enter `package.zip` because that licence bans
  standalone redistribution; Pexels is deferred (`docs/SPEC.md:169`,
  `docs/SPEC.md:389`, `docs/SPEC.md:496`).
- CC BY-SA is filtered out in v0.1 (`docs/SPEC.md:389`).
- User uploads carry a rights assertion that cannot override a third-party
  licence (`docs/SPEC.md:443`; `packages/sources/README.md:48-54`).

Committed example stock: `examples/licensing-demo/package.json:31-52` is an
approved CC BY 4.0 fixture and `examples/licensing-demo/package.json:54-75` is a
refused CC BY-NC 4.0 fixture. Its README says the bytes are synthetic and no
network call is made (`examples/licensing-demo/README.md:1-12`). The stock
images are therefore not shipped in the repo or the archive. Other examples use
generated SVG, generated media, or user-supplied/private assets.

Two other committed media groups are not stock search results:

- `docs/media/` and `docs/ui/` hold first-party screenshots and example stills,
  covered by the repo's MIT licence statement (`docs/SPEC.md:423`). They carry no
  per-file licence metadata.
- `scripts/gpu6/fixtures/a_portrait.png`, `music.wav` and `s1.wav` are harness
  fixtures. The harness records the portrait as CC0 and "drawn for the harness;
  not a real person" (`scripts/gpu6/g6_package.mjs:148-157`).

## 6. What `package.zip` exports

Built by `buildPackageZip` (`packages/sources/src/package-zip.ts:112-235`) and
called by the server export (`apps/server/src/export.mjs:227-239`).

| Entry | When | Evidence |
| --- | --- | --- |
| `package.json` | Always; asset `file` paths are rewritten to archived paths | `packages/sources/src/package-zip.ts:127-130`, `:174-176`, `:193` |
| `timeline.json` | When a timeline is supplied | `packages/sources/src/package-zip.ts:131` |
| `workflows/<name>` | When workflow data is supplied | `packages/sources/src/package-zip.ts:132-134` |
| Captured API-format workflows (`*.workflow.api.json`, `*.workflow.md`) | When captured graphs exist; secret-shaped strings are redacted | `packages/sources/src/package-zip.ts:135-145` |
| `OPEN-IN-COMFYUI.md` | When captured workflows are included | `packages/sources/src/package-zip.ts:146-148` |
| Asset bytes and variants | Only if `isAssetRedistributable()` passes **and** the supplied bytes match the recorded sha256 | `packages/sources/src/package-zip.ts:150-191`; gate in `packages/sources/src/licenses.ts:115-126` |
| `licenses/MIT.txt` | When included assets are MIT | `packages/sources/src/package-zip.ts:178-180`, `:194-196` |
| `credits.json` | Always; generated from `buildCredits` | `packages/sources/src/package-zip.ts:205-206` |
| `CREDITS.md` | Always; includes an MIT notice section when relevant | `packages/sources/src/package-zip.ts:207-208` |
| `manifest.json` | Always; `complete`, `included`, `excluded`, reasons, and no-secret note | `packages/sources/src/package-zip.ts:209-227` |
| `INCOMPLETE.md` | When any asset is excluded | `packages/sources/src/package-zip.ts:228-233` |
| Extras (social pack, narration sidecars, composition cache) | Only caller-cleared extras; social pixels derived from a blocked scene asset are refused | `packages/sources/src/package-zip.ts:198-203`; `apps/server/src/export.mjs:209-226` |

Explicit exclusions and guarantees:

- Non-redistributable assets are listed by source URL and sha256, not shipped
  (`packages/sources/src/package-zip.ts:150-162`; `packages/sources/src/credits.ts:58-62`).
- A hash mismatch refuses the asset (`packages/sources/src/package-zip.ts:169-172`).
- No keys, signed URLs or model weights are written
  (`packages/sources/src/package-zip.ts:112-117`, `:218`).
- The archive is deterministic store-only zip with a fixed timestamp
  (`packages/sources/README.md:75-77`).

The top-level export bundle additionally contains `video.mp4`, `captions.srt`,
`captions.vtt`, optional `captions.words.vtt`, `CREDITS.md` and `package.zip`
(`apps/server/src/export.mjs:247-253`; `apps/server/README.md:61`,
`apps/server/README.md:143-144`).

## 7. CREDITS

| Item | Evidence | Status |
| --- | --- | --- |
| Per-export credits | `buildCredits` writes `credits.json` + `CREDITS.md`, includes licence, creator, source, attribution, whether the asset ships, an end-card flag for CC BY, and a "fetch it yourself" section for excluded assets (`packages/sources/src/credits.ts:15-64`). The server also writes a top-level `CREDITS.md` next to the MP4 (`apps/server/src/export.mjs:241-245`). | Pass |
| Example credits | `examples/hook-20s/CREDITS.md:1-48` documents the hook's SVG/vector assets (CC0), Kokoro narration (Apache-2.0), captions, invented data and the MIT package licence. | Pass |
| Root `CREDITS.md` | Not present at audit time; planned as S05 (`docs/specs/SUBMISSION.md:36`, `docs/specs/SUBMISSION.md:98-102`). | Needs work |
| Root `THIRD_PARTY_LICENSES.md` | Not present at audit time; planned as S04 (`docs/specs/SUBMISSION.md:35`, `docs/specs/SUBMISSION.md:85-89`). | Needs work |
| Model licence table in README | `README.md:376-383` lists FLUX 3 Klein, LTX-2.5, Kokoro-82M and Qwen3-TTS. It does not list the Gemma 4 encoder. | Needs work (minor) |

## 8. Findings and contradictions

1. **Agent provider is the only real Open Weights Only risk.** The image, video
   and TTS models are open weights and the workflows use core nodes, but
   OpenRouter/OpenCode Go are hosted closed APIs. Strict compliance depends on
   the `custom` local preset (`docs/SPEC.md:437`). The repo does not record the
   live demo's provider.
2. **Stale model metadata in `examples/data-story`.** That package says its
   still is `flux3-klein` but labels the model licence Apache-2.0 with a
   FLUX.1-schnell URL (`examples/data-story/package.json:399-408`), and its plate
   is `ltx25` but labelled Apache-2.0 with an LTX-Video URL
   (`examples/data-story/package.json:425-434`). This conflicts with
   `docs/SPEC.md:429-430` and `NOTICE:44-46`. It should be corrected or marked
   `[unverified]` before judges read the examples.
3. **TTS / encoder licences are inconsistently described as verified and
   unverified.** `colab/qwen-models.lock.json:6` says "Public Apache-2.0
   models", while `NOTICE:48-59` marks the same Qwen models `[unverified]`.
   `packages/tts/README.md:60` also marks Kokoro `[unverified]` even though the
   example CREDITS states Apache-2.0. One authoritative table is needed.
4. **`apps/web/package.json` has no `license` field.** The root MIT licence
   covers the repo, but per-package metadata is incomplete.
5. **Consolidated submission licence/credits files are still missing.** Root
   `THIRD_PARTY_LICENSES.md` and `CREDITS.md` are planned tasks S04/S05, not
   current files.

## 9. Pass / needs-work table by category

| Category | Verdict | Evidence |
| --- | --- | --- |
| Repo licence (`LICENSE`, `NOTICE`, MIT metadata) | **Pass** | `LICENSE:1-21`; `NOTICE:1-59`; `README.md:369`; `docs/SPEC.md:423` |
| Setup instructions / open-source requirement | **Pass** | `README.md:179-219`; `docs/RELEASE_CHECK.md:5-20` |
| Image model (FLUX 3 Klein + Qwen3-VL encoder) | **Pass** | `NOTICE:44-46`; `docs/SPEC.md:275`, `:429`; `colab/models.lock.json:11-17`, `:84-95`; `workflows/flux3_klein_*.api.json` |
| Video model (LTX-2.5 + Gemma 4 encoder) | **Needs work** | LTX terms are cited (`docs/SPEC.md:430`), but Gemma encoder terms are `[unverified]` and not separately noticed (`docs/SPEC.md:430`; `colab/models.lock.json:59-64`) |
| TTS models (Kokoro-82M, Qwen3-TTS family, aligner, ASR) | **Needs work** | Apache-2.0 claims are split between verified/unverified (`packages/tts/README.md:60-63`; `NOTICE:48-59`; `colab/qwen-models.lock.json:6-12`) |
| Agent LLM is model-agnostic and is not an image model | **Pass** | `packages/llm/src/presets.ts:4-26`; `packages/llm/README.md:3-13`; `docs/SPEC.md:436` |
| No closed APIs (category requirement) | **Needs work** | Hosted OpenRouter/OpenCode Go presets are closed APIs (`packages/llm/src/presets.ts:5-25`); strict path is the local `custom` preset (`docs/SPEC.md:437`) |
| No partner nodes | **Pass** | Core ComfyUI node classes only in `workflows/*.api.json`; `colab/bootstrap.py:263` clones upstream ComfyUI |
| Stock-asset policy | **Pass** | `packages/sources/README.md:6-29`; `packages/sources/src/licenses.ts:3-10`, `:60-103` |
| `package.zip` rights filtering | **Pass** | `packages/sources/src/package-zip.ts:112-235`; `packages/sources/src/licenses.ts:115-126`; `apps/server/src/export.mjs:227-245` |
| No weights / keys / signed URLs in export | **Pass** | `packages/sources/src/package-zip.ts:112-117`, `:218`, `:220-224` |
| `CREDITS.md` generation | **Pass** | `packages/sources/src/credits.ts:15-64`; `apps/server/src/export.mjs:241-245`; `examples/hook-20s/CREDITS.md:1-48` |
| Root `CREDITS.md` and `THIRD_PARTY_LICENSES.md` | **Needs work** | Files absent at audit time; planned in `docs/specs/SUBMISSION.md:35-36`, `:85-102` |
| Example model-licence metadata | **Needs work** | `examples/data-story/package.json:399-408`, `:425-434` conflict with `docs/SPEC.md:429-430` |
| Remotion non-OSI terms disclosed | **Pass** | `NOTICE:13-15`; `README.md:374` |
