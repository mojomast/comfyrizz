// The storyboard animation controls must use the shared catalogue, respect locked
// scenes, and keep unrelated motion/package edits intact.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  ANIMATION_RECIPES,
  ANIMATION_RECIPE_IDS,
  ANIMATION_REVEAL_TRANSITIONS,
  ANIMATION_TRANSITIONS,
} from '../../../packages/schema/src/animation.mjs';
import {
  MAX_CUE_PHRASES,
  RECIPE_IDS,
  animationMarkup,
  defaultFocus,
  formatCuePhrases,
  nextTransition,
  normalizeFocusField,
  parseCuePhrases,
  recipesForLayout,
  timingProvenance,
  transitionHasDirection,
  validFocus,
  withRecipe,
} from '../src/animation-controls.mjs';

const source = readFileSync(fileURLToPath(new URL('../src/main.ts', import.meta.url)), 'utf8');
const settings = readFileSync(fileURLToPath(new URL('../src/animation-settings.ts', import.meta.url)), 'utf8');
const css = readFileSync(fileURLToPath(new URL('../src/animation-settings.css', import.meta.url)), 'utf8');

test('animation catalogue: the editor and schema expose the same fixed recipe vocabulary', () => {
  assert.deepEqual([...RECIPE_IDS], [...ANIMATION_RECIPE_IDS]);
  assert.equal(ANIMATION_RECIPES.length, 6);
  for (const recipe of ANIMATION_RECIPES) {
    assert.equal(typeof recipe.id, 'string');
    assert.equal(typeof recipe.label, 'string');
    assert.equal(typeof recipe.description, 'string');
    assert.ok(Array.isArray(recipe.layouts) && recipe.layouts.length > 0, `${recipe.id} lists layouts`);
  }
  assert.deepEqual(recipesForLayout('title').map(recipe => recipe.id), ANIMATION_RECIPES.filter(recipe => recipe.layouts.includes('title')).map(recipe => recipe.id));
  assert.ok(recipesForLayout('title').some(recipe => recipe.id === 'sketch'));
  assert.ok(!recipesForLayout('title').some(recipe => recipe.id === 'technical-flow'), 'technical-flow is not offered for title');
  assert.ok(recipesForLayout('code').some(recipe => recipe.id === 'focus'));
  assert.ok(!recipesForLayout('code').some(recipe => recipe.id === 'technical-flow'), 'the terminal has no free region for a graph');
  assert.deepEqual(recipesForLayout('not-a-layout'), []);
});

test('recipe choices preserve custom motion fields and only fill missing bounded defaults', () => {
  const custom = {
    recipe: 'sketch',
    seed: 17,
    intensity: 0.2,
    entry: 'maskRise',
    ease: 'land',
    spring: 'pop',
    emphasis: 'keyword',
    highlight: 'shape',
    cue_phrases: ['first beat'],
    morph: { from: 'blob', to: 'triangle' },
    focus: { x: 0.1, y: 0.2, width: 0.3, height: 0.4 },
    cue_seconds: [1, 2],
  };
  const next = withRecipe(custom, 'focus', 's_demo');
  assert.notEqual(next, custom, 'motion is copied, never mutated in place');
  assert.equal(next.recipe, 'focus');
  assert.equal(next.seed, 17);
  assert.equal(next.intensity, 0.2);
  assert.equal(next.entry, 'maskRise');
  assert.equal(next.ease, 'land');
  assert.equal(next.spring, 'pop');
  assert.equal(next.emphasis, 'keyword');
  assert.equal(next.highlight, 'shape');
  assert.deepEqual(next.cue_phrases, ['first beat']);
  assert.deepEqual(next.cue_seconds, [1, 2]);
  assert.deepEqual(next.morph, { from: 'blob', to: 'triangle' }, 'unrelated morph data survives');
  assert.deepEqual(next.focus, { x: 0.1, y: 0.2, width: 0.3, height: 0.4 });

  const removed = withRecipe(next, undefined, 's_demo');
  assert.equal('recipe' in removed, false, 'default/none removes only the recipe');
  assert.equal(removed.entry, 'maskRise');
  assert.equal(removed.seed, 17);
  assert.deepEqual(removed.focus, next.focus);

  const first = withRecipe({}, 'morph', 's_demo');
  assert.equal(first.recipe, 'morph');
  assert.ok(Number.isInteger(first.seed) && first.seed >= 1 && first.seed <= 2147483647);
  assert.equal(first.intensity, 0.65);
  assert.deepEqual(first.morph, { from: 'circle', to: 'square' });
  assert.equal(withRecipe({}, 'morph', 's_demo').seed, first.seed, 'the default seed is stable');
  assert.equal(withRecipe({}, 'focus', 's_demo').focus.width, defaultFocus().width);
});

test('cue phrases are line-separated, trimmed and capped at six', () => {
  const phrases = parseCuePhrases(' first \n\n second\nthird\nfourth\nfifth\nsixth\nseventh ');
  assert.deepEqual(phrases, ['first', 'second', 'third', 'fourth', 'fifth', 'sixth']);
  assert.equal(phrases.length, MAX_CUE_PHRASES);
  assert.equal(formatCuePhrases(phrases), 'first\nsecond\nthird\nfourth\nfifth\nsixth');
});

test('focus rectangles stay normalised and inside the frame', () => {
  const focus = { x: 0.2, y: 0.2, width: 0.4, height: 0.4 };
  assert.equal(validFocus(focus), true);
  assert.equal(normalizeFocusField('x', '0.5', focus), 0.5);
  assert.equal(normalizeFocusField('width', '0', focus), undefined, 'width must be positive');
  assert.equal(normalizeFocusField('height', '-0.1', focus), undefined);
  assert.equal(normalizeFocusField('x', '0.7', focus), undefined, 'x + width may not leave the frame');
  assert.equal(normalizeFocusField('y', '0.7', focus), undefined, 'y + height may not leave the frame');
});

test('timing hints distinguish measured, estimated and absent narration timing', () => {
  assert.equal(timingProvenance('', { scenes: [] }, 's1').state, 'no-narration');
  const estimated = timingProvenance('A line of narration.', {
    scenes: [{ id: 's1', provisional: true }],
    captions: [{ sceneId: 's1', estimated: true }],
  }, 's1');
  assert.equal(estimated.state, 'estimated');
  assert.match(estimated.label, /estimated narration timing/i);
  assert.match(estimated.label, /measured speech when the pipeline runs/i);
  const measured = timingProvenance('A line of narration.', {
    scenes: [{ id: 's1', provisional: false }],
    captions: [{ sceneId: 's1', estimated: false }],
  }, 's1');
  assert.equal(measured.state, 'measured');
  const unavailable = timingProvenance('A line of narration.', { scenes: [] }, 's1');
  assert.equal(unavailable.state, 'unavailable');
  assert.match(unavailable.label, /resolve during the measured pipeline/i);
});

test('markup conditionally exposes morph, focus, cue and transition controls', () => {
  const base = {
    sceneId: 's1',
    layout: 'title',
    motion: { recipe: 'sketch', seed: 42, intensity: 0.5 },
    transition: { type: 'fade', frames: 15 },
    timing: { state: 'measured', label: 'Measured timing.' },
    fps: 30,
  };
  const sketch = animationMarkup(base);
  assert.match(sketch, /Animation &amp; storytelling/);
  assert.match(sketch, /data-anim-field="seed"/);
  assert.match(sketch, /data-anim-field="intensity"/);
  assert.match(sketch, /data-anim-field="cue_phrases"/);
  assert.doesNotMatch(sketch, /data-anim-field="morph\.from"/);
  assert.doesNotMatch(sketch, /data-anim-field="focus\.x"/);
  assert.match(sketch, /data-anim-field="transition\.type"/);
  assert.match(sketch, /data-anim-field="transition\.frames"/);
  for (const transition of ANIMATION_TRANSITIONS) assert.ok(sketch.includes(`value="${transition}"`), `transition ${transition} is offered`);
  for (const transition of ANIMATION_REVEAL_TRANSITIONS) assert.match(css + sketch, /reveal/i);

  const morph = animationMarkup({ ...base, motion: { recipe: 'morph' } });
  assert.match(morph, /data-anim-field="morph\.from"/);
  assert.match(morph, /data-anim-field="morph\.to"/);
  assert.doesNotMatch(morph, /data-anim-field="focus\.x"/);

  const focus = animationMarkup({ ...base, layout: 'hero', motion: { recipe: 'focus' } });
  assert.match(focus, /data-anim-field="focus\.x"/);
  assert.match(focus, /data-anim-field="focus\.height"/);
  assert.doesNotMatch(focus, /data-anim-field="morph\.from"/);

  const invalid = animationMarkup({ ...base, motion: { recipe: 'technical-flow' } });
  assert.match(invalid, /not offered for the title layout/);
});

test('locked scenes disable every animation control and the save action', () => {
  const markup = animationMarkup({
    sceneId: 's1',
    layout: 'hero',
    motion: { recipe: 'focus', seed: 1, intensity: 0.4 },
    transition: { type: 'paper-reveal', frames: 12 },
    locked: true,
    timing: { state: 'estimated', label: 'Estimated timing.' },
  });
  assert.match(markup, /animation-settings locked/);
  assert.match(markup, /animation-lock/);
  assert.match(markup, /data-anim-action="save"[^>]*disabled/);
  assert.ok((markup.match(/disabled/g) ?? []).length >= 7, 'recipe, fields, cues, transition and save are disabled');
  assert.match(markup, /Estimated timing\./);
});

test('the final scene has no outgoing transition control', () => {
  const markup = animationMarkup({
    sceneId: 's_last',
    layout: 'title',
    motion: { recipe: 'kinetic' },
    transition: { type: 'fade', frames: 15 },
    isFinal: true,
  });
  assert.match(markup, /data-animation-transition="final"/);
  assert.match(markup, /Final scene: there is no next scene/);
  assert.doesNotMatch(markup, /data-anim-field="transition\.type"/);
  assert.doesNotMatch(markup, /data-anim-field="transition\.frames"/);
  assert.equal(transitionHasDirection('paper-reveal'), false);
  assert.equal(transitionHasDirection('slide'), true);
});

test('transition choices add reveal types and keep only applicable fields', () => {
  assert.equal(nextTransition(undefined, ''), undefined);
  const reveal = nextTransition({ type: 'slide', frames: 12, direction: 'left' }, 'paper-reveal');
  assert.deepEqual(reveal, { type: 'paper-reveal', frames: 12 });
  const fade = nextTransition({ type: 'none', frames: 0 }, 'fade');
  assert.deepEqual(fade, { type: 'fade', frames: 15 });
  const slide = nextTransition({ type: 'fade', frames: 18 }, 'slide');
  assert.equal(slide.frames, 18);
  assert.equal('direction' in slide, false);
  assert.equal(nextTransition({ type: 'fade', frames: 15 }, 'cut').frames, 0);
});

test('the storyboard mounts per-scene controls and keeps existing voice/preview wiring', () => {
  assert.match(source, /mountSceneAnimation/);
  assert.match(source, /timingProvenance/);
  assert.match(source, /data-animation-scene=/);
  assert.match(source, /save: \(\) => persistDraft\(true\)/);
  assert.match(source, /scene\.locked \? '<span class="scene-lock">locked<\/span>'/);
  assert.match(source, /restoreStoryboardFocus/);
  assert.match(source, /mountVoiceSettings/);
  assert.match(source, /updateAnimationTiming/);
  assert.match(settings, /fresh\.locked/);
  assert.match(settings, /export function updateAnimationTiming/);
  assert.match(settings, /withRecipe/);
  assert.match(css, /@media \(max-width: 760px\)/);
});
