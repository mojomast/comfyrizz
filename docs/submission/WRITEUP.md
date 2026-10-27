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

- **A bounded creative agent.** The model writes a creative plan, not executable
  ComfyUI graphs or spending decisions. Tool arguments and plans are validated;
  generated-film intent requires appropriate motion, references and sound rather
  than accepting FLUX-only stills.
- **A concise proposal.** `proposal.logline`, `look` and `soundtrack` give the user
  a short, accurate creative checkpoint. Revisions preserve the original prompt
  and notes and create no production or paid run.
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
| **Built with FLUX** | Relevant if organizers confirm Klein | Klein identity/keyframe art and reference editing are central. FLUX 3 Image Klein's bonus eligibility needs confirmation. |

One entry can be considered for Best Overall and a model-provider bonus according
to the official FAQ. Do not infer that multiple bonuses are guaranteed.

## Current evidence and remaining work

The web unit suite, focused server suites, browser/capture tests, production
build, TypeScript check and release scan are green. A real no-GPU Easy Studio
brief-to-MP4 path passed. The separate four-route comparison is planned with a
40-credit total ceiling including setup, failures and retries.

Real four-route output quality, native-Windows smoke and final submission media
must be verified before claiming them. See [STATUS.md](STATUS.md) for the
authoritative state, not historical demo notes.

## Run it

**Judges:** open the managed demo link supplied with the submission. Agent
inference, Colab and model access are preconfigured, with server-side rate and
credit limits. No installation or keys are required.

**Self-host users:**

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
