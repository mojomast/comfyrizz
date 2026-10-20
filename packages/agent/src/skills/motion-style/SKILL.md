---
name: motion-style
metadata:
  version: "1.0.0"
description: Pick a motion style recipe, apply it to a storyboard, vary scenes within the look, stay inside the transition budget and critique the result with the look score.
---
# Motion style

Choose one of the 24 named style recipes and apply it to a package in a single call. A look binds palette, type pair, easing personality, entries, transition grammar, background pattern and finish stack — not just a palette.

## Choose a look — style.suggest

Call `style.suggest({tone, goal, history})`. It returns up to three recipe ids with reasons, weighted by tone/goal affinity and penalised against recipes within distance 0.35 of any of the last 8 looks in `history`. History is plain JSON the session keeps; this tool never stores it.

Use `tone` (playful, editorial, calm, high-energy, retro, premium, technical) and `goal` (hook, explain, demonstrate, conclude) to rank candidates, then let `pickRecipe` do the seeded weighted sampling so a seed reproduces a pick.

## Apply it — style.apply

Call `style.apply({recipeId, seed})`. It compiles the recipe to fields the package schema already accepts (tier A): `brand.palette`, `brand.fonts`, per-scene `motion` (energy, entry, ease/spring, emphasis, `transitionOut`, `recipe`), `background.procedural.pattern`. It also writes a `comfyrizz.look/v1` sidecar with the finish stack, font files and transition hints (tier B). Renderers that ignore the sidecar still render tier A.

Never hand-edit palette or transition fields around a compiled look — recompile from the recipe id instead.

## Vary scenes inside the look

Inside a film, rotate `entries` and `emphasis` across scenes so no three scenes in a row share an entry, and keep exactly one hero moment. Use `sceneVariation` with the recipe and the scene list; it returns a varied scene list that keeps one hero. Do not switch recipes mid-film unless the brief changes.

## Never exceed the transition budget

A film may use at most 3 distinct transition types total (one primary plus accents). A recipe's `transitions.primary` plus `transitions.accent[]` already respect this, and every transition sits inside the recipe's energy family so `motion_lint` passes untouched. Don't add a fourth type per scene; use accents elsewhere, not a new primary per cut.

## Critique with the look score

Call `scoreLook(pkg, recipe, {frameQa})` → score 0-100 with parts `adherence`, `rhythm`, `variety`, `contrast`, `finish`, `qa` and `findings[]` naming the scene. Below 70 means the agent revises the flagged scenes (existing critique loop). `frame-qa` remains the hard gate for black/static/flash/safe-area/contrast frames; its deductions lower `qa`.

## Do / don't

- Do name the look in the storyboard so later turns stay consistent.
- Do reuse one look across a film; vary scenes inside it.
- Do keep transitions inside the energy family and within the 3-type budget.
- Don't pick a fourth transition type to "liven up" a scene.
- Don't centre headlines in a Swiss-grid look; each look has its own do/don't rules in its recipe card.

## Sources

- [Material Design 3: easing and duration tokens](https://m3.material.io/styles/motion/easing-and-duration/tokens-specs)
- [Apple Human Interface Guidelines: Motion](https://developer.apple.com/design/human-interface-guidelines/motion)
- [easings.net: easing functions gallery](https://easings.net/)
