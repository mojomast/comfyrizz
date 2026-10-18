import { test } from 'node:test';
import assert from 'node:assert/strict';
import { datasetFromCsv } from '../src/dataset.js';
import { CHART_SCENE_KINDS, formatValue, proposeChartScenes, proposalValues, sourceCaption } from '../src/chart-scenes.js';

const dataset = () =>
  datasetFromCsv('label,value\nCPU slice,6\nRender queue,19\nReview edits,11\n', { unit: 'minutes', label: 'Where the minutes went' }).dataset;

test('D1: proposeChartScenes makes a bar, a big number and a comparison', () => {
  const scenes = proposeChartScenes({ datasetId: 'd_minutes', dataset: dataset() });
  assert.deepEqual(scenes.map(scene => scene.kind), CHART_SCENE_KINDS);

  const [bar] = scenes;
  assert.equal(bar.layout, 'chart');
  assert.equal(bar.variant, 'bar');
  assert.deepEqual(bar.data, { dataset: 'd_minutes', display: 'bar' });
  assert.equal(bar.copy.headline, 'Where the minutes went');
  assert.match(String(bar.copy.footnote), /Where the minutes went/);

  const number = scenes[1];
  assert.equal(number.layout, 'stat');
  assert.deepEqual(number.data, { dataset: 'd_minutes', display: 'number' });
  assert.equal(number.copy.body, '6 minutes');
  assert.equal(number.copy.sub, 'CPU slice');

  const comparison = scenes[2];
  assert.equal(comparison.layout, 'list');
  assert.deepEqual(comparison.copy.items, ['CPU slice: 6 minutes', 'Render queue: 19 minutes', 'Review edits: 11 minutes']);
});

test('D1: every proposed label and value is exactly the CSV value', () => {
  const csv = 'label,value\nNorth,"1,250"\nSouth,900\nEast,12\nWest,7\n';
  const { dataset: parsed } = datasetFromCsv(csv, { unit: 'units' });
  const scenes = proposeChartScenes({ datasetId: 'd_sales', dataset: parsed });
  const comparison = scenes.find(scene => scene.kind === 'comparison')!;
  assert.deepEqual(comparison.copy.items, ['North: 1250 units', 'South: 900 units', 'East: 12 units', 'West: 7 units']);
  assert.deepEqual(proposalValues(parsed), [
    { label: 'North', value: 1250 },
    { label: 'South', value: 900 },
    { label: 'East', value: 12 },
    { label: 'West', value: 7 },
  ]);
  // The bar scene carries the same dataset reference, so the renderer draws the
  // CSV values, and the big number is the CSV's first value.
  assert.equal(scenes[1].copy.body, '1250 units');
});

test('D1: formatValue and sourceCaption are deterministic and invent nothing', () => {
  const parsed = dataset();
  assert.equal(formatValue(6, 'minutes'), '6 minutes');
  assert.equal(formatValue(6, ''), '6');
  assert.equal(sourceCaption('d_minutes', parsed), 'Where the minutes went · source: user');
  assert.match(sourceCaption('d_id', { ...parsed, source: 'example', label: undefined, values: parsed.values }), /example data/);
  const cited = sourceCaption('d_id', { ...parsed, source_url: 'https://data.example/x.csv' });
  assert.match(cited, /https:\/\/data\.example\/x\.csv/);
});

test('D1: proposeChartScenes rejects an empty dataset and unknown kinds', () => {
  assert.throws(() => proposeChartScenes({ datasetId: 'd_x', dataset: { unit: 'x', source: 'user', values: [] } }), /values/);
  assert.throws(() => proposeChartScenes({ datasetId: 'd_x', dataset: dataset(), kinds: ['pie' as never] }), /unknown chart scene kind/);
});

test('D1: scenes are deterministic across calls', () => {
  const a = proposeChartScenes({ datasetId: 'd_minutes', dataset: dataset() });
  const b = proposeChartScenes({ datasetId: 'd_minutes', dataset: dataset() });
  assert.deepEqual(a, b);
});
