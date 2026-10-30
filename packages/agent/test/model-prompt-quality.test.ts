import assert from 'node:assert/strict';
import test from 'node:test';
import { expandFluxCaption, expandReferenceEditCaption } from '../src/caption.js';
import { createToolset, generateImageSchema } from '../src/tools.js';
import { runAgent } from '../src/agent.js';
import { MODEL_QUALITY_GUIDANCE, KLEIN_CAPTION_GUIDANCE, KLEIN_EDIT_GUIDANCE } from '../src/prompts/model-quality.js';
import type { ChatModel } from '../src/types.js';

test('Klein rich captions preserve exact multilingual copy and line breaks through schema and planning', async () => {
  const intent = 'Studio photograph, eye-level medium-wide framing of a brushed steel kettle on a pale oak table. '
    + 'The kettle stands frame-left with its handle facing right and its spout pointing toward the left edge. '
    + 'Soft window light from frame-right reveals the steel grain and casts a single shadow across the table. '
    + 'The cream wall fills the background; the tabletop remains visible around the entire base. '
    + 'A small card at frame-right carries the exact two-line wording "Été — 20%\n明日も。" in dark upright lettering. '
    + 'The card faces the camera squarely, its edges parallel to the frame, with sufficient space around both lines to keep every character legible.';
  assert.ok(intent.split(/\s+/).length >= 100);
  const parsed = generateImageSchema.parse({ scene_id: 's1', intent, text: true });
  assert.equal(parsed.intent, intent);
  const tools = createToolset();
  await tools['storyboard.propose'].run({ brief: 'A product still with exact card lettering.' });
  const result = await tools['assets.generate_image'].run(parsed) as any;
  assert.ok(result.caption.startsWith(intent + '\n'));
  assert.ok(result.asset.gen.inputs.prompt.includes('"Été — 20%\n明日も。"'));
  assert.equal(result.asset.gen.inputs.text, true);
  assert.doesNotMatch(result.caption, /plain, unmarked surfaces|no text|no letters/);
});

test('Klein caption decoration keeps result prose and bounded edits intact without invented reference tokens', () => {
  for (const intent of [
    'Close-up photograph of the original steel kettle, now with a red handle.',
    'Change only the handle to red. Keep the label "STOP!".',
  ]) {
    const caption = expandReferenceEditCaption({ intent, text: true });
    assert.ok(caption.startsWith(intent + '\n'));
    assert.doesNotMatch(caption, /Restyle this|Edit the supplied reference:|<ref_image_|Picture \d/);
    assert.match(caption, /except for the requested changes/);
  }
  const plain = expandFluxCaption({ intent: 'A steel kettle.' });
  assert.match(plain, /plain, unmarked surfaces/);
  assert.doesNotMatch(plain, /no text|no letters|no words|no logos/);
});

test('image tool advertises two references and refuses unsupported low-level planned input overrides', async () => {
  assert.equal(generateImageSchema.safeParse({ scene_id: 's1', intent: 'An edit.', refs: ['a', 'b', 'c'] }).success, false);
  for (const inputs of [
    { reference: 'a', reference_2: 'b', reference_3: 'c' },
    { reference: 'a', _reference_2: 'b', _reference_3: 'c' },
    { images: 'a,b,c' },
  ]) {
    const tools = createToolset({ planImage: () => ({ inputs }) });
    await tools['storyboard.propose'].run({ brief: 'A still image.' });
    const definition = tools['assets.generate_image'].definition as any;
    assert.equal(definition.parameters.properties.refs.maxItems, 2);
    await assert.rejects(async () => tools['assets.generate_image'].run({ scene_id: 's1', intent: 'An edit.' }), /PLAN_KLEIN_REFERENCE_UNSUPPORTED/);
  }
});

test('builder and model-facing image schema share canonical guidance while retaining H3 boundaries', async () => {
  let system = '';
  const model: ChatModel = { id: 'prompt-inspection', async *stream(request) {
    system = request.system ?? '';
    yield { type: 'text' as const, delta: 'Inspected.' };
    yield { type: 'done' as const };
  } };
  const tools = createToolset();
  await runAgent({ model, tools, brief: 'Inspect prompt guidance.', maxSteps: 1 });
  assert.ok(system.includes(MODEL_QUALITY_GUIDANCE));
  const definition = JSON.stringify(tools['assets.generate_image'].definition);
  assert.ok(definition.includes(KLEIN_CAPTION_GUIDANCE));
  assert.ok(definition.includes(KLEIN_EDIT_GUIDANCE));
  assert.doesNotMatch(system, /40-70 words|None of these models has a working negative prompt/);
  assert.match(system, /retain the LTX workflow negative conditioning/);
  assert.match(system, /six-section full-reference prompt/);
  assert.match(system, /conditioningText/);
});
