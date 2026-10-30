import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { createToolset } from '../src/tools.js';

const drawing = {
  background: '#ffffff',
  elements: [
    { type: 'path', points: [[500, 800], [500, 500], [500, 430]], color: '#337766', width: 8, start: 0, end: 40 },
    { type: 'text', x: 500, y: 200, text: 'COTTON WICK', color: '#112233', size: 48, start: 0, end: 10 },
  ],
};

function session() {
  let pkg: any;
  let mutations = 0;
  const tools = createToolset({ onPackageChange: value => { pkg = value; mutations++; } });
  const call = async (name: string, args: any) => tools[name].run(tools[name].schema.parse(args)) as Promise<any>;
  return { tools, call, get: () => pkg, mutations: () => mutations };
}

test('blank and field-null headlines fail on every layout, including drawing scenes, before committing', async () => {
  for (const layout of ['title', 'hero', 'list']) {
    for (const withDrawing of [false, true]) {
      const { call, get, mutations } = session();
      await call('storyboard.propose', {
        brief: 'Native explanation.', scenes: [{ id: 's1', layout, preferredFrames: 150, copy: { headline: 'Original' }, ...(withDrawing ? { drawing } : {}) }],
      });
      const original = structuredClone(get());
      const count = mutations();
      for (const headline of ['', ' ', '  ', '\t\r\n', '\u00a0', null]) {
        await assert.rejects(call('storyboard.edit', { scene_id: 's1', patch: { copy: { headline } } }), (error: Error) => {
          assert.match(error.message, /copy.headline must be a nonblank string/);
          assert.match(error.message, /whole-object copy:null/);
          assert.match(error.message, /layout:"list",copy:null/);
          return true;
        });
        assert.deepEqual(get(), original);
        assert.equal(mutations(), count);
      }
    }
  }
});

test('invalid proposals and aliases cannot silently replace an explicit blank headline with fallback copy', async () => {
  const { call, get, mutations } = session();
  await call('storyboard.propose', { brief: 'Original title', scenes: [{ id: 's1', layout: 'title', copy: { headline: 'Original' } }] });
  const original = structuredClone(get());
  for (const fields of [
    { copy: { headline: '' }, title: 'Must not rescue the blank' },
    { copy: ' \t ' },
    { headline: '\n' },
    { title: '   ' },
  ]) {
    await assert.rejects(call('storyboard.propose', { brief: 'A different draft', scenes: [{ id: 's1', layout: 'title', ...fields }] }), /nonblank string/);
    assert.deepEqual(get(), original);
    assert.equal(mutations(), 1);
  }
});

test('explicit copy removal refuses headline-required shells but retains ordinary omitted-copy defaults', async () => {
  for (const layout of ['title', 'hero', 'stat']) {
    const { call, get } = session();
    await call('storyboard.propose', {
      brief: 'Native editorial layout.',
      datasets: { d_count: { unit: 'items', source: 'user', values: [{ label: 'Books', value: 3 }] } },
      scenes: [{ id: 's1', layout, ...(layout === 'stat' ? { data: { dataset: 'd_count', display: 'number' } } : {}), copy: { headline: 'Keep this' } }],
    });
    const original = structuredClone(get());
    await assert.rejects(call('storyboard.edit', { scene_id: 's1', patch: { copy: null } }), /requires copy.headline; copy:null cannot remove it/);
    assert.deepEqual(get(), original);
    await call('storyboard.edit', { scene_id: 's1', patch: { preferredFrames: 180 } });
    assert.deepEqual(get().scenes[0].copy, original.scenes[0].copy);
  }
  const { call, get } = session();
  await call('storyboard.propose', { brief: 'Original default title' });
  assert.equal(get().scenes[0].copy.headline, 'Original default title');
  await call('storyboard.edit', { scene_id: 's1', patch: { copy: { cta: '', sub: '' } } });
  assert.equal(get().scenes[0].copy.cta, '', 'optional supported text fields are not subject to the headline-only blank rule');
});

test('Window Garden repair removes unwanted layout copy without altering drawing, media or exact narration', async () => {
  const { call, get } = session();
  const narration = 'A cotton wick draws it upward.';
  await call('storyboard.propose', {
    brief: 'A narrated native procedural explanation, 9:16.',
    scenes: [{ id: 's1', layout: 'hero', preferredFrames: 150, copy: { headline: 'Unwanted extra title', sub: 'Unwanted subtitle' }, narration }],
  });
  const image = await call('assets.generate_image', { scene_id: 's1', placement: 'conditioning', intent: 'A paper-cut planter reference.' });
  await call('storyboard.edit', { scene_id: 's1', patch: {
    background: { asset: image.asset.id },
    media: [{ asset: image.asset.id, fit: 'contain' }, { procedural: { pattern: 'grid' }, fit: 'cover' }],
    lower_third: { text: 'COTTON WICK' },
  } });
  await call('storyboard.draw', { scene_id: 's1', drawing });
  const original = structuredClone(get());
  await call('storyboard.edit', { scene_id: 's1', patch: { layout: 'list', copy: null, lower_third: null } });
  let repaired = get().scenes[0];
  assert.equal(repaired.copy, undefined);
  assert.equal(repaired.lower_third, undefined);
  for (const key of ['drawing', 'media', 'background', 'foreground', 'narration', 'preferredFrames']) assert.deepEqual(repaired[key], original.scenes[0][key], key);
  assert.deepEqual(get().assets, original.assets);
  const { validatePackage } = await import(new URL('../../../schema/src/index.mjs', import.meta.url).href);
  assert.equal(validatePackage(get()).valid, true, JSON.stringify(validatePackage(get()).errors));
  // The next unrelated edit must not resurrect fallback copy after removal.
  await call('storyboard.edit', { scene_id: 's1', patch: { notes: 'Preserve the final diagram.' } });
  repaired = get().scenes[0];
  assert.equal(repaired.copy, undefined);
  assert.equal(repaired.narration, narration);
  assert.deepEqual(repaired.drawing, drawing);
});

test('copy:null is valid on a drawing-backed title; selected optional fields can be restored explicitly', async () => {
  const { call, get } = session();
  await call('storyboard.propose', { brief: 'Native drawing.', scenes: [{ id: 's1', layout: 'title', drawing, copy: { headline: 'Hidden layout title' } }] });
  await call('storyboard.edit', { scene_id: 's1', patch: { copy: null } });
  assert.equal(get().scenes[0].copy, undefined);
  assert.deepEqual(get().scenes[0].drawing, drawing);
  await call('storyboard.edit', { scene_id: 's1', patch: { preferredFrames: 200 } });
  assert.equal(get().scenes[0].copy, undefined);
  // An explicitly copy-optional list accepts a two-edit reset and restoration.
  await call('storyboard.propose', { brief: 'Native list.', scenes: [{ id: 's1', layout: 'list', copy: { headline: 'Remove title', items: ['Keep one', 'Keep two'] } }] });
  await call('storyboard.edit', { scene_id: 's1', patch: { copy: null } });
  await call('storyboard.edit', { scene_id: 's1', patch: { copy: { items: ['Keep one', 'Keep two'] } } });
  assert.deepEqual(get().scenes[0].copy, { items: ['Keep one', 'Keep two'] });
});

test('drawing tools and builder guidance explain visible text, arrow direction and latest-step continuation', () => {
  const tools = createToolset();
  for (const name of ['storyboard.draw', 'storyboard.extend_drawing', 'storyboard.inspect_drawing']) {
    assert.match(tools[name].definition.description, /copy and lower_third are not rendered/);
    assert.match(tools[name].definition.description, /drawing.elements.*type:"text"/);
  }
  assert.match(tools['storyboard.draw'].definition.description, /final path endpoint and travel direction/);
  assert.match(tools['storyboard.extend_drawing'].definition.description, /latest preceding diagram scene/);
  const guidance = readFileSync(new URL('../../src/skills/storyboard-direction/PROCEDURAL-DRAWING.md', import.meta.url), 'utf8');
  assert.match(guidance, /upward flow needs decreasing y/);
  assert.match(guidance, /arrowhead at the final endpoint/);
  assert.match(guidance, /extend the wick scene for the roots view/);
});
