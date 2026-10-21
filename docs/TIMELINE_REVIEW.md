# Timeline review: user guide and 60-second demo

Timeline review is the step between "the generated media came back" and "render the
video". Every generated clip gets a list of **takes**. You watch the selected take in
the normal browser preview, compare it with the one before it, write a correction for
the one clip that is wrong, and approve each clip. Only then does the final render
start, unless you override the gate with a written reason.

This guide matches the `TIMELINE-REVIEW` implementation (TR00-TR19). The design and
resolved decisions are in [the feature spec](specs/TIMELINE_REVIEW.md). Narration and
TTS are out of scope: narration already has its own takes in the editor sidecar.

## 1. The loop

1. Run a media plan on Google Colab or your own ComfyUI. The outputs land on the
   timeline as **take 1** of each generated clip.
2. Open **Takes** in the inspector. Watch the clip in the Player, compare takes, and
   write a correction such as "slower push-in, keep the logo readable, no people".
3. Regenerate. Only that clip is planned (`planJobs({assets:[assetId]})`) and only a
   new take is added; every other clip is untouched.
4. For Google Colab, approve the spend **for that regeneration**. The estimate and
   plan hash are shown before anything runs.
5. A/B the new take against the old one in the Player. Approve one take per clip.
6. When the render bar says `n/n clips approved`, render the final MP4. The selected
   takes are now the package's normal asset files, so local and Colab renders consume
   exactly what you previewed.

A take is a complete replacement for one clip. There is no partial-segment retake and
no generative extend; see [Limits](#9-limits).

## 2. Generate, then open review

Start the local server the same way as the rest of the app:

```bash
pnpm install --frozen-lockfile
pnpm -r --if-present run build
pnpm run doctor --offline
npm --prefix apps/server run start
```

Open the loopback URL the server prints. The server enforces loopback `Host`/`Origin`
and puts the session token in the URL fragment (`#token=...`). The same token is in
`apps/server/.runtime/server-token` (mode 0600). Keep the token out of screenshots,
logs, pasted commands, and terminal output. The browser client attaches it to every
`/api/` request; media is read through short-lived tickets, never by guessing a package
path.

The first time a clip is read, a ready generated asset is **adopted as take 1** with
`by: 'initial'`. That take is `unreviewed`, so an existing generated project starts in
`review`, not `approved`. Uploads, references and SVGs have no `gen.generator` and are
not reviewable clips.

Only assets with generated media are clips. A package asset used in two scenes
produces two clip ids that share one take list:

- `clipId = <sceneId>:<assetId>`, for example `s2:a_plate2`.
- URL-encode the colon when it is part of a path: `/clips/s2%3Aa_plate2/...`.

## 3. States and badges

The state is derived from the selected take, the last job and the asset's current
`gen`. It is never hand-set. The same eight states drive the timeline chip badge and
the Takes tab header, and the inspector's **Clip** menu shows `clipId · state`.

| State | Meaning | Badge on the timeline | Tone |
| --- | --- | --- | --- |
| `planned` | No take yet, no job | `planned` | neutral, dashed border |
| `queued` | A regenerate is waiting for the active run to finish | `queued` | neutral |
| `generating` | A run containing this asset is active | `generating` plus a progress bar | blue |
| `review` | The selected take is `unreviewed` | `review` | amber |
| `approved` | The selected take is `approved` | `✓` | green |
| `rejected` | The selected take is `rejected` and no newer take exists | `rejected` | red |
| `failed` | The last job failed and no take from that run landed; the previous take, if any, stays selected | `!` (hover for the runner message) | red |
| `stale` | The selected take's `gen` differs from the asset's current `gen` | `stale` | amber stripe |

The chip's accessible name also carries the take counter and the state, for example
`Scene 2 background, take 3 of 3, +1 new, approved`. The chip shows:

- `take 3 of 3` when a take is selected;
- `+1 new` when an unreviewed take landed beside an approved one;
- a progress bar only in `generating`; the progress is indeterminate until the run
  reports a value.

Transitions are `planned -> queued -> generating -> review`; `review -> approved` or
`review -> rejected`; any state can go back to `queued` when a regenerate is waiting
for the runner; a failed run becomes `failed` without losing the previous take.

A regeneration that is waiting for **spend approval** is not a clip state. The clip
stays where it was (usually `review`) while the approval card is open; `queued` is only
for a regenerate that the server accepted but cannot start because another run is
active.

Three rules are worth knowing before you approve anything:

- **A new take never replaces an approved one.** It lands as `unreviewed` beside it,
  the clip stays `approved`, and the chip gains `+1 new`. Selecting the new take moves
  the clip to `review`; the old approval does not transfer.
- **Approval is per take.** Approving take 2 does not approve take 1. If you revert to
  take 1, its old verdict applies again.
- **Stale is not approved.** If someone edits the prompt, seed, inputs or workflow
  hash after a take was approved, the selected take no longer matches the asset. Use
  **Use take N** to re-apply that take's generation fields, or regenerate.

In the current shell the guaranteed review surface is the inspector's **Takes** tab
(the **Clip** menu lists every reviewable clip and its state). The timeline chip
renderer uses the same badges and, when the shell supplies the clips map, `[` and `]`
cycle takes and `A` approves the focused chip. Timeline trimming keeps its normal
`[`/`]` behaviour when no clip chip has focus.

## 4. Correct one clip

### 4.1 From the Takes panel

1. Open **Takes**, choose the clip in the **Clip** menu.
2. Watch the selected take. Click another take card to preview it (A/B), then click
   **Preview selected take** to return.
3. In **Correct this clip**, write a **Correction note** and, optionally, one
   structured change. The current take is always kept.
4. Click **Regenerate this clip**. The response includes the exact diff; once the take
   lands, the diff view shows the correction against the previous take. On Google Colab
   the panel first shows **Approve the regeneration** with the estimate and plan hash.
5. Approve the spend if asked. The new take appears in the strip when it lands; the
   old one is still there.

The correction fields:

| Field | Effect | Notes |
| --- | --- | --- |
| Correction note | Human record of why this take exists; stored on the take | Up to 1000 characters; it is data, never an instruction to the server |
| Prompt append | Appends to the workflow's prompt input with a space | Use this for the smallest fix |
| Prompt replace | Replaces the prompt input | Do not use together with append |
| Negative append | Appends to the negative prompt with `, ` | Use for things that must not appear |
| Seed | `new` (default), `keep`, or a fixed integer `0..4294967295` | `new` derives a different deterministic seed, so the take differs; `keep` is for "same render, different inputs" |
| Inputs | Allow-listed workflow parameters only | `reference`, `reference_2` to `reference_10`, `image`, `strength`, `denoise`, `motion.*`; only keys the workflow actually declares |

Anything outside the allow-list is rejected with a 400 and a code such as
`INPUT_NOT_ALLOWED` or `INPUT_UNSUPPORTED`. The panel also caps each prompt field at
2000 characters. The seed changes by default; choose **Keep seed** when the change is
in a reference or a strength value and you want the same starting noise.

The returned `diff` names exact JSON paths, for example:

```json
[
  {
    "path": "gen.inputs.prompt",
    "before": "slow aerial over the turbine field at sunrise",
    "after": "slow aerial over the turbine field at sunrise, clean negative space in the top right for the logo"
  },
  {
    "path": "gen.inputs.negative",
    "before": null,
    "after": "busy background, text, watermark, people"
  },
  {
    "path": "gen.inputs.seed",
    "before": 1042,
    "after": 3847291055
  }
]
```

### 4.2 Correction examples

These are written the way the panel expects: a short note plus the smallest structured
change. The workflow still decides what the model can do; a prompt cannot add a camera
move to a still workflow that has no motion parameters.

**Too busy, logo lost** (background plate):

```json
{
  "change": {
    "note": "Scene 2 is too busy and the logo is lost; keep the top right clean.",
    "promptAppend": "clean negative space in the top right for a logo, uncluttered background",
    "negativeAppend": "busy background, text, watermark, people, clutter",
    "seed": "new"
  },
  "backendId": "colab",
  "budgetUnits": 8
}
```

**Push-in is too fast** (motion plate):

```json
{
  "change": {
    "note": "Slower, steadier push-in; no whip pan and no zoom past the product.",
    "promptAppend": "slow steady push-in, gentle camera move, keep the product centred",
    "negativeAppend": "whip pan, fast zoom, camera shake",
    "seed": "new"
  }
}
```

**Framing is right, only the grade is wrong** (keep the seed):

```json
{
  "change": {
    "note": "Keep this framing and motion; only warm the grade and lift the shadows.",
    "promptAppend": "warm grade, soft lifted shadows, natural skin tones",
    "negativeAppend": "green cast, crushed blacks",
    "seed": "keep"
  }
}
```

**Same shot with a stronger reference** (structured input):

```json
{
  "change": {
    "note": "Follow the reference more closely but keep the logo readable.",
    "inputs": { "strength": 0.62, "reference": "assets/ref_logo.png" }
  }
}
```

Only use `inputs` keys that the asset's workflow params declare. If `strength` is not
declared, the server refuses the correction instead of silently ignoring it.

**Fixed seed for a reproducible comparison**:

```json
{
  "change": {
    "note": "Reproduce the last take exactly; only the reference strength changes.",
    "inputs": { "strength": 0.5 },
    "seed": 1042
  }
}
```

### 4.3 Correct several clips before one Colab boot

Use **Regenerate** per clip in the panel, or the batch route to plan several
corrections into one run. The batch shares one Colab boot, one estimate and one
`planHash`, while each item keeps its own correction and diff:

```http
POST /api/package/launch-demo/clips/regenerate-batch
Content-Type: application/json

{
  "items": [
    {
      "clipId": "s2:a_plate2",
      "change": {
        "note": "Less busy behind the logo.",
        "negativeAppend": "busy background, text, people",
        "seed": "new"
      }
    },
    {
      "clipId": "s5:a_plate5",
      "change": {
        "note": "Slower push-in.",
        "promptAppend": "slow steady push-in",
        "seed": "new"
      }
    }
  ],
  "backendId": "colab",
  "budgetUnits": 12
}
```

The batch accepts at most 50 items and refuses a batch that repeats the same asset.
A clip corrected twice in one batch is a mistake, not two takes.

### 4.4 Correct by chat

The chat agent has clip tools, but it can only **propose**:

| Tool | What it returns |
| --- | --- |
| `clip_list {}` | Compact rows: clip id, scene, slot, kind, state, take count, selected take, last correction |
| `clip_get {clip_id}` | Prompt, seed, inputs, takes, corrections, verdicts, diff against the previous take |
| `clip_propose_correction {clip_id, note, prompt_append?, prompt_replace?, negative_append?, seed?, inputs?}` | A proposal with the exact diff; never starts a run or estimates spend |
| `clip_propose_select {clip_id, take_n, reason}` | A proposed selection |
| `clip_propose_verdict {clip_id, verdict, reason}` | A proposed approved/rejected verdict |
| `clip_render_readiness {}` | The gate result, so the agent can say how many clips still need review |

Example conversation:

> **You:** Scene 2's background is too busy and the logo is lost. Keep the logo
> readable, add clean space top right, no people.
>
> **Agent:** I would change only `s2:a_plate2`. Append "clean negative space in the
> top-right for a logo, uncluttered background", append "busy background, text,
> watermark, people" to the negative prompt, and use a new seed. That is a new take;
> take 1 stays. Shall I propose it?

The agent is told to name the clip, prefer append over replace, keep the seed only
when asked, batch several corrections, and never approve on your behalf. A proposal is
not applied by the model's reply and it carries no spend estimate; the estimate is
returned when the confirmed correction is planned. Confirmation happens through the
user's action:

- in the browser, apply the proposed change in the Takes panel (the guaranteed
  confirmation surface in this shell), or
- for API/automation, send the proposal id in `confirmClipProposals` on
  `POST /api/agent/chat`. The server applies it through the same take functions as
  the routes above, and a Colab proposal still stops at `approval_required`.

The agent sees at most 40 clip rows in its manifest; on a larger project, name the clip
or scene so it can read that one. The chat endpoint requires a configured provider and
model in Agent settings. The bundled scripted model is for planning and does not call
clip tools; use a tool-capable provider for a live chat correction. No confirmation
means no run.

## 5. Spend approval

Google Colab spend is approved **per regeneration**. There is no blanket approval and
the chat agent cannot approve.

1. `POST .../regenerate` (or the batch route) returns
   `kind: "approval_required"`, a 64-character `planHash`, `estimate` and `budget`.
   Nothing has run and nothing has been charged; the clip keeps its previous state
   while the approval card is open.
2. The panel shows **Approve the regeneration**, the estimate (`GPU min`, `min
   overhead`, budget units when present) and the plan hash.
3. **Approve and regenerate** calls `POST /api/run/approve` with the plan hash, then
   re-sends the same regenerate request with `approved: true`.
4. Re-sending the same change and budget gives the same plan hash. Any change to the
   jobs or budget gives a new hash, so a stale approval cannot pay for a different
   plan.
5. A budget that is not allowed comes back as `kind: "refused"` with the budget
   details; the clip stays as it was.

The approval response is:

```json
{ "planHash": "<64 hex characters>", "approved": true }
```

For your own ComfyUI the run is `external`: Comfyrizz does not meter it, so there is no
spend approval step, but the correction and take flow are identical. Only Colab
returns `approval_required`.

## 6. Review: A/B, select, approve, reject, revert

The take strip is a list of cards, one per take, with its number, duration, verdict
and correction note. Clicking a card previews that take in the Player without
selecting or approving it. That is the A/B: click take 1, then take 2, compare in
context, then click **Preview selected take** to stop previewing.

- **Use take N** writes that take's `file`, `sha256`, `bytes`, `media` and `gen` into
  the package asset. This is the selection; it is what the final render will use.
- **Approve** sets the selected (or previewed) take's verdict to `approved`. It does
  not change which take is selected.
- **Reject** sets the verdict to `rejected`. The take stays on disk so you can compare
  it; write a correction and regenerate to get a new one.
- **Revert** restores the previous selection from the clip's selection history. It is
  a stack: repeated reverts walk further back. If there is no previous take, the route
  returns 409 `NO_PREVIOUS_TAKE`.
- `unreviewed` is a valid verdict in the model (and is what a new take starts as), but
  the panel's normal actions are Approve and Reject. A clip with no verdict is never
  treated as approved.

Approving a take that is not selected is allowed by the API (`takeId` in the verdict
body); the panel approves the take currently shown in the preview so the verdict and
the picture match. When in doubt, select first, then approve.

## 7. Preview vs final render

| | Preview | Final render |
| --- | --- | --- |
| What runs | The browser Player with the same `PackageComposition` as the MP4 | Remotion on CPU, or the Google Colab remote render path |
| Which media | The selected take, or the take you click for A/B, through a short-lived media ticket | The selected take's file, now written into the package asset by `selectTake` |
| Cost | No render, no Colab spend; only a media ticket | Normal render cost and time |
| Timing | Never changes: swapping a take only changes `asset.file`/`media`; scene `from`/`durationInFrames` come from the compiled timeline | Never changes for a take swap; a take of a different length is fitted (trimmed to the clip's frames, or the last frame is held), the same way the renderer already fits plates |
| Output | Instant in the Player; optional **Render changes** for a true pixel check of one scene | The MP4 (and the export bundle/social cuts from the existing export flow) |

`previewPackage(pkg, clips, {abTake})` is pure: it clones the package, swaps only the
chosen clip's asset file/media to the ticket URL, and never mutates the document or
recompiles the timeline. Clearing A/B restores the selected take. The final render does
not read the preview object at all; it reads the package whose selected take was saved.

A regenerate run is a **take-mode** run. It ingests the outputs as takes, applies the
selection to the package, publishes `clip.take.landed`, and returns `render: null`; it
does not run the automatic full render that a normal completed media run does. The full
MP4 is only produced later, by you, through the gate.

The 1920x1080 export still prefers `variants.upscaled` when an upscale job ran for the
approved take (the existing H12 rule). Selecting a take with a different sha drops an
old upscaled variant whose base sha no longer matches, so you never get an upscale of a
take you did not approve.

The final render is gated:

- `POST /api/render` checks the gate before rendering.
- `POST /api/pipeline` (everything except `/api/pipeline/plan`) checks the same gate.
- `GET /api/package/:id/clips` is the source for the render bar's `n/m clips approved`.
- A blocked request returns 409 `RENDER_GATE_BLOCKED` with `approved`, `total`,
  `blocking[]`, and publishes `render.gate.blocked`. The render bar lists the blocking
  clips; clicking one jumps to it in the Takes tab.

A `stale` clip blocks the gate too, even if its old take was approved. Re-select the
take or regenerate.

## 8. Override

If you must render before every clip is approved, the render bar offers **Render
anyway**. It opens **Override reason** and **Render with override**.

- The reason must be 4 to 500 characters (the trimmed reason must be at least 4; the
  raw reason cannot exceed 500). A blank, short or too long reason is refused
  (`INVALID_OVERRIDE`, 400) and the render does not start.
- A valid reason is appended to `runtime/takes/<pkgId>.json` under `overrides` with
  `at`, `reason` and the package `revision`; no take verdict is changed.
- The request publishes `render.gate.override` with the reason and the blocking clips.
  A blocked request without a reason publishes `render.gate.blocked`.
- Override is **not approval**. The render still uses whatever take is selected for
  each clip; the override just records that you chose to ship with those selections.

API shape:

```json
{
  "packageId": "launch-demo",
  "baseRevision": 12,
  "override": { "reason": "Client approved the rough cut for an internal review; scene 2 is known." }
}
```

`override` must be an object with a string `reason`. If `override` is present but
invalid, the response is 400 rather than silently rendering. The same body works on
`/api/pipeline`.

## 9. Limits

These are deliberate, not unfinished edges to work around:

- **No partial retake.** A correction regenerates the whole clip. There is no
  region/segment retake, no "retake from frame 40", no generative extend, and no
  in-place trim that changes the take's source. If only two seconds are wrong, you
  still get a new whole-clip take. The workflow set has no partial-retake graph.
- **Cap: 12 live takes per asset** (`MAX_TAKES_PER_ASSET`). When a thirteenth take
  lands, the store purges the **oldest rejected, unselected** take: its file is
  deleted and its metadata is kept with `purged: true`. Approved, selected and
  unreviewed takes are never the victim. If every take is selected or not rejected,
  nothing is force-deleted; the cap never silently discards work you have not
  rejected.
- **One take list per asset.** An asset reused in two scenes shares its takes; the
  timeline shows two clips, but selecting or approving the take affects both. The gate
  counts both clips.
- **One active run at a time.** Regenerating while a run is active returns `queued`
  (202) and is recorded in the sidecar; it is drained when the active run ends, not
  refused. The UI shows `queued` rather than pretending the take is generating.
- **No narration/TTS takes.** This feature is for generated media assets only.
- **No take branching.** One linear list of takes per asset; no trees, no named
  variants, no multi-user comments.
- **Disk grows with takes.** Take files live under
  `runtime/packages/<pkgId>/takes/<assetId>/`; duplicates by sha are deduplicated, and
  the cap purge is the only automatic cleanup.
- **The preview is not a render.** It uses browser media tickets and the Player; use
  **Render changes** (scene render) when you need a real encoded frame check before
  the final render.
- **User text is data.** Correction notes, prompts and reference notes are never
  treated as instructions to the server or the agent. The agent's system prompt fences
  them in `<project_context>`.

## 10. HTTP routes

The routes below use the server's normal `/api/` auth; the media URL returned by the
ticket route is the credential for that one file. The clip routes are mounted before
the generic 404 and return `false` for paths they do not own. `:id` is the package id;
`:clipId` is `<sceneId>:<assetId>` (URL-encoded, e.g. `s2%3Aa_plate2`).

| Method | Path | Body | Result |
| --- | --- | --- | --- |
| GET | `/api/package/:id/clips` | - | `{packageId, revision, clips[]}` with derived state, selected take, counts, last job, queued |
| GET | `/api/package/:id/clips/:clipId/takes` | - | `{clip, assetId, selected, takes[], history, lastJob, queued}` |
| POST | `/api/package/:id/clips/:clipId/regenerate` | `{change, backendId?, approved?, budgetUnits?}` | `kind: approval_required \| started \| queued` |
| POST | `/api/package/:id/clips/regenerate-batch` | `{items:[{clipId, change, backendId?}], backendId?, approved?, budgetUnits?}` | Same kinds, with `items[]` |
| POST | `/api/package/:id/clips/:clipId/select` | `{takeId}` | `{kind:"selected", clip, takeId}`; saves the package |
| POST | `/api/package/:id/clips/:clipId/revert` | - | `{kind:"reverted", clip, takeId}` |
| POST | `/api/package/:id/clips/:clipId/verdict` | `{verdict, note?, takeId?}` | `{kind:"verdict", clip, takeId, verdict}` |
| POST | `/api/package/:id/clips/:clipId/takes/:takeId/ticket` | - | `{ticket, url, expiresAt}` for `GET /api/media/<ticket>` |
| POST | `/api/run/approve` | `{planHash}` | `{planHash, approved:true}` |
| POST | `/api/render` | `{packageId, baseRevision?, override?}` or `{package, override?}` | MP4 bytes, or 409 `RENDER_GATE_BLOCKED` |
| POST | `/api/pipeline` | `{packageId, baseRevision, override?}` | pipeline run; gate applies |
| POST | `/api/scene/render` | `{packageId, sceneId, baseRevision?, force?}` | one scene MP4 (the optional pixel check) |

The regenerate response in the approval case:

```json
{
  "kind": "approval_required",
  "approvalRequired": true,
  "clipId": "s2:a_plate2",
  "assetId": "a_plate2",
  "diff": [{ "path": "gen.inputs.prompt", "before": "…", "after": "…" }],
  "correction": { "note": "…", "seed": "new", "diff": [{ "path": "gen.inputs.prompt", "before": "…", "after": "…" }] },
  "planHash": "<64 hex characters>",
  "estimate": { "gpuMinutes": 3.2, "overheadMinutes": 1.6 },
  "budget": { "allowed": true, "required": 4.8 },
  "jobs": 1
}
```

After approval and the re-sent request, the start case is
`{kind:"started", runId, status, planHash, estimate, budget}`. If another run is
active, it is `{kind:"queued", diff, correction, planHash?}` with HTTP 202.

The verdict body accepts `approved`, `rejected` or `unreviewed`; `note` is capped at
1000 characters. `takeId` defaults to the selected take. A clip with no take returns
409 `NO_TAKE`.

Common errors: 400 for an invalid change, seed, input, verdict or body;
404 for an unknown package, clip, asset or take; 409 for `NO_PREVIOUS_TAKE`, a refused
budget, or a blocked render; 403 for a take path escaping the package directory; 413
for a body over 2 MB.

### Events

The existing SSE stream (`GET /api/events?token=...`) carries:

- `clip.queued` - `{packageId, clipId, assetId, backendId, planHash?}`
- `clip.job` - `{packageId, clipId, assetId, runId, state, progress}`
- `clip.take.landed` - a new take was ingested; the editor refreshes the clip
- `clip.take.selected` - `{clipId, assetId, takeId}`
- `clip.verdict` - `{clipId, assetId, takeId, verdict, note?}`
- `render.gate.blocked` - `{packageId, path, approved, total, blocking[]}`
- `render.gate.override` - the same plus `reason`, when an override was accepted

## 11. Data and files

- **Package:** unchanged. The selected take is the asset's ordinary `file`, with its
  `sha256`, `bytes`, `media` and `gen`.
- **Sidecar:** `runtime/takes/<pkgId>.json`,
  `{schema:'comfyrizz.takes/v1', packageId, clips, overrides}`. Writes are atomic
  (temporary file plus rename) with mode 0600.
- **Take files:** `runtime/packages/<pkgId>/takes/<assetId>/<takeId>.<ext>` where
  `takeId = tk_` plus the first 12 hex characters of the sha, and the extension is one
  of `png`, `jpg`, `webp`, `mp4`, `webm`. Identical bytes are one take, not two.
- **Take record:** `{takeId, assetId, n, file, sha256, bytes, media, gen, correction?,
  runId, createdAt, verdict, verdictNote?, purged?}`. The `correction` records the
  note, `by` (`user`/`agent`/`initial`) and the exact diff.
- **Overrides:** `overrides: [{at, reason, revision}]` in the same sidecar.

The sidecar is derived state, not a second package. Deleting it re-adopts ready assets
as take 1 and loses verdicts; keep it with the runtime.

## 12. 60-second judge demo

The slow parts - GPU generation and the final encode - are **pre-warmed before the
clock**. The 60 seconds are the review decisions, which is the feature. Say so on
camera; do not pretend a Colab render finished in 30 seconds.

What is live: opening the project, the Takes tab, the chat proposal, the regenerate
request and its Spend card, the A/B clicks, the take-approval clicks and the Render
request. What is pre-warmed: take 2 (produced by the **same correction** and the same
approved Spend card in the rehearsal) and the final MP4. The script cancels the duplicate
live spend after showing the card and cuts to the pre-warmed take; it says why. If you
run the whole thing live, add the generation wait and the encode wait; it will not fit
in 60 seconds.

### Before the clock (one rehearsal, about 10 minutes)

1. Start the app (commands in [section 2](#2-generate-then-open-review)) and open the
   printed loopback URL.
2. Make a short project with three generated clips (a background, a second background,
   and one foreground or presenter). Run the media plan on Google Colab or your own
   ComfyUI and let it finish. Keep the finished run visible in the Activity panel so you
   can show "VM stopped (verified)" as the generation receipt.
3. In **Takes**, approve two of the three clips. Leave the third in `review` with take 1
   selected.
4. For the third clip, run the correction you will use on camera once, off camera, and
   let the new take land. That is take 2, your B side. Then click take 1 again so the
   demo starts with take 1 selected and take 2 waiting as `+1 new`. Note both take
   numbers.
5. Do a final render once at the target size and keep the MP4 in another tab or on the
   desktop. The on-camera render may still be running at 1:00; cut to the rehearsed MP4
   and say "same approved takes, same timeline".

If you do not want any GPU at all, use the zero-spend rehearsal in
[section 13](#13-verify) instead of the UI demo; it drives the same routes against a
fake backend.

### On the clock

| Time | Screen | Action and words |
| --- | --- | --- |
| 0:00-0:08 | Activity + Player | "These three clips came back from one generation run. The VM is stopped; two clips are approved. The third came back as take 1 and needs review." Point at the `VM stopped (verified)` receipt, then open **Takes**; its header names the state. |
| 0:08-0:16 | Takes header | Point at the **Clip** menu (`s2:a_plate2 · review`), the strip position (`1 / 2`), the "Take 1 · selected" card, and `2/3 clips approved`; the chip counter reads `take 1 of 2, +1 new`. "State is derived from takes and jobs, not typed in." |
| 0:16-0:30 | Chat | Ask: "Scene 2 background is too busy and the logo is lost. Keep the logo readable, add clean space top right, no people." Let the agent name `s2:a_plate2` and read its proposed append/negative/seed diff. "It proposed; it did not touch the take, and it cannot approve spend." |
| 0:30-0:40 | Takes, correction form | Enter the same note and the agent's append/negative in **Correct this clip**. "Only this clip is planned; the seed changes; take 1 stays." Click **Regenerate this clip**. Point at **Approve the regeneration**, the estimate and the plan hash: "This approval covers this regeneration only; nothing is charged yet." Say "I approved this exact card in the rehearsal; that produced take 2. I'll cancel the duplicate so the demo stays live," and click **Cancel**. |
| 0:40-0:48 | Take strip | Cut to the pre-warmed take: "This is take 2 from the approved correction in the rehearsal." Click take 2, then take 1, then take 2. "B, A, B. Same scene timing; the Player is previewing, not rendering." Click **Use take 2** to make it the selected take. |
| 0:48-0:55 | Take actions | With take 2 selected, click **Approve**. "Take 2 is approved; take 1 is still there if I want it. `3/3 clips approved`." (Approve the other two here only if the pre-warm left them unapproved.) |
| 0:55-1:00 | Render bar | Click **Render**. "The gate is open; the final render consumes the selected takes - exactly what the Player showed." Cut to the rehearsed MP4 if the encode is still running. |

If a clip shows `stale`, say why: its generation fields changed after approval, so the
old verdict no longer applies; **Use take N** re-applies the take. If Colab spend is
not approved, the clip keeps its previous state and nothing runs; there is no free
retry.

## 13. Verify

Deterministic tests (no external network, GPU, ffmpeg or paid backend; the e2e test
starts the app in-process on loopback with a fake backend):

Run them from the repo root after the workspace dependencies and builds are in place
(`pnpm install --frozen-lockfile`, `pnpm -r --if-present run build`). The model and
store tests are pure; the clips/routes/e2e tests import the built planner.

```bash
# pure take model and the 12-take store
node --test apps/server/test/takes/model.test.mjs
node --test apps/server/test/takes/store.test.mjs

# the whole loop through createApp with a fake backend:
# adopt take 1, Colab approval, corrected take 2, gate 409, approve all, one render
node --test apps/server/test/takes/e2e.test.mjs

# the other take layers
node --test apps/server/test/takes/clips.test.mjs
node --test apps/server/test/takes/correction.test.mjs
node --test apps/server/test/takes/routes.test.mjs
node --test apps/server/test/takes/gate.test.mjs

# web take panel, A/B preview and API client (needs the planner build)
node --experimental-strip-types --test apps/web/test/takes-panel.test.ts
node --experimental-strip-types --test apps/web/test/takes-preview.test.ts
node --experimental-strip-types --test apps/web/test/takes-api.test.ts
```

`e2e.test.mjs` is the zero-spend judge demo in terminal form. It asserts that the
corrected take lands without a full render, that `/api/render` returns 409 before the
gate opens, and that the render is called exactly once with the approved files.

The full workspace checks are:

```bash
pnpm test
pnpm run test:scan
```

`test:scan` is the release scan for personal paths and secrets; it must stay clean.

## 14. Troubleshooting

| Symptom | Check |
| --- | --- |
| `No reviewable clips in this package yet` | The project has no asset with `gen.generator`, or the timeline has no generated background/foreground/presenter. Uploads and SVGs are not clips. |
| Clip is stuck `queued` | Another run is active. Check the run status; queued regenerates drain after the active run ends. A regenerate waiting for Colab spend is not `queued`; its approval card is in the Takes panel. |
| `RENDER_GATE_BLOCKED` | Read `blocking[]`; a `stale` or `review` clip blocks even if an older take was approved. Approve the selected take, or override with a 4-500 character reason. |
| New take did not replace the selected one | An approved take is never auto-replaced. The new take is in the strip with `+1 new`; select it to compare. |
| `NO_PREVIOUS_TAKE` on Revert | There is no earlier selection in this clip's history. Select the take you want directly. |
| Colab approval does not apply | The correction or budget changed, which changed the `planHash`. Approve the new hash; a previous hash cannot authorize a different plan. |
| A take is missing from the strip after 12 takes | The oldest rejected, unselected take was purged over the cap. Its metadata remains with `purged: true`; approved and selected takes are never purged. |
| Preview shows the old picture after a selection | Refresh the Takes tab or wait for `clip.take.selected`; the shell remounts the Player from the selected take. A hard refresh clears a stale media ticket cache. |
| 401 on a take URL | The media ticket expired. The panel mints a new one; never construct `/api/media/...` by hand. |

## 15. Where the code lives

| Area | Files |
| --- | --- |
| Take model, store, ingest, select, correction | `apps/server/src/takes/model.mjs`, `store.mjs`, `ingest.mjs`, `select.mjs`, `correction.mjs` |
| Clips, routes, render gate | `apps/server/src/takes/clips.mjs`, `routes.mjs`, `gate.mjs`; gate enforcement in `apps/server/src/app.mjs` |
| Agent tools and chat wiring | `packages/agent/src/clip-tools.ts`, `conversation.ts`; `apps/server/src/agent-chat.mjs` |
| Web API, preview, panel, render bar | `apps/web/src/takes/api.ts`, `preview-takes.ts`, `panel.ts`, `render-bar.ts` |
| Timeline chips and keys | `apps/web/src/editor/timeline/clip-state.ts`, `Timeline.tsx`, `timeline.css` |
| Inspector Takes tab | `apps/web/src/editor/inspector/panel.ts`, `apps/web/src/main.ts` |
| Tests | `apps/server/test/takes/`, `apps/web/test/takes-*.test.ts` |

The raw design, including the resolved decisions on the render gate, per-regeneration
Colab spend, the take cap and the agent's propose-only role, is in
[the feature spec](specs/TIMELINE_REVIEW.md).
