// Shared animation capability catalogue for comfyrizz.package/v1.
//
// This module is intentionally browser-safe: no Node built-ins, no filesystem, no network.
// The planner, the schema validator and the web/renderer can import the same IDs so a recipe
// is never spelled one way in a package and another way in a capability picker.
//
// The contract is additive: a scene without `motion.recipe` keeps the renderer's existing
// layout defaults. A recipe is a validated identifier plus optional bounded parameters
// (`seed`, `intensity`, `focus`, `morph`, `cue_phrases`); it is not arbitrary executable code.
//
// Sources: docs/research/ANIMATION_STORYTELLING_2026.md (sections 3, 4 and 6A).

/**
 * Every storytelling recipe id accepted by `scene.motion.recipe`. The array order is the
 * intended presentation order in an editor picker.
 * @type {ReadonlyArray<'sketch'|'paper-cut'|'morph'|'technical-flow'|'focus'|'kinetic'>}
 */
export const ANIMATION_RECIPE_IDS = Object.freeze([
  "sketch",
  "paper-cut",
  "morph",
  "technical-flow",
  "focus",
  "kinetic",
]);

/**
 * A recipe catalogue entry. `layouts` are the existing package layout ids the recipe is
 * meaningful for; it is guidance for the planner/editor, not a new closed schema constraint
 * (the renderer still owns what it can draw).
 *
 * @typedef {{
 *   id: 'sketch'|'paper-cut'|'morph'|'technical-flow'|'focus'|'kinetic',
 *   label: string,
 *   description: string,
 *   layouts: ReadonlyArray<'title'|'hero'|'stat'|'chart'|'list'|'split'|'compare'|'code'>,
 * }} AnimationRecipe
 */

/**
 * The shared recipe catalogue. Each object is frozen so consumers cannot mutate the
 * capability list at runtime.
 * @type {ReadonlyArray<AnimationRecipe>}
 */
export const ANIMATION_RECIPES = Object.freeze(
  [
    {
      id: "sketch",
      label: "Sketchbook explainer",
      description:
        "Seeded rough outlines, hatching and marker accents that draw on with the narration; for mechanisms and informal technical explanations.",
      layouts: Object.freeze(["title", "hero", "list", "chart", "code"]),
    },
    {
      id: "paper-cut",
      label: "Editorial paper collage",
      description:
        "Layered cutouts, offset shadows and stepped card/page reveals; for profiles, history and community stories.",
      layouts: Object.freeze(["title", "hero", "split", "compare", "list"]),
    },
    {
      id: "morph",
      label: "Morphing visual metaphor",
      description:
        "A bounded shape interpolation (for example circle to blob) that carries a before/after or transformation idea; labels stay separate from the morphing geometry.",
      layouts: Object.freeze(["title", "hero", "compare", "list"]),
    },
    {
      id: "technical-flow",
      label: "Technical blueprint",
      description:
        "Directed graph cards, routed connectors and active-node highlighting; for architecture, workflows and cause/effect.",
      layouts: Object.freeze(["hero", "list", "chart"]),
    },
    {
      id: "focus",
      label: "Evidence focus window",
      description:
        "A scene-entry focus rectangle over media or code, with restrained annotation; for screenshots, sourced claims and product demonstrations.",
      layouts: Object.freeze(["hero", "split", "compare", "chart", "code"]),
    },
    {
      id: "kinetic",
      label: "Kinetic editorial type",
      description:
        "Phrase-level masked reveals and restrained word emphasis; for hooks, definitions, chapters and conclusions.",
      layouts: Object.freeze(["title", "hero", "list", "stat"]),
    },
  ].map((recipe) => Object.freeze(recipe)),
);

/**
 * Every transition id accepted by `transitionOut.type`, including the original MS2 set and
 * the three storytelling reveals. `paper-reveal`, `draw-reveal` and `shape-reveal` have no
 * travel axis: a `direction` on them is a motion-lint warning, not a directional transition.
 *
 * Entries are plain string ids so a consumer can compare them directly with a package value.
 * @type {ReadonlyArray<string>}
 */
export const ANIMATION_TRANSITIONS = Object.freeze([
  "none",
  "cut",
  "fade",
  "blur",
  "slide",
  "push",
  "wipe",
  "zoom",
  "iris",
  "paper-reveal",
  "draw-reveal",
  "shape-reveal",
]);

/** The reveal transitions added by the storytelling contract. */
export const ANIMATION_REVEAL_TRANSITIONS = Object.freeze([
  "paper-reveal",
  "draw-reveal",
  "shape-reveal",
]);
