# Comfy's services: what exists and how Comfyrizz could use them

Researched Sun Oct 18, 2026, 2:00–2:30 PM EDT (Toronto), for Kyle. The repo was read only; nothing in `<repo root>` was changed. Every web source was read on Oct 18, 2026 unless another date is given.

Tags used here: **[verified]** = checked against a primary source (Comfy docs, Comfy-Org source code, a live public endpoint) or on this box. **[inferred]** = follows from verified facts but wasn't tested. **[unverified]** = couldn't be checked: it needs a paid key, a Discord answer, or a GPU run.

---

## 0. TL;DR

- **Comfy Cloud runs API-format workflows through the same Comfy API v2 and `comfy-sdk` our runner already uses.** To switch, set `COMFY_BASE_URL` (or leave it unset, which means Cloud) and `COMFY_API_KEY`. This is the cheapest high-value integration: a third backend, `comfy-cloud`, behind the same `runPackage()`.
- **LTX-2.5 runs on Cloud with our exact graphs.** All five of our LTX-2.5 model files are in Comfy Cloud's public model list under the same filenames, and every node class we use is core ComfyUI in Cloud's version (v0.41.1) [verified, see §2.1].
- **FLUX 3 Klein isn't on Comfy Cloud yet.** The public model list (checked 2:21 PM EDT) has FLUX.2 Klein but no FLUX 3 Klein diffusion model. The text encoder and VAE we use *are* there. ComfyUI's FLUX 3 Klein templates are only 3 days old (Oct 15), so Cloud may add the model soon [unverified]. Until then, Klein jobs need one of: (a) a Creator plan or higher plus a Hugging Face import, (b) routing stills to Google Colab or BYO, or (c) waiting.
- **Cloud API access needs a paid subscription.** Standard costs $20/month ($16/month billed yearly) and allows 1 concurrent API job and a 30-minute cap per job. Creator ($35/month) allows 3 concurrent jobs and model imports [verified, pricing page]. I found no hackathon-provided Cloud credits; the only credits are prizes ($250 to each of 10 runner-ups) [verified absence on the public pages; ask in Discord].
- **Partner nodes and Comfy Router would push Comfyrizz out of "Open Weights Only".** The FLUX 3 Image and LTX-2.5 partner models are hosted closed APIs from the rules' point of view, even though LTX-2.5's weights are open. Keep them deferred, as Kyle already planned.
- **Recommendation:** for the hackathon, ship an optional `comfy-cloud` backend (about 4.5 agent-days) that runs our own open-weights graphs. Ask in the Comfy Discord whether Comfy Cloud counts as a "closed-source API" for Open Weights Only. Partner nodes and Router, Comfy API deployments, and Comfy Cloud nodes come after the hackathon.

---

## 1. What Comfy offers today

### 1.1 Comfy API v2 + Comfy SDK (`comfy-sdk` / `@comfyorg/sdk`)
- **What it is**: Comfy's versioned HTTP API for running ComfyUI workflows from outside: upload assets, submit an API-format graph, follow the job, download outputs. Changes within v2 are additive; breaking changes go to v3 [verified, https://docs.comfy.org/api-reference/v2/overview].
- **Three surfaces, one contract**: Comfy Cloud `https://cloud.comfy.org`, a Comfy API deployment `https://{deployment}.run.comfy.app`, and self-hosted ComfyUI behind comfy-api-proxy `http://127.0.0.1:8189` [verified, same page].
- **Auth**: `Authorization: Bearer <key>` on Cloud and on deployments. The proxy needs no key by default and can take an optional static bearer [verified]. The SDK takes the key from `Comfy(api_key=...)`, falling back to the `COMFY_API_KEY` env var. With no `COMFY_BASE_URL` set it targets Cloud and raises `MissingApiKey` locally if no key is set. The SDK never logs the key or prints it in `repr`/exceptions [verified, `comfy_sdk/client.py` docstring in the 0.5.0 wheel].
- **Partner-node key**: there is a separate `api_key` argument on `submit()`/`run()` that goes into the request body as `extra_data.api_key_comfy_org` [verified, `comfy_sdk/_core.py` `extra_data_for`].
- **Version**: `comfy-sdk` 0.5.0 (PyPI, Oct 10, 2026, MIT) and `@comfyorg/sdk` 0.5.0 (npm, Oct 10, 2026) [verified, PyPI/npm JSON].
- **Cloud vs deployment vs proxy**:
  - Job **labels** (`metadata`) work only on Comfy API deployments. Cloud refuses them, and the proxy refuses a label map.
  - The **job list** returns `501 not_implemented` on Cloud.
  - **Signed output URLs** last about 6 hours on Cloud. The proxy has none.
  - Idempotency keys are **reject-on-duplicate** (`422 idempotency_key_reuse`). A submit that definitively failed (validation error, out of credits, queue full) frees its key.
  - [All verified, https://docs.comfy.org/development/api-development/sdks]
- **Not in the SDK yet**: saved workflows, the model library, node introspection, named parameters [verified].
- **Maturity**: 0.x but officially committed ("we intend to support long term").

### 1.2 comfy-api-proxy (self-hosted v2)
- **What it is**: MIT, `pip install comfy-api-proxy`, 0.1.6 (Aug 19, 2026); the latest commit on `main` is Aug 27, 2026 [verified, PyPI + git clone].
- **Defaults**: proxies `127.0.0.1:8188` and serves v2 on `127.0.0.1:8189`. It refuses a non-loopback `--host` without `--token` unless `--allow-insecure-bind` is set. `--token` gates `/api/v2/*` only [verified, `src/comfy_api_proxy/cli.py`].
- **How it maps v2 onto ComfyUI** [verified, `app.py` header]:
  - `POST /api/v2/jobs` → resolve `core/ASSET` refs → `POST /prompt`
  - `POST /api/v2/assets` → `POST /upload/image`
  - asset content → `/view`
- **Partner-node key**: it forwards `extra_data.api_key_comfy_org` verbatim and never stores it. It accepts no other `extra_data` key [verified, `app.py` ~L695–785; the vendored spec `spec/openapi.yaml` v2.0.0 has `extra_data.api_key_comfy_org`]. So partner nodes *can* run through our BYO path later without a new protocol.
- **SPEC §9 item 9, now resolved**:
  - (a) **Verified**: the proxy's upstream `ClientSession` sends no auth headers. `--token` protects only calls *into* the proxy, so we can't promise upstream auth.
  - (b) **Verified**: the SDK sends the proxy token as its API key (`Comfy(api_key=…)` or `COMFY_API_KEY`), per https://docs.comfy.org/development/comfyui-server/api-proxy ("pass that token as the SDK API key") and the SDK source.
  - (c) **Still unverified**: a non-loopback `--comfyui` URL. `--comfyui` takes any URL, but I didn't test it.

### 1.3 Comfy Cloud (hosted ComfyUI)
- **What it is**: managed ComfyUI on Blackwell RTX 6000 Pro (96 GB) GPUs, with "900+ pre-installed models", a curated set of custom nodes, and imports from Civitai or Hugging Face on Creator and higher [verified, https://www.comfy.org/cloud/pricing, https://docs.comfy.org/get_started/cloud, https://docs.comfy.org/cloud/import-models]. Our Google Colab G4 is the same GPU class.
- **Programmatic API**: **yes**. Comfy API v2 through the SDK, at base `https://cloud.comfy.org` (the default) [verified]. The **v1 Cloud API** is deprecated but still serves extras v2 lacks [verified, https://docs.comfy.org/development/cloud/overview]:
  - auth: `X-API-Key` header
  - `/api/object_info`, `/api/queue`, `/api/interrupt`, `/api/user`, `/api/experiment/models[/{folder}]`
  - `/api/billing/usage/timeseries`, which includes `summary.balance` in **cents** despite the `_micros` suffix and is invoice-derived, not real-time [verified, https://docs.comfy.org/openapi-cloud.yaml]
  - v1 status codes: 401 bad key, **402 insufficient credits**, **429 inactive subscription**.
- **Live check** [verified, Oct 18, 2026, 2:21 PM EDT]:
  - `GET https://cloud.comfy.org/api/system_stats` (public) reports `comfyui_version v0.41.1`, `cloud_version v0.480.0` and `workflow_templates_version 0.7.64`.
  - `GET /api/experiment/models/*` is public.
  - `GET /api/object_info` answers 401 without a key.
- **Auth**: one API key per Comfy workspace, created at https://platform.comfy.org (`+ New`; shown once; keys start `comfyui-`). The same key covers Cloud, partner nodes, Router and MCP [verified, https://docs.comfy.org/development/api-development/getting-an-api-key].
- **Pricing** [verified, https://www.comfy.org/cloud/pricing and https://docs.comfy.org/development/deploy/cloud-usage]:
  - **API access needs a paid plan; the free tier doesn't include it.**
  - Standard: $20/month, or $16/month billed yearly (50,400 credits/year). Creator: $35/month, or $28/month yearly (88,800 credits/year). The page lists Pro and Team but their prices didn't come through in the fetch [unverified].
  - API jobs draw from the same credit pool as the UI. Only active GPU time is charged.
  - Rate: 211 credits = $1 [verified, https://docs.comfy.org/tutorials/partner-nodes/concurrency-limits].
  - Comfy publishes **no per-second GPU rate** for Cloud workflow runtime. Its only reference point is "a 5 s Wan 2.2 i2v video ≈ 11 credits" [verified that this is all the page gives].
- **Limits** [verified, cloud-usage + pricing FAQ]:
  - Concurrent API workflows: 1 / 3 / 5 / 25 on Standard / Creator / Pro / Team.
  - Max runtime per job: 30 min on Standard and Creator, 1 h on Pro.
  - Up to 100 jobs queued. `QueueFull` is retried by the SDK within a budget.
- **Data**: Comfy keeps customer content "as long as necessary to operate, analyze, and improve the service" and doesn't train on inputs or outputs. Partner-node media is deleted after 24 h [verified, https://docs.comfy.org/support/data-retention, ToS "No AI Training"].
- **Maturity**: GA product. API docs current as of this month.

### 1.4 Comfy API deployments ("serverless", Developer Platform)
- **What it is**: package a ComfyUI version, models, custom nodes and Python deps into a **Build** (`comfy-build.yaml`), cut a release for `linux/nvidia`, then `comfy deploy up --gpu --region --min --max`. You get a dedicated v2 endpoint at `https://{deployment}.run.comfy.app` [verified, https://docs.comfy.org/development/serverless/overview, /quickstart].
- **Build sources**: a local install (`comfy build init --models-dir --custom-nodes-dir` + `push`), a Comfy Desktop snapshot, or a workflow JSON in the Build Wizard [verified, /development/serverless/build-sources].
- **Pricing** [verified, https://www.comfy.org/pricing]: per GPU-second. RTX PRO 6000 $4.54/h (957.94 credits/h), H100 $6.23/h, H200 $7.71/h, B200 $11.23/h. Network storage costs $0.20/GB/month while any deployment of the Build exists, paused ones included.
- **Workers**: `--min 0` scales to zero. Flex workers bill from startup, including model load, plus a 30 s idle tail. Deployments stop automatically when credits run out.
- **Plan limits**: Standard and Creator include 5 builds, 2 deployments and up to 2 workers per deployment. The next plan up (presumably Pro) includes 10 / 5 / 10 [verified].
- **Fit**: it runs **our exact graphs and models** (FLUX 3 Klein included), and labels and the job list work there. The cost is a one-time Build of about 60 GB of models (≈ $12/month storage while deployed) and a per-user setup that's too heavy for normal users. It's good for Kyle's own demo endpoint, though each user would still need their own [inferred].

### 1.5 Partner Nodes (formerly "API nodes")
- **What they are**: core ComfyUI nodes that call third-party or closed model APIs. They're billed in Comfy credits and authenticated with the Comfy account: UI login, or headless `extra_data.api_key_comfy_org` on `/prompt` [verified, https://docs.comfy.org/development/comfyui-server/api-key-integration].
- **Local use**: partner nodes need `127.0.0.1`/`localhost` access, so they fail behind `--listen` on a LAN. Prepaid; the balance can go briefly negative. No refunds [verified, https://docs.comfy.org/tutorials/partner-nodes/faq].
- **Concurrency**: set by lifetime spend: 1 if you've never paid, 5, 10 at $100, 20 at $500, 40 at $1,000. Models costing $5 or more per request get ¼ of that. Over the limit you get `429` [verified, /tutorials/partner-nodes/concurrency-limits].
- **Relevant models** [verified, https://docs.comfy.org/tutorials/partner-nodes/pricing, /lightricks/ltx-2-5, /black-forest-labs/flux-3-image]:
  - **LTX-2.5 (Pro/Fast)**: runs on Lightricks' servers. t2v, i2v and first-last-frame, with synced audio, up to 4K on Fast.
    - Pro: 36.21 credits/s at 720p, 51.29 at 1080p.
    - Fast: 27.16 at 720p, 39.22 at 1080p, 90.52 at 4K.
  - **FLUX 3 Image**: BFL's hosted FLUX 3 (Early Access, announced Jul 23, 2026). This is *not* Klein. t2i, up to 10-reference edit, bounding-box layout, web-search grounding on by default. 12.37 credits (0.75K) to 14.48 (1K) to 30.17 (2K) to 183.15 (4K) per image.
  - **FLUX 3 video**: 51.29 credits/s at 720p.
  - Also MiniMax H3 and many others.
- **Fit**: these models are **not our graphs**. They're different node classes with hosted weights and different controls: no seed or sampler control, prompt rewriting and search grounding on FLUX 3 Image, audio on by default on LTX. **Using them disqualifies Open Weights Only** ("No partner nodes or closed-source APIs") [verified, https://comfy.org/open-source-higgsfield/].
- **ToS**: partner use falls under the provider's terms too; Comfy proxies requests without sending the user's identity [verified, ToS "Partner Nodes"].

### 1.6 Comfy Router (pre-GA)
- **What it is**: one HTTP API for partner models in each provider's native request body. `POST https://api.comfy.org/v2/models/{provider}/{model}` (sync, 10-minute default deadline), or queued: `/requests` → `request_id` → poll/collect. No progress events and no webhooks [verified, https://docs.comfy.org/development/comfy-router/limitations].
- **Limits**: 100 MiB request body cap; `429 concurrency_limit_exceeded` / `rate_limited` per caller.
- **Cost reporting**: `X-Comfy-Credits-Used` is optional, and the `/estimate` route is still rolling out (`403 not_enabled`) [verified]. Billing happens "when the provider bills Comfy" [verified, /comfy-router/billing].
- **Status**: "Router is not generally available yet" [verified, v2 overview].
- **Catalog**: includes `ltx/ltx-2-5-fast`, `ltx/ltx-2-5-pro`, `bfl/flux-3-image`, `bfl/flux-3-video`, `minimax/minimax-h3`. **No Klein** [verified, https://docs.comfy.org/llms.txt router-schemas list].
- **SDK**: `client.models.run(...)` in Python and `comfy.models` in TypeScript, using the same key. Base URL comes from `COMFY_ROUTER_BASE_URL` [verified, SDK docs + client.py].
- **Fit**: a "hosted model" adapter, not a ComfyUI-graph backend. Partner and closed, same as §1.5.

### 1.7 Comfy Cloud nodes (beta)
- **What they are**: core nodes (ComfyUI ≥ v0.34.5) that run one fixed workflow on a pinned **open-source** model on Comfy's GPUs. Billed per GPU-second in credits, with no subscription [verified, https://docs.comfy.org/cloud-nodes/overview].
- **Available nodes at launch** (8): Flux 2 t2i, Mage Flow (and Turbo), Z-Image Turbo, MiniMax H3 t2v/i2v/FLF2V, MiniMax Music 3. **No FLUX 3 Klein or LTX-2.5**, and no BYO LoRA or checkpoint.
- **Fit**: none today. Whether these count as "partner nodes" for Open Weights Only is ambiguous [unverified].

### 1.8 comfy-cli
- **What it is**: GPL-3.0-only, 1.22.0 (Sep 30, 2026) [verified, PyPI]. Commands cover:
  - local ComfyUI install, launch and nodes
  - `comfy generate` (partner one-shots, beta)
  - `comfy run` (Cloud workflows)
  - `comfy build …` / `comfy deploy …` (Comfy API)
  - `comfy skills show comfy-build|comfy-deploy` (agent recipes)
  - [verified, https://docs.comfy.org/agent-tools/cli, /comfy-cli/reference, /development/serverless/quickstart]
- **Auth**: `comfy cloud login` (OAuth) or `COMFY_API_KEY` / `--api-key` [verified].
- **Retention**: files uploaded through `comfy generate` are auto-deleted after 24 h [verified, reference].
- **Fit**: an optional dev tool for building a Comfy API deployment. We shouldn't depend on it at runtime: the SDK covers execution, and as a GPL tool it could only be called as a subprocess, never vendored.

### 1.9 Comfy Registry
- **What it is**: the public custom-node registry behind ComfyUI-Manager. It provides semver'd and security-scanned node packs, publisher API keys, and a Registry API [verified, https://docs.comfy.org/registry/overview].
- **Fit**: our graphs use **only core nodes**, so we need nothing from it now. It matters later only if we publish a "Comfyrizz nodes" pack, which would help the "Most Innovative: novel custom node packs" angle, or pin third-party packs.

### 1.10 Comfy Desktop
- **What it is**: a free, open-source launcher that manages local ComfyUI instances (Windows, macOS on Apple Silicon, Linux). It has Cloud/Local onboarding, snapshots that feed Comfy API Builds, and a "Deploy to Comfy API" menu entry. **No headless mode** [verified, https://docs.comfy.org/installation/desktop/overview, /faq, /development/deploy/overview].
- **Fit**: already covered by the **BYO ComfyUI URL** backend. We just need a README line and a URL hint for Desktop's port, which I didn't verify.

### 1.11 Comfy MCP / Comfy Agent / Comfy Hub (context only)
- **Comfy MCP**: has a hosted Cloud connection (OAuth, "5 free runs" for new users) and an open-source local connection [verified, https://docs.comfy.org/agent-tools/mcp].
- **Comfy Agent**: builds and runs workflows on Cloud and is billed in credits [verified, pricing].
- **Comfy Hub**: winning entries will be featured there [verified, hackathon page].
- None of these is needed for runPackage.

### 1.12 Hackathon specifics
- **Rules**: "Create your favorite app … using the Comfy Developer Platform". Partner models are allowed except in Open Weights Only. Each entry can win one main prize and one model-provider bonus. Deadline Oct 30, 9 AM PT [verified, https://comfy.org/open-source-higgsfield/].
- **Platform definition**: Comfy API, Comfy Router and/or Comfy SDK [verified, secondary: https://comfyui-wiki.com/en/news/2026-10-15-open-source-higgsfield, https://thereelstack.com/lab/open-source-higgsfield-challenge-first-builds; matches our brief].
- **Backers**: Runpod, LTX, BFL and MiniMax [verified, https://blog.comfy.org/p/higgsfield-promised-to-open-source, Oct 15, 2026].
- **Hackathon-provided credits or hosted endpoints**: **none found** on the hackathon page, the blog post or the Developer Platform page, and X search found no posts. The only credits are prizes: $250 in Comfy credits for each of 10 runner-ups, and FLUX/MiniMax API credits for bonus winners [unverified that there are none; Discord isn't public to us].

---

## 2. Can each service run our exact graphs?

Our graphs (`workflows/*.api.json`) use **only core node classes**:
- **FLUX**: `UNETLoader`, `CLIPLoader`, `VAELoader`, `EmptyFlux2LatentImage`, `ReferenceMultiLatent`, `KSampler`, `ImageScale`, `LoadImage`, `SaveImage`, …
- **LTX**: `LTXVConcatAVLatent`, `LTXVDualCFGGuider`, `LTXVEmptyLatentAudio`, `LTXVImgToVideoInplace`, `LTXVLatentUpsampler`, `LTXVPreprocess`, `LTXVSeparateAVLatent`, `LatentUpscaleModelLoader`, `ManualSigmas`, `SamplerCustomAdvanced`, `CreateVideo`, `SaveVideo`, `VAEDecodeTiled`, …

All are present in ComfyUI **v0.41.1** (Cloud's reported version, tagged Oct 15, 2026) [verified by grepping the v0.41.1 tag]. Checking Cloud's actual `object_info` needs a key [unverified].

### 2.1 Model files on Comfy Cloud (public `/api/experiment/models/{folder}`, Oct 18, 2026, 2:21 PM EDT) [verified]

| Our file | Folder | On Cloud? |
|---|---|---|
| `ltx-2.5-22b-distilled-transformer-comfy-int8-convrot.safetensors` | diffusion_models | **yes, exact name** |
| `gemma4-12b-with-proj-ltx-2.5-comfy-int8-convrot.safetensors` | text_encoders | **yes** |
| `ltx-2.5-video-vae-bf16.safetensors` / `ltx-2.5-audio-vae-bf16.safetensors` | vae | **yes** |
| `ltx-2.5-latent-spatial-upscaler-x2-bf16-1.0.safetensors` | latent_upscale_models | **yes** |
| `flux2-vae.safetensors` | vae | **yes** |
| `qwen3vl_4b_bf16.safetensors` (our merged Klein text encoder) | text_encoders | **a file with this name exists**. That it's byte-identical to our merge is [unverified]. |
| `flux-3-image-klein-bf16.safetensors` (our rename of BFL's `model.safetensors`) | diffusion_models | **no**. Neither is the Comfy-repackaged `flux3-image-klein-*.safetensors`. Only `flux-2-klein-*` (FLUX.2) is listed. |

So on Cloud **today**:
- **LTX-2.5 t2v/i2v 2-stage**: runs as-is [inferred from the verified files and nodes; untested].
- **FLUX 3 Klein t2i/img2img/ref-edit**: blocked by the missing diffusion model. Options:
  1. **Creator plan + Hugging Face import**: import `black-forest-labs/flux-3-image-klein-comfy/.../flux3-image-klein-bf16.safetensors` (or int8). The repo is gated, so the user's HF token goes into Cloud **Secrets**. Then point `unet_name` at the imported name through a per-backend model alias map [inferred from verified import docs; the import flow is untested].
  2. **Wait**: Comfy's own FLUX 3 Klein templates (`image_flux3_klein_*`) were added Oct 15. Cloud "will update after ComfyUI stable release", so preinstall is likely but not promised [unverified].
  3. **Hybrid routing**: stills on Google Colab or BYO, plates on Cloud. This is complex and two runtimes are billed.
  4. **Swap to FLUX.2 Klein on Cloud**: a different model, and it weakens the FLUX 3 story. Not recommended.
- **Filename caveat**: Comfy's templates use `flux3-image-klein-…` and `qwen3vl_4b_int8_convrot`, while we use `flux-3-image-klein-bf16` and `qwen3vl_4b_bf16`. Any Cloud or deployment path needs a **model alias map**, not a hard-coded name.

### 2.2 Summary matrix

| Service | Runs our FLUX 3 Klein graphs | Runs our LTX-2.5 graphs | Open Weights Only safe | Auth | Price basis |
|---|---|---|---|---|---|
| BYO ComfyUI / Desktop (+ proxy) | yes | yes | yes | none or proxy bearer | user's own |
| Google Colab (current) | yes | yes | yes | user's Google CLI login | Google Colab units (≈ 8.9/h on G4) |
| **Comfy Cloud via SDK v2** | **not yet** (model missing) | **yes** | **probably**: open weights, but it's a hosted Comfy service. **Ask** | Comfy API key (Bearer) | paid plan + GPU-time credits |
| Comfy API deployment | yes (we build it) | yes | probably (same question) | Comfy API key | $4.54/h RTX PRO 6000 + $0.20/GB/month |
| Partner nodes (in our graphs) | no (FLUX 3 Image ≠ Klein) | LTX-2.5 API (different controls) | **no** | key in `extra_data` | per image / per second |
| Comfy Router | no | `ltx/ltx-2-5-*` (native body) | **no** | key (Bearer) | per call; pre-GA |
| Comfy Cloud nodes | no | no | ambiguous | Comfy account | per GPU-second |

---

## 3. ToS and policy notes for an open-source tool

- **Comfy ToS** (effective May 13, 2026) [verified, https://www.comfy.org/terms-of-service]:
  - Access is "for your internal business purposes"; no "sublicense the Comfy Products for use by a third party".
  - "You are responsible for all usage … under your credentials and API keys".
  - Comfy may change or discontinue endpoints without notice.
  - A "competitive product" clause exists. A client for Comfy's own API is unlikely to fall under it [interpretation].
- **What that means for Comfyrizz** [interpretation]:
  - **Each user brings their own Comfy account and key.** Never ship a shared key.
  - Never run a hosted multi-tenant Comfyrizz on Kyle's key; that would be sublicensing.
  - Say in the README that prompts and images go to Comfy and stay under Comfy's retention policy.
- **comfy-cli is GPL-3.0**: don't vendor it. A subprocess is fine if ever needed.
- **Licences we'd use**: comfy-sdk and comfy-api-proxy are both MIT [verified, PyPI], so they're compatible with our MIT repo.
- **Open Weights Only**: "No partner nodes or closed-source APIs, open-weights models only" [verified]. Whether **Comfy Cloud running open-weights graphs** counts as a "closed-source API" isn't stated [unverified]. Since Comfy wrote the rules around its own platform, Cloud is probably fine, but that has to be asked. **Our demo/default should stay Google Colab or BYO**, with Cloud as an option, until Comfy answers.

---

## 4. Recommendation: hackathon vs later

**For the hackathon (by Oct 30):**
1. **Comfy Cloud backend (`comfy-cloud`)**: our own open-weights graphs through `comfy-sdk`, no partner nodes.
   - LTX-2.5 plates work now.
   - Klein stills use preflight-and-route: if the Klein model is missing on Cloud, the plan card says so and offers to run stills on Google Colab or BYO, or to wait, or uses an imported model through the alias map.
   - Why: it shows "built on the Comfy Developer Platform" beyond the SDK-plus-proxy story, needs **no VM lifecycle** (no bootstrap, no teardown risk, no 4-minute overhead), and reuses about 80% of the BYO code.
2. **Comfy account card** in Settings, next to U2's guided Google Colab sign-in card.
3. **Discord question** before the demo: "Does running open-weights FLUX 3 Klein / LTX-2.5 graphs on Comfy Cloud via the SDK keep an entry eligible for Open Weights Only?" Also ask whether hackathon participants get Cloud credits.

**After the hackathon:**
- Partner-node / Router "hosted model" adapter (LTX-2.5 API, FLUX 3 Image, MiniMax H3). It's labelled closed, has its own spend card, and is off when `compliance.open_weights_only`.
- A Comfy API deployment recipe for power users (Build from `models.lock.json`).
- Optional Comfyrizz custom-node pack on the Registry.

**Tradeoff Kyle has to weigh**:
- **Cost**: Kyle deferred paid providers. Comfy Cloud is paid: at least $20/month for Kyle to test (Creator $35/month if Klein import is needed). It's also Comfy's own service, which judges may favour, and it removes Google Colab's 4-minute bootstrap and VM-stop risk from the demo.
- **Risk**: an Open Weights Only interpretation, a Klein gap that may not close by Oct 30, and an unknown Cloud GPU-time rate.
- **Mitigations**: keep Google Colab as the default, keep Cloud optional, and decide after one Discord answer and one smoke run.

---

## 5. Integration plan

### 5.1 New backend: `packages/backends/src/comfy-cloud-backend.mjs`
Same factory shape as `createByoBackend`, attached `runPackage` via `withRunPackage`.

```js
createComfyCloudBackend({
  baseUrl = "https://cloud.comfy.org",     // or a https://<dep>.run.comfy.app deployment (same code; labels on)
  apiKeySource,                             // () => string, from env COMFY_API_KEY or the settings store; never logged
  modelAliases,                             // workflows/models.cloud.json (see 5.4)
  pythonBin, runnerCwd, runnerTimeoutSeconds,
  fetchImpl = fetch, now,                   // injectable for the fake
})
```
- `id: "comfy-cloud"`. `describe()` returns:
  - `costVisibility: "comfy-credits-estimate"`
  - `requiresApproval: true`
  - `dataNotice: "prompts and input images are sent to Comfy Cloud"`
- `estimate(jobs)` returns `{ gpuMinutes, overheadMinutes: 0, credits, usd, caps }`.
  - Per-job minutes come from `MEASURED_JOB_MINUTES` (same GPU class as G4) plus a configurable **cold-load allowance** [unverified; measure on the smoke run].
  - Credits come from a configurable `cloudCreditsPerGpuSecond`. Cloud publishes no rate, so the default comes from Comfy API's RTX PRO 6000 rate (957.94 credits/h ≈ 0.266 credits/s) and is labelled "estimate, Comfy doesn't publish a Cloud per-second rate".
  - Also returns plan caps: concurrency 1/3/5 and a 30/60-minute per-job cap.
- `ensureUp()`: no VM. It validates the key and plan:
  - `GET {base}/api/user` with `X-API-Key` (v1): 200 OK, 401 bad key, 429 inactive or no paid subscription.
  - Then reads the balance from `GET /api/billing/usage/timeseries?months=1`, `summary.balance` (cents ÷ 100 = USD), labelled "invoice-derived, may lag".
  - Returns `{state: "ready", evidence}`.
- `health()`:
  1. Model preflight against the **public** `/api/experiment/models/{folder}` and, with the key, `/api/object_info` for node classes.
  2. Resolves each job's model names through the alias map.
  3. Marks jobs `runnable | missing_model | missing_node`.
  4. Optional tiny smoke job, which costs credits: off by default and only after approval.
- `run(jobsFile, onEvent, signal)`: spawns the same `pipeline-py` runner with:
  - env `COMFY_API_KEY=<key>` (env only, **never argv**) and `COMFY_BASE_URL` unset or set to the deployment
  - `--upload-mode v2-asset`
  - `--job-labels off` (Cloud refuses labels)
  - `--concurrency <planCap>`
  - Jobs the preflight marked unrunnable are excluded and reported (`skipped_on_backend`) so `runPackage` can offer routing.
- `reconcile(runId)`: uses the attempt records' stored job ids through `client.jobs.get(id)`. This works on Cloud, which has no job list (501), so never fall back to listing.
- `collect()`: the runner already writes outputs with `handle.to_file()`. We re-host the bytes in the package store and never persist signed URLs (they expire after about 6 h).
- `teardown(reason)`: no runtime to stop. On `error`/`user`/`budget` it **cancels every non-terminal job we own** (SDK cancel by id) and returns:
  - `{state: "stopped", evidence: "n jobs canceled; no runtime"}`
  - `{state: "stop_unconfirmed"}` if any cancel fails
  - Never a global `/api/interrupt`.
- `Backend.id` union and `index.mjs` exports: add `"comfy-cloud"`. In `apps/server/src/run.mjs`, change `requiresApproval: backendId === 'colab'` to read `describe().requiresApproval`.

### 5.2 Runner changes (`pipeline-py`)
- **Uploads**: today `client.upload_file` POSTs to ComfyUI's `/upload/image` and injects a filename. That won't work on Cloud.
  - Add `upload_mode = "v2-asset"`: `client.assets.from_file(path)` (lazy, blake3 content-addressed, dedupes re-runs), then `wf.set_input(node, input, asset)`, which writes a `core/ASSET` ref.
  - Keep `comfyui-upload` as the default for BYO/proxy. That's needed because `LoadImage` can't take asset ids through the proxy's `/upload/image` path; the proxy does resolve `core/ASSET` refs on submit, so v2-asset may work there too [unverified].
- **Labels**: an explicit `job_labels: off` on Cloud. The existing auto-retry on a metadata refusal is safe, but costs an extra round trip and depends on how Cloud phrases the refusal.
- **Typed errors**: map `InsufficientCredits` (402), `QueueFull`, `Unauthorized` (401), subscription inactive (429) and `JobFailed` into attempt states. **An out-of-credits submit creates no job** [verified, SDK docs], so it's a clean refusal, not an ambiguous one.
- **Idempotency**: keep the current "record key, then job id" rule. Cloud is reject-on-duplicate, the same as the proxy.
- **Per-job runtime cap**: refuse to plan a job whose upper estimate exceeds the plan's cap (30 min on Standard). Every current job is far below it.
- **Concurrency**: honour the plan cap (1 on Standard). The runner is effectively serial today, so this is a guard, not new parallelism.

### 5.3 Auth and secret handling
- **Sources**, in order: the `COMFY_API_KEY` env var, then the settings store `~/.config/comfyrizz/secrets.json` (mode 0600).
  - The settings API returns only `{configured: true, last4, workspace?}`, never the key, the same as the LLM keys.
  - It's **never** in `jobs.json`, attempt records, progress logs, the manifest, `package.zip` or argv.
- **Redaction**: add `comfyui-[A-Za-z0-9]{16,}` and the header names `X-API-Key` / `Authorization: Bearer` to `redactSecrets`/`redactAll`. Also scan the runner's stderr before relaying it.
- **Extend `assertNoSecrets` tests** to cover the Comfy key pattern.
- **Keep two keys apart**: the **client credential** (Bearer) and a **partner-node key** (`extra_data`) are separate concepts in the SDK. We only use the former, and the partner path stays disabled while `open_weights_only` is on.
- **No OAuth for now**: comfy-cli has `comfy cloud login` (OAuth), but we don't read its token store. That follows the same rule as Google Colab: never read another tool's token.

### 5.4 Graph mapping and model aliases
- Add `workflows/models.cloud.json`, which maps our canonical model ids to backend filenames:
  ```json
  { "klein.unet": { "colab": "flux-3-image-klein-bf16.safetensors", "comfy-cloud": null, "comfy-cloud-imported": "<name after import>" },
    "klein.te":   { "colab": "qwen3vl_4b_bf16.safetensors", "comfy-cloud": "qwen3vl_4b_bf16.safetensors" },
    "ltx.unet":   { "colab": "ltx-2.5-22b-distilled-transformer-comfy-int8-convrot.safetensors", "comfy-cloud": "same" } }
  ```
- The planner injects the backend-specific names through the existing params mechanism (`*.api.params.json`), so graphs stay identical. `null` means unavailable, and preflight turns that into a routing prompt.
- **Quality check before swapping Klein files**: if Klein comes through Comfy's repackaged files (`flux3-image-klein-bf16` or `-int8-convrot`, `qwen3vl_4b_int8_convrot`), rerun the quality gate on a few stills before calling them equivalent. Int8 vs bf16 and the text-encoder merge may differ [unverified].
- **No partner-node swap for the hackathon.** Later, an `api_ltx2_5_*` / `api_bfl_flux3_*` graph family goes behind a "hosted closed models" toggle.

### 5.5 Spend estimate and consent card changes
- **Generalise the card**:
  - Unit label per backend: Google Colab "units", Comfy "credits ($)".
  - Plan hash includes the backend id, the job list, the alias map hash and the credit budget.
  - Show the plan tier caps (concurrency, 30/60-minute per-job cap).
  - **"No machine to stop: charges stop when jobs finish; Comfyrizz cancels its own jobs on abort."**
  - Data notice: prompts and inputs go to Comfy Cloud.
- **Budget**: reuse `budget.mjs`'s reserve formula in credits (`spent_estimate + committed + next_upper + 0 ≤ budget`). There's no collect-and-stop reserve, because nothing is left running.
  - `spent_estimate` = the sum of per-job GPU-seconds × rate. The balance delta from `billing/usage/timeseries` is invoice-derived and laggy, so use it only as a cross-check.
- **Worked example** for a typical package (20 stills at 0.15 min + 10 plates at 0.5 min + 10 upscales at 0.5 min ≈ 13 GPU-min) [estimate]:
  - **Comfy Cloud**: ≈ 13 min × 0.266 credits/s × 60 ≈ **210 credits ≈ $1.00**, plus unknown cold-load time [rate unverified for Cloud].
  - **Google Colab**: (13 + 4) min at 8.9 units/h ≈ 2.5 units.
  - **Partner path, for contrast**: 10 × 5 s LTX-2.5 Fast 1080p = 1,961 credits ≈ $9.29, plus 20 FLUX 3 Image 1K = 290 credits ≈ $1.37 [verified rates].
- **Subscription**: the card should say plainly that the user needs a paid Comfy Cloud plan ($20/month minimum).

### 5.6 Assets upload and download
- **Inputs**: SDK `assets.from_file` (content-addressed; no re-upload on rerun). SVG-guided rasters and reference images go the same way.
- **Outputs**: `job.get_outputs(node)` → `to_file` into `<runDir>/out`. Then the existing manifest and apply steps run.
- **Never store signed URLs.** If the UI needs a link, mint a fresh one or serve the bytes from our server.
- Cloud retention is "as long as necessary", so we don't rely on it. Optionally delete uploaded input assets after a run (`assets.delete`), behind a setting that defaults to off [inferred].

### 5.7 Settings UI and guided sign-in (next to U2's Google Colab card)
"Comfy account" card, steps:
1. **Create or sign in**: link to https://platform.comfy.org/login.
2. **Plan**: "API access needs a paid Comfy Cloud plan." Link to https://www.comfy.org/cloud/pricing. Creator is needed to import FLUX 3 Klein if Cloud doesn't have it.
3. **API key**: "Click + New under API Keys, copy it now (shown once)". The paste field is masked.
4. **Check**: we call `/api/user` and show ✓ key OK / ✗ invalid (401) / ✗ no active paid plan (429). Then show the balance (cents → $) and the plan concurrency.
5. **Model check**: the preflight table (LTX-2.5 ✓, FLUX 3 Klein ✗ "not on Comfy Cloud yet") with routing choices.
6. **Forget key**, and a "Compliance" chip: "Open-weights graphs only; no partner nodes".

The backend picker becomes: "Google Colab (auto)" · "Comfy Cloud" · "My ComfyUI URL". The default stays Google Colab until Kyle decides.

### 5.8 Tests with a fake
- **Extend `packages/backends/test/bin/v2-stub.mjs` into a Cloud mode**:
  - Bearer required (401), `X-API-Key` on v1 `/api/user`, and 429 for an "inactive" key
  - `/api/experiment/models/{folder}` and `/api/object_info` fixtures
  - v2 assets (`POST /api/v2/assets`, blake3 check) and `core/ASSET` resolution
  - labels refused, and `GET /api/v2/jobs` → 501
  - 402 insufficient credits (no job created, key freed), `QueueFull`, and `JobFailed`
- **Cases**:
  - happy path
  - missing Klein model → preflight excludes, routing offered
  - key never in argv, logs or manifest (spawn-capture + grep)
  - budget refusal before submit
  - abort → our jobs canceled
  - lost runner → reconcile by stored ids
  - redaction of `comfyui-…`
  - plan-hash change on alias map change
- **pipeline-py**: `tests/fake_comfy_server.py` gains `--cloud` (asset API, bearer). Unit tests cover the `v2-asset` upload mode and `job_labels off`.
- **Live** (Kyle-gated, costs money): one smoke run per surface, measuring cold-load seconds and the real credit cost per still and per plate to calibrate `cloudCreditsPerGpuSecond`.

---

## 6. Effort (agent-days)

| Task | Days |
|---|---|
| Cloud backend module + factory wiring + `requiresApproval` from `describe()` | 0.75 |
| Runner: `v2-asset` uploads, `job_labels off`, typed Cloud errors, plan-cap guards | 1.0 |
| Model alias map + preflight (public models + authed `object_info`) + planner param injection | 0.5 |
| Secrets: store, env, redaction, key check via `/api/user`, balance read | 0.5 |
| Spend/consent card generalisation (credits/$, caps, data notice) | 0.5 |
| Settings "Comfy account" card + backend picker + routing prompt for unrunnable jobs | 0.5 |
| Cloud fake (Node stub + Python fake) and test suite | 0.75 |
| Docs: README/BYO-COMFYUI/SPEC updates, rules-fit note | 0.25 |
| **Hackathon total** | **≈ 4.75** (+ about 0.25 of Kyle's time for the live smoke and subscription) |
| Later: partner/Router "hosted closed models" adapter + separate graphs + compliance gating | 2.5–3 |
| Later: Comfy API deployment recipe (Build from `models.lock.json`, deploy docs, labels on) | 1.5 + Kyle's build time |
| Later: Registry node pack (if pursued) | 2+ |

---

## 7. Board tasks I'd create (not created)

1. **CC1 Comfy Cloud backend**: `comfy-cloud-backend.mjs` implementing Backend + `runPackage`; `index.mjs` export; `apps/server` reads `requiresApproval` from `describe()`. Owner: backends.
2. **CC2 Runner v2-asset uploads + Cloud flags**: `--upload-mode v2-asset`, `--job-labels off`, typed 401/402/429/QueueFull mapping, per-job cap guard. Owner: pipeline-py.
3. **CC3 Model alias map + preflight**: `workflows/models.cloud.json`, planner injection, health preflight (public model list + authed `object_info`), and "unrunnable on this backend" reporting.
4. **CC4 Comfy key handling**: settings store (0600), env override, settings API redaction, `redactSecrets` pattern, `assertNoSecrets` tests, `/api/user` check, balance read.
5. **CC5 Spend card for credits**: units/credits/$ labels, plan caps, data notice, credit budget in `budget.mjs`, plan hash includes backend + alias map.
6. **CC6 Settings "Comfy account" card**: guided steps beside U2's Google Colab sign-in card; backend picker adds "Comfy Cloud"; routing prompt for Klein-missing.
7. **CC7 Cloud fakes + tests**: v2-stub Cloud mode and Python fake `--cloud`; full case list in §5.8.
8. **CC8 (Kyle-gated) Live Cloud smoke + calibration**: subscribe (Standard or Creator), run 1 LTX plate + (if available or imported) 1 Klein still; record cold-load and credits; calibrate the rate.
9. **CC9 (Kyle) Discord questions**: Open Weights Only + Comfy Cloud; hackathon Cloud credits; FLUX 3 Klein preinstall ETA on Cloud.
10. **CC10 Docs**: README backend table, `BYO-COMFYUI.md` (Desktop note, proxy findings (a)/(b) now verified), SPEC §5.1/§9 updates, ToS note (own key only).
11. **Later-1 Hosted closed models adapter** (partner nodes / Router), off under `open_weights_only`.
12. **Later-2 Comfy API deployment recipe** + labels-on path.

---

## 8. Open questions for Kyle

1. **Do we add Comfy Cloud for the hackathon at all?** It needs a paid plan: at least $20/month, or $35/month to import Klein. That cuts against "paid providers after the hackathon", but it's Comfy's own service and removes the VM-lifecycle risk from the demo.
2. **Klein on Cloud**: do we (a) pay for Creator and import FLUX 3 Klein from Hugging Face (your HF token goes into Comfy Cloud Secrets), (b) route stills to Google Colab or BYO and plates to Cloud, or (c) wait for Cloud to preinstall it and ship LTX-only on Cloud meanwhile?
3. **Demo default**: should the video show Google Colab (the current plan) or Comfy Cloud? Answer after the Discord reply on Open Weights Only.
4. **Partner nodes / Router stay deferred until after Oct 30?** They'd disqualify Open Weights Only; the LTX bonus doesn't need them.
5. Should "delete my uploaded inputs from Comfy Cloud after a run" be on by default?

---

## 9. Not verified (and how to close each)

- Comfy Cloud `object_info` node list and whether our exact graphs validate there. *Needs a key*: one `GET /api/object_info`.
- Whether FLUX 3 Klein will be preinstalled on Cloud before Oct 30. *Discord, or poll the public model list daily*: `curl https://cloud.comfy.org/api/experiment/models/diffusion_models`.
- Cloud's per-GPU-second credit rate for workflow runtime, and cold-load billing. *Smoke run*.
- How Cloud refuses `metadata` labels (status/code). *Smoke run*; we turn labels off anyway.
- Whether the Hugging Face import works for gated BFL repos with a token in Cloud Secrets, and what filename it produces. *Creator plan test*.
- Pro and Team prices (not rendered in the fetch).
- Whether hackathon entrants get any Comfy Cloud credits, and whether Comfy Cloud counts as a "closed-source API" for Open Weights Only. *Discord*.
- comfy-api-proxy against a non-loopback `--comfyui` URL (SPEC §9 (c)). *A loopback-to-LAN test on any box*.
- Whether `qwen3vl_4b_bf16.safetensors` on Cloud is byte-identical to our merged text encoder.

## 10. Sources (all read Oct 18, 2026)
- SDKs: https://docs.comfy.org/development/api-development/sdks · Design notes: /development/api-development/sdks-design
- API v2: https://docs.comfy.org/api-reference/v2/overview · versions: /development/comfy-api/overview
- v1 Cloud API: https://docs.comfy.org/development/cloud/overview · OpenAPI: https://docs.comfy.org/openapi-cloud.yaml
- Cloud usage/limits: https://docs.comfy.org/development/deploy/cloud-usage · Cloud quickstart: /development/deploy/cloud · Cloud intro: /get_started/cloud · Import models: /cloud/import-models
- Pricing: https://www.comfy.org/cloud/pricing , https://www.comfy.org/pricing
- API key: https://docs.comfy.org/development/api-development/getting-an-api-key · Partner-node key headless: /development/comfyui-server/api-key-integration
- Proxy: https://docs.comfy.org/development/comfyui-server/api-proxy · https://github.com/Comfy-Org/comfy-api-proxy (commit 1569dc1, Aug 27, 2026)
- Comfy API deployments: /development/serverless/overview, /quickstart, /build-sources · /development/deploy/overview
- Partner nodes: /tutorials/partner-nodes/pricing, /concurrency-limits, /faq, /lightricks/ltx-2-5, /black-forest-labs/flux-3-image · Credits: /interface/credits · Retention: /support/data-retention
- Router: /development/comfy-router/limitations, /billing · catalog via https://docs.comfy.org/llms.txt
- Cloud nodes: /cloud-nodes/overview · comfy-cli: /agent-tools/cli, /comfy-cli/reference · Desktop: /installation/desktop/overview, /faq · Registry: /registry/overview · MCP: /agent-tools/mcp
- Templates: https://github.com/Comfy-Org/workflow_templates (`templates/index.json`: `image_flux3_klein_*` dated Oct 15, 2026; `video_ltx2_5_*` dated Aug 11, 2026)
- Live endpoints: `https://cloud.comfy.org/api/system_stats`, `/api/experiment/models/{diffusion_models,text_encoders,vae,latent_upscale_models}` (2:21 PM EDT)
- ComfyUI v0.41.1 tag (node-class grep): https://github.com/comfyanonymous/ComfyUI
- PyPI/npm: comfy-sdk 0.5.0, comfy-api-proxy 0.1.6, comfy-cli 1.22.0, @comfyorg/sdk 0.5.0
- Hackathon: https://comfy.org/open-source-higgsfield/ · https://blog.comfy.org/p/higgsfield-promised-to-open-source (Oct 15, 2026) · https://comfy.org/platform/ · secondary: comfyui-wiki.com (Oct 15), thereelstack.com (Oct 16)
- ToS: https://www.comfy.org/terms-of-service (effective May 13, 2026)
- Repo (read-only): `docs/SPEC.md` §5.1/§6.5/§6.6/§9, `packages/backends/{README.md,src/*}`, `pipeline-py/comfyrizz_pipeline/{client,runner}.py`, `workflows/*.api.json`, `colab/models.lock.json`, `apps/server/src/run.mjs`
