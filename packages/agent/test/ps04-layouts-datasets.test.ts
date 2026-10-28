import assert from 'node:assert/strict';
import test from 'node:test';
import { createToolset, proposeSchema } from '../src/tools.js';

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

function toolset() {
  return createToolset({ now: () => '2026-10-28T12:00:00.000Z' });
}

test('PS04 propose schema accepts compare, split and code layouts', () => {
  const parsed = proposeSchema.parse({
    brief: 'Three layouts in one storyboard',
    scenes: [
      { id: 's_compare', layout: 'compare', copy: { headline: 'Before and after' } },
      { id: 's_split', layout: 'split', copy: { headline: 'Two plates' } },
      { id: 's_code', layout: 'code', code: { language: 'typescript', code: 'const ok = true;' } },
    ],
  });
  assert.deepEqual(parsed.scenes?.map(scene => scene.layout), ['compare', 'split', 'code']);
});

test('PS04 chart and stat without a dataset fail with an actionable tool error', () => {
  const tools = toolset();
  for (const layout of ['chart', 'stat'] as const) {
    assert.throws(
      () => tools['storyboard.propose'].run({
        brief: 'A data explainer',
        scenes: [{ id: `s_${layout}`, layout, copy: { headline: 'Growth' } }],
      }),
      (error: any) => {
        assert.equal(error?.status, 422);
        assert.equal(error?.code, 'SCENE_DATA_REQUIRED');
        assert.match(error.message, /dataset/i);
        assert.match(error.message, /data\.display/);
        assert.match(error.message, new RegExp(`s_${layout}`));
        return true;
      },
    );
  }
});

test('PS04 an unknown dataset reference is an error, not a silent hero/list downgrade', () => {
  const tools = toolset();
  assert.throws(
    () => tools['storyboard.propose'].run({
      brief: 'A data explainer',
      datasets: { d_regions: REGIONS },
      scenes: [{ id: 's_chart', layout: 'chart', data: { dataset: 'd_missing', display: 'bar' } }],
    }),
    (error: any) => error?.status === 422 && error?.code === 'SCENE_DATASET_UNKNOWN' && /d_missing/.test(error.message),
  );
});

test('PS04 user datasets round-trip and every data scene references the same dataset', async () => {
  const result = await toolset()['storyboard.propose'].run({
    brief: 'A data sequence with a bar chart, a big-number stat and a comparison',
    datasets: { d_regions: REGIONS },
    scenes: [
      { id: 's_chart', layout: 'chart', copy: { headline: 'Regions' }, data: { dataset: 'd_regions', display: 'bar' } },
      { id: 's_stat', layout: 'stat', copy: { headline: 'South', body: '19' }, data: { dataset: 'd_regions', display: 'number' } },
      { id: 's_compare', layout: 'compare', copy: { headline: 'North vs South' }, data: { dataset: 'd_regions', display: 'bar' } },
    ],
  }) as any;

  assert.deepEqual(result.package.datasets, { d_regions: REGIONS });
  assert.deepEqual(result.package.datasets.d_regions.values, REGIONS.values);
  assert.deepEqual(result.package.scenes.map((scene: any) => scene.layout), ['chart', 'stat', 'compare']);
  for (const scene of result.package.scenes) {
    assert.deepEqual(scene.data.dataset, 'd_regions');
    assert.ok(['bar', 'number'].includes(scene.data.display));
  }
});

test('PS04 propose takes the output format from the brief aspect instead of 1920x1080', async () => {
  const propose = (brief: string) => toolset()['storyboard.propose'].run({ brief }) as any;

  assert.deepEqual((await propose('A vertical 9:16 teaser')).package.format, { width: 1080, height: 1920, fps: 30 });
  assert.deepEqual((await propose('A square 1:1 clip')).package.format, { width: 1080, height: 1080, fps: 30 });
  assert.deepEqual((await propose('A 16:9 explainer')).package.format, { width: 1920, height: 1080, fps: 30 });
  assert.deepEqual((await propose('Aspect: 1080x1920. Every source image must be 1080 wide by 1920 tall.')).package.format, { width: 1080, height: 1920, fps: 30 });
  assert.deepEqual((await propose('Aspect: 720x1280 at 24 fps.')).package.format, { width: 720, height: 1280, fps: 24 });
});

test('PS04 unsupported formats are rejected with an actionable error', () => {
  const tools = toolset();
  assert.throws(
    () => tools['storyboard.propose'].run({
      brief: 'Create a 6-second motion-graphics title card. Format must be 8K, 120 fps and aspect 2.39:1. Reject this unsupported format with an actionable error. Do not silently default to 1920x1080, 30 fps or 16:9.',
    }),
    (error: any) => {
      assert.equal(error?.status, 422);
      assert.equal(error?.code, 'UNSUPPORTED_FORMAT');
      assert.match(error.message, /unsupported format/i);
      assert.match(error.message, /8K|120|2\.39/);
      return true;
    },
  );
});
