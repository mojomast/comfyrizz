# The Impossible Brief — end-product quality review and pipeline improvements

**Date:** October 26, 2026. **Status:** analysis and proposals; no regeneration or
application fixes performed for this review. Companion to the
[production incident report](IMPOSSIBLE_BRIEF_PRODUCTION_INCIDENTS_20261026.md).

## Main finding

The delivered film has coherent art direction and an intact technical delivery,
but it reads more like a polished sequence of presenters and attractive inserts
than the promised miniature story. The largest opportunity is **preserving and
proving dramatic intent through generation and editing**, followed by caption
legibility, coverage, performance selection and sound structure. Increasing model
size or output resolution would not restore the missing story or demonstration.

The production process optimized for collectible media, correct selected words,
stable-looking frames and a successful export. Those checks were useful, but the
production decision to deliver treated them as sufficient evidence of quality.
They did not establish that an iris opened, that a second take improved something,
that characters collaborated, or that the film remained readable on a phone.

## Evidence and limits

- Reviewed the delivered **57.083-second, 1,370-frame, 1080p24 master**; its SHA-256
  is recorded in the private `quality-analysis/metrics.json` and delivery manifest.
- Inspected final-film frames across all 15 sections, comparative character/UI
  frames, and approved boards versus seven temporally spaced source frames for
  each of the three environment clips. Inspected 342px-wide film frames, matching
  the inline player width in the previously checked 390px mobile page.
- Examined `treatment.md`, `production-plan.json`, actual compiled jobs/prompts,
  native/source audits, selected ranges, final captions, audio stems and the exact
  local `assemble.py` / `render/film.tsx` used to deliver the film.
- Recomputed coverage durations, caption dwell/CPS, repeated source intervals,
  source/display scaling, dialogue/music RMS ratios and premaster peak bounds.
  The reproducible private analysis is `analyze-quality.py` and its generated
  evidence folder. No private media or machine-local paths are included in Git.
- **No subjective audio listening is established by this review.** Audio claims
  below concern measured signal/structure and source code. Voice appeal, timbral
  transfer, micro-lip-sync and perceptual mix quality still require audible review.
  Temporal samples also do not establish flawless anatomy on every frame.

This is a case study, not a statistically representative model benchmark. Current
application main may differ from the production checkout; code links below are
pinned to the actual backend baseline, `bbd8cf7`, unless stated otherwise.

## What is working and should be retained

- Recognizable cast identities and clear amber/plum/teal character coding.
- Consistent brass, porcelain, indigo and warm-practical-light art direction.
- Detailed city imagery and a restrained palette, rather than unrelated visual styles.
- Clear title/end-card hierarchy at desktop size and a well-composed cast triptych.
- Native speech retained at natural speed; faulty source takes preserved separately.
- Verified delivery and source provenance: no dropped frames in the recorded
  browser playback, matching served hashes, and preserved prior owner documents.

These strengths should survive corrections. Recasting all three characters or
regenerating every accepted image is unnecessary.

## Timestamped findings

| Final-film time | Observation | Effect on the film |
| --- | --- | --- |
| 00:00–00:03.75 | The iris image changes framing/lighting, but the central aperture does not visibly open to reveal a brief. | Attractive title background; missing initiating action. |
| 00:03.75–00:13.04 | Abstract invitation, “Impossible?” response, then another Rillets line; no concrete brief or obstacle is shown. Consecutive Rillets shots change framing and screen position at 00:10.92. | The characters announce a concept instead of visibly undertaking a task; the adjacent reframing is unmotivated. |
| 00:13.04–00:17.50 | The city moves toward the viewer and retains a rich skyline, but remains an elevated panorama, not the planned extreme street-level macro. | Useful atmosphere, weaker macro-to-wide contrast and scale reveal. |
| 00:17.50–00:25.71 | Boobie announces motion/mischief. Ring planes remain broadly coplanar in the sampled progression, without the requested distinct multi-axis turn. | “Motion” is illustrated by gentle movement, with little consequential action or mischief. |
| 00:19.50–00:19.92 | “mischief.” becomes a lone 0.42-second subtitle after “Give it motion. Give it a little”. | The word carrying the joke flashes as an orphan. |
| 00:28.88–00:33.88 | The cast reveal lasts 5 seconds; its selected voice phrase ends about 1.74 seconds into the section. | Roughly 3.26 seconds remain for an already-established portrait display; there is no collaborative payoff. |
| 00:33.88–00:38.00 | “That bit? Again.” is followed by “Again. With feeling.” over **the same rings source frames 12–59** already used earlier. | An exact replay is presented where the story needs a meaningful variation or improved take. |
| 00:38.00–00:44.00 | The real interface insert is an animated placement of one screenshot of the unrelated ussy.host example, including a porridge preview. No actual trim/take change occurs; dialogue ends around 00:40.30. | The product's most concrete proof arrives two-thirds through the film and is difficult to read or connect to this project. |
| 00:44.00–00:48.17 | “Every word in place. Every beat on time.” is another portrait, not the planned timed diagram. “time.” appears alone for 0.44 seconds. | Precision is asserted without a visible example; subtitle timing undermines the claim. |
| 00:48.17–00:57.08 | Spoken “Your idea. Your cast.” leads to a six-second branded card. | Clean brand finish, but the missing completed-object reveal leaves the story unresolved. |

## Ranked improvements

### Q01 — Preserve story obligations through the edit [P0, planning + editing]

**Evidence:** The treatment specified a cream brief card, conflicting personalities,
collaboration, preserved-versus-changed takes, a timed diagram and a hero reveal.
The final cut contains no legible brief card, no meaningful before/after iteration,
no acted exchange with a listener, and no diagram. The cast triptych is a cast
introduction, not evidence that the characters completed something together.

**Pipeline change:** before spending, make a short animatic using existing boards,
approved conditioning and graphics. Give each essential beat an obligation such as
“viewer sees the brief,” “Boobie changes one property,” or “the same object returns
completed.” Bind it to a shot and a proposed visual proof. A shot may be rewritten,
but its narrative function must be reassigned or explicitly retired after salvage.
Evaluate the connected cut, not merely the sum of independent approved shots.

For this film, a concrete brief could be “A whole world. On this tiny stage.” A
small city appears, one ring goes deliberately off-axis, Rillets reacts, a revised
take locks it into place, and the camera reveals the completed miniature. This is
a proposed rewrite, not something the existing footage already demonstrates.

**Acceptance:** an unfamiliar viewer can identify the task, the change and the
payoff after one viewing. Every must-have beat has visible final-cut evidence.
Automated coverage checks can catch missing mappings; they cannot certify a joke.
No extra user audition checkpoint is implied when the user has waived one.

### Q02 — Review whether the requested action happened [P0, direction + media review]

**Evidence:** board review accepted the iris and corrected rings primarily because
they looked coherent and contained no people. The iris board has a solid central
disk; the rings board shows nearly coplanar suspended bands. Neither visibly
establishes the mechanism or final state requested for its motion shot. Generated
footage preserves those limitations. Some motion exists; a blanket “static video”
diagnosis would be inaccurate. The missing piece is the **intended state change**.

**Pipeline change:** add shot-specific start/end-state and action checks alongside
identity/anatomy checks. For an opening iris, the open aperture/revealed object must
be visible; for a ring turning, a marked ring must clearly change orientation while
staying rigid. Inspect the reference for that action's plausibility before inference.
Check action amplitude and geometry after generation, not just frame differences.

Route deterministic mechanisms, exact lettering and diagrams to authored 2D/3D
animation where appropriate, while using generated footage for character performance
and material-rich environments. A modeled brass iris or ring mechanism can match
the established palette and produce an exact, repeatable visual payoff. This is
already an authored hybrid showcase; adding authored mechanics is consistent with it.

**Acceptance:** reviewers can point to distinct before/after states at delivery size;
global camera motion or texture flicker cannot count as the requested object action.
Reject or revise a board that cannot plausibly support its motion. Endpoint images
may guide planning, but this Omni graph does **not** guarantee fixed endpoints.

### Q03 — Design coverage that reveals character and relationships [P1, direction]

**Evidence:** 25.42 seconds (44.5%) are native portrait sections. The speaking
production reuses one principal composition per character; recurring actions are
small smiles, nods and head tilts with still hands. These avoided difficult contact
failures but also removed most physical storytelling. The trio never appears to
affect one another. All three are predominantly delivering lines to the lens.

**Pipeline change:** plan wide/mid/close/detail coverage, character intent, listener
eyeline, prop state and screen direction before generation. Keep difficult actions
simple and isolate them in dedicated inserts. One useful gesture and a motivated
reaction can communicate more personality than several new portrait lines.
Keep one speaker per generated shot when necessary, but edit it as a connected
exchange with another character rather than a series of independent introductions.

For the current footage, a city cutaway can bridge the consecutive Rillets framing
change. A stronger new version would include a physical prop insert, a listening
reaction and a meaningful scale change. Coverage variety is a shot-plan goal, not
a requirement to move the camera in every shot.

**Acceptance:** every shot has a reason to be that size/angle; consecutive similar
portraits need a dramatic reason or alternate coverage. Review neighboring shots
for eyeline, prop/layout continuity and cause/effect. Preserve approved identities.

### Q04 — Select performances, not just clean transcript fragments [P0/P1, speech + review]

**Evidence:** only **2 of 7 new speaking sources** matched their complete intended
text in the original ASR check. The final selected excerpts passed retranscription,
but the edit had to remove or relocate material in five sources. It retained
22.54 seconds from 33.33 generated speaking-source seconds; this includes selected
pauses and is **not** a score for word accuracy or quality. Recovery was economical,
but it weakened story content and forced the available phrases to drive the edit.

The actual prompt calls Audio 1 a **timbre/delivery reference for a new performance**.
Exact conditioning text therefore cannot establish locked final timing or words.
The local duration rule also adds 0.9 seconds and enforces a minimum of 90 frames.
For “That bit? Again.”, 1.85 seconds of conditioning became a 3.75-second source;
the source repeated “again.” This suggests a duration experiment, not proof of cause:
other longer references repeated internally too.

**Pipeline change:**

1. Keep each approved voice reference and its character-specific delivery. Test
   new native settings on final-script material, without repeating auditions the
   user already selected or waived.
2. Use one coherent thought/action per generated unit. Separate speech duration,
   settling time and reaction handles; round to the legal `17n+5` frame lattice.
   Treat oversized short-line slots as candidates for a bounded comparison.
3. For important shots, use a small authorized candidate set and compare exact
   words, expressive intent, voice identity, lip sync, action and editability.
   Do not auto-select the first decodable or ASR-matching result.
4. Recheck the joined scene after trimming. If trimming removes a setup/payoff,
   select a targeted replacement or deliberately rewrite the beat, then update
   captions and the story map. Keep raw rejected material.
5. Keep technical, visual, audible-performance and editorial verdicts independent.
   A waived approval checkpoint is not a listening verdict, and it should not
   trigger another mandatory user approval dialog.

**Acceptance:** intact intended phrases, usable breathing/reaction space, approved
character continuity and an actual audible/native-performance review where the
reviewer has listening capability. Unavailable listening remains unknown. Do not
infer audible truncation from ASR timestamps alone: the timeline trim is within
about 8ms of its last word timestamp, and such timestamps are not phoneme-accurate.

### Q05 — Make captions semantic, readable and delivery-size aware [P0, captions + renderer]

**Evidence:** `assemble.py` groups every seven words regardless of syntax, creating
“mischief.” at 19.50–19.92 and “time.” at 46.72–47.16. The composition uses 35px
captions, 21px character names and 14px feature labels in a 1920px-wide canvas.
At the checked 342px inline player width, their font-size equivalents are **6.23px,
3.74px and 2.49px**. These are geometric font-size equivalents, not measured glyph
heights. The sampled mobile frames show the practical legibility problem.

**Pipeline change:** break at phrases/sentences using measured word timing, balance
line length and dwell, and attach an isolated final word to its meaningful phrase.
Initial configurable checks: flag ordinary sentence cues below 0.8–1.0 seconds,
more than two lines, excessive reading speed, or tiny projected display text.
Allow explicitly directed word-pop emphasis; do not accidentally create it by count.

For this cut, use “Give it motion.” / “Give it a little mischief.” and “Every word
in place.” / “Every beat on time.” There is already post-speech room in both shots
to allow comfortable reading without changing the spoken audio.

Produce a clean-caption master with a real browser caption track for scalable,
user-controlled playback, plus a separately identified burned-caption download
when wanted. Avoid displaying closed captions over an already-burned duplicate.
Compose portrait/social versions deliberately rather than simply shrinking the
landscape canvas. Check actual in-video text at playback size, not just page overflow.

**Acceptance:** sentence groups preserve spoken wording; no accidental orphan cues;
captions remain readable at intended player sizes; preview, burn, SRT, VTT and
archive share one caption revision. Demonstrate the two observed failures as fixtures.

### Q06 — Give each hold and repeated shot an editorial purpose [P1, editing]

**Evidence:** the cast card has a roughly 3.26-second post-speech hold; the UI insert
has about 3.7 seconds after dialogue; the end card lasts 6 seconds. These are not
automatically wrong—reading time matters—but little new information arrives during
the holds. The 36–38-second rings reprise repeats the exact original source range.

**Pipeline change:** build timing around performance, comprehension and visual
events rather than fixed 5/6-second card slots. Mark each hold as reaction, reading,
suspense or musical resolution. A repeated shot needs a callback/comparison purpose;
an iteration demonstration needs a visible difference. Use J/L cuts and motivated
cutaways to retain complete speech while improving visual rhythm. Coordinate key
changes with music phrasing; do not force every spoken cut onto a beat.

**Acceptance:** each repeated interval and long low-information hold has a stated
purpose. Compare a shorter rough cut against the existing one at natural speed.
Use “time until the next meaningful event” as an editorial diagnostic, not a
universal ban on stillness. Keep a six-second end card only if reading/distribution
requirements justify it. Never speed up native speech to hit an arbitrary runtime.

### Q07 — Demonstrate the product through a real, visible change [P1, capture + editing]

**Evidence:** the screenshot at 38–44 seconds is genuine, but shows another film,
small controls and diagnostic copy including “Take missing. Alignment missing.”
Its subtle transformed placement does not demonstrate choosing a take or changing
a cut. The viewer is asked to believe the claim instead of seeing a result.

**Pipeline change:** use a dedicated demo copy containing this cast/film, capture
one real working action and its before/after result, and crop to the relevant UI.
For example: select two visibly different existing takes, trim a beat, then play
the changed moment. Tie the demonstrated action to the shot immediately before or
after it. Preserve owners' projects; do not fabricate controls or hide a failure
to imply an unsupported capability works. If an action is unavailable, show a
different actual capability and qualify the authored workflow.

**Acceptance:** in a short screen recording, an unfamiliar viewer can identify the
input, action and result at intended playback size. Raw capture provenance and
demo-project identity are retained. A static screenshot is labelled as such when
used, and is not counted as interaction evidence.

### Q08 — Score the scene and its physical events [P1, music + mix]

**Measured/code evidence:** the original score repeats a 128 BPM pattern and four
chords on a **15-second cycle**. Six inserts receive the same synthesized descending
tone. There is no authored mechanical/paper event map or continuous ambient stem.
Ducking follows caption blocks, with a special challenge-shot multiplier of 0.05
instead of the ordinary 0.2. Measured dialogue-over-score RMS is about 17.8–20.2dB
in most speech windows and 30.2dB in that exception. These figures do not establish
that the music sounds too quiet or that the acting sounds good/bad.

The premaster sum has **zero samples outside the unit range** in this analysis;
there is no evidence here of pre-encode hard clipping. Recorded master loudness was
about -16.22 LUFS and -1.28dBTP. Technical level handling is not the main shortfall.

**Pipeline change:** define a spotting sheet: brief arrival, world reveal, comic
interruption, retry, final resolution. Give the score a restrained introduction,
build, deliberate break and ending cadence; add distinct restrained paper/brass/
mechanical sounds keyed to visible events. Preserve room tone across native edits.
Duck from dialogue activity with an intentional release, not subtitle grouping;
review any per-shot exception. Level-match auditions, but preserve meaningful
performance dynamics in the finished scene rather than treating every line alike.

**Acceptance:** audible review on headphones and ordinary small speakers; clear
dialogue without pumping, consistent room tone, motivated effects and a musical
payoff. Automated loudness/peak checks remain useful but cannot approve this category.

### Q09 — Improve acquisition/detail only after the bigger gains [P2, rendering]

**Evidence:** native clips are 1344×768, enlarged about **1.43× horizontally** for
1920×1080 delivery. Cover fitting trims approximately 1.56% of source height. The
1080p file is legitimate 1080p delivery, but it does not contain native 1080p
generation detail. The small crop is not an explanation for the missing story.

**Pipeline change:** compose with an explicit 16:9 safe area inside the native
grid; preserve framing across source, overlays and delivery. Evaluate a controlled
upscale or higher-detail acquisition on selected hero shots, examining eyes,
teeth, hair, brass edges and temporal shimmer. Keep exact graphics at delivery
resolution. For revision-friendly delivery, preserve graphics, captions, source
ranges and audio as layers instead of making the app's baked clips the only edit path.

**Acceptance:** same-shot comparisons at normal viewing size and 100%, stable
identity/texture through time, and an observed benefit before spending across a
batch. Do not invent detail with aggressive sharpening or claim upscaling repairs
geometry. Keep the current source archive and owner edits intact.

## Pipeline implementation order and code entry points

Production-local filenames below identify the scripts used for this film; they
are not currently shared application modules. Product fixes should reuse the
existing review/selection/export contracts instead of creating a parallel system.

| Order | Work | Concrete entry points | Completion evidence |
| --- | --- | --- | --- |
| 1 | Q01/Q02: story obligations and action-aware review | Local `treatment.md`, `production-plan.json`, board review; shared [storyboard direction](https://github.com/mojomast/comfyrizz/blob/bbd8cf7/packages/agent/src/skills/storyboard-direction/SKILL.md), [FastH3 direction](https://github.com/mojomast/comfyrizz/blob/bbd8cf7/packages/jobs/src/fasth3-direction.mjs); UX17/18 | Intact task→change→payoff animatic; before/after action evidence for critical shots. |
| 2 | Q05: phrase segmentation and playback-size typography | Local `assemble.py:24–32`, `render/film.tsx:12,16`; shared [timeline caption builder](https://github.com/mojomast/comfyrizz/blob/bbd8cf7/packages/planner/src/timeline.ts#L398-L438), [caption overlay](https://github.com/mojomast/comfyrizz/blob/bbd8cf7/apps/renderer/src/captions.tsx); UX15/17/20 | The two orphan-word fixtures pass; readable small-player rendering and caption parity. The seven-word bug is local, not attributed to the shared sentence splitter. |
| 3 | Q03/Q06/Q07: coverage, purposeful timing and real UI proof | Local `production-plan.json`, `assemble.py:35–52`, `render/film.tsx:7–13`, capture scripts; UX12/17 | Connected cut review, real before/after capture, repeat/hold reasons. |
| 4 | Q04: native candidate quality and bounded correction | Local `production.mjs:42–52`, `review-media.py:35–51`, `review/selected-takes.json`; [frame resolver](https://github.com/mojomast/comfyrizz/blob/bbd8cf7/packages/jobs/src/plan.mjs#L36-L54), [voice/direction contract](https://github.com/mojomast/comfyrizz/blob/bbd8cf7/packages/jobs/src/fasth3-direction.mjs#L27-L49); UX10/12/14 | Exact words plus separate action, performance, sync and editorial evidence on selected ranges. |
| 5 | Q08: authored sound structure | Local `assemble.py:54–94`; shared renderer audio-mix model; UX12/15 | Spotting sheet, audible review and level checks on the actual mixed export. |
| 6 | Q09 + PB08: source fidelity and reproducible final delivery | Local `render.mjs`, `publish.mjs`, `verify-delivery.mjs`; UX15/16 | Input-bound render receipt, versioned export, real-size viewing and editable-source parity. |

Existing standing direction guidance already calls for dramatic intent, coverage,
natural-speed audible review and selected corrections. This case shows an
**execution/acceptance gap**, not merely a need for longer prompt instructions.
Keep the directives attached to evidence and decisions through the edit.

### Small additions to the existing take-review contract

Use selected-range records containing: source hash/range, shot intent, reference
fingerprint, transcript result, identity/geometry result, action result, audible
performance result, sync result, editorial-use result and unresolved findings.
Each result records reviewer/method/evidence and `pass / revise / unknown`, rather
than a single broad `technicallyUsable` boolean. The complete cut also needs its
own editorial review after assembly; individual take passes do not compose into it.

Keep source and selection metadata distinct. The local edit currently spreads
source audit fields into a trimmed shot: `hook` has 72 selected frames while its
inherited `seconds` describes the 11.54-second source and `wordMatch` describes
the untrimmed transcript. The renderer correctly uses `frames`, but future review
automation could easily grade the wrong duration/text. Use explicit source and
selected-slice fields and bind reviews to their media/range hashes.

## Controlled experiments after the no-generation improvements

These are proposals, not executed tests or new spending authorization. Estimate
and reserve each experiment within a fresh approved budget, including failures.

| Experiment | Controlled comparison | Measure / stop rule |
| --- | --- | --- |
| Short-line timing | For the approved Boobie line, compare current 90 frames with a legal 73-frame slot that still fits 1.85s conditioning + 0.7s reaction; same voice, references and two paired seeds. | Exact words, repeated tail, complete final phoneme, natural rhythm, mouth/reaction closure and accepted seconds per credit. Stop if shortening harms delivery; do not infer cause from one seed. |
| Coherent dialogue units | Compare one multi-sentence native take against separately directed single-thought coverage with the same approved voice and script. | Editorial continuity, timbral consistency, repetition and setup/teardown-inclusive cost; avoid stitching fragments merely to win ASR. |
| Action proof | Compare the existing ring shot with a deliberately actuable reference and explicit before/after orientation; consider a deterministic modeled version for the hero mechanism. | Visible change, rigidity, continuity and viewer comprehension, not raw pixel movement. |
| Performance selection | Blindly compare the first technical pass against the best of a small capped candidate set for one important line. | Audible acting, identity, sync and usefulness in the scene; preserve disagreement and cost. |
| Precision/detail | Only after the above, compare the pinned recipe against a supported higher-detail/backend variant with one factor changed. | Blind normal-size/100% visual and audible review, timing, memory and accepted-result cost. No global settings change without measured benefit. |

The production used an 8-step distilled Omni graph with Euler/simple and a pinned
attention/precision recipe. Do **not** prescribe “more sampling steps” or switch
precision/attention indiscriminately. Compatibility and benefits need controlled
evidence; neither quantization nor attention is proven to have caused this film's
repetition or conservative action.

## Recommended next revision of this film

1. **Local editorial pass:** fix phrase captions; create a readable caption-track
   delivery; bridge the Rillets reframing with the city; tighten or motivate holds;
   remove the exact rings replay as an iteration claim; restructure the score.
2. **Real demo capture:** use a dedicated copy of this project to show one actual
   working trim/take choice and its result, with a legible crop.
3. **Small creative replacement set:** one legible brief/iris reveal, one clear
   action/change and one character reaction or final payoff. Reuse the accepted
   cast, worlds and clean speech where they still serve the rewritten scene.
4. **Review the whole cut:** first without sound for causal clarity and mobile
   legibility, then audibly for acting, lip sync, pacing and mix. Verify the actual
   export after those decisions, with unknown review dimensions stated honestly.

The goal is a film where the characters visibly make something happen. Successful
generation and delivery remain necessary, but they must serve that outcome.
