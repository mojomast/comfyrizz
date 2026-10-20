# Third-party licences

Comfyrizz itself is MIT-licensed (`LICENSE`, `NOTICE`). This file records the
third-party licences and terms that apply to what the repository uses. It is a
summary, not legal advice: the linked licence text governs.

Every claim below cites a repository file or a URL from **docs/SPEC.md
Appendix A**. Anything the repository does not state is marked **[unverified]**.

## 1. Repository licence

| Item | Licence | Source |
| --- | --- | --- |
| Comfyrizz source | MIT | `LICENSE`, `NOTICE`, root `package.json` (`"license": "MIT"`) |
| Workspace packages (`packages/*`) | MIT | each package's `package.json` (`"license": "MIT"`) |
| Portions derived from Orbit | MIT, relicensed by the owner | `NOTICE`, `docs/SPEC.md` §8.1 |

`apps/web/package.json` declares no `license` field; the repository-level MIT
licence still applies to the code in it.

## 2. Model weights

Models are **not distributed with this repository**. Each user downloads the
weights under the model's own licence (`README.md`, "Credits and licences";
`NOTICE`).

| Model | Used for | Licence | Source |
| --- | --- | --- | --- |
| **FLUX 3 Image Klein** | Stills, reference edits, sketch-to-render | **FLUX Kommunity License v1.0** | `docs/SPEC.md` §8.2 ("[verified, model card]"); model card https://huggingface.co/black-forest-labs/flux-3-image-klein ; release notes https://docs.bfl.ml/release-notes (Appendix A) |
| **LTX-2.5** (22B distilled) | Text/image-to-video plates, ×2 upscale | **LTX-2.x Community License** | `docs/SPEC.md` §8.2; https://huggingface.co/Lightricks/LTX-2.5 and https://raw.githubusercontent.com/Lightricks/LTX-2/main/LICENSE-2_x (Appendix A) |
| **Kokoro-82M** | Default CPU narration | Apache-2.0 **[unverified]** | `packages/schema/src/semantic.mjs` (`MODEL_LICENSES.kokoro`), `packages/tts/README.md`, `docs/SPEC.md` §6.9/§8.2; https://huggingface.co/hexgrad/Kokoro-82M |
| **Qwen3-TTS 1.7B** (VoiceDesign / Base) | Optional Qwen narration | Apache-2.0 **[unverified]** | `NOTICE`; `packages/schema/src/semantic.mjs` (`MODEL_LICENSES["qwen3-tts"]`); model page https://huggingface.co/Qwen/Qwen3-TTS-12Hz-1.7B-Base |
| **Qwen3-ForcedAligner-0.6B** | Optional forced alignment | Apache-2.0 **[unverified]** | `NOTICE`, `packages/tts/README.md` |
| **Qwen3-ASR-0.6B** | Optional ASR in the Qwen QA pass | Apache-2.0 **[unverified]** | `NOTICE`, `packages/tts/README.md` |
| **VoxCPM2** (2B) | Documented alternative only; no code in this repo | Apache-2.0 **[unverified]** | `NOTICE`, `packages/tts/README.md` |

Notes from the repository:

- FLUX 3 Klein: non-commercial use, plus commercial *outputs* for Qualifying
  Users under US$5M gross annualised revenue including affiliates. The licence
  is not blanket permission for commercial fine-tuning, hosting or distribution,
  and it prohibits publicity/likeness violations and improving a competing
  model. The repo is gated (`gated: auto`) on Hugging Face (`docs/SPEC.md` §8.2).
  The Qwen3-VL-4B-Instruct text encoder is Apache-2.0 (`docs/SPEC.md` §8.2).
- LTX-2.5: free for entities under US$10M revenue including affiliates; above
  that a paid licence is required. The repo is gated. Possible Gemma terms on
  the 12B text encoder are **[unverified]**; an earlier "Apache 2.0" statement
  on ltx.io conflicts with the licence text, and the licence text governs
  (`docs/SPEC.md` §8.2).
- Kokoro weights are fetched by `packages/tts/scripts/fetch-models.sh` and are
  not committed. The repository marks the Apache-2.0 claim **[unverified]** in
  `packages/tts/README.md` and `docs/SPEC.md` until a licence review.
- VoxCPM2 is listed in `NOTICE` and `packages/tts/README.md` as an alternative
  only; this repository contains no VoxCPM2 code.
- **Qwen Image 2.1** is a deferred, off-by-default idea: its weights are open
  but licensed for non-commercial use only (`README.md`). It is not used by the
  current pipeline.
- The agent LLM depends on the provider the user chooses; `docs/SPEC.md` §8.2
  records DeepSeek's open weights as historically MIT but **[unverified for
  V4.1]**.

## 3. Remotion (company licence note)

Remotion is **source-available, not OSI-licensed**. The repository uses
`remotion`, `@remotion/cli`, `@remotion/fonts`, `@remotion/transitions`
(`apps/renderer/package.json`, version 4.0.536) and `@remotion/player`
(`apps/web/package.json`, version 4.0.536).

Terms, as stated in `docs/SPEC.md` §6.9 and `NOTICE`:

- The **Remotion Free License** covers individuals and organisations with **up
  to 3 people**.
- **Bigger companies need a Company License.**
- An MIT repository may depend on Remotion; the README states the Remotion
  terms.
- Licence page: https://www.remotion.dev/license (Appendix A; marked
  "[verified, summary]" in `docs/SPEC.md` §6.9).

Company licence note: Comfyrizz's own MIT licence does not relicense Remotion or
change these terms. If Comfyrizz is used or redistributed by an organisation of
more than three people, that organisation must obtain a Remotion Company
License for its use. The terms of the licence text govern over this summary.

## 4. Fonts

| Font | Licence | Source |
| --- | --- | --- |
| **Inter** (`apps/web/public/fonts/Inter-Variable.ttf`) | SIL Open Font License 1.1 | `apps/web/public/fonts/OFL.txt` ("Copyright 2020 The Inter Project Authors") |
| **JetBrains Mono** (`apps/renderer/public/fonts/JetBrainsMono-Regular.ttf`) | SIL Open Font License 1.1 | `apps/renderer/public/fonts/JetBrainsMono-OFL.txt`; `NOTICE` records version 2.304, "Copyright 2020 The JetBrains Mono Project Authors" |

Both font families are distributed under the OFL, which permits bundling and
embedding with software provided the copyright notice and licence accompany the
font. The full OFL text is in the two files above.

## 5. Key npm dependencies

Versions are read from the `package.json` files named below. A licence is only
listed as known where `NOTICE` or a spec section names it; otherwise it is
**[unverified]** here (the package's own licence file was not read as part of
this document).

| Dependency | Version | Declared in | Licence | Licence source |
| --- | --- | --- | --- | --- |
| `remotion`, `@remotion/cli`, `@remotion/fonts`, `@remotion/transitions` | 4.0.536 | `apps/renderer/package.json` | Remotion License (source-available) | `NOTICE`, `docs/SPEC.md` §6.9 |
| `@remotion/player`, `remotion` | 4.0.536 | `apps/web/package.json` | Remotion License (source-available) | `NOTICE`, `docs/SPEC.md` §6.9 |
| `react`, `react-dom` | 19.1.1 | `apps/renderer/package.json`, `apps/web/package.json` | **[unverified]** | — |
| `@resvg/resvg-js` | 2.6.2 | `packages/vector/package.json` | MPL-2.0 | `NOTICE` ("resvg / @resvg/resvg-js (MPL-2.0)") |
| `shiki`, `@shikijs/langs`, `@shikijs/themes` | 1.29.2 | `apps/renderer/package.json` | MIT | `NOTICE` ("Shiki 1.29.2 (MIT, Copyright (c) 2021 Pine Wu and Shiki contributors)") |
| `roughjs` | 4.6.6 | `apps/renderer/package.json` | MIT | `NOTICE` ("Rough.js 4.6.6 (MIT, Copyright (c) 2019 Preet Shihn)") |
| `perfect-freehand` | 1.2.3 | `apps/renderer/package.json` | MIT | `NOTICE` ("perfect-freehand 1.2.3 (MIT, Copyright (c) 2021 Stephen Ruiz Ltd)") |
| `flubber` | 0.4.2 | `apps/renderer/package.json` | MIT | `NOTICE` ("Flubber 0.4.2 (MIT, Copyright (c) 2017 Noah Veltman)") |
| `@dagrejs/dagre` | 3.1.1 | `apps/renderer/package.json` | MIT | `NOTICE` ("@dagrejs/dagre 3.1.1 (MIT, Copyright (c) 2012-2014 Chris Pettitt)") |
| `d3-scale` | 4.0.2 | `apps/renderer/package.json` | **[unverified]** | — |
| `zod` | 3.23.8 | `packages/agent/package.json` | **[unverified]** | — |
| `ajv`, `ajv-formats` | ^8.17.1, ^3.0.1 | `packages/schema/package.json` | **[unverified]** | — |
| `typescript` | 5.6.3 (apps), ^5.6.3 (packages) | `apps/renderer/package.json`, `apps/web/package.json`, `packages/schema/package.json` | **[unverified]** | — |
| `vite` | 5.4.10 | `apps/web/package.json` (dev) | **[unverified]** | — |
| `@playwright/test`, `@axe-core/playwright` | 1.64.1, 4.14.0 | `apps/web/package.json` (dev) | **[unverified]** | — |

`NOTICE` also records **Vercel AI SDK (Apache-2.0)**, **comfy-sdk /
@comfyorg/sdk and comfy-api-proxy (MIT)**, **google-colab-cli (Apache-2.0)** and
**ComfyUI (GPL-3.0)**, none of which are bundled npm dependencies of these
manifests. `NOTICE` also records timing/easing values re-expressed (no code
copied) from `whaleyxbt/claude-motion` (MIT) and the HyperFrames motion skills
(Apache-2.0).

## 6. Key Python dependencies

Versions are read from `pipeline-py/pyproject.toml`,
`pipeline-py/requirements-dev.txt` and `packages/tts/py/requirements.txt`.
Licences are listed only where the repository states them.

| Dependency | Version | Declared in | Licence | Licence source |
| --- | --- | --- | --- | --- |
| `jsonschema` | 4.25.1 | `pipeline-py/pyproject.toml`, `pipeline-py/requirements-dev.txt` | **[unverified]** | — |
| `comfy-sdk` | 0.5.0 | `pipeline-py/requirements-dev.txt` | MIT | `NOTICE` ("comfy-sdk / @comfyorg/sdk and comfy-api-proxy (MIT)") |
| `pytest` | 8.4.2 | `pipeline-py/pyproject.toml` (dev), `pipeline-py/requirements-dev.txt` | **[unverified]** | — |
| `numpy` | 2.5.4 / `>=1.26,<3` | `pipeline-py/requirements-dev.txt`, `packages/tts/py/requirements.txt` | **[unverified]** | — |
| `Pillow` | `>=10` | `pipeline-py/requirements-dev.txt` | **[unverified]** | — |
| `kokoro-onnx` | 0.4.9 | `packages/tts/py/requirements.txt` | **[unverified]**; `NOTICE` says "see their notices" and does not name a licence | `NOTICE`, `packages/tts/README.md` |
| `onnxruntime` | not pinned in the repo | `packages/tts/README.md` (CPU build) | **[unverified]** | — |
| `phonemizer-fork` / espeak-ng data | not pinned in the repo | `packages/tts/README.md` | **[unverified]** | — |
| `qwen-tts`, `torch` | not in requirements | `packages/tts/README.md` (optional Qwen backend, imported only at runtime) | **[unverified]** | — |

`pipeline-py/pyproject.toml` declares the Comfyrizz pipeline itself as MIT.

## 7. Not vendored

- **ComfyUI** is GPL-3.0 and is cloned at runtime, not vendored
  (`NOTICE`, `docs/SPEC.md` §8.1, `README.md`).
- **google-colab-cli** is Apache-2.0 and is invoked as an external command
  (`NOTICE`, `docs/SPEC.md` Appendix A).
- **ComfyUI-LTXVideo** and any other custom node pack are not vendored; whether
  the tested graphs use core or custom LTX nodes is **[unverified]**
  (`docs/SPEC.md` §6.4).

## 8. Open items

- Kokoro-82M, Qwen3-TTS, Qwen3-ForcedAligner, Qwen3-ASR and VoxCPM2 licences
  are stated in `NOTICE` but were not re-checked against their model cards in
  this repository, so they remain **[unverified]**.
- Gemma 4 12B terms on the LTX-2.5 text encoder are **[unverified]**
  (`docs/SPEC.md` §8.2).
- npm and Python licences marked **[unverified]** above need a package-level
  review before shipping a distribution that includes those dependencies.
- Model output rights are separate from model-weight licences; see
  `docs/SPEC.md` §6.10 and §8.2 for the export policy.
