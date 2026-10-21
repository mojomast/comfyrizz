# Nous universe — miniseries production preparation

Status: season preproduction; the 90-second FastH3 pilot cut has been generated.
See [pilot production and delivery](NRCU_PILOT_PRODUCTION.md) for the actual
voice references, user-directed Molty revision, review coverage and measured cost.
Revised October 21, 2026. The [season bible](NOUS_OPENCLAW_SEASON_ONE.md) supplies
the story and cast; its scene scripts will assign beat IDs.
This document supplies the repeatable production method.

## Directing the ensemble

Build scenes around a visible objective, an obstacle, a consequential choice and
a changed situation. A character explaining a capability is not a substitute for
showing that capability work, fail or cost something.

- Establish where the heroes, civilians, obstacle and exit are before fast cutting.
- Use a wide shot to establish scale, a medium shot to show the decisive action,
  and a close reaction to make its cost personal. Reserve low-angle entrances and
  the full-team composition for moments the story earns.
- Cut action into achievable stages: approach, contact, consequence, reaction.
  A new angle continues the action instead of restarting the same gesture.
- Preserve travel direction, eyelines, character height, handedness and object
  ownership. An explosion cannot conveniently hide an unexplained transfer.
- Keep one clearly identifiable speaker per dialogue shot. Use over-shoulders,
  reaction shots and off-screen exchanges to build ensemble energy.
- Keep the key physical action readable without captions. Text can name a
  location or confirm an outcome; it cannot be the only evidence of a rescue.
- Let a failed rescue, a sincere admission or a sacrifice land before a joke.
  Humor comes from personalities colliding under pressure.

## Persistent cast and reference registry

Give every character a permanent ID, approved silhouette and original synthetic
voice identity. Screen names are fictionalized character identities; vocal
direction does not specify imitation of the people behind community handles.

Each approved image entry records:

```text
assetId / version / source URL / source revision / local SHA-256
character / costume / view / expression / relative scale
allowed variations / immutable features / production usage
```

Make front, profile, three-quarter, full-body and expression references before
shot production. Record the chosen version of any alternate archive design.
Keep a reference for each damaged costume state rather than silently returning
to the clean model sheet in the next episode.

The current References panel accepts images and short videos, with a maximum of
24 references per conversation. Use it for the relevant episode's selected
character, environment and prop images; maintain the complete season library
outside individual chats. Write explicit role/placement notes. The chat agent
receives metadata and notes, **not the image pixels**. A confirmed assignment is
not visual inspection. See [Reference Assets](REFERENCE_ASSETS.md).

Audio references belong in the speaker registry and generation job inputs; the
current image/video reference-upload panel is not an audio voice-lock interface.

## Voice continuity and dialogue

Use registry IDs `nrcu.<character>.v1` across all five episodes. An ID becomes a
voice lock only after an actual audition has been selected; prose casting notes
are not an implemented voice preset.

For every selected voice, persist the exact model/revision, engine/preset or
synthetic reference WAV, transcript, SHA-256, normalization, seed where relevant,
conditioning and post-processing settings. Store clean masters before mask,
radio or antagonist effects. Record pronunciation decisions for every proper
name; do not infer real accents from handles.

Audition each lead with three short performances: ordinary conversation, urgent
action and a quiet admission. Test returning to the same voice in a separate
scene. Loudness, emphasis and emotional intensity may change; identity should not.

Every utterance gets a stable ID such as `e03.s07.nous-girl.002`, plus speaker,
text, performance direction, selected take, measured timing and file hash. Build
the edit from those performances. Rewrite or move a line if necessary; do not
speed up speech to force it into arbitrary six- or ten-second slots.

Current app boundaries:

- The built-in narration configuration is package-level. Per-scene Qwen delivery
  instructions do not automatically change the speaker.
- `ref_asset` does not yet implement automatic approved-reference reuse in that
  narration path. A speaker-aware preparation step must explicitly reuse the
  locked file/configuration. See [Voice Generation](VOICE_GENERATION.md).
- The experimental native FastH3 workflow accepts a voice reference and retains
  generated audiovisual speech, but a reference does not guarantee exact wording
  or stable identity. The four-minute trial required trimming extra speech and
  replacing takes. Audition cross-scene voice consistency before selecting it
  for a whole season.

## Generator selection from measured behavior

Use a bounded pilot to choose the route for each shot class:

| Shot class | Candidate method | Evidence required |
|---|---|---|
| Speaking close-up | Native FastH3 image/voice-conditioned performance | Same speaker across scenes, correct words, readable lip motion, clean ending |
| Action, flight, environment | LTX or selected motion workflow with separately authored stems | Objective and result visible, stable bodies/props, usable camera direction |
| Complex hero interaction | Short sequential takes with explicit before/after states | Contact, transfer and aftermath agree across the cut |
| Brief strategic graphic | Designed graphic/composition insert | Supports an already understandable physical objective |

FastH3's tested graph uses two images and one audio reference at 24 fps. Tight
single-character portraits and a person-free environment reference reduced
duplicate characters in the mockumentary trial. Group artwork is a design
reference, not automatically a good conditioning image for every close-up.

Treat difficult multi-character shots as planned hero shots with extra review,
not the default coverage. Avoid turning an action scene into thirty static
talking portraits merely because those are easier to generate.

## Measured cost basis

The prior FastH3 trial produced 246.375 seconds of initial source video in
2,021.63 seconds of summed generation/save time on a G4: approximately 8.21
compute seconds per source second. At the observed 8.90 credits/hour rate, that
is about **0.0203 credits per generated source second** before startup, transfer,
idle time, repairs and rejected takes. Rates and workloads must be rechecked.

For illustration, the revised 29-minute season at that same rate would cost about
**35.3 credits for one source pass**, or about **53.0 credits at 1.5× coverage**,
before those overheads. This is arithmetic from the trial, not a season quote:
action complexity, shot duration, model choice and revision rate change the cost.

The earlier 25-credit combined task had 13.33 observed credits spent and 11.67
remaining after the mockumentaries. This preparation allocates no GPU and is
not a claim that the remaining amount funds an epic five-episode production.
Estimate a revised season budget from the selected pilot route and actual shot
list before production.

## Sound and image grammar

Compose original recurring motifs rather than treating every scene as a trailer.
Record each motif's rhythm, instrumentation, dramatic association and permitted
transformations. The ensemble theme should combine already familiar parts in
the finale. Quiet aftermath and room tone are part of that design.

Keep dialogue, music, ambience and Foley as separate stems. Tie a metal impact,
power loss, engine ignition or object transfer to its actual on-screen frame.
Leave space for a held look or a failed reply. Do not place a continuous score
under every comic pause or emotional silence.

Lock one image treatment, exposure/contrast approach, faction palettes, lens
families and environmental lighting directions. Changes in palette should track
story changes. Large scale comes from composition, geography and consequence,
not perpetual camera shake and unmotivated explosions.

## Story-aware evidence package

Prepare these alongside each episode's eventual render package:

| File | Required content |
|---|---|
| `beats.json` | Objective, physical before/after, speaking character, required visual proof and rejection conditions |
| `shots.json` | Beat linkage, size, camera, participants, action window, reference IDs, screen direction and editorial role |
| `library.json` | Approved character/prop/set versions and provenance |
| `ledger.json` | Costume damage, prop owner, location, learned information, power/capacity and state at every cut |
| `voice-manifest.json` / `utterances.json` | Locked speakers, immutable selected dialogue, measured durations and hashes |
| `takes.json` / `verdicts.json` | Observed temporal/semantic results with timestamps and reviewed-file hashes |
| `captions.json` / `cue-sheet.json` | Readable caption spans, music, rests, ambience and frame-linked Foley |
| `listening.json` / `verification.json` | Actual listening review and technical verification, recorded separately |

These are target deliverables using the documented QA input contracts, not files
already populated with fabricated passes. Initialize unperformed reviews as
`not_reviewed`. The [Quality Pipeline](QUALITY_PIPELINE.md) provides the schema
details and JSON-only CLI. It does not inspect or listen to the media itself,
and is not automatically wired into the renderer.

For a prepared episode directory:

```bash
node scripts/quality/cli.mjs beats episode-dir
node scripts/quality/cli.mjs takes episode-dir
node scripts/quality/cli.mjs continuity episode-dir
node scripts/quality/cli.mjs edit episode-dir
node scripts/quality/cli.mjs captions episode-dir
node scripts/quality/cli.mjs sound episode-dir
node scripts/quality/cli.mjs receipt episode-dir
```

## Pilot and production sequence

1. Lock the rewritten story, actual source/design choices, world rules and ending.
2. Produce a silent board/animatic of one 60–90-second sequence using existing or
   placeholder artwork. Confirm action geography and cause/effect first.
3. Audition and lock original voices; make a dialogue-only scene with two leads
   and Hermes. Check that each identity is recognizable without a picture.
4. Generate the bounded pilot: one speaking close-up, a rival encounter, a visible
   rescue/hand interaction, a scale shot and an emotional reaction. Use the
   season's hardest recurring requirements, not only easy footage.
5. Review the pilot at normal playback speed for story, motion and sound, then
   inspect action windows frame by frame. Reconcile ASR with actual listening.
6. Finalize scripts, measured dialogue, reference states and costed shot lists.
   Batch compatible jobs while keeping each episode's receipts distinct.
7. Assemble and review episodes in order. Check the finale's setup/payoff shots
   against the selected earlier takes; substitutions update the story ledger.
8. Export a consistent frame rate, 1080p masters, subtitles and compact copies.
   A 1080p upscale must be described as an upscale. Decode every final file,
   measure audio, check caption readability and play the final ending in context.

Keep the persistent speaker registry, selected source assets, revisioned edit,
measured timings, stems and review receipts with the editable delivery.
