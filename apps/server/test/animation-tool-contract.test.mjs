import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { CONVERSATION_TOOLS, CONVERSATION_RECIPES, CONVERSATION_TRANSITIONS, conversationPlanSchema, patchConversationPlan, runConversationTurn } from '../../../packages/agent/dist/src/index.js';
import { ANIMATION_RECIPES, ANIMATION_RECIPE_IDS, ANIMATION_TRANSITIONS } from '../../../packages/schema/src/animation.mjs';

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

test('actual drafting and revision model requests receive current recipe capabilities and usage limits', async () => {
  const plan = conversationPlanSchema.parse({ title: 'Flow', brief: 'Explain a workflow', audience: 'Developers', aspect: '16:9', stylePreset: 'cinematic-dark',
    scenes: [{ id: 's_flow', layout: 'list', headline: 'Follow the work', items: ['Request', 'Worker', 'Result'], narration: 'A request reaches the worker and produces a result.', seconds: 8, visual: 'A process',
      motion: { recipe: 'technical-flow', seed: 42, entry: 'maskRise', cue_seconds: [1, 2, 3] } }] });
  for (const mode of ['chat', 'express']) for (const existing of [null, plan]) {
    let request;
    const result = await runConversationTurn({
      model: { id: 'contract', async *stream(input) { request = input; yield { type: 'text', delta: 'Here is the guidance.' }; } },
      plan: existing, projectContext: existing ? { packageId: 'pkg_flow' } : undefined, mode,
      messages: [{ role: 'user', content: 'Explain available animation settings without changing my project.' }],
      sessionId: 'animation-instructions', signal: AbortSignal.timeout(5000), build: async () => { throw Error('Advice must not build'); },
    });
    for (const recipe of ANIMATION_RECIPES) assert.ok(request.system.includes(`- ${recipe.id}: ${recipe.layouts.join(', ')}.`), `model guidance matches catalogue for ${recipe.id}`);
    assert.match(request.system, /Paper-cut and focus currently enter at scene start/);
    assert.match(request.system, /not forced\s+alignment/);
    assert.match(request.system, /no shared-object continuity/);
    assert.match(request.system, /future work, not available tools/);
    assert.equal(result.trace.promptVersion, '2.2.0');
    assert.ok(result.trace.skills.some(skill => skill.id === 'storyboard-direction' && skill.version === '1.4.2'));
    if (existing) {
      assert.match(request.system, /cue_seconds:null,cue_phrases/);
      assert.match(request.system, /motion:\{recipe:null\}/);
    }
    const tools = JSON.stringify(request.tools);
    assert.match(tools, /Whole-frame normalized rectangle/);
    assert.match(tools, /Explicit scene-local seconds/);
    assert.equal(result.built, false);
  }
  const switchToPhrases = { scenePatches: [{ id: 's_flow', changes: { motion: { cue_seconds: null, cue_phrases: ['request', 'worker', 'result'] } } }] };
  assert.equal(accepts(switchToPhrases), true);
  const updated = patchConversationPlan(plan, switchToPhrases);
  assert.equal(updated.scenes[0].motion.cue_seconds, undefined);
  assert.deepEqual(updated.scenes[0].motion.cue_phrases, ['request', 'worker', 'result']);
  assert.equal(updated.scenes[0].motion.seed, 42);
  assert.equal(updated.scenes[0].motion.entry, 'maskRise');
});
