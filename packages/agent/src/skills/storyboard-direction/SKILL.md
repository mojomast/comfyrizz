---
name: storyboard-direction
metadata:
  version: "1.0.0"
description: Make each scene communicate through a concrete, consistent visual mechanism.
---
# Storyboard direction

Give every scene a visual purpose. Describe the relationship it explains and
where attention goes. Prefer sequences for processes, side-by-side contrasts
for comparisons, nested shapes for containment, and directed connections for
transfers. Decorative imagery rarely explains a mechanism. Arrows must not
imply unsupported causality.

Keep visual semantics stable across the video. The same entity should retain its
color, shape, label, and relative role. Use the supplied style palette and reuse
recognizable motifs rather than changing metaphors in every scene. Make the
reading order obvious, allow breathing room around text, and keep detail legible
at the intended aspect ratio. Pair visual distinctions with labels or shapes so
color is not the only carrier of meaning.

Choose from the supported title, hero, and list layouts according to the job of
the scene. Use the tool schema for exact fields and limits. Put implementable
composition guidance in visual; do not invent motion or presenter fields, or
promise animation capabilities that the current tools do not expose. A static
diagram with a clear relationship is better than an impossible camera direction.

Prefer procedural visuals for a quick CPU preview. When useful and supported,
provide a small original standalone SVG using simple shapes and paths. Keep it
self-contained, with no external references, scripts, or event handlers. If a
generated image is necessary, describe its subject, composition, and communicative
purpose; an image request plans work rather than proving an asset exists.
Honor explicit media choices: procedural-only excludes SVG and image assets.

The visual field records direction, not executable animation. Procedural mode
currently renders a mesh backdrop with the chosen text layout; prose cannot make
it draw buckets, moving electrons, or custom arrows. For an actual diagram,
provide SVG markup and choose svg media. If procedural-only is requested, make
the explanation work through the available titles, supporting copy, and lists.

Check that scene timing leaves space to inspect the visual while hearing the
narration. Preserve existing suitable assets during revisions. Saving with
project_update_plan or project_patch_plan records the storyboard; project_build
applies it. Neither action is evidence that GPU work, synthesized audio, or an
export has finished. Explain the actual state plainly.

## Sources

Original guidance informed by multimedia learning and consistent visual meaning:
- [Richard Mayer: multimedia learning research](https://psych.ucsb.edu/people/faculty/richard-mayer)
- [Nielsen Norman Group: usability heuristics](https://www.nngroup.com/articles/ten-usability-heuristics/)
