import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { CONVERSATION_TOOLS, CONVERSATION_RECIPES, CONVERSATION_TRANSITIONS, conversationPlanSchema, patchConversationPlan } from '../../../packages/agent/dist/src/index.js';
import { ANIMATION_RECIPE_IDS, ANIMATION_TRANSITIONS } from '../../../packages/schema/src/animation.mjs';

const require = createRequire(new URL('../../../packages/schema/package.json', import.meta.url));
const Ajv = require('ajv');
const accepts = new Ajv({ strict: false }).compile(CONVERSATION_TOOLS.find(tool => tool.name === 'project_patch_plan').parameters);

test('model-visible patch schema and executor both accept partial and cleared motion fields', () => {
  const plan = conversationPlanSchema.parse({ title: 'Motion contract', brief: 'An editable test', audience: 'Developers', aspect: '16:9', stylePreset: 'cinematic-dark',
    scenes: [{ id: 's_demo', layout: 'hero', headline: 'A clear idea', narration: 'A clear idea.', seconds: 5, visual: 'A simple diagram',
      motion: { recipe: 'focus', seed: 7, intensity: .5, focus: { x: .2, y: .2, width: .5, height: .5 }, entry: 'maskRise' } }] });
  const edit = { scenePatches: [{ id: 's_demo', changes: { motion: { intensity: .8, focus: { x: .1 } } } }] };
  assert.equal(accepts(edit), true, JSON.stringify(accepts.errors));
  const updated = patchConversationPlan(plan, edit);
  assert.equal(updated.scenes[0].motion.focus.x, .1);
  assert.equal(updated.scenes[0].motion.focus.width, .5);
  assert.equal(updated.scenes[0].motion.entry, 'maskRise');
  const clear = { scenePatches: [{ id: 's_demo', changes: { motion: { recipe: null, focus: null } } }] };
  assert.equal(accepts(clear), true, JSON.stringify(accepts.errors));
  const cleared = patchConversationPlan(updated, clear);
  assert.equal(cleared.scenes[0].motion.recipe, undefined);
  assert.equal(cleared.scenes[0].motion.seed, 7);
  const all = { scenePatches: [{ id: 's_demo', changes: { motion: null } }] };
  assert.equal(accepts(all), true, JSON.stringify(accepts.errors));
  assert.equal(patchConversationPlan(cleared, all).scenes[0].motion, undefined);
  assert.equal(accepts({ scenePatches: [{ id: 's_demo', changes: { motion: { mystery: true } } }] }), false);
});

test('conversation tool vocabulary matches the shared animation catalogue', () => {
  assert.deepEqual(CONVERSATION_RECIPES, ANIMATION_RECIPE_IDS);
  assert.deepEqual(CONVERSATION_TRANSITIONS, ANIMATION_TRANSITIONS);
});
