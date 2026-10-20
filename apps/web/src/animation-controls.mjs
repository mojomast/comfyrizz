// Browser-safe helpers and markup for the storyboard's per-scene animation controls.
//
// The recipe vocabulary is the shared catalogue in
// `packages/schema/src/animation.mjs`; the UI must not invent a second list. These
// helpers are plain ESM so the web tests can exercise the filtering, bounded
// defaults and cue parsing without a DOM.

import {
  ANIMATION_RECIPES,
  ANIMATION_RECIPE_IDS,
  ANIMATION_REVEAL_TRANSITIONS,
  ANIMATION_TRANSITIONS,
} from '../../../packages/schema/src/animation.mjs';

/** The fixed scene.motion.recipe enum, from the shared catalogue. */
export const RECIPE_IDS = ANIMATION_RECIPE_IDS;

/** The fixed scene.motion.morph shapes. */
export const MORPH_SHAPES = Object.freeze(['circle', 'square', 'triangle', 'blob']);

/** Longest cue list the package schema accepts. */
export const MAX_CUE_PHRASES = 6;

const TRANSITION_LABELS = Object.freeze({
  none: 'None',
  cut: 'Hard cut',
  fade: 'Fade',
  blur: 'Blur crossfade',
  slide: 'Slide',
  push: 'Push',
  wipe: 'Wipe',
  zoom: 'Zoom',
  iris: 'Iris',
  'paper-reveal': 'Paper reveal',
  'draw-reveal': 'Draw reveal',
  'shape-reveal': 'Shape reveal',
});

const REVEAL_TRANSITIONS = new Set(ANIMATION_REVEAL_TRANSITIONS);

/** Existing MS2 transition vocabulary plus the reveal family, from the shared catalogue. */
export const TRANSITION_OPTIONS = Object.freeze(
  ANIMATION_TRANSITIONS.map(id => Object.freeze({
    id,
    label: TRANSITION_LABELS[id] ?? id,
    group: REVEAL_TRANSITIONS.has(id) ? 'reveal' : 'standard',
  })),
);

export const DEFAULT_TRANSITION_FRAMES = 15;

const RECIPE_SET = new Set(RECIPE_IDS);
const SHAPE_SET = new Set(MORPH_SHAPES);
const TRANSITION_SET = new Set(TRANSITION_OPTIONS.map(option => option.id));

const esc = value =>
  String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

/** Accept the catalogue's array form, and be forgiving about a string/record. */
export function recipeLayouts(recipe) {
  const value = recipe?.layouts;
  if (Array.isArray(value)) return value.filter(item => typeof item === 'string');
  if (typeof value === 'string') return value.split(/[\s,]+/).filter(Boolean);
  if (isObject(value)) return Object.keys(value).filter(key => value[key]);
  return [];
}

/** Whether a catalogue recipe applies to a scene layout. `*`/`all` are explicit wildcards. */
export function recipeFitsLayout(recipe, layout) {
  if (typeof layout !== 'string' || !layout) return false;
  const layouts = recipeLayouts(recipe);
  return layouts.includes(layout) || layouts.includes('*') || layouts.includes('all');
}

/** Recipes valid for a layout, in catalogue order. */
export function recipesForLayout(layout, catalogue = ANIMATION_RECIPES) {
  return (Array.isArray(catalogue) ? catalogue : []).filter(recipe => recipeFitsLayout(recipe, layout));
}

/** A stable, nonzero 32-bit seed derived from the scene id. */
export function defaultSeed(sceneId) {
  let hash = 2166136261;
  for (const char of String(sceneId ?? 'scene')) {
    hash ^= char.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) % 2147483646 + 1;
}

export function validSeed(value) {
  return isFiniteNumber(value) && Number.isInteger(value) && value >= 1 && value <= 2147483647;
}

export function normalizeSeed(value) {
  const number = typeof value === 'string' && value.trim() === '' ? NaN : Number(value);
  return validSeed(number) ? number : undefined;
}

export function validIntensity(value) {
  return isFiniteNumber(value) && value >= 0 && value <= 1;
}

export function normalizeIntensity(value) {
  const number = typeof value === 'string' && value.trim() === '' ? NaN : Number(value);
  return validIntensity(number) ? number : undefined;
}

export function validShape(value) {
  return typeof value === 'string' && SHAPE_SET.has(value);
}

export function validFocus(focus) {
  if (!isObject(focus)) return false;
  if (!['x', 'y', 'width', 'height'].every(field => validIntensity(focus[field]))) return false;
  if (focus.width <= 0 || focus.height <= 0) return false;
  return focus.x + focus.width <= 1 && focus.y + focus.height <= 1;
}

/**
 * Validate one focus-rectangle edit against the normalised frame bounds.
 * Width/height must stay positive and the rectangle cannot leave the frame.
 */
export function normalizeFocusField(field, value, focus) {
  if (!['x', 'y', 'width', 'height'].includes(field)) return undefined;
  const number = typeof value === 'string' && value.trim() === '' ? NaN : Number(value);
  if (!isFiniteNumber(number) || number < 0 || number > 1) return undefined;
  if ((field === 'width' || field === 'height') && number <= 0) return undefined;
  const base = validFocus(focus) ? focus : defaultFocus();
  return validFocus({ ...base, [field]: number }) ? number : undefined;
}

export function defaultFocus() {
  return { x: 0.2, y: 0.2, width: 0.6, height: 0.6 };
}

export function validMorph(morph) {
  return isObject(morph) && validShape(morph.from) && validShape(morph.to);
}

export function defaultMorph() {
  return { from: 'circle', to: 'square' };
}

/**
 * Add or remove a recipe without replacing the rest of scene.motion.
 *
 * Selecting a recipe only fills a missing seed/intensity (and the conditional
 * morph/focus default) so existing custom motion fields survive untouched.
 * Choosing the default removes only `recipe`.
 */
export function withRecipe(motion, recipe, sceneId) {
  const next = isObject(motion) ? { ...motion } : {};
  if (!recipe) {
    delete next.recipe;
    return next;
  }
  if (!RECIPE_SET.has(recipe)) return next;
  next.recipe = recipe;
  if (!validSeed(next.seed)) next.seed = defaultSeed(sceneId);
  if (!validIntensity(next.intensity)) next.intensity = 0.65;
  if (recipe === 'morph' && !validMorph(next.morph)) next.morph = defaultMorph();
  if (recipe === 'focus' && !validFocus(next.focus)) next.focus = defaultFocus();
  return next;
}

/** One phrase per line, trimmed, blanks removed, capped at the schema maximum. */
export function parseCuePhrases(text) {
  return String(text ?? '')
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
    .slice(0, MAX_CUE_PHRASES);
}

export function formatCuePhrases(phrases) {
  return Array.isArray(phrases) ? phrases.filter(item => typeof item === 'string').slice(0, MAX_CUE_PHRASES).join('\n') : '';
}

/** Frames shown/used for an explicit transition. */
export function transitionFrames(transition) {
  if (!isObject(transition)) return DEFAULT_TRANSITION_FRAMES;
  const frames = Number(transition.frames);
  return isFiniteNumber(frames) && frames >= 0 ? Math.floor(frames) : DEFAULT_TRANSITION_FRAMES;
}

export function transitionType(transition) {
  return isObject(transition) && typeof transition.type === 'string' && TRANSITION_SET.has(transition.type)
    ? transition.type
    : '';
}

export function transitionNeedsFrames(type) {
  return Boolean(type) && type !== 'none' && type !== 'cut';
}

/** slide/push/wipe travel in the plane; zoom/iris travel in depth; reveals have no axis. */
export function transitionHasDirection(type) {
  return ['slide', 'push', 'wipe', 'zoom', 'iris'].includes(type);
}

/**
 * The next explicit transitionOut for a type pick. Choosing the default returns
 * undefined (remove the saved transition). Existing duration/direction survive
 * where they still apply; a reveal drops a directional field it cannot use.
 */
export function nextTransition(transition, type) {
  if (!type) return undefined;
  const old = isObject(transition) ? transition : null;
  const oldFrames = old ? transitionFrames(old) : 0;
  const oldType = old ? transitionType(old) : '';
  const frames = transitionNeedsFrames(type)
    ? (transitionNeedsFrames(oldType) && oldFrames > 0 ? oldFrames : DEFAULT_TRANSITION_FRAMES)
    : 0;
  const next = { ...(old ?? {}), type, frames };
  if (!transitionHasDirection(type)) delete next.direction;
  return next;
}

/**
 * Timing provenance for a scene. Phrase cues are resolved by the measured
 * pipeline, so the preview must say whether it has a measured timeline, an
 * estimate, or no data at all.
 */
export function timingProvenance(narration, timeline, sceneId) {
  const hasNarration = typeof narration === 'string' && narration.trim().length > 0;
  if (!hasNarration) {
    return {
      state: 'no-narration',
      label: 'Add narration text to use phrase cues; there is nothing to resolve against yet.',
    };
  }
  const scene = Array.isArray(timeline?.scenes) ? timeline.scenes.find(item => item?.id === sceneId) : undefined;
  const captions = Array.isArray(timeline?.captions)
    ? timeline.captions.filter(caption => caption?.sceneId === sceneId)
    : [];
  const estimated = timeline?.provisional === true || scene?.provisional === true || captions.some(caption => caption?.estimated === true);
  if (estimated) {
    return {
      state: 'estimated',
      label: 'This preview uses estimated narration timing. Phrase cues resolve against measured speech when the pipeline runs, so preview cue positions are approximate.',
    };
  }
  if (captions.length > 0) {
    return {
      state: 'measured',
      label: 'Narration duration is measured for this scene. Phrase cues resolve in the pipeline; word positions may still be estimated (for example, Kokoro syllable timing).',
    };
  }
  return {
    state: 'unavailable',
    label: 'No measured narration timing is in this preview. Phrase cues resolve during the measured pipeline; preview positions are approximate.',
  };
}

function option(value, label, selected, disabled = false, title = '') {
  return `<option value="${esc(value)}"${selected ? ' selected' : ''}${disabled ? ' disabled' : ''}${title ? ` title="${esc(title)}"` : ''}>${esc(label)}</option>`;
}

function secondsHint(frames, fps) {
  const rate = isFiniteNumber(fps) && fps > 0 ? fps : 30;
  return `${(frames / rate).toFixed(2)} s at ${rate} fps`;
}

/**
 * Markup for one scene's Animation & storytelling section.
 *
 * `motion` is the raw scene.motion (possibly absent); `transition` is the raw
 * scene.transitionOut. The caller owns package mutation and persistence.
 */
export function animationMarkup({
  sceneId,
  layout,
  motion = {},
  transition,
  locked = false,
  isFinal = false,
  timing = { state: 'unavailable', label: '' },
  fps = 30,
}) {
  const current = isObject(motion) ? motion : {};
  const recipe = RECIPE_SET.has(current.recipe) ? current.recipe : '';
  const allowed = recipesForLayout(layout);
  const currentAllowed = allowed.some(item => item.id === recipe);
  const currentRecipe = allowed.find(item => item.id === recipe);
  const disabled = locked ? ' disabled' : '';
  const confirm = locked ? ' aria-disabled="true"' : '';
  const recipeOptions = allowed
    .map(item => option(item.id, item.label ?? item.id, item.id === recipe, false, item.description ?? ''))
    .join('');
  const invalidOption = recipe && !currentAllowed
    ? option(recipe, `${currentRecipe?.label ?? recipe} · not offered for ${layout}`, true, true)
    : '';
  const description = currentRecipe?.description
    ?? (recipe
      ? `The saved recipe “${recipe}” is not offered for the ${layout} layout. Choose the default or a recipe from this list.`
      : 'Default keeps the scene’s existing entry, ease, emphasis and other motion fields. A recipe adds only its bounded fields.');
  const seed = validSeed(current.seed) ? String(current.seed) : '';
  const intensity = validIntensity(current.intensity) ? current.intensity : 0.65;
  const morph = validMorph(current.morph) ? current.morph : defaultMorph();
  const focus = validFocus(current.focus) ? current.focus : defaultFocus();
  const cues = formatCuePhrases(current.cue_phrases);
  const cueNote = timing?.label ?? '';
  const type = transitionType(transition);
  const explicit = isObject(transition) && typeof transition.type === 'string';
  const frames = transitionFrames(transition);
  const framesOn = transitionNeedsFrames(type);

  const conditional = recipe ? `
    <div class="animation-grid animation-recipe-fields">
      <label>Seed (stable sketch/noise seed)
        <input type="number" min="1" max="2147483647" step="1" value="${esc(seed)}" placeholder="${esc(defaultSeed(sceneId))}" data-anim-scene="${esc(sceneId)}" data-anim-field="seed"${disabled}${confirm} />
      </label>
      <label>Intensity <span class="animation-value" data-anim-intensity-value>${esc(intensity)}</span>
        <input type="range" min="0" max="1" step="0.01" value="${esc(intensity)}" data-anim-scene="${esc(sceneId)}" data-anim-field="intensity"${disabled}${confirm} />
      </label>
    </div>
    ${recipe === 'morph' ? `<div class="animation-grid animation-conditional" data-animation-conditional="morph">
      <label>Morph from
        <select data-anim-scene="${esc(sceneId)}" data-anim-field="morph.from"${disabled}${confirm}>${MORPH_SHAPES.map(shape => option(shape, shape, shape === morph.from)).join('')}</select>
      </label>
      <label>Morph to
        <select data-anim-scene="${esc(sceneId)}" data-anim-field="morph.to"${disabled}${confirm}>${MORPH_SHAPES.map(shape => option(shape, shape, shape === morph.to)).join('')}</select>
      </label>
    </div>` : ''}
    ${recipe === 'focus' ? `<div class="animation-focus" data-animation-conditional="focus">
      <span class="animation-subhead">Focus window (normalised 0–1)</span>
      <div class="animation-grid animation-focus-grid">
        ${[['x', focus.x, 0], ['y', focus.y, 0], ['width', focus.width, 0.01], ['height', focus.height, 0.01]].map(([field, value, min]) => `<label>${field}
          <input type="number" min="${min}" max="1" step="0.01" value="${esc(value)}" data-anim-scene="${esc(sceneId)}" data-anim-field="focus.${field}"${disabled}${confirm} />
        </label>`).join('')}
      </div>
    </div>` : ''}
    <label class="animation-cues">Phrase cues (one per line, max ${MAX_CUE_PHRASES})
      <textarea rows="3" maxlength="1200" placeholder="e.g. reaches the worker" data-anim-scene="${esc(sceneId)}" data-anim-field="cue_phrases"${disabled}${confirm}>${esc(cues)}</textarea>
    </label>
    <p class="animation-hint" data-animation-timing="${esc(timing?.state ?? 'unavailable')}">${esc(cueNote)}</p>
  ` : '';

  const transitionBlock = isFinal
    ? `<div class="animation-transition" data-animation-transition="final">
      <span class="animation-subhead">Outgoing transition</span>
      <p class="animation-hint">Final scene: there is no next scene, so no outgoing transition is applied.${explicit ? ` The saved “${esc(type || 'unknown')}” value is ignored.` : ''}</p>
    </div>`
    : `<div class="animation-transition" data-animation-transition="scene">
      <span class="animation-subhead">Outgoing transition</span>
      <div class="animation-grid">
        <label>Transition
          <select data-anim-scene="${esc(sceneId)}" data-anim-field="transition.type"${disabled}${confirm}>
            ${option('', 'Default (fade)', !explicit)}
            ${explicit && !type ? option('', 'Unknown saved value', true, true) : ''}
            <optgroup label="Standard">${TRANSITION_OPTIONS.filter(item => item.group === 'standard').map(item => option(item.id, item.label, item.id === type)).join('')}</optgroup>
            <optgroup label="Reveal">${TRANSITION_OPTIONS.filter(item => item.group === 'reveal').map(item => option(item.id, item.label, item.id === type)).join('')}</optgroup>
          </select>
        </label>
        <label>Duration (frames)
          <input type="number" min="0" max="120" step="1" value="${esc(frames)}" data-anim-scene="${esc(sceneId)}" data-anim-field="transition.frames"${!explicit || !framesOn ? ' disabled' : ''}${locked ? ' disabled' : ''}${confirm} />
        </label>
      </div>
      <p class="animation-hint">${explicit && framesOn ? `${esc(secondsHint(frames, fps))}. ` : ''}The next scene overlaps by this many frames; export recompiles the overlap. The final scene has no outgoing transition.</p>
    </div>`;

  return `<section class="animation-settings${locked ? ' locked' : ''}" aria-label="Animation and storytelling" data-animation-section data-scene-id="${esc(sceneId)}" data-animation-layout="${esc(layout)}">
    <div class="animation-head">
      <span class="animation-title">Animation &amp; storytelling</span>
      <span class="animation-layout">${esc(layout)}</span>
      ${locked ? '<span class="animation-lock">locked</span>' : ''}
    </div>
    <label>Recipe
      <select data-anim-scene="${esc(sceneId)}" data-anim-field="recipe"${disabled}${confirm}>
        ${option('', 'Default / none', !recipe)}
        ${invalidOption}${recipeOptions}
      </select>
    </label>
    <p class="animation-hint animation-recipe-description">${esc(description)}</p>
    ${conditional}
    ${transitionBlock}
    <div class="animation-actions">
      <button type="button" data-anim-scene="${esc(sceneId)}" data-anim-action="save"${disabled}${confirm}>Save animation</button>
      <span class="animation-status" role="status" aria-live="polite" data-anim-status></span>
    </div>
    <p class="animation-hint"><a href="/animation-licenses.txt" target="_blank" rel="noopener">Animation software notices</a></p>
  </section>`;
}
