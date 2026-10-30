---
name: storyboard-direction
metadata:
  version: "1.4.1"
description: Make each scene communicate through a concrete, consistent visual mechanism.
---
# Storyboard direction

For drawn animation, describe the subject, construction order, continuity and final
hold. Respect the requested medium; make solid objects legible with planes and
edges. A conversational plan describes the visual intent, not drawing tool calls
or a promise that the geometry has already been rendered.

Give each scene a story job. Choose title for a hook, hero for one idea, list for
steps, stat or chart for sourced data, split/compare for two labeled plates, and
code for real terminal or code evidence. Reuse a narrow set of forms.

For attached CSV data stories, inspect column names and use context.query_csv for
exact filtered counts and distinct values. Use storyboard.csv_tile_wall after
proposing the scene to render one tile per selected row directly from the source.
Match category values exactly, state exclusions, and retain the source identity.
Labels must describe the actual filter, not an inferred outcome: inspect related
fields before equating classification with finishing, retirement, or causation.
For each number name the specific counted category and scope, including whether
the final event is included. A wall follows source order, not necessarily date order;
inspect the date/sequence fields and verify chronology before describing it as such.
Give categories an explicit key with text as well as color. Use actual data-backed
marks for requested event tiles rather than generic icons. Reserve space for the
ending, keep text inside the safe area, and review opening, ending, and contrast in
rendered frames. A revision to editorial claims or authored visuals requires the
normal model/edit workflow and another review; a render alone cannot correct them.
For explicitly requested per-tile labels, use csv_tile_wall label_column with the
actual source column and check the resulting labels in rendered frames. A tile
reveal is not a camera pullback: do not promise a pullback unless the scene has
an actual supported camera movement. Do not describe tiles as visible in a scene
without building the corresponding visual in that scene.

In visual (<=512 characters), name subject, framing, action, resulting state and
continuity anchor. This is direction, not executable animation. Use actual SVG
geometry for diagrams, supplied evidence for product claims, and label
reconstructions as illustrative. Keep labels editable. A generic dashboard
cannot prove a workflow.

Keep visual semantics stable. The same entity should retain its color, shape, label,
and relative role. Use the supplied palette and reuse recognizable motifs instead of
changing metaphors in every scene. Make reading order obvious, leave breathing room,
and keep detail legible at the intended aspect ratio. Pair color distinctions with
labels or shapes. Reserve caption space without deleting essential comparison labels.

Choose motion by storytelling purpose, never for random variety. Sketch suits
mechanisms and informal explanations; paper-cut suits history, profiles, and community
texture; morph suits a genuine before/after transformation; technical-flow suits
causality and process; focus suits evidence and detail; kinetic suits a hook,
definition, chapter, or conclusion. Recipe fields are bounded: a stable seed,
intensity, focus window, morph shapes, and narration cue phrases. Use them only when
they clarify the beat; keep one hero.

Use these recipe/layout combinations (the editor's capability catalogue):
- sketch: title, hero, list, chart, code.
- paper-cut: title, hero, split, compare, list.
- morph: title, hero, compare, list.
- technical-flow: hero, list, chart.
- focus: hero, split, compare, chart, code.
- kinetic: title, hero, list, stat.

For a process, prefer a technical-flow list with editable items as node labels and
diagram "flow" or "hub"; a code layout has no space for its graph. Sketch lists
reveal aligned item cards. Morph interpolates only circle, square, triangle and
blob; identical endpoints are static. It does not morph arbitrary media. Focus
uses whole-frame normalized x/y/width/height, not coordinates relative to the asset;
x+width and y+height must be <=1. Preserve the source evidence and check framing
again after an aspect change. Kinetic animates headline text, not arbitrary objects.

Set motion.recipe and its parameters in the tool arguments, not just visual prose.
For example, a list with items ["Request", "Worker", "Result"] can use
motion: {recipe:"technical-flow", seed:42, intensity:0.65,
cue_phrases:["request","worker","result"]}. Include those phrases in its narration
in that order. Up to six cues anchor sketch items, flow nodes, morph timing or
kinetic headline groups; for kinetic, prefer phrases also present in the headline.
Explicit cue_seconds are scene-local and override phrase timing; clear old seconds
when switching to phrases. Resolution happens after narration synthesis. Missing
phrases fall back with diagnostics; repeated phrases select the first occurrence.
Kokoro syllable-fallback timing is estimated within measured audio, not forced
alignment. Measured zero audio lag can coexist with estimated word boundaries;
neither invalidates the other. Paper-cut and focus currently enter at scene start,
not phrase cues.

When reviewing existing footage, compare trimmed source duration / playback speed
with measured scene duration. A 4s plate at 0.4x covers 10s, leaving a 14s scene
4s short. Revise copy, split into supported scenes, or plan additional coverage;
slowdown and looping need an intentional visual reason. Check loop seams and final
holds in playback. Chat plans cannot set video speed, generate plates, or guarantee
multi-shot continuity; do not invent tool fields for them.

Choose transitions from the relationship between adjacent beats. Hard cuts punctuate;
fade or blur carry calm continuity; slide, push, or wipe show directed progress; zoom
or iris add depth; paper-reveal suits a chapter or evidence switch; draw-reveal suits
sketch-to-finished; shape-reveal suits a bounded form change. Keep one current and a
small palette of types. The final scene has no outgoing transition.
Reveal transitions have no direction and no shared-object continuity. At 30 fps,
use roughly 9–24 frames for paper-reveal, 11–27 for draw-reveal, and 8–18 for
shape-reveal; scale with fps. Cut/none use zero overlap.

For statistics, use only supplied or sourced datasets and preserve units, labels and
provenance; never invent a series to fill a chart. Write real code or terminal text,
not a description of code. Describe the visual relationship in the visual field, not
a promise of arbitrary animation. Prefer procedural visuals for previews; provide
small self-contained SVG when useful. Saving is not proof that GPU work, audio, or
export finished.
These recipes render on CPU. Lottie/dotLottie, Three.js/shaders, shared-element
handoffs and Motion Canvas/Manim adapters are future work, not available tools.

Before saving an initial draft, check through-line, visual contribution, feasible
timing, readable text, continuity and supported execution. Every depicted object
needs actual asset geometry or a supported recipe: a procedural scene describing
a drifting receipt still renders no receipt. Remove that promise or author the asset.
Respect explicit media restrictions in every scene, including title cards.
Fix the weakest beat in
one focused pass. With rendered evidence, review opening, action, ending and cuts;
a midpoint contact sheet cannot establish motion quality. Name unreviewed evidence
rather than claiming visual, audio or timing checks passed.

### Native reference-conditioned video

For reference-conditioned video, references do not lock frames. Describe identity,
composition, props and one observable action per short shot. Review character count,
contact, framing, sound, motion and cuts when evidence is available; decoding or ASR
alone cannot approve acting, identity or story accuracy.

## Sources

Original guidance informed by multimedia learning, consistent visual meaning and animated data graphics:
- [Richard Mayer: multimedia learning research](https://psych.ucsb.edu/people/faculty/richard-mayer)
- [Heer & Robertson: animated transitions in statistical graphics](https://idl.cs.washington.edu/files/2007-AnimatedTransitions-InfoVis.pdf)
- [Nielsen Norman Group: usability heuristics](https://www.nngroup.com/articles/ten-usability-heuristics/)
- [LTX prompting guide, accessed 2026-10-20](https://docs.ltx.io/open-source-model/usage-guides/prompting-guide)
- [MiniMax full-reference prompt guide, accessed 2026-10-21](https://huggingface.co/MiniMaxAI/MiniMax-H3/blob/main/docs/VIDEO_PROMPT_WRITING_GUIDE_ref_en.md)
- [FastH3 Omni release recipe, accessed 2026-10-21](https://huggingface.co/FastVideo/FastH3-Omni-Comfy)
