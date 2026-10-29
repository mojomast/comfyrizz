import assert from 'node:assert/strict';
import test from 'node:test';
import { createToolset } from '../src/tools.js';

test('title sizing is bounded, title-only, and visible in real tool definitions and results', async () => {
  const tools = createToolset();
  const tool = tools['storyboard.propose'];
  const result: any = await tool.run(tool.schema.parse({ brief: 'A silent native title', scenes: [{ id: 's1', layout: 'title', headline_size: 440, copy: { headline: 'PLEASE\nHOLD' } }] }));
  assert.equal(result.package.scenes[0].headline_size, 440);
  assert.equal((tool.modelResult!(result) as any).package.scenes[0].headline_size, 440);
  assert.deepEqual(result.copy_contract.slots_by_layout.title, ['headline', 'kicker', 'sub', 'cta']);
  for (const name of ['storyboard.propose', 'storyboard.edit', 'storyboard.add_scene']) {
    const definition: any = tools[name].definition.parameters;
    const props = name.endsWith('propose') ? definition.properties.scenes.items.properties : definition.properties[name.endsWith('edit') ? 'patch' : 'scene'].properties;
    assert.equal(props.headline_size.minimum, 24);
    assert.equal(props.headline_size.maximum, 512);
    assert.equal(props.copy.additionalProperties, false);
    assert.equal(props.lower_third.properties.text.maxLength, 120);
  }
  for (const headline_size of [23, 513, 104.5, '440', 'url(x)']) {
    await assert.rejects(async () => tools['storyboard.edit'].run({ scene_id: 's1', patch: { headline_size } }));
  }
  await assert.rejects(async () => tools['storyboard.edit'].run({ scene_id: 's1', patch: { layout: 'hero' } }), /only.*title/);
  const after: any = await tools['storyboard.edit'].run({ scene_id: 's1', patch: { preferredFrames: 180 } });
  assert.equal(after.package.scenes[0].headline_size, 440);
  assert.equal(after.revision, result.revision + 1, 'rejected edits did not mutate the draft');
  const defaults: any = await createToolset()['storyboard.propose'].run({ brief: 'A silent native title', scenes: [{ id: 's1', layout: 'title', copy: 'Original default' }] });
  assert.equal(defaults.package.scenes[0].headline_size, undefined);
});

test('supported body and caption/credit copy survives propose, edit and compact model results exactly', async () => {
  const tools = createToolset();
  const body = 'STUDY CONCLUDED.';
  const credit = 'Eadweard Muybridge, 1887 · Library of Congress';
  const result: any = await tools['storyboard.propose'].run({ brief: 'A silent editorial card', scenes: [{ id: 's1', layout: 'hero', copy: { headline: 'ANIMAL LOCOMOTION — PLATE 720', body }, lower_third: { text: credit } }] });
  const edited: any = await tools['storyboard.edit'].run({ scene_id: 's1', patch: { copy: { sub: 'An archival study' }, lower_third: { text: credit, kicker: 'Source' } } });
  for (const value of [result, edited, tools['storyboard.edit'].modelResult!(edited) as any]) {
    assert.equal(value.package.scenes[0].copy.body, body);
    assert.equal(value.package.scenes[0].lower_third.text, credit);
    assert.ok(value.copy_contract.slots_by_layout.hero.includes('body'));
  }
});

test('unsupported copy and overlong headlines produce actionable errors on propose/edit/add, never successful no-ops', async () => {
  const invalid = [
    { body: 'Closing', error: /hero.copy.body/ },
    { credit: 'Source', error: /lower_third/ },
    { lower_third: 'Source', error: /object.*text/ },
    { lower_third: { text: 'Source', title: 'Ignored' }, error: /lower_third/ },
    { copy: { subhead: 'Subtitle' }, error: /copy.sub/ },
    { copy: { title: 'Title' }, error: /copy.headline/ },
    { copy: { lower_third: 'Source' }, error: /scene.lower_third/ },
    { copy: { caption: 'Source' }, error: /lower_third/ },
    { copy: { headline: 'A'.repeat(65) }, error: /64.*65.*never silently truncated/ },
  ];
  for (const { error, ...patch } of invalid) {
    const tools = createToolset();
    await tools['storyboard.propose'].run({ brief: 'An editorial card', scenes: [{ id: 's1', layout: 'hero', copy: { headline: 'Original' } }] });
    await assert.rejects(async () => tools['storyboard.edit'].run({ scene_id: 's1', patch }), error);
    await assert.rejects(async () => tools['storyboard.propose'].run({ brief: 'An editorial card', scenes: [{ id: 's1', layout: 'hero', ...patch }] }), error);
    await assert.rejects(async () => tools['storyboard.add_scene'].run({ scene: { id: 's2', layout: 'hero', preferredFrames: 120, ...patch } }), error);
    const after: any = await tools['storyboard.edit'].run({ scene_id: 's1', patch: { preferredFrames: 150 } });
    assert.equal(after.package.scenes[0].copy.headline, 'Original');
    assert.equal(after.revision, 2);
  }
  await assert.rejects(async () => createToolset()['storyboard.propose'].run({ brief: 'A title', scenes: [{ id: 's1', layout: 'title', copy: { body: 'Unsupported body' } }] }), /not rendered.*title/);
});

test('intentional headline and list aliases remain accepted', async () => {
  const result: any = await createToolset()['storyboard.propose'].run({ brief: 'Native graphics', scenes: [
    { id: 's1', layout: 'title', copy: 'String headline' },
    { id: 's2', layout: 'hero', title: 'Title alias' },
    { id: 's3', layout: 'hero', headline: 'Headline alias' },
    { id: 's4', layout: 'list', items: ['First', 'Second'] },
  ] });
  assert.deepEqual(result.package.scenes.slice(0, 3).map((scene: any) => scene.copy.headline), ['String headline', 'Title alias', 'Headline alias']);
  assert.deepEqual(result.package.scenes[3].copy.items, ['First', 'Second']);
});
