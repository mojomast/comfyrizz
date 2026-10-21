# The video journey: brief to MP4

One path, five stages:

1. **Brief** - say what the film is.
2. **Storyboard** - turn the brief into scenes and a timeline.
3. **Generate clips on Google Colab (GPU)** - render the generated media.
4. **Review takes** - pick and approve one take per clip.
5. **Export the MP4** - render and package the finished film.

Each stage below says what it does, how to drive it (editor or HTTP), what "done"
looks like, and the failure modes you can hit with the recovery for each one.

Only stage 3 needs a GPU and an account. Stages 1, 2, 4 and 5 run locally on the CPU.

## Before you start

| Requirement | Needed for | Notes |
| --- | --- | --- |
| Node.js 22 and pnpm 10 | everything | `pnpm install --frozen-lockfile`, then `pnpm run build:libs` |
| Chrome or Chromium | stage 5 (the final MP4) | the renderer drives a browser to draw the frames |
| ffmpeg | stage 5 (audio muxing), optional elsewhere | `ffmpeg -version` should print a version |
| The official Google Colab CLI | stage 3 | `python3 -m pip install --user google-colab-cli`, verify with `colab version` |
| A signed-in Google Colab CLI | stage 3 | the CLI owns its own credentials; Comfyrizz never reads or stores them |

Start the editor server on a disposable runtime directory:

```sh
COMFYRIZZ_RUNTIME=/tmp/pip-night-shift-demo pnpm --filter @comfyrizz/server start
```

The server prints a loopback URL that carries a session fragment. The fragment is
stripped from the address bar, and the URL must never be pasted into an issue, a
chat or a recording.

The repository also ships a read-only preflight for stage 3:
`scripts/doctor/check-colab-auth.mjs` asks the Google Colab CLI for its usage and
reports whether the CLI is installed and signed in. It never runs the interactive
sign-in command and never prints a credential.

> This checkout is a partial one: the workspace dependencies are not installed and
> the `renderer/` workspace is not part of it, so the editor server cannot start
> here. The API contracts below are the source of truth; the editor walkthrough
> needs a full checkout.

## Stage 1 - Brief

**What it does.** The brief is the single paragraph that decides the film: length,
scenes, look, tone, and what must not appear. It becomes the package that every
later stage reads.

**How to drive it.**

- In the editor: type the brief in the chat panel. The chat posts it to
  `POST /api/agent` and answers with the written package, its revision and the
  compiled timeline.
- Over HTTP: `POST /api/agent` with `{ "brief": "..." }`. The answer carries
  `package`, `revision`, `timeline`, `routes`, `pendingGpu`, `live` and `fallback`.
- The brief panel is a separate, model-free step: `POST /api/brief` with
  `{ "prompt": "..." }` returns the plan plus any clarifying questions,
  `POST /api/brief/outline` returns the beats, and `POST /api/brand` prepares a
  brand kit (palette, fonts, logo) that overrides the brief's look.

**Done when** the package is written and the Player already shows the scenes.
`live: true` in the agent answer means a model provider answered; `live: false`
with `fallback: true` means the scripted CPU path produced the package. That is a
valid result, not an error.

**Offline.** Without a provider key the agent runs the scripted path. The demo can
also replay a recorded conversation with no network at all:

```sh
COMFYRIZZ_LLM_CASSETTE=play:$PWD/examples/pip-night-shift/cassette.json \
  COMFYRIZZ_RUNTIME=/tmp/pip-night-shift-demo \
  pnpm --filter @comfyrizz/server start
```

| Failure mode | Cause | Recovery |
| --- | --- | --- |
| `503 agent runner not configured` | the server was started without an agent runner | restart the server with the standard command above |
| The answer has `fallback: true` and `live: false` | no model provider key is configured | accept the scripted package, or set a provider key and re-run the brief |
| The storyboard comes back empty or too short | the brief left the beats open | re-run with a concrete shape ("about 20 seconds, four scenes, a cafe at dawn") and answer the questions the brief panel asked |
| A brand kit arrives with warnings | the logo or a font was missing | the kit still applies its palette; fix the missing asset and re-post it |
| The agent times out | the provider answered too slowly | re-run the brief; the package store keeps the last good revision |

## Stage 2 - Storyboard

**What it does.** The storyboard is the package compiled into a timeline: the
scenes, their durations, their transitions and the captions under them. Nothing in
this stage needs a GPU.

**How to drive it.**

- The editor compiles automatically whenever the package changes.
- Over HTTP: `POST /api/compile` with `{ "doc": { "package": ..., "editor": ... } }`
  answers with `{ revision, editSequence, inputHash, timeline }`.
- Per-scene edits are deterministic and free: `GET /api/scene/chips` lists the
  scene-local chips (warmer, calmer, more depth, less busy).

**Done when** the timeline compiles without an error, the scene count matches the
brief, and the Player previews every scene. Motion graphics are drawn by the
renderer, not by a model, so they preview on the CPU.

| Failure mode | Cause | Recovery |
| --- | --- | --- |
| `POST /api/compile` answers `400` with a message | the package does not satisfy the current schema (a generated asset without the fields the schema requires, for example) | fix the package in the editor, or start from a fresh runtime directory; the message names the field |
| The Player still shows the old scenes | a stale compile answer won the race | the answer carries `inputHash` and `editSequence`; reload the editor so it compiles again |
| The scene count differs from the brief | the beats came from the brief, not from the package | change the beats in the brief panel and re-compile, or re-run the brief with a clearer beat list |
| A scene previews as an empty frame | the scene has no generated media yet | that is expected before stage 3; the scene still draws its text |
| The timeline length is not what was asked for | the clip durations come from the package | adjust the durations in the package and re-compile |

## Stage 3 - Generate clips on Google Colab (GPU)

**What it does.** This is the only metered stage. The plan is priced first,
approved by a human, and only then does a Google Colab runtime come up, generate
the missing clips and go away again.

**Preflight.**

```sh
colab version     # the CLI is installed
colab usage       # the CLI is signed in and prints the remaining compute units
```

If `colab usage` prints no balance, the CLI is installed but not signed in, and
every Google Colab run will fail at allocation. Sign in with the CLI's own
sign-in command; the credential stays with the CLI.

**How to drive it.**

1. Plan: `POST /api/run` with `{ "packageId": "...", "backendId": "colab",
   "budgetUnits": 100 }`. The answer is a plan: `planHash`, `estimate`, `budget`,
   `jobs` and `approvalRequired: true`. A dry plan starts nothing and costs
   nothing.
2. Approve: `POST /api/run/approve` with `{ "planHash": "..." }`. You are approving
   that estimate.
3. Run: `POST /api/run` again with `approved: true` (or the same `planHash`).
   The answer carries `runId`.
4. Watch: `GET /api/events` streams server-sent events - `run.budget`,
   `run.started`, `run.event`, `clip.job` per clip, `run.approved`. The stream
   resumes from `last-event-id` if the connection drops.
5. Collect: `GET /api/run/<runId>` for the run record, and
   `GET /api/run/<runId>/video` for the MP4 once the run finished rendering (it
   answers `404` until then).

Two modes: `mode: "final"` generates the whole package, `mode: "take"`
regenerates a single clip. To re-render one scene without regenerating media,
`POST /api/scene/plan` is a free dry plan and `POST /api/scene/render` re-renders
that scene only, reusing every cached segment whose key did not change.

Bring your own ComfyUI instead (`backendId` for your own instance and a
`comfyuiUrl`) and the run never asks for approval: the compute is yours and
Comfyrizz does not meter it.

**Done when** the run record reports `done`, every planned clip is attached to its
scene, and the review bar in stage 4 lists the new takes.

| Failure mode | Cause | Recovery |
| --- | --- | --- |
| The plan comes back with `approvalRequired: true` | Google Colab is metered, so a human approves the spend | approve the `planHash`, then run again; the estimate you approve is the one that runs |
| The plan comes back with `refused: true` | the estimate does not fit the budget | raise `budgetUnits`, or generate fewer clips; a dry plan is free, so re-plan before spending |
| `409 run busy` | a run is already active | wait for it (`GET /api/run` shows the active run) and start again |
| `409 pipeline busy` | a pipeline is using the same account | wait for the pipeline to finish; a run cannot start while one is active |
| The run fails at preflight with a missing-CLI message | the Google Colab CLI is not installed | install it, then re-run |
| The run fails at allocation | the CLI is installed but not signed in | sign in with the CLI, then re-run; nothing was spent |
| The run fails with a quota or entitlement error | the account cannot afford or may not use that runtime | check the remaining compute units with `colab usage`, generate fewer clips, or use a different runtime |
| The teardown reports `stop_unconfirmed` | the runtime could not be confirmed as stopped | check the account in the Google Colab console before starting another run |
| One job failed and the manifest is incomplete | a clip failed on the runtime; the run is reported as failed even though the box came up and went down cleanly | regenerate that clip only (`mode: "take"`, or the regenerate route in stage 4) and re-run the plan |
| The run record reports `render_failed` | the media succeeded but the end-to-end request produced no video | the clips are safe; render the film on the CPU in stage 5 |
| The run dies mid-way | the runtime or the network dropped | the run record shows `failed`; start a new run once the previous one is gone, and plan again so the estimate still matches |

## Stage 4 - Review takes

**What it does.** A clip is only finished when one of its takes is selected *and*
that take is approved. The gate that guards the render is exactly that rule.

**How to drive it.**

| Route | What it does |
| --- | --- |
| `GET /api/package/<packageId>/clips` | the clip list with each clip's state |
| `GET /api/package/<packageId>/clips/<clipId>/takes` | the takes of one clip |
| `POST /api/package/<packageId>/clips/<clipId>/verdict` | set the verdict of a take (`unreviewed`, `approved` or `rejected`) with an optional note of up to 1000 characters |
| `POST /api/package/<packageId>/clips/<clipId>/select` | choose the take the clip uses |
| `POST /api/package/<packageId>/clips/<clipId>/revert` | go back to the previous selection |
| `POST /api/package/<packageId>/clips/<clipId>/regenerate` | generate a new take on Google Colab (costs compute) |

**Done when** the render bar reads "all clips approved" and the Render button is
enabled.

| Failure mode | Cause | Recovery |
| --- | --- | --- |
| The gate stays locked after approving | the approved take is not the selected one, or the asset was regenerated after the verdict, so the take no longer matches the current generation | select the approved take, and approve it again if the asset changed |
| `409 CONFLICT` or `409 NO_PREVIOUS_TAKE` | the take sidecar moved under you | re-read the clip and retry the verdict against the current take ids |
| `400 INVALID_VERDICT` or `400 INVALID_TAKE_ID` | the verdict vocabulary is fixed and the take id must exist | use `unreviewed`, `approved` or `rejected`, and copy the take id from the takes route |
| A rejection is accepted but nothing changes | a rejection without a correction note tells the next generation nothing | attach the note ("keep the yellow jacket, slower entry") and regenerate |
| The take does not play in the editor | media is served through a ticket | a missing ticket means the file is gone from the runtime; regenerate the media |
| The regeneration is more expensive than expected | a regeneration is a Google Colab run | plan it first and approve the estimate, exactly as in stage 3 |

## Stage 5 - Export the MP4

**What it does.** The render draws the timeline and muxes the audio; the export
writes the redistribution bundle next to it.

**How to drive it.**

- Render: `POST /api/render` with `{ "packageId": "..." }` answers with the MP4
  stream and the headers `x-comfyrizz-render-id`, `x-comfyrizz-timeline-sha256` and
  `x-comfyrizz-frames`.
- Export: `POST /api/export` with `{ "packageId": "..." }` writes the bundle -
  `video.mp4`, `captions.srt`, `captions.vtt`, `CREDITS.md` and `package.zip`
  (plus `captions.words.vtt` when word timings exist) - under
  `<runtime>/out/export/<packageId>`, next to the social cutdowns. The answer
  carries `dir`, `files`, `frames`, `captions`, `social`, `complete`, `included`
  and `excluded`.
- One scene at a time: `POST /api/scene/render` (see stage 3).

Both routes pass through the approval gate. `409 RENDER_GATE_BLOCKED` names the
clips that still need a verdict; `override: { "reason": "..." }` (4 to 500
characters) renders anyway and the override is recorded on the package.

**Done when** the MP4 plays end to end, the captions line up with the narration,
and `CREDITS.md` lists every asset in the bundle.

| Failure mode | Cause | Recovery |
| --- | --- | --- |
| `409 RENDER_GATE_BLOCKED` | a clip is still unapproved | finish stage 4, or pass an override with a reason |
| `409 render busy` or `409 export busy` | one render or export runs at a time | wait for the running one to finish |
| `409 conflict` with a current revision | the package changed while the request was in flight | re-read the package and retry with the current `baseRevision` |
| The render fails with a missing browser or a missing ffmpeg | the renderer needs Chrome or Chromium to draw the frames and ffmpeg to mux the audio | install the browser and ffmpeg, then render again |
| The MP4 has no sound | the music bed or the effects were not generated | the audio is synthesized locally by the demo scripts; generate it, then render again |
| The captions are empty | the package carries no narration | add the captions to the package and re-export |
| `complete: false` or a non-empty `excluded` list | assets whose licence does not allow redistribution are left out on purpose | check `CREDITS.md`; `package.zip` carries only the assets that may be shared |
| The MP4 does not match the current package | the package changed after the render | compare the `x-comfyrizz-timeline-sha256` header with the package revision and render again |

## Recovery playbook

| Symptom | First move |
| --- | --- |
| The render is locked and the bar shows fewer approvals than clips | stage 4: approve the selected take of every clip |
| A Google Colab run will not start | `colab version` and `colab usage`; install the CLI or sign in |
| A run was refused | re-plan with a higher budget or fewer clips; the dry plan is free |
| The server was started against a stale runtime | point `COMFYRIZZ_RUNTIME` at a fresh directory and restart |
| A stage-4 verdict keeps conflicting | re-read the clip: the take ids and the asset generation moved |
| The export is missing an asset | read `CREDITS.md`; the asset may be excluded on purpose |

## What this journey does not cover

- Bring-your-own ComfyUI: it replaces stage 3 and never asks for approval.
- Live model chat: the brief stage works offline with the scripted path or the
  recorded cassette.
- Variant exports: `POST /api/export` also accepts a `variants` object and writes
  one bundle per language and aspect variant, with a `variants.json` manifest.
- The recorded activity panel: the Google Colab history in the demo is a replay of
  a past run, not a live connection.
