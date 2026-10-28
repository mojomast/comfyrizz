// PS16: T29 asks for exactly one list scene with six items. The live model
// sometimes sends the six bullets as scene-level `items` (the conversation-plan
// shape) instead of `copy.items`, so the list scene lost every bullet. The tool
// must lift that shape, keep the list layout and preserve six items on propose
// and edit. A short list is an actionable 422, never a silent short list.

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import test from 'node:test';

function sourceUrl(candidates: string[]): URL {
  for (const candidate of candidates) {
    const url = new URL(candidate, import.meta.url);
    if (existsSync(url)) return url;
  }
  throw new Error(`none of ${candidates.join(', ')} exists`);
}

const toolsUrl = sourceUrl(['../dist/src/tools.js', '../src/tools.js', '../src/tools.ts']);
const { createToolset } = await import(toolsUrl.href) as typeof import('../src/tools.js');
const schemaUrl = sourceUrl(['../../schema/src/index.mjs', '../../../schema/src/index.mjs']);
const schema = await import(schemaUrl.href) as {
  validatePackage: (pkg: unknown) => { valid: boolean; errors: unknown[] };
};

const T29_BRIEF = 'Create an 18-second six-scene motion-graphics briefing. Keep copy inside the layout limits. Include exactly one list scene with six items. Preserve the integers 12, 19, 34 and 47 without truncation or merging, each as its own number. Draw four SVG diagrams and plan one still. No narration.';

const SIX_ITEMS = [
  'North holds 12 of the total',
  'South holds 19 of the total',
  'East holds 34 of the total',
  'West holds 47 of the total',
  'Keep each integer as its own number',
  'Let the audience compare at a glance',
];

const SHORT_ITEMS = SIX_ITEMS.slice(0, 5);

function toolset() {
  return createToolset({ now: () => '2026-10-28T12:00:00.000Z' });
}

function briefingScenes(listScene: Record<string, unknown>) {
  return [
    { id: 's_title', layout: 'title', copy: { headline: 'Regional briefing' } },
    { id: 's_hero', layout: 'hero', copy: { headline: 'Four regions, one picture' } },
    listScene,
    { id: 's_chart', layout: 'hero', copy: { headline: 'The trend at a glance' } },
    { id: 's_stat', layout: 'title', copy: { headline: 'What changes next' } },
    { id: 's_close', layout: 'title', copy: { headline: 'Thanks for watching' } },
  ];
}

function listScenes(pkg: any) {
  return (pkg.scenes as any[]).filter(scene => scene.layout === 'list' || (Array.isArray(scene.copy?.items) && scene.copy.items.length > 0));
}

test('PS16 T29 keeps six scene-level items on the one list scene', async () => {
  const result = await toolset()['storyboard.propose'].run({
    brief: T29_BRIEF,
    scenes: briefingScenes({
      id: 's_list',
      layout: 'list',
      copy: { headline: 'The numbers that matter' },
      items: SIX_ITEMS,
    }),
  }) as any;

  const lists = listScenes(result.package);
  assert.equal(lists.length, 1, 'the brief asks for exactly one list scene');
  assert.equal(lists[0].layout, 'list');
  assert.deepEqual(lists[0].copy.items, SIX_ITEMS);
});

test('PS16 a list-hinted scene without a layout becomes the six-item list', async () => {
  const result = await toolset()['storyboard.propose'].run({
    brief: T29_BRIEF,
    scenes: briefingScenes({
      id: 's_key_points',
      copy: { headline: 'Six key points', items: SIX_ITEMS },
    }),
  }) as any;

  const lists = listScenes(result.package);
  assert.equal(lists.length, 1);
  assert.equal(lists[0].layout, 'list', 'a scene carrying list items must render as a list');
  assert.equal(lists[0].copy.items.length, 6);
});

test('PS16 seven authored bullets become exactly six, never fewer than six', async () => {
  const result = await toolset()['storyboard.propose'].run({
    brief: T29_BRIEF,
    scenes: briefingScenes({
      id: 's_list',
      layout: 'list',
      copy: { headline: 'The numbers that matter' },
      items: [...SIX_ITEMS, 'A seventh bullet the brief did not ask for'],
    }),
  }) as any;

  const [list] = listScenes(result.package);
  assert.equal(list.layout, 'list');
  assert.equal(list.copy.items.length, 6);
  assert.deepEqual(list.copy.items, SIX_ITEMS);
});

test('PS16 the integers arrive as numbers and still become six string bullets', async () => {
  const numeric = ['12', '19', '34', '47', 'Compare each number', 'Keep the order'];
  const result = await toolset()['storyboard.propose'].run({
    brief: T29_BRIEF,
    scenes: briefingScenes({
      id: 's_list',
      layout: 'list',
      copy: { headline: 'The numbers that matter' },
      items: [12, 19, 34, 47, 'Compare each number', 'Keep the order'],
    }),
  }) as any;

  const [list] = listScenes(result.package);
  assert.deepEqual(list.copy.items, numeric);
});

test('PS16 a short list is an actionable 422 instead of a silent truncation', async () => {
  assert.throws(
    () => toolset()['storyboard.propose'].run({
      brief: T29_BRIEF,
      scenes: briefingScenes({
        id: 's_list',
        layout: 'list',
        copy: { headline: 'The numbers that matter' },
        items: SHORT_ITEMS,
      }),
    }),
    (error: any) => {
      assert.equal(error?.status, 422);
      assert.equal(error?.code, 'SCENE_LIST_ITEMS_REQUIRED');
      assert.match(error.message, /six items/i);
      assert.match(error.message, /supplied 5/i);
      return true;
    },
  );
});

test('PS16 edit keeps the list layout and all six items', async () => {
  const tools = toolset();
  await tools['storyboard.propose'].run({
    brief: T29_BRIEF,
    scenes: briefingScenes({
      id: 's_list',
      layout: 'list',
      copy: { headline: 'The numbers that matter' },
      items: SIX_ITEMS,
    }),
  });

  const edited = tools['storyboard.edit'].run({
    scene_id: 's_list',
    patch: { copy: { headline: 'The six numbers that matter' } },
  }) as any;

  const [list] = listScenes(edited.package);
  assert.equal(list.layout, 'list');
  assert.deepEqual(list.copy.items, SIX_ITEMS);
});

test('PS16 edit cannot silently cut the list below six and keeps the draft intact', async () => {
  const tools = toolset();
  const proposed = await tools['storyboard.propose'].run({
    brief: T29_BRIEF,
    scenes: briefingScenes({
      id: 's_list',
      layout: 'list',
      copy: { headline: 'The numbers that matter' },
      items: SIX_ITEMS,
    }),
  }) as any;

  assert.throws(
    () => tools['storyboard.edit'].run({
      scene_id: 's_list',
      patch: { copy: { items: SHORT_ITEMS } },
    }),
    (error: any) => {
      assert.equal(error?.status, 422);
      assert.equal(error?.code, 'SCENE_LIST_ITEMS_REQUIRED');
      return true;
    },
  );

  const stillSix = tools['storyboard.edit'].run({
    scene_id: 's_list',
    patch: { copy: { headline: 'Still six' } },
  }) as any;
  assert.deepEqual(listScenes(stillSix.package)[0].copy.items, proposed.package.scenes.find((scene: any) => scene.id === 's_list').copy.items);
});

test('PS16 a shared-dataset comparison brief still gets compare and keeps the list', async () => {
  const result = await toolset()['storyboard.propose'].run({
    brief: 'Create a four-scene motion-graphics sequence with a bar chart, a stat, a comparison and exactly one list scene with six items. One shared user dataset: North=12, South=19, East=34, West=47. No narration.',
    datasets: {
      d_regions: {
        unit: 'regions',
        values: [
          { label: 'North', value: 12 },
          { label: 'South', value: 19 },
          { label: 'East', value: 34 },
          { label: 'West', value: 47 },
        ],
        source: 'user',
      },
    },
    scenes: [
      { id: 's_chart', layout: 'chart', copy: { headline: 'Regions' }, data: { dataset: 'd_regions', display: 'bar' } },
      { id: 's_stat', layout: 'stat', copy: { headline: 'North', body: '12' }, data: { dataset: 'd_regions', display: 'number' } },
      { id: 's_compare', layout: 'hero', copy: { headline: 'North versus South' }, data: { dataset: 'd_regions', display: 'bar' } },
      { id: 's_list', layout: 'list', copy: { headline: 'Six points' }, items: SIX_ITEMS },
    ],
  }) as any;

  assert.deepEqual(result.package.scenes.map((scene: any) => scene.layout), ['chart', 'stat', 'compare', 'list']);
  const [list] = listScenes(result.package);
  assert.equal(list.copy.items.length, 6);
  const datasetIds = Object.keys(result.package.datasets);
  assert.equal(datasetIds.length, 1);
  for (const scene of result.package.scenes) assert.equal(scene.data.dataset, datasetIds[0]);
  const validation = schema.validatePackage(result.package);
  assert.equal(validation.valid, true, JSON.stringify(validation.errors));
});
