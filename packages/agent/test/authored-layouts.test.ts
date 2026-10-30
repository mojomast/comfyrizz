import assert from 'node:assert/strict';
import test from 'node:test';
import { createToolset } from '../src/tools.js';

const datasets = { d_regions: { source: 'user', unit: 'value', values: [{ label: 'North', value: 12 }, { label: 'South', value: 19 }] } };

for (const brief of [
  'Motion graphics: compare supplied values in one bar chart.',
  'Motion graphics: do not use comparison plates. Use one bar chart.',
]) {
  test(`${brief} preserves chart layout, data and media absence through edits`, () => {
    const tools = createToolset();
    const proposed = tools['storyboard.propose'].run({
      brief, datasets, scenes: [{ id: 's1', layout: 'chart', data: { dataset: 'd_regions', display: 'bar' }, copy: { headline: 'Compare supplied values' } }],
    }) as any;
    const edited = tools['storyboard.edit'].run({ scene_id: 's1', patch: { copy: { headline: 'North versus South' } } }) as any;
    for (const pkg of [proposed.package, edited.package]) {
      assert.equal(pkg.scenes[0].layout, 'chart');
      assert.equal(pkg.scenes[0].media, undefined);
      assert.deepEqual(pkg.scenes[0].data, { dataset: 'd_regions', display: 'bar' });
      assert.deepEqual(pkg.datasets, datasets);
    }
  });
}

test('layout inference applies only to omitted layouts and prefers a named bar chart', () => {
  const result = createToolset()['storyboard.propose'].run({
    brief: 'Motion graphics.', datasets,
    scenes: [
      { id: 's1', copy: { headline: 'Compare values in a bar chart' }, data: { dataset: 'd_regions', display: 'bar' } },
      { id: 's2', layout: 'hero', copy: { headline: 'Compare values in a bar chart' } },
      { id: 's3', copy: { headline: 'North versus South' } },
      { id: 's4', copy: { headline: 'Do not use comparison plates' } },
    ],
  }) as any;
  assert.deepEqual(result.package.scenes.map((scene: any) => scene.layout), ['chart', 'hero', 'compare', 'hero']);
  assert.ok(result.package.scenes.every((scene: any) => scene.media === undefined));
});

test('split and compare without authored content remain schema errors instead of acquiring fake plates', async () => {
  const schema = await import(new URL('../../../schema/src/index.mjs', import.meta.url).href);
  for (const layout of ['split', 'compare']) {
    const tools = createToolset();
    const proposed = tools['storyboard.propose'].run({ brief: 'Motion graphics.', scenes: [{ id: 's1', layout, copy: { headline: 'Two real views needed' } }] }) as any;
    const edited = tools['storyboard.edit'].run({ scene_id: 's1', patch: { copy: { headline: 'Still need real views' } } }) as any;
    for (const pkg of [proposed.package, edited.package]) {
      assert.equal(pkg.scenes[0].layout, layout);
      assert.equal(pkg.scenes[0].media, undefined);
      assert.ok(schema.validatePackage(pkg).semantic.some((error: any) => error.code === 'SEM_LAYOUT_REQUIRES_MEDIA'));
    }
  }
});
