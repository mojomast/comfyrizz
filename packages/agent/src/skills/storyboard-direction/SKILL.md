---
name: storyboard-direction
metadata:
  version: "1.2.0"
description: Make each scene communicate through a concrete, consistent visual mechanism.
---
# Storyboard direction

Give every scene a story job before choosing a look: introduce, explain a mechanism,
compare, prove a claim, trace a process, or land a conclusion. Then pick the layout
that performs it. Title for a hook or chapter; hero for one idea with a visual; list
for steps or a small set; stat for one sourced number; chart for a sourced series;
split or compare for exactly two labeled plates; code for real terminal or code
evidence. Reuse a narrow set of forms across the film.

Keep visual semantics stable. The same entity should retain its color, shape, label,
and relative role. Use the supplied palette and reuse recognizable motifs instead of
changing metaphors in every scene. Make reading order obvious, leave breathing room,
and keep detail legible at the intended aspect ratio. Pair color distinctions with
labels or shapes.

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
alignment. Paper-cut and focus currently enter at scene start, not phrase cues.

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

## Sources

Original guidance informed by multimedia learning, consistent visual meaning and animated data graphics:
- [Richard Mayer: multimedia learning research](https://psych.ucsb.edu/people/faculty/richard-mayer)
- [Heer & Robertson: animated transitions in statistical graphics](https://idl.cs.washington.edu/files/2007-AnimatedTransitions-InfoVis.pdf)
- [Nielsen Norman Group: usability heuristics](https://www.nngroup.com/articles/ten-usability-heuristics/)
