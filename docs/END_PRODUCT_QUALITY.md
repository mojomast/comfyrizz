# End-product quality workflow

Quality is evaluated on the connected cut, independently from successful inference,
decoding or export. These controls run locally without paid generation.

## Before generation

Prepare `beats.json`, `shots.json`, `script.json` and continuity/reference evidence
using the contracts and examples under `scripts/quality/fixtures`. Each essential
beat needs an observable setup, action and result. Declare the intended speaker,
prop state and continuity anchors. Use a rough animatic to check the connected
story before committing to motion. Check the plan with:

```sh
pnpm quality:production plan path/to/production
```

This runs the existing beat and continuity checks together. A zero exit status is
validation of the supplied evidence, not proof that a generated iris actually opens.
Inspect before/action/after frames, keep audible review separate, and retain the
approved character references. A waived casting checkpoint is not voice approval.

## During editing

Use the existing take, voice, caption, cue-sheet and listening contracts. Preserve
the source hash and exact selected interval. Evaluate whole phrases and reaction
space; choose a replacement or reassign the story obligation when salvage removes
a setup or payoff. Label intentional repeated footage and holds with an editorial
reason. A product-demo beat needs a real recorded action and visible result.

Use the sound cue sheet to place distinct physical effects and deliberate rests;
use measured dialogue intervals for ducking, not caption visibility. The existing
`cue-sheet.mjs`, `ducking.mjs`, `allocate.mjs`, `dialogue-tails.mjs` and temporal
review helpers remain the specialized implementations.

Run all seven review areas together before delivery:

```sh
pnpm quality:production final path/to/production > production-quality.json
```

The command exits nonzero for findings or missing review evidence. It never starts
generation, extends budgets, alters references, or manufactures listening approval.
Its JSON lists each area's findings so corrections can stay scoped to affected shots.

## Phrase-aware captions

Set the package field:

```json
{"captions":{"style":"sentence","presentation":"phrases"}}
```

The shared timeline compiler applies existing cue-index wording overrides first,
then segments exactly matching word-aligned text at sentence boundaries. Short
sentences are joined to their neighbors instead of becoming accidental word-pop.
Original word times and scene durations remain intact. Edited wording without
matching alignment remains unsplit. Existing packages retain their previous caption
behavior. Preview, rendering and SRT/VTT export all consume this compiled timeline.

Rendered-video QA now reports short sentence dwell, excessive reading speed and
small projected caption size at a 342px inline player. These are advisory findings,
not a claim of subjective readability. Check the actual intended viewport; a
responsive page alone is not enough. Scalable closed-caption playback and specially
composed social layouts remain delivery choices; this change does not generate a
new portrait film or silently remove burned captions.

## Export-bound creative review

Every normal export returns and archives `quality.json`, including caption findings
and the existing six-axis quality receipt. Missing creative evidence stays
`not_reviewed`; the report does not prevent draft downloads.

To attach a completed review to the exact input set, save `quality-review.json` in
the package directory:

```json
{
  "schema":"comfyrizz.export-review/v1",
  "renderFingerprint":"<copy renderFingerprint from the exported quality.json>",
  "inputs":{
    "beats":{"beats":[],"verdicts":[]},
    "takes":[],
    "listening":{"status":"not_reviewed"}
  }
}
```

The empty example deliberately establishes no approval. Populate the existing
`buildReceipt` input contracts with real reviewer/method/evidence records. Keep
before/after action evidence and selected-source ranges in those records. The
fingerprint binds package, timeline (including selected trims), actual asset bytes,
caption inputs and composition sources. Changing them makes the review stale.
Updating only review evidence does not require another video render. Readability
findings can fail that receipt dimension even when a supplied review claimed a pass.

This is a local evidence sidecar, not an authenticated user-approval API. The
pipeline cannot verify that a person genuinely listened from a JSON assertion.
The production authority and paid-work gates remain responsible for authorization.

## Further creative work

The tools expose and track quality failures; they do not automatically direct actors,
model mechanisms, record a real UI demonstration or compose a dramatic score.
Perform those production steps against the plan, then cite their actual results.
Model-duration/precision experiments need separate bounded evaluation with the
approved voices and settings. Do not change the distilled sampler recipe simply
to increase step count or infer quality from resolution alone.

## Production package

The two-minute action film follows [`productions/action-film-20261026/`](../productions/action-film-20261026/README.md):
budget record (APPROVED 20-credit Google Colab envelope, no unattended retries), shot list,
pilots, model checklist and runbook. A bespoke film renderer does not call the helpers
above automatically; the package's [quality integration guide](../productions/action-film-20261026/QUALITY_INTEGRATION.md)
and `tools/quality-gate.mjs` invoke them explicitly.
