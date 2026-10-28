import assert from 'node:assert/strict';
import test from 'node:test';
import { createToolset } from '../src/tools.js';

const DATASET_ID_RE = /^d[A-Za-z0-9_-]{0,63}$/;

const REGIONS = {
  unit: 'regions',
  label: 'Regions',
  values: [
    { label: 'North', value: 12 },
    { label: 'South', value: 19 },
    { label: 'East', value: 7 },
  ],
  source: 'user',
};

const QUARTERLY = {
  unit: 'USD millions',
  label: 'Example data',
  values: [
    { label: 'Q1', value: 41 },
    { label: 'Q2', value: 57 },
  ],
  source: 'example',
  approved: true,
};

const Q3 = {
  unit: 'orders',
  values: [
    { label: 'Q3', value: 63 },
    { label: 'Q4', value: 71 },
  ],
  source: 'user',
};

function toolset(initialPackage?: Record<string, any>) {
  return createToolset({
    now: () => '2026-10-28T12:00:00.000Z',
    ...(initialPackage ? { initialPackage } : {}),
  });
}

async function propose(datasets: Record<string, unknown>, scenes: Array<Record<string, any>>) {
  return await toolset()['storyboard.propose'].run({
    brief: 'A 10-second data explainer with a chart, a big number and a comparison.',
    datasets,
    scenes,
  }) as any;
}

test('PS08 propose normalizes dataset keys to schema ids and remaps scene references', async () => {
  const result = await propose(
    { regions: REGIONS, 'quarterly-example': QUARTERLY, 'Q3 Results!': Q3 },
    [
      { id: 's_chart', layout: 'chart', copy: { headline: 'Regions' }, data: { dataset: 'regions', display: 'bar' } },
      { id: 's_stat', layout: 'stat', copy: { headline: 'Q2' }, data: { dataset: 'quarterly-example', display: 'number' } },
      { id: 's_compare', layout: 'compare', copy: { headline: 'Quarter 3' }, data: { dataset: 'Q3 Results!', display: 'bar' }, media: [{ procedural: { pattern: 'gradient' } }, { procedural: { pattern: 'grid' } }] },
    ],
  );

  const ids = Object.keys(result.package.datasets).sort();
  assert.deepEqual(ids, ['d_Q3_Results', 'd_quarterly-example', 'd_regions'].sort());
  for (const id of ids) assert.match(id, DATASET_ID_RE);
  assert.deepEqual(result.package.datasets.d_regions, REGIONS);
  assert.deepEqual(result.package.datasets['d_quarterly-example'].values, QUARTERLY.values);
  assert.deepEqual(result.package.datasets.d_Q3_Results.values, Q3.values);
  assert.deepEqual(
    result.package.scenes.map((scene: any) => scene.data.dataset),
    ['d_regions', 'd_quarterly-example', 'd_Q3_Results'],
  );

  const schema = await import(new URL('../../../schema/src/index.mjs', import.meta.url).href) as {
    validatePackage: (pkg: unknown) => { valid: boolean; errors: unknown[] };
  };
  const validation = schema.validatePackage(result.package);
  assert.equal(validation.valid, true, JSON.stringify(validation.errors));
});

test('PS08 schema-safe dataset ids survive propose unchanged', async () => {
  const result = await propose(
    { d_regions: REGIONS },
    [{ id: 's_chart', layout: 'chart', copy: { headline: 'Regions' }, data: { dataset: 'd_regions', display: 'bar' } }],
  );

  assert.deepEqual(Object.keys(result.package.datasets), ['d_regions']);
  assert.equal(result.package.scenes[0].data.dataset, 'd_regions');
});

test('PS08 edit normalizes an existing draft and remaps its dataset references', () => {
  const initialPackage = {
    $schema: 'https://comfyrizz.example/schema/package-v1.json',
    schemaVersion: 1,
    revision: 1,
    id: 'pkg_ps08_edit',
    title: 'Regions draft',
    createdAt: '2026-10-28T12:00:00.000Z',
    format: { width: 1920, height: 1080, fps: 30 },
    duration: { mode: 'flexible', flexibleCeilingFrames: 2700 },
    theme: { palette: ['#0d0f14', '#1b2440', '#6d8cff', '#e6e8ee'], font: 'Inter' },
    voice: { enabled: false, engine: 'none' },
    datasets: { regions: REGIONS },
    scenes: [{
      id: 's_chart',
      layout: 'chart',
      preferredFrames: 180,
      copy: { headline: 'Regions' },
      data: { dataset: 'regions', display: 'bar' },
      foreground: [],
    }],
    assets: {},
    compliance: { open_weights_only: true },
    renders: [],
  };

  const result = toolset(initialPackage)['storyboard.edit'].run({
    scene_id: 's_chart',
    patch: { copy: { headline: 'Regions, edited' } },
  }) as any;

  assert.deepEqual(Object.keys(result.package.datasets), ['d_regions']);
  assert.deepEqual(result.package.datasets.d_regions, REGIONS);
  assert.equal(result.package.scenes[0].data.dataset, 'd_regions');
  assert.equal(result.package.scenes[0].copy.headline, 'Regions, edited');
});

test('PS08 fills the required source from the user and drops unknown dataset fields', async () => {
  const result = await propose(
    { 'd_counts': { unit: 'count', values: [{ label: 'A', value: 1 }], source: undefined, extra: 'drop me' } },
    [],
  );

  assert.equal(result.package.datasets.d_counts.source, 'user');
  assert.equal('extra' in result.package.datasets.d_counts, false);
  assert.deepEqual(result.package.datasets.d_counts.values, [{ label: 'A', value: 1 }]);
});

test('PS08 unrecoverable user data is an actionable tool error, never invented stats', () => {
  const tools = toolset();

  assert.throws(
    () => tools['storyboard.propose'].run({
      brief: 'A data explainer',
      datasets: { regions: { unit: 'regions', source: 'user' } },
    }),
    (error: any) => {
      assert.equal(error?.status, 422);
      assert.equal(error?.code, 'DATASET_VALUES_REQUIRED');
      assert.match(error.message, /never invent/i);
      assert.match(error.message, /regions|d_regions/);
      return true;
    },
  );

  assert.throws(
    () => tools['storyboard.propose'].run({
      brief: 'A data explainer',
      datasets: { d_regions: { unit: 'regions', source: 'user', values: [{ label: 'North', value: 'twelve' }] } },
    }),
    (error: any) => {
      assert.equal(error?.status, 422);
      assert.equal(error?.code, 'DATASET_VALUE_INVALID');
      assert.match(error.message, /never invent|finite number/i);
      return true;
    },
  );

  assert.throws(
    () => tools['storyboard.propose'].run({
      brief: 'A data explainer',
      datasets: { d_regions: { values: REGIONS.values, source: 'user' } },
    }),
    (error: any) => error?.status === 422 && error?.code === 'DATASET_UNIT_REQUIRED',
  );
});
