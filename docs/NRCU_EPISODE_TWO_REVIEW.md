# Episode two — stopped-run accuracy review (2026-10-21)

**Decision: remain stopped. The generated episode is not approved for resumption
or final export.** Corrected conditioning is prepared locally but has not been
validated by a new FastH3 generation.

## Preserved evidence and spending

- Run: `run_e73e113be46f`; Colab session: `comfyrizz-nrcu_episode2`.
- Explicit stop confirmed by `colab sessions`: no active sessions. `colab usage`:
  zero assignments, 0.00 units/hour, balance 321.46.
- Balance delta from 326.34: **4.88 credits** (account-level estimate). Remaining
  episode authorization: **9.62**, out of 14.5. Combined spend estimate: 25.08.
- All 53 generated stills and **28 video takes (a01–a16, b01–b12)** are local.
- The log reports b13 completed, but it was not downloaded before termination;
  it is **not** counted as preserved or reviewed. b14 was submitted at stop.
- All 28 preserved MP4s match their recorded SHA-256, fully decode, contain audio,
  and probe at 1344×768 / 24 fps. These are technical checks, not creative approval.
- Project revision 10 is preserved. The owner's a02 extension from 96 to 124
  frames remains intact: current total 5,788 frames / 241.167 s, versus the original
  5,760-frame target. No automatic timing rewrite was applied during review.

## Findings

### Voice-reference words leak into performances

The reusable character WAVs contain multiple unrelated lines. Despite the prompt
asking for identity only, FastH3 often reproduces them. Examples:

- a02 starts with “Where is the regulator?” before its intended line.
- a03, b04 and b07 repeat other sentences from Hermes's voice reference.
- b03 adds “Where is the regulator? We needed that part.” before its line.
- b05 repeats the requested line twice.
- Don's a05 includes unwanted speech between the two intended phrases.

Small.en ASR flags extra/repeated speech in **16 of 20 speaking clips**. The
remaining four are a06 (brakes/breaks homophone), a10, a11 and b10. ASR is not a
normal-speed listening or lip-sync review; the exact wording of garbled passages
is uncertain. Its b09 “Thanks for watching” result has a very low-confidence first
word and may be a noise hallucination; do not treat it as confirmed speech.

### The current cuts are not speech-aligned

Fifteen clips have ASR-detected speech extending beyond their current scene cut.
Some of that speech is unwanted reference leakage. In other shots the intended
line itself is late: a06 ends around 4.28 s in a 4 s slot, a10 around 4.18 s in a
4 s slot, and b03's intended sentence begins after its 3 s slot has already ended.
Extending every shot to the raw duration would retain unwanted lines and break
the edit; shortening blindly would cut intended dialogue. Candidate trims need
normal-speed playback verification before changing the timeline.

### Composition and story-action mismatches

The reference-to-video graph uses **identity/context references, not a guaranteed
first frame**. Several “keyframes” also fail to show the intended physical action.
Important failures include invented humans in empty machinery/Hermes inserts,
an invented glowing weapon in b02, and a duplicated bear already present in the
ungenerated d06 reference. More explicit reference composition and character
counts are needed before spending on those shots.

## Per-shot review

“Candidate” below is not an approval. Audio delivery, lip sync and full-speed
motion still need review. All original takes are retained.

| Shot | Assessment and next action |
| --- | --- |
| a01 | Regenerate: two invented humans in an intended empty engine insert; bolt action is not a readable close-up. |
| a02 | Edit candidate: correct character; remove unrelated opening question. Desired line is approximately 2.59–4.89 s. Preserve the owner's duration edit until reviewed. |
| a03 | Regenerate: invented humans, floating waveform, unrelated Hermes sentences; replace wide reference with the requested console insert. |
| a04 | Edit candidate: desired line ends about 2.18 s, followed by unwanted speech. Check cutoff-lever action at normal speed. |
| a05 | Regenerate: unwanted speech interrupts the intended two-part line. Repair beam/shoulder contact in the reference. |
| a06 | Timing review: transcript matches apart from brakes/breaks; final word extends beyond 4 s. |
| a07 | Candidate: kart movement and market setting broadly match sampled frames; no speech detected. |
| a08 | Regenerate: two unintended onscreen human customers and unwanted extra dialogue. Customers were meant to remain offscreen. |
| a09 | Edit candidate: the intended question is at the end after unrelated speech; current 3 s cut misses most of it. |
| a10 | Timing review: requested line is intact but ends about 0.18 s after the cut, before adding tail room. |
| a11 | Candidate: exact requested line in ASR and fits the slot. Molty's evil delivery remains a listening check; the buggy/wheel is not clearly established. |
| a12 | Edit candidate: intended broken-English line occurs first, followed by unwanted speech. “no/know” is ambiguous to ASR. |
| a13 | Candidate: barrier is pushed aside with grounded buggy motion in half-second samples. Check wheel/body continuity at speed. |
| a14 | Regenerate/reference correction: crate falls in the lane centre rather than the specified road edge; strap behaviour differs. |
| a15 | Motion correction/review: Don rises out of the seat before dropping back down; does not cleanly show the requested duck-under-hook action with wheel contact. |
| a16 | Candidate: camera reveals curved road and lower route; no detected speech. |
| b01 | Regenerate/reference correction: wide engine shot fails to communicate the requested close-up bolt release. |
| b02 | Regenerate: invented glowing weapon, missing supported-beam contact, unrelated opening speech. |
| b03 | Edit candidate: intended sentence arrives after 3.34 s, beyond the entire current scene; remove voice-reference lead-in. |
| b04 | Regenerate: two invented humans in an empty-console shot and several unrelated Hermes lines. |
| b05 | Edit candidate: requested line repeats; isolate one performance only. Wrench/cutoff contact needs full-motion review. |
| b06 | Regenerate/reference correction: bear gestures with free hands instead of bracing the beam; unwanted speech follows the question. |
| b07 | Regenerate: invented humans and style drift in an empty-console shot; contaminated Hermes dialogue. |
| b08 | Edit candidate: intended sentence ends about 1.88 s, followed by reference leakage. Verify slider movement. |
| b09 | Candidate: half-second sampling shows left, then middle, then right lamps brightening. ASR noise flag requires listening. |
| b10 | Candidate: exact line detected, ending about 2.26 s within the 3 s slot; beam-contact story beat still needs verification. |
| b11 | Edit candidate: unrelated regulator question precedes intended line; current cut truncates it. |
| b12 | Regenerate/reference correction: no clear shoulder/beam contact, unrelated lead-in, intended line runs to about 5.04 s. Exact-line conditioning itself needs 3.23 s including modest padding, exceeding the 3 s slot. |

## Still references for unfinished scenes

All 53 stills were inspected in contact sheets. Before generating the remaining
shots, correct at least: **b18** (required two distinct pulse diagrams are not
established), **b19** (extra hand/arm), **c01** (blankets absent), **c05** (small
wrench absent), **d02** (portrait instead of the city photographs), and **d06**
(two bears, despite exactly one being required). The console/beam problems above
also originate partly in their reference compositions. Do not simply resume the
remaining batch with the existing inputs.

## Fixes prepared

1. Live collection/preview integration is in the new PR; PR #18 was already merged
   before that commit and does not contain it.
2. Full-run completion now rebases generated media onto the latest project,
   preserving intervening timing/prompt/file edits rather than saving the old
   revision. Only accepted files are copied; completed outputs are retained as takes.
3. Takes record the authored generator fingerprint so resolved filenames/defaults
   no longer falsely mark an untouched new take stale. Actual prompt edits still do.
4. `nrcu_shot_conditioning.py` prepares one exact-line WAV per speaking shot,
   preserving voice preset, language and speed. All 33 are prepared locally;
   b12 is explicitly flagged overfull. These are conditioning inputs only;
   finished audio/video must still come from FastH3.
5. Fresh episode authoring/import now uses shot-specific conditioning and refuses
   known overfull or legacy multi-line references. Do not rerun the importer over
   the existing user-edited production.

## Before resumption

- Review candidate edits at natural speed, including Don's broken English and
  Molty's menacing delivery; do not replace FastH3 audio with conditioning WAVs.
- Correct rejected keyframes and test exact-line conditioning on a small set of
  affected shots before admitting the remaining batch.
- Resolve b12 timing, native speech boundaries, captions and the 28-frame target
  overrun as an editorial change; preserve the owner's a02 edit.
- Resume only failed/missing shots within the **9.62-credit remaining ceiling**.
  No new GPU run was started during this review.

Private evidence lives under the episode production root in
`review-paused-20261021/`, including full-decode results, word timestamps, reference
comparisons and motion samples. It is not committed to Git.
