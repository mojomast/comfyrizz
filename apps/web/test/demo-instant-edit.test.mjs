import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { applyInstantEdit } from '../src/demo/instant-edit.mjs';

const readJson = name => JSON.parse(
  readFileSync(fileURLToPath(new URL(`../../../examples/launch-demo/${name}`, import.meta.url)), 'utf8'),
);

const load = () => ({ pkg: readJson('package.json'), timeline: readJson('timeline.json') });
const scene = (document, id) => document.scenes.find(item => item.id === id);

test('headline edits patch both the package and the compiled timeline', () => {
  const { pkg, timeline } = load();
  const beforePkg = structuredClone(pkg);
  const beforeTimeline = structuredClone(timeline);

  const result = applyInstantEdit(pkg, timeline, {
    kind: 'text',
    sceneId: 's_title',
    field: 'headline',
    value: 'Comfyrizz II',
  });

  assert.equal(scene(result.pkg, 's_title').copy.headline, 'Comfyrizz II');
  assert.equal(scene(result.timeline, 's_title').copy.headline, 'Comfyrizz II');
  assert.deepEqual(result.changedScenes, ['s_title']);
  assert.deepEqual(pkg, beforePkg);
  assert.deepEqual(timeline, beforeTimeline);
});

test('subhead and caption map to the schema copy fields', () => {
  const { pkg, timeline } = load();

  const sub = applyInstantEdit(pkg, timeline, {
    kind: 'text',
    sceneId: 's_hero',
    field: 'subhead',
    value: 'A shorter supporting line.',
  });
  assert.equal(scene(sub.pkg, 's_hero').copy.sub, 'A shorter supporting line.');
  assert.equal(scene(sub.timeline, 's_hero').copy.sub, 'A shorter supporting line.');

  const caption = applyInstantEdit(pkg, timeline, {
    kind: 'text',
    sceneId: 's_chart',
    field: 'caption',
    value: 'Live edit, no render.',
  });
  assert.equal(scene(caption.pkg, 's_chart').copy.footnote, 'Live edit, no render.');
  assert.equal(scene(caption.timeline, 's_chart').copy.footnote, 'Live edit, no render.');
});

test('a chart value change marks only its scene and leaves other scenes alone', () => {
  const { pkg, timeline } = load();
  const beforePkg = structuredClone(pkg);

  const result = applyInstantEdit(pkg, timeline, {
    kind: 'chart',
    sceneId: 's_chart',
    index: 1,
    value: 9,
  });

  assert.equal(result.pkg.datasets.d_minutes.values[1].value, 9);
  assert.deepEqual(result.changedScenes, ['s_chart']);
  assert.deepEqual(result.timeline, timeline);
  assert.deepEqual(pkg, beforePkg);

  for (const id of ['s_title', 's_hero', 's_stat', 's_list', 's_outro']) {
    assert.deepEqual(scene(result.pkg, id), scene(beforePkg, id));
  }
});

test('numeric chart strings are accepted but non-numeric values are rejected', () => {
  const { pkg, timeline } = load();
  const result = applyInstantEdit(pkg, timeline, {
    kind: 'chart',
    sceneId: 's_chart',
    index: 0,
    value: '42',
  });
  assert.equal(result.pkg.datasets.d_minutes.values[0].value, 42);

  for (const value of ['many', '', null, undefined, Number.NaN, Number.POSITIVE_INFINITY, true]) {
    assert.throws(
      () => applyInstantEdit(pkg, timeline, { kind: 'chart', sceneId: 's_chart', index: 0, value }),
      /finite number/i,
    );
  }
});

test('chart bounds and missing datasets are rejected with a message', () => {
  const { pkg, timeline } = load();

  assert.throws(
    () => applyInstantEdit(pkg, timeline, { kind: 'chart', sceneId: 's_chart', index: 99, value: 1 }),
    /chart index 99/i,
  );
  assert.throws(
    () => applyInstantEdit(pkg, timeline, { kind: 'chart', sceneId: 's_title', index: 0, value: 1 }),
    /no chart dataset/i,
  );
});

test('unknown scenes are rejected before anything changes', () => {
  const { pkg, timeline } = load();

  assert.throws(
    () => applyInstantEdit(pkg, timeline, { kind: 'text', sceneId: 's_nope', field: 'headline', value: 'x' }),
    /Unknown scene: s_nope/,
  );
  assert.throws(
    () => applyInstantEdit(pkg, timeline, { kind: 'chart', sceneId: 's_nope', index: 0, value: 1 }),
    /Unknown scene: s_nope/,
  );
  assert.throws(
    () => applyInstantEdit(pkg, timeline, { kind: 'colour', sceneId: 's_nope', role: 'accent', hex: '#ffffff' }),
    /Unknown scene: s_nope/,
  );
});

test('colours validate their hex and patch the scene palette immutably', () => {
  const { pkg, timeline } = load();
  const beforePkg = structuredClone(pkg);
  const beforeTimeline = structuredClone(timeline);

  const result = applyInstantEdit(pkg, timeline, {
    kind: 'colour',
    sceneId: 's_title',
    role: 'accent',
    hex: '#ff8800',
  });

  assert.equal(result.pkg.scenes[0].background.procedural.palette[2], '#ff8800');
  assert.equal(result.timeline.scenes[0].background.procedural.palette[2], '#ff8800');
  assert.equal(result.pkg.theme.palette[2], '#6d8cff');
  assert.deepEqual(result.changedScenes, ['s_title']);
  assert.deepEqual(pkg, beforePkg);
  assert.deepEqual(timeline, beforeTimeline);

  for (const hex of ['ff8800', '#fff', '#gggggg', '', null, undefined]) {
    assert.throws(
      () => applyInstantEdit(pkg, timeline, { kind: 'colour', sceneId: 's_title', role: 'accent', hex }),
      /Invalid hex colour/i,
    );
  }
});

test('unknown roles, fields and kinds are rejected', () => {
  const { pkg, timeline } = load();

  assert.throws(
    () => applyInstantEdit(pkg, timeline, { kind: 'colour', sceneId: 's_title', role: 'sparkle', hex: '#ffffff' }),
    /Unknown colour role: sparkle/,
  );
  assert.throws(
    () => applyInstantEdit(pkg, timeline, { kind: 'text', sceneId: 's_title', field: 'body', value: 'x' }),
    /Unknown text field: body/,
  );
  assert.throws(
    () => applyInstantEdit(pkg, timeline, { kind: 'text', sceneId: 's_title', field: 'headline', value: 7 }),
    /must be a string/i,
  );
  assert.throws(
    () => applyInstantEdit(pkg, timeline, { kind: 'video', sceneId: 's_title' }),
    /Unknown edit kind: video/,
  );
});

test('no-op edits report no changed scenes', () => {
  const { pkg, timeline } = load();

  assert.deepEqual(
    applyInstantEdit(pkg, timeline, {
      kind: 'text',
      sceneId: 's_title',
      field: 'headline',
      value: scene(pkg, 's_title').copy.headline,
    }).changedScenes,
    [],
  );

  assert.deepEqual(
    applyInstantEdit(pkg, timeline, {
      kind: 'chart',
      sceneId: 's_chart',
      index: 0,
      value: pkg.datasets.d_minutes.values[0].value,
    }).changedScenes,
    [],
  );

  assert.deepEqual(
    applyInstantEdit(pkg, timeline, {
      kind: 'colour',
      sceneId: 's_title',
      role: 'accent',
      hex: pkg.scenes[0].background.procedural.palette[2],
    }).changedScenes,
    [],
  );
});
