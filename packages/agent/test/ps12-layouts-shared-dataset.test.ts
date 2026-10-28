import assert from 'node:assert/strict';
import test from 'node:test';
import { createToolset } from '../src/tools.js';

const D13_BRIEF = 'Create a motion-graphics data sequence with three scenes that share one user dataset: a bar chart, a big-number stat, and a comparison. North=12, South=19, East=7. Do not add regions or change these integers. Draw four SVG assets and plan one still. No narration.';

const D15_BRIEF = 'Create a four-scene motion-graphics sequence: bar chart, stat, comparison and outro. One shared user dataset: North=1250, South=900, East=12, West=7. Keep these integers exactly; do not insert thousands separators or split 1250 into 1 and 250. Draw four SVG assets and plan one still. No narration.';

const D13_VALUES = [
  { label: 'North', value: 12 },
  { label: 'South', value: 19 },
  { label: 'East', value: 7 },
];

const D15_VALUES = [
  { label: 'North', value: 1250 },
  { label: 'South', value: 900 },
  { label: 'East', value: 12 },
  { label: 'West', value: 7 },
];

function toolset() {
  return createToolset({ now: () => '2026-10-28T12:00:00.000Z' });
}

function copy(scene: any): string {
  const headline = typeof scene?.copy?.headline === 'string' ? scene.copy.headline : '';
  return headline.toLowerCase();
}

test('PS12 D13 keeps a comparison layout and shares one exact user dataset', async () => {
  const result = await toolset()['storyboard.propose'].run({
    brief: D13_BRIEF,
    datasets: {
      d_north: { unit: 'regions', values: [{ label: 'North', value: 12 }, { label: 'South', value: 19 }], source: 'user' },
      d_east: { unit: 'regions', values: [{ label: 'East', value: 7 }], source: 'user' },
    },
    scenes: [
      { id: 's_chart', layout: 'chart', copy: { headline: 'Regions' }, data: { dataset: 'd_north', display: 'bar' } },
      { id: 's_stat', layout: 'stat', copy: { headline: 'South', body: '19' }, data: { dataset: 'd_east', display: 'number' } },
      { id: 's_compare', layout: 'hero', copy: { headline: 'North versus South' }, data: { dataset: 'd_north', display: 'bar' } },
    ],
  }) as any;

  assert.ok(result.package.scenes.some((scene: any) => scene.layout === 'compare'), 'comparison brief must keep a compare layout');
  const compare = result.package.scenes.find((scene: any) => scene.layout === 'compare');
  assert.equal(compare.media.length, 2, 'compare scenes need the two schema plates');

  const datasetIds = Object.keys(result.package.datasets);
  assert.equal(datasetIds.length, 1, 'a shared user dataset must not be split');
  assert.deepEqual(result.package.datasets[datasetIds[0]].values, D13_VALUES);
  assert.equal(result.package.datasets[datasetIds[0]].source, 'user');
  assert.deepEqual(
    result.package.scenes.map((scene: any) => scene.data.dataset),
    result.package.scenes.map(() => datasetIds[0]),
  );

  const schema = await import(new URL('../../../schema/src/index.mjs', import.meta.url).href) as {
    validatePackage: (pkg: unknown) => { valid: boolean; errors: unknown[] };
  };
  const validation = schema.validatePackage(result.package);
  assert.equal(validation.valid, true, JSON.stringify(validation.errors));
});

test('PS12 D15 keeps comparison and shares one dataset with every scene, including the outro', async () => {
  const result = await toolset()['storyboard.propose'].run({
    brief: D15_BRIEF,
    datasets: {
      d_north: { unit: 'regions', values: [{ label: 'North', value: 1250 }, { label: 'South', value: 1 }], source: 'user' },
      d_south: { unit: 'regions', values: [{ label: 'East', value: 12 }, { label: 'West', value: 7 }], source: 'user' },
    },
    scenes: [
      { id: 's_chart', layout: 'chart', copy: { headline: 'Regions' }, data: { dataset: 'd_north', display: 'bar' } },
      { id: 's_stat', layout: 'stat', copy: { headline: 'North', body: '1250' }, data: { dataset: 'd_south', display: 'number' } },
      { id: 's_compare', layout: 'hero', copy: { headline: 'North versus South' }, data: { dataset: 'd_north', display: 'bar' } },
      { id: 's_outro', layout: 'title', copy: { headline: 'WEST WINS' } },
    ],
  }) as any;

  assert.deepEqual(result.package.scenes.map((scene: any) => scene.layout), ['chart', 'stat', 'compare', 'title']);
  const datasetIds = Object.keys(result.package.datasets);
  assert.equal(datasetIds.length, 1);
  assert.deepEqual(result.package.datasets[datasetIds[0]].values, D15_VALUES);
  for (const scene of result.package.scenes) {
    assert.equal(scene.data.dataset, datasetIds[0]);
  }

  const schema = await import(new URL('../../../schema/src/index.mjs', import.meta.url).href) as {
    validatePackage: (pkg: unknown) => { valid: boolean; errors: unknown[] };
  };
  const validation = schema.validatePackage(result.package);
  assert.equal(validation.valid, true, JSON.stringify(validation.errors));
});

test('PS12 edit keeps the comparison layout and shared dataset after a local patch', async () => {
  const tools = toolset();
  const proposed = await tools['storyboard.propose'].run({
    brief: D13_BRIEF,
    datasets: { d_regions: { unit: 'regions', values: D13_VALUES, source: 'user' } },
    scenes: [
      { id: 's_chart', layout: 'chart', copy: { headline: 'Regions' }, data: { dataset: 'd_regions', display: 'bar' } },
      { id: 's_stat', layout: 'stat', copy: { headline: 'South', body: '19' }, data: { dataset: 'd_regions', display: 'number' } },
      { id: 's_compare', layout: 'hero', copy: { headline: 'North versus South' }, data: { dataset: 'd_regions', display: 'bar' } },
    ],
  }) as any;

  const datasetId = Object.keys(proposed.package.datasets)[0];
  const edited = tools['storyboard.edit'].run({
    scene_id: 's_compare',
    patch: { copy: { headline: 'North versus South, edited' } },
  }) as any;

  const compare = edited.package.scenes.find((scene: any) => scene.layout === 'compare');
  assert.ok(compare, 'edit must not downgrade the only compare scene');
  assert.equal(copy(compare), 'north versus south, edited');
  for (const scene of edited.package.scenes) assert.equal(scene.data.dataset, datasetId);
});

test('PS12 a scene headline asking for versus still becomes a compare scene', async () => {
  const result = await toolset()['storyboard.propose'].run({
    brief: 'Create a three-scene motion-graphics sequence with a chart, a stat and a closing scene. No narration.',
    datasets: { d_regions: { unit: 'regions', values: D13_VALUES, source: 'user' } },
    scenes: [
      { id: 's_chart', layout: 'chart', copy: { headline: 'Regions' }, data: { dataset: 'd_regions', display: 'bar' } },
      { id: 's_stat', layout: 'stat', copy: { headline: 'South', body: '19' }, data: { dataset: 'd_regions', display: 'number' } },
      { id: 's_close', layout: 'hero', copy: { headline: 'North vs South' } },
    ],
  }) as any;

  assert.deepEqual(result.package.scenes.map((scene: any) => scene.layout), ['chart', 'stat', 'compare']);
  assert.equal(result.package.scenes[2].media.length, 2);
});

test('PS12 a data brief without a shared-dataset request keeps separate datasets', async () => {
  const result = await toolset()['storyboard.propose'].run({
    brief: 'A 10-second data explainer with a chart, a big number and a comparison.',
    datasets: {
      d_regions: { unit: 'regions', values: D13_VALUES, source: 'user' },
      d_quarterly: { unit: 'orders', values: [{ label: 'Q1', value: 41 }, { label: 'Q2', value: 57 }], source: 'user' },
    },
    scenes: [
      { id: 's_chart', layout: 'chart', copy: { headline: 'Regions' }, data: { dataset: 'd_regions', display: 'bar' } },
      { id: 's_stat', layout: 'stat', copy: { headline: 'Q2', body: '57' }, data: { dataset: 'd_quarterly', display: 'number' } },
      { id: 's_compare', layout: 'compare', copy: { headline: 'North versus South' }, data: { dataset: 'd_regions', display: 'bar' } },
    ],
  }) as any;

  assert.deepEqual(Object.keys(result.package.datasets).sort(), ['d_quarterly', 'd_regions']);
  assert.equal(result.package.scenes[0].data.dataset, 'd_regions');
  assert.equal(result.package.scenes[1].data.dataset, 'd_quarterly');
  assert.equal(result.package.scenes[2].data.dataset, 'd_regions');
});
