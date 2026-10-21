# Quality pipeline: QA passes and the pilot workflow

Date: 2026-10-20. Feature: **QUALITY-FIXES** (Q01-Q18).

This document describes the additive QA passes under `scripts/quality/`, how
they map to `docs/research/MOCKUMENTARY_QUALITY_REVIEW_20261020.md`, how to run
the QA CLI, and what the passes deliberately do **not** prove. The feature
specification is `docs/specs/QUALITY_FIXES.md`.

The passes exist because the review found films that were technically valid
while contradicting their own dialogue, floating a body off the floor, swapping
recurring artwork, cutting on a fixed ten-second grid, and presenting captions
that were too fast to read. A valid MP4, a matching file hash, a model score or
a pixel-difference metric is not a pass.

## What this is and is not

- The passes are pure Node ESM modules (`.mjs`) with `node:test` tests and small
  synthetic fixtures. They run from the repository root, need no network, GPU or
  ffmpeg, and add no npm dependencies.
- The CLI reads **JSON only**. It does not decode video, audio or images, call a
  model, render a frame, write a render, or modify a production package.
- A missing review is `not_reviewed`, never `passed`. Findings and exceptions
  are explicit; silence is not approval.
- `pixelDiff` / `flowDiff` values are triage only. They can mark a sample for
  inspection and never pass or fail a take.
- These passes are not called by the render core yet. See
  [Limits and remaining integration](#limits-and-remaining-integration).

## Commands

The only commands are the seven in `scripts/quality/cli.mjs`:

```bash
node scripts/quality/cli.mjs beats      <production-dir-or-json> [--json]
node scripts/quality/cli.mjs takes      <production-dir-or-json> [--json]
node scripts/quality/cli.mjs continuity <production-dir-or-json> [--json]
node scripts/quality/cli.mjs edit       <production-dir-or-json> [--json]
node scripts/quality/cli.mjs captions   <production-dir-or-json> [--json]
node scripts/quality/cli.mjs sound      <production-dir-or-json> [--json]
node scripts/quality/cli.mjs receipt    <production-dir-or-json> [--json]
```

`--help` prints usage. `--json` prints the machine report
(`comfyrizz.quality-cli/v1`) with a preview of at most 80 characters per
finding message; file contents and absolute paths are not printed.

Exit codes:

| Exit | Meaning |
|---:|---|
| `0` | No blocking finding in the JSON that was supplied. This is not a claim that the film is good. |
| `1` | At least one blocking finding, including a `not_reviewed` review or a missing required input. |
| `2` | CLI usage error: unknown command/option, missing target, or the path could not be read. |

The target may be one JSON file or a directory. A directory is read
non-recursively; top-level `.json` files up to 8 MiB are considered in sorted
order. A single JSON file may carry the relevant keys directly
(`beats`, `shots`, `script`, `verdicts`, `library`, `ledger`, `cues`, ...), or a
small composite object. A missing required input produces a blocking
`*_MISSING` finding rather than an empty success.

### Primary input filenames

The CLI also recognizes the input by its shape, so these are the conventional
names, not the only possible ones. `shots`, `ledger`, `captions` and similar
names may be supplied in any file the detector recognizes.

| Input | Conventional files |
|---|---|
| Beat plan | `beats.json`, `beat-plan.json`, `beats-plan.json`, `beat-contract.json`, or `plan.json` with `cases` |
| Shot plan | `shots.json`, `shot-plan.json`, `shot-list.json`, `ledger-shots.json` |
| Script lines | `script.json`, `script-lines.json`, `dialogue.json`, `lines.json` |
| Beat verdicts | `verdicts.json`, `beat-verdicts.json` |
| Take reviews | `takes.json`, `take-reviews.json`, `temporal-review.json`, `leak-take.json` |
| Asset library | `library.json`, `asset-library.json` |
| State ledger | `ledger.json`, `state-ledger.json` |
| Voice manifest | `voice-manifest.json`, `voice.json`, `voice_manifest.json` |
| Utterances | `utterances.json`, `utterance-manifest.json` |
| Captions | `captions.json`, `caption-cues.json` |
| Cue sheet | `cue-sheet.json`, `cues.json`, `cue_sheet.json` |
| Listening review | `listening.json`, `listening-review.json` |
| Technical verification | `technical.json`, `verification.json`, `final-verification.json` |

## Command reference

| Command | Passes | Reads | Blocks on |
|---|---|---|---|
| `beats` | Q01 beat contract, Q02 shot-plan lint, Q03 verdict gate | beats, shots, script, verdicts | `BEAT_*` schema errors, `ANCHOR_MISSING`, `STATE_CHANGE_UNLICENSED`, `PROMPT_CONTRADICTS`, `SPEAKER_UNASSIGNED`, `BEAT_FAILED`, `NOT_REVIEWED`, duplicate beat/verdict |
| `takes` | Q05 temporal artifact review | take plus per-sample observations, or recorded take reviews | `BODY_COUNT_CHANGE`, `IDENTITY_CHANGE`, `SCALE_JUMP`, `UNGROUNDED`, `PROP_TELEPORT`, `UNINTENDED_CAMERA`, `TAKE_NOT_REVIEWED` |
| `continuity` | Q07 asset library, Q08 state ledger, Q09 shot references | library, ledger or shots | library errors, `COSTUME_NOT_PAID_OFF`, `ARTWORK_SWAP`, `PROP_OWNER_JUMP`, `REF_MISSING` |
| `edit` | Q10 dialogue tails, Q11 dialogue-led allocation and cut audit | voice manifest, utterances, role-tagged beats, shots | `TAIL_UNEXPLAINED`, `TAIL_UNMEASURED`, `SPEED_UP`, allocation and `CUT_INSIDE_SPEECH` findings |
| `captions` | Q13 readability metrics, Q14 presentation pass | captions | `CAPTION_OVER_CPS`, `CAPTION_OVER_LENGTH`, `CAPTION_NEEDS_EDIT` |
| `sound` | Q15 cue sheet, Q16 ducking plan | cue sheet, captions used as utterance timing | cue-sheet schema errors, `FOLEY_FRAME_MISMATCH`, `MUSIC_FILLS_REACTION_PAUSE`, `MISSING_FOLEY` |
| `receipt` | Q06 multi-axis quality receipt | technical, beats/verdicts, takes, continuity, captions, listening | any axis that is `failed` or `not_reviewed` (`AXIS_NOT_PASSED`), invalid evidence or exceptions |

Two passes are library-only at present and have no CLI command:

- **Q04 sampling plan** (`scripts/quality/sample-plan.mjs`) chooses first, last,
  action-window and regular intermediate frame times for a take. Its ffmpeg
  helper builds an argv array; its test assumes a 24 fps take.
- **Q12 measured adapter** (`scripts/quality/measured-adapter.mjs`) maps
  speaker-tagged utterances and Q11 shot ranges onto the `DurationsReport`
  shape read by `packages/planner/src/measured.ts`. It does not import the built
  planner package and the planner does not call it yet.

Run their tests directly:

```bash
node --test scripts/quality/sample-plan.test.mjs
node --test scripts/quality/measured-adapter.test.mjs
```

### What each command actually checks

`beats` validates the beat contract, lints the script-to-shot plan, and, when
verdict records are supplied, gates assembly. A passed verdict must cite a
frame or timestamp and the reviewed file's sha256. A `substituted` verdict must
carry an editorial note. When the gate runs, a `failed`, `not_reviewed`,
missing, malformed or duplicate verdict blocks. The lint is lexical: it checks the speaker's anchor
line, unlicensed before/during state changes, `rejectIf` phrases or
"outside reach" prop moves in image/action prompts, and whether the speaking
character is in the shot's participants.

The gate runs when verdict data is present (a `verdicts` array, a
`verdicts.json`, or `gate: true` on a plan case). If no verdict input exists at
all, `beats` still validates and lints but does not invent a gate. The
`receipt` command is stricter: a beat plan without verdicts is
`semantic: not_reviewed`.

`takes` reviews per-sample observations. Observations cover body count,
characters, grounding, scale, prop holder and camera movement. A take with no
observation is `not_reviewed`. A leak-take fixture reproduces the review's
`04:34-04:38` fragment: Nell's boots leave the floor at `04:36.5` and the take
fails `UNGROUNDED`.

`continuity` validates the approved asset manifest, checks the state ledger at
each cut, and attaches approved references to shots. It reports a costume that
never pays off, a recurring artwork id/version swap, and an unlicensed prop
holder jump. It also reports the opening and payoff shots carrying
`raccoon_portrait` for side-by-side review.

`edit` reports trailing dialogue padding and speed-ups, and, when utterances
and role-tagged beats are supplied, allocates integer-frame shots. Allocation
keeps measured speech, sums to the requested target (600 s at 30 fps by
default), stretches or shrinks reasoned holds instead of speeding speech, and
lists cuts inside speech without a `b-roll` or `reaction` reason.

`captions` measures the displayed text including the `Speaker: ` label against
2 lines × 42 characters and 20 characters/second. The presentation pass splits
at phrase boundaries, distributes the measured span proportionally, marks
sub-cue timing `estimated`, and returns cues it cannot make readable in
`needsEdit`. It never silently shortens text.

`sound` validates `comfyrizz.cue-sheet/v1`, requires Foley cues to sit within
two frames of the declared visual event, forbids music cues inside a declared
reaction pause, and flags a scene with a sound event but no Foley cue. It then
builds a deterministic music duck/rest plan from the caption timings and the
declared pauses. It writes no audio.

`receipt` combines the axes `technical`, `semantic`, `temporal`, `continuity`,
`captionReadability` and `listeningReview`. `approved` is true only when every
axis is `passed` or has an accepted exception with a non-empty reason. It also
records reviewed files and their sha256, failures and selected take ids. It
does not have edit or sound axes; run `edit` and `sound` separately.

## Statuses

| Status | Where | Meaning |
|---|---|---|
| `passed` | Beat verdicts, take reviews, receipt axes | Reviewed with the required evidence. |
| `failed` | Beat verdicts, take reviews, receipt axes | A blocking defect was observed. |
| `substituted` | Beat verdicts | An intentional editorial substitution, allowed only with a note. |
| `not_reviewed` | Beat verdicts, take reviews, receipt axes | Missing or insufficient review. It blocks and is never treated as a pass. |

The receipt axes are independent. A clean technical verification, a matching
audio envelope, or a zero pixel diff does not fill `semantic`, `temporal`,
`continuity`, `captionReadability` or `listeningReview`.

## How the passes map to the review

| Review finding | Passes | CLI | Evidence in the repository |
|---|---|---|---|
| P0 story beat: chair gag, accessible sandwich, human portrait instead of the raccoon | Q01-Q03 | `beats` | `fixtures/sandwich-plan.json`: `PROMPT_CONTRADICTS`, `SPEAKER_UNASSIGNED` |
| P0 temporal: Nell's boots off the floor at `04:36.5` | Q04, Q05 | `takes` | `fixtures/leak-take.json`: `UNGROUNDED` covering `04:34-04:38` |
| P1 continuity: raccoon artwork swap and unpaid-off cardigan | Q07-Q09 | `continuity` | `fixtures/library.json`, `fixtures/ledger.json`: `ARTWORK_SWAP`, `COSTUME_NOT_PAID_OFF`, `PROP_OWNER_JUMP`, `REF_MISSING` |
| P1 editing: fixed 10 s grid, 86.96 s of trailing padding, 1.15x speed-up, cuts inside speech | Q10-Q12 | `edit` | `fixtures/voice-manifest.json`: 86.96 s, 14.49%, chapter 5 and 19 tails, 1.15x |
| Captions: 148-character and 28.70 cps cues | Q13, Q14 | `captions` | `fixtures/captions.json`: over-rate, over-length and `needsEdit` |
| Sound: bell/drip/brush off their events, music filling a rest, missing Foley | Q15, Q16 | `sound` | `fixtures/cue-sheet.json`: `FOLEY_FRAME_MISMATCH`, `MUSIC_FILLS_REACTION_PAUSE`, `MISSING_FOLEY` |
| Traceable multi-axis result, missing review is not a pass | Q06 | `receipt` | `fixtures/*`: `approved: false`, `not_reviewed` axes |
| Readable CLI for people and automation | Q17 | all seven | `cli.test.mjs` |

The review's coverage finding ("distinct camera coverage and identify the
speaking character") is only partly covered. `beats` can catch a shot that
omits the speaker from its participants, but it does not assess eyelines,
screen direction, repeated handoffs or whether two angles actually advance the
action. Those still need a human viewing pass.

## Acceptance criteria quoted from the review

Story beats (section 3, P0):

> The sandwich remains visibly inaccessible through the relevant line; the courtroom picture remains the approved raccoon asset; all story-critical beats have a recorded pass or an intentional editorial substitution before assembly.

Temporal review (section 3, P0):

> A 60–90-second pilot containing the leak, a hand interaction, and a prop reveal passes temporal review before the remaining scenes are commissioned. The four-second leak fragment around 04:34–04:38 would be rejected by this test.

Continuity (section 3, P1):

> Side-by-side opening/payoff views preserve the painting's subject, robe and frame. A state ledger verifies costume changes and prop ownership at each cut. Save approved reference hashes alongside prompts and generated assets.

Dialogue-led editing (section 3, P1):

> Preserve all intended dialogue and the 600-second target while demonstrating at least one setup/reveal/reaction sequence whose cuts follow the joke. Flag unexplained dialogue tails over roughly two seconds for review; do not ban deliberate silent comedy or cutaways within speech.

Coverage (section 3, P1; partially covered):

> In a caption-free pilot, viewers can identify who is speaking and what changes in the scene. Adjacent shots either advance the action or provide an intentional reaction; they do not accidentally repeat the same handoff.

Captions (section 4):

> Add a caption presentation pass over the immutable dialogue timings: sensible phrase boundaries, at most two lines, approximately 42 characters per line, and a target reading rate around 17–20 characters/second as configurable editorial heuristics. Use alignment where supported; retain explicit estimated provenance otherwise. Do not invent precise word timings when subdividing a measured sentence. Shorten display text only through an explicit caption edit that preserves meaning.

Sound (section 4):

> Add a cue sheet and separate room-tone, Foley, music and dialogue stems. Place the bell, drip and brush sounds on actual visual events; keep deliberate pauses instead of filling every gap. Derive ducking and music changes from the editorial beats.

Pilot captions and sound (section 6, recommended order 3):

> Pilot captions fit two readable lines at target player sizes; overlaps are checked; Foley and music respect action/punchline cues.

Traceability (section 5A):

> A missing review is `not_reviewed`, not `passed`.

## Pilot workflow before commissioning the rest

The review recommends rebuilding a small pilot first. Do not generate all 60
shots and then discover that the hero beats contradict themselves.

1. **Author the pilot beats and shot plan.** Cover the chair gag, the
   ControlNet/negative-action beat (the sandwich must stay out of reach), the
   cloud/leak beat, and the opening/final raccoon match. Each beat names its
   speaker, participants, versioned props, `before`/`duringLine` state, and
   `rejectIf` phrases. Run:

   ```bash
   node scripts/quality/cli.mjs beats pilot/ --json
   ```

   Fix every `PROMPT_CONTRADICTS`, `STATE_CHANGE_UNLICENSED`,
   `SPEAKER_UNASSIGNED` and `ANCHOR_MISSING` before paying for generation. This
   lint does not inspect a ComfyUI workflow graph or generated frames; it checks
   the authored prompts and contract.

2. **Generate only the pilot stills and takes.** For each candidate take,
   collect observations at the sample frames (use Q04's sampling plan as a
   library) and run:

   ```bash
   node scripts/quality/cli.mjs takes pilot/ --json
   ```

   The pilot should be roughly 60–90 seconds including the leak, a hand
   interaction and a prop reveal. Reject or recut a take rather than adding
   movement. Prefer shorter single-action takes for fragile gestures.

3. **Lock continuity before the rest is commissioned.** Build the approved
   library with sha256 for the raccoon portrait, sandwich, cardigan and other
   recurring props; describe each shot's costume/prop/artwork state in the
   ledger; run:

   ```bash
   node scripts/quality/cli.mjs continuity pilot/ --json
   ```

   Inspect the reported opening/payoff pair side by side. Generate a
   reference sidecar with `attachRefs` for the generator, and keep the approved
   hashes next to the prompts. Neither the sidecar nor the hash verification is
   wired into generation yet.

4. **Cut on the dialogue.** Supply measured utterances and role-tagged beats
   (`setup`, `reveal`, `reaction`, `payoff`, `action`) and run:

   ```bash
   node scripts/quality/cli.mjs edit pilot/ --json
   ```

   Confirm every scene is present once, the total is exactly the target frame
   count, a setup/reveal/reaction sequence cuts on the joke, and every cut
   inside speech has a `b-roll` or `reaction` reason. A long tail needs a
   declared editorial reason, or an edit.

5. **Present captions and cue the sound.** Run:

   ```bash
   node scripts/quality/cli.mjs captions pilot/ --json
   node scripts/quality/cli.mjs sound pilot/ --json
   ```

   Every cue must fit 2 × 42 characters and 20 cps, or be listed in
   `needsEdit` for an explicit edit. Every Foley cue must sit on its visual
   event; music must not fill a declared reaction pause.

6. **Do the human pass, then issue the receipt.** Watch and listen in real
   time, check browser captions at desktop and mobile widths, and record the
   result as `listening.json`. Then run:

   ```bash
   node scripts/quality/cli.mjs receipt pilot/ --json
   ```

   Commission the remaining scenes only when the receipt is approved, or every
   non-passed axis has an accepted exception with a written reason. Repeat the
   same sequence for the full production.

## Reproducing the review fixtures

The fixtures are synthetic JSON built from the review's measured examples, not
production prompts or media. All seven commands exit `1` on the fixture
directory because the fixtures intentionally contain the review's defects.

```bash
node scripts/quality/cli.mjs beats      scripts/quality/fixtures --json
node scripts/quality/cli.mjs takes      scripts/quality/fixtures --json
node scripts/quality/cli.mjs continuity scripts/quality/fixtures --json
node scripts/quality/cli.mjs edit       scripts/quality/fixtures --json
node scripts/quality/cli.mjs captions   scripts/quality/fixtures --json
node scripts/quality/cli.mjs sound      scripts/quality/fixtures --json
node scripts/quality/cli.mjs receipt    scripts/quality/fixtures --json
```

Expected signals include:

| Command | Expected on the fixtures |
|---|---|
| `beats` | `PROMPT_CONTRADICTS` on `s08_unreachable_sandwich`; `SPEAKER_UNASSIGNED` on the chair beat |
| `takes` | `UNGROUNDED` for `cloud-leak-0430`; 2 inspected samples |
| `continuity` | `PROP_OWNER_JUMP`, `COSTUME_NOT_PAID_OFF`, `ARTWORK_SWAP`, `REF_MISSING`; opening `s00_opening_portrait`, payoff `s18_payoff_b`, `sameAsset: false` |
| `edit` | 20 segments, 86.96 s, 14.49% of the film, `TAIL_UNEXPLAINED` and `SPEED_UP` |
| `captions` | 7 cues, 28.70 cps maximum, 148 characters maximum, 3 cues needing an explicit edit |
| `sound` | `FOLEY_FRAME_MISMATCH`, `MUSIC_FILLS_REACTION_PAUSE`, `MISSING_FOLEY`; 32 ducking points, 1 rest |
| `receipt` | `approved: false`; `technical` and `listeningReview` are `not_reviewed`; temporal/continuity/caption axes fail |

Tests:

```bash
node --test scripts/quality/cli.test.mjs
node --test scripts/quality/beat-contract.test.mjs scripts/quality/beat-lint.test.mjs scripts/quality/beat-verdicts.test.mjs
node --test scripts/quality/sample-plan.test.mjs scripts/quality/temporal-review.test.mjs scripts/quality/receipt.test.mjs
node --test scripts/quality/asset-library.test.mjs scripts/quality/state-ledger.test.mjs scripts/quality/shot-refs.test.mjs
node --test scripts/quality/dialogue-tails.test.mjs scripts/quality/allocate.test.mjs scripts/quality/measured-adapter.test.mjs
node --test scripts/quality/caption-metrics.test.mjs scripts/quality/caption-split.test.mjs
node --test scripts/quality/cue-sheet.test.mjs scripts/quality/ducking.test.mjs
```

## Limits and remaining integration

### What still needs a human listening or playback pass

- The review itself was **not a real-time watch-and-listen pass**. The suite
  inherits that gap. `listeningReview` records a human status; it does not
  perform the listening.
- Vocal naturalness, pronunciation of ComfyUI, GPU, LoRA and ControlNet,
  speaker-to-speaker loudness, joke stress and breath/pause placement need a
  person with the masters.
- Browser subtitle layout at 390 px, overlaps, safe areas and mobile
  readability need an actual player pass. Character counts are not a layout.
- Whether a viewer can name the speaker, understands the joke from the images,
  or notices a body/prop discontinuity is a viewing judgement. The passes can
  flag specific contract violations, not audience comprehension.
- Cadence (24 fps source converted to 30 fps), texture, upscaling and codec
  preferences were not judged by the review and are not judged here.

### What still needs render-core integration

- Nothing in `apps/**`, `packages/**`, `colab/**` or the renderer calls these
  passes. `pipeline-worker.mjs`, Remotion, FFmpeg, the Colab finisher and the
  final assembly do not block on them. They are a CLI and library layer only.
- The measured adapter is not imported by the planner, and `packages/planner`
  was not edited. It produces a compatible sidecar, not an installed timing
  path.
- `attachRefs` produces a sidecar. No generator reads it automatically, and
  `workflows/flux3_klein_ref_edit.api.json` was read only, not changed.
- The CLI validates the asset manifest and ledger but does not hash asset files
  at runtime. `hashFile` and `verifyAssetFiles` exist in the library module;
  the CLI does not call them. A manifest can be internally consistent while its
  files are missing or changed.
- Caption presentation is not written to SRT/VTT, burned in, or checked against
  the player. Q14 returns data and `needsEdit`; it does not invent word timings.
- The cue sheet and ducking plan are data. No audio is rendered, mixed, limited
  or measured. The receipt has no sound or edit axis, so a clean receipt does
  not mean Foley, music or allocation passed.
- Q04's sampling plan is not wired into the CLI. Take review depends on
  observations being supplied by a reviewer or a vision/detector process that
  is not part of this repository.
- Beat lint is lexical and heuristic. It can miss a paraphrase, a visual
  contradiction that is not in the prompt text, or a bad take that satisfies
  the contract on paper. A clean `beats` run is not proof of a correct film.
- The state ledger and reference checks do not composite, regenerate or repair
  an asset. They report.
- Review items outside this feature remain open: input-keyed intermediate
  caches, render-receipt integration, OCR/text-region review of generated
  signage, deterministic lettering compositing, resolution/cadence/encode
  benchmarks, bulk transfer and alternate-take budgeting.

The intended use is early, cheap rejection: run `beats` before generation,
`takes` and `continuity` before assembly, `edit`/`captions`/`sound` on the
candidate cut, and a human listening/playback review before `receipt` can be
approved.
