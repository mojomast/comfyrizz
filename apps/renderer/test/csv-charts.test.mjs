// D1 acceptance: the labels and values the renderer draws come from data.csv.
// `chartSeries` is the exact series ChartLayout maps over, so a label on screen
// equals the CSV label, and the committed package is a fresh build of the CSV
// (edited numbers that do not match the CSV fail this test).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { datasetFromCsv } from '../../../packages/agent/dist/src/index.js';
import { validatePackage } from '../../../packages/schema/src/index.mjs';
import { buildCsvPackage, CSV_PATH, DATASET_ID, EXAMPLE_DIR } from '../../../examples/tools/author-csv-package.mjs';
import { chartSeries, headlineValue } from '../src/chart-model.js';

const committed = JSON.parse(readFileSync(join(EXAMPLE_DIR, 'package.json'), 'utf8'));
const csv = readFileSync(CSV_PATH, 'utf8');
const parsed = datasetFromCsv(csv, { unit: 'minutes', label: 'Where the minutes went', source: 'user', note: 'The team planning log for one launch video.' }).dataset;

test('D1: the committed example is a fresh build of data.csv', () => {
  assert.deepEqual(committed, buildCsvPackage());
  assert.equal(validatePackage(committed).valid, true);
});

test('D1: the package dataset is exactly the CSV values', () => {
  assert.deepEqual(committed.datasets[DATASET_ID].values, parsed.values);
  assert.deepEqual(
    committed.datasets[DATASET_ID].values.map(item => [item.label, item.value]),
    [
      ['CPU slice', 6],
      ['Render queue', 19],
      ['Review edits', 11],
      ['Waiting', 34],
    ],
  );
});

test('D1: the labels ChartLayout draws are the CSV labels', () => {
  const series = chartSeries(committed.datasets[DATASET_ID]);
  assert.deepEqual(series.map(item => [item.label, item.value]), parsed.values.map(item => [item.label, item.value]));
  assert.deepEqual(series.map(item => item.label), ['CPU slice', 'Render queue', 'Review edits', 'Waiting']);
  assert.deepEqual(series.map(item => item.value), [6, 19, 11, 34]);
});

test('D1: the big number and the comparison copy match the CSV', () => {
  const headline = headlineValue(committed.datasets[DATASET_ID]);
  assert.deepEqual(headline, { label: 'CPU slice', value: 6 });
  const number = committed.scenes.find(scene => scene.id === 's_data_minutes_number');
  assert.equal(number.copy.body, '6 minutes');
  assert.equal(number.copy.sub, 'CPU slice');
  const comparison = committed.scenes.find(scene => scene.id === 's_data_minutes_comparison');
  assert.deepEqual(comparison.copy.items, ['CPU slice: 6 minutes', 'Render queue: 19 minutes', 'Review edits: 11 minutes', 'Waiting: 34 minutes']);
});

test('D1: every data scene references the dataset and is schema-valid', () => {
  const dataScenes = committed.scenes.filter(scene => scene.data);
  assert.equal(dataScenes.length, 2);
  for (const scene of dataScenes) {
    assert.equal(scene.data.dataset, DATASET_ID);
    assert.ok(committed.datasets[scene.data.dataset], `${scene.id} points at a missing dataset`);
  }
  const [bar] = dataScenes;
  assert.equal(bar.layout, 'chart');
  assert.equal(bar.data.display, 'bar');
});
