# ComfyRizz: one prompt to an editable generated film

## What it is

ComfyRizz turns a short brief into a watchable, editable film. It is for creators
who want a strong first result without learning node graphs, production journals
or a timeline first. A concise creative proposal appears before any paid work;
the user can revise it or choose **Make this film**. Real assets appear while the
film is being made, and the finished MP4 can be downloaded or changed with the
agent.

The app is MIT-licensed, runs as a browser UI plus a local Node server, and uses
ComfyUI workflows through the Comfy SDK on Google Colab or a user's ComfyUI. The
primary setup path covers Linux and native Windows; see [One prompt setup](../ONE_PROMPT.md)
for current validation limits.

## A generated film without owning a GPU

**Google Colab is the default managed inference path.** ComfyRizz makes the cloud
GPU part of the filmmaking flow: after one-time account/model-access setup and
production approval, it allocates the accelerator, deploys ComfyUI with its
dependencies and pinned models, checks readiness, runs the workflows, collects
the media and shuts down the runtime with confirmation. Creators can direct the
film from an ordinary laptop without installing CUDA, storing GPU model weights
locally or manually operating a notebook for each production.

Eligible Google AI Pro subscriptions include Colab compute units. Google's
[current benefits page](https://support.google.com/googleone/answer/14534406?hl=en)
lists **200 CCUs**, while the separate
[Colab Pro plan](https://colab.research.google.com/signup) advertises **100 units
per month** (checked 2026-10-29). Actual account eligibility and allowance govern
usage. Units cover runtime consumption—including setup and downloads—not a
promised number of films. Agent-provider charges are separate. ComfyRizz checks
the available balance and production estimate against the user's budget ceiling.
See [Colab automation](../features/google-colab.md).

## Four ways to make a film

Before planning, the user selects a structured motion route:

- **Auto:** FLUX 3 Image Klein for identity/keyframe art, LTX-2.5 for establishing
  shots, scenery and camera motion, and MiniMax H3 for recurring character acting,
  physical action and native sound.
- **MiniMax H3:** recurring characters, reference-driven motion and native audio.
- **LTX-2.5:** cinematic motion plates.
- **Klein only:** FLUX 3 Image Klein stills, code-driven camera moves, transitions
  and timing, plus finishing sound. It is an image-driven film, not a claim of full
  generated character animation.

Model substitution is not hidden: the choice persists and appears in the proposal.

## How it is built

- **A Pi-powered bounded creative agent.** Pi 1.4 coordinates initial planning,
  chat, proposal/narration revisions, repairs and continuation through the existing
  provider transport. Configured DeepSeek Flash routes now use a 65,536-token output
  allowance. The model writes a creative plan, not executable
  ComfyUI graphs or spending decisions. Tool arguments and plans are validated;
  generated-film intent requires appropriate motion, references and sound rather
  than accepting FLUX-only stills.
- **A concise proposal.** `proposal.logline`, `look` and `soundtrack` give the user
  a short, accurate creative checkpoint. Revisions preserve the original prompt
  and notes and create no production or paid run.
- **Exact custom timing.** Super Easy retains the 15/30/60/90-second presets and
  adds exact custom durations from 1–120 seconds. Infeasible shot/narration bounds
  are rejected rather than silently changing the requested duration.
- **Pinned ComfyUI workflows.** Ordered, hashed jobs use model-specific graphs and
  prompt contracts. Only scene-reachable assets and their reference/audio
  dependencies become jobs; orphan restyles cannot consume budget.
- **Server-priced execution.** A whole-production final action uses the same
  dry-run estimate as execution, including setup overhead. A saved per-video cap
  limits spend, while production approval, reservations and settlement remain
  server-owned.
- **Deterministic finishing.** Remotion draws exact typography, charts and
  captions. Generated media is assembled at natural speed; no image model invents
  a chart number or title. Native audio is required even for wordless H3 films.
- **Verified generated-media delivery.** Every final production video must visibly
  use eligible ComfyUI output from a verified supported model. Server-owned
  generation receipts bind jobs/workflows to collected bytes; render receipts bind
  those contributions to the delivered video. Cached exports and final pipeline
  downloads are checked too. CPU-only diagnostics and unused references do not qualify.
- **Live evidence and recovery.** The gallery uses real clip/take routes and
  expiring media tickets. Durable journals, package revisions, collected hashes,
  bounded retries and verified runtime teardown make execution inspectable.
- **Agent-led editing.** Result chat adopts the existing package with stable scene
  IDs and revision checks. Advanced mode adds shots, takes and timeline editing.
  Subsequent paid regeneration remains explicit.

## Why it is innovative

The innovation is not merely “an agent plus video generation.” ComfyRizz separates
creative direction, model-specific media generation and exact editorial finishing
in one usable app. It combines per-shot H3/LTX/Klein routing, a short user-approved
creative contract, reachable-asset budgeting, deterministic type/data rendering,
and same-project agent edits with source provenance and verified compute teardown.

Managed Colab deployment removes another practical barrier: access to these media
models does not depend on owning a high-end graphics card or maintaining an
inference server. The app connects the creative workflow to cloud compute already
available through an eligible account, with a visible budget and runtime lifecycle.

That claim should be demonstrated visibly: one prompt and model choice, proposal,
live generated assets, a finished film, then a scoped agent change. Architecture
slides and model checkboxes are not enough.

## Categories and bonuses

| Target | Priority | Evidence to show |
| --- | --- | --- |
| **Best Overall** | Primary | One-prompt usability, output quality, reliable delivery and editing. |
| **Most Innovative** | Secondary | Per-shot model routing plus deterministic finishing, reachable-asset pricing and same-project revision. |
| **Most Viral** | Secondary | A strong result people want to share, a short setup and an immediate downloadable MP4. No official view threshold is assumed. |
| **Open Weights Only** | Conditional | The entire critical path, including the agent and every dependency, must comply. A hosted closed agent API disqualifies that path. |
| **Built with MiniMax H3** | Relevant for H3/Auto | H3 character acting and native audio must be central and audible in the demo. |
| **VFX Workflow Built with LTX** | Relevant for LTX/Auto | LTX must be the core video model for the claimed workflow; motion-graphics eligibility is not assumed. |
| **Built with FLUX** | Relevant for Klein/Auto | Official Comfy documentation identifies Klein as FLUX.3. Show that its output is core to the workflow; family mapping alone does not establish bonus eligibility. |

One entry can be considered for Best Overall and a model-provider bonus according
to the official FAQ. Do not infer that multiple bonuses are guaranteed.

## Current evidence and remaining work

As of **2026-10-29**, the Pi migration and contribution gate have focused test
coverage; web reconciliation passed 1,607 tests, typecheck and build. Broad server
reconciliation is still awaiting its final complete result. The exact-duration
controls and 64K provider request configuration have automated coverage.

A current, receipt-backed ComfyUI generation → visible final use → export →
Download → live chat revision journey is still pending. Earlier CPU films and
scripted-provider tests are development evidence, not acceptance of that journey.
Additional live Super Easy prompts reached proposals but exposed placement,
styling and copy failures; a proposal is not a finished film. The current campaign
has a 60-credit authorization, with a separate 10-credit ceiling for the two-minute
documentary attempt. Older 40-credit campaign notes are historical.

See [Deadline handoff](DEADLINE_HANDOFF.md) and the
[live reliability log](SUPER_EASY_24H_PLAN.md) for dated results and artifact status.
Final submission media, hosted-demo readiness, exact-revision clean-checkout
reproducibility and native-Windows smoke remain to be verified.

## Run it

**Judges:** the intended entry point is the managed demo link supplied with the
submission, with agent inference, Colab and model access preconfigured and
server-side rate/credit limits. The public URL and live generation must be
verified before describing the deployment as ready.

**Self-host users:**

Use Node.js **22.19.0+**, pnpm 10 and the rendering/Python dependencies in the setup guide.

```sh
pnpm install --frozen-lockfile
pnpm -r --if-present run build
npm --prefix apps/server start
```

Open the printed loopback URL. Setup, model selection and the first real run are
covered in [docs/ONE_PROMPT.md](../ONE_PROMPT.md). For the no-spend capture fixture:

```sh
pnpm capture:procedure
```

The fixture is labelled as mocked. It is not a substitute for a real generated
example.
