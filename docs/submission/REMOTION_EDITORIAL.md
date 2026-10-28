# Remotion editorial layer for generated films

## User-visible behavior

Generated films now use Remotion as their editable editorial and motion-design layer, not only as an MP4 encoder.

- The first AI-footage shot becomes a native **title opener** (`layout:title`, `variant:centered`).
- The last AI-footage shot becomes a native **outro** (`variant:outro`).
- Shot IDs, footage, narration, timing, total duration, and generated-media requirements do not change.
- Explicit no-text, no-title, text-free, or no-caption requests disable automatic bookends.
- Lower-third-only openings/closures and model-authored layouts/recipes remain valid choices.
- Meaningful text remains native, editable Remotion copy. It is not baked into generated footage.

## Purpose-driven structured visuals

The planner and model guidance use the shared animation catalogue:

| Story need | Treatment |
| --- | --- |
| Process, workflow, architecture, cause/effect | `technical-flow` with editable nodes/items |
| Mechanism or informal technical explanation | `sketch` |
| Before/after or transformation | `morph` or `compare` |
| Evidence, screenshot, sourced detail | `focus` |
| Hook, chapter, definition, conclusion | `kinetic` |
| History, profile, community | `paper-cut` |

Charts and statistics require real supplied data. The planner does not invent data to make a scene look richer. Hard cuts are the default; other transitions need an editorial reason. One expressive gesture carries a scene, followed by a readable static hold.

## Duration and splitting invariant

Bookends live on existing generated shots rather than adding new scenes. If an under-covered opening or closing shot must split into shorter generated clips:

- only the first part carries the opener;
- only the last part carries the outro;
- intermediate parts are clean footage-only shots;
- a single long opening/closing shot can become an opener, clean middle footage, and an outro;
- the actual final scene has no positive outgoing transition.

This preserves requested duration and avoids repeated title cards or duplicated title-animation beats.

## Editable review

The full-plan editor exposes title, kicker, headline, subheadline, body, quote, attribution, footnote, CTA, items, narration, generation directions, and sound plans. Saving recompiles the editable timeline and creates a fresh signed plan; GPU approval remains separate.

## Submission demo sequence

1. Show a purely generated-footage film with a native Remotion opener and outro.
2. Open **Review & edit full plan** and change the title or CTA before approval.
3. Show that the AI footage, shot count, and requested duration remain unchanged.
4. Include a purpose-driven middle scene: a process `technical-flow`, mechanism `sketch`, or evidence `focus`—not a random assortment of effects.
5. Show one intentional cut/transition and the settled final frame.
6. Include the portrait version to demonstrate reflow and safe areas rather than a center crop.
7. Export the editable package/timeline alongside the MP4.

## Verification

- Agent planning, media attachment, no-text, structured-intent, and overlay tests.
- Server duration/coverage and bookend-splitting tests.
- Planner and schema compatibility suites.
- `apps/renderer/test/generated-film-overlays.test.mjs`: actual landscape and portrait MP4s, native title pixels, exact frame timing, clean middle footage, settled final frame, and frame QA.
- No network, provider, paid generation, or GPU is needed for these tests.

Relevant implementation guidance comes from the official Remotion documentation for sequences, transitions, frame-deterministic animation, fonts, scaling, captions, and render quality:
- https://www.remotion.dev/docs/sequence
- https://www.remotion.dev/docs/transitions/transitionseries
- https://www.remotion.dev/docs/animating-properties
- https://www.remotion.dev/docs/fonts
- https://www.remotion.dev/docs/scaling
- https://www.remotion.dev/docs/quality
