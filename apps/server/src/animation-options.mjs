import { ANIMATION_RECIPES, ANIMATION_TRANSITIONS } from '../../../packages/schema/src/animation.mjs';

/**
 * Shared, authenticated capability catalogue for the conversation planner, the editor
 * controls and the renderer. The IDs come from packages/schema/src/animation.mjs so the
 * picker cannot drift from the package schema.
 */
export function animationOptions() {
  return {
    version: 1,
    recipes: ANIMATION_RECIPES,
    transitions: ANIMATION_TRANSITIONS,
  };
}
