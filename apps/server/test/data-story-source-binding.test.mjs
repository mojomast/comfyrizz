import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createToolset } from '../../../packages/agent/dist/src/index.js';
import { validatePackage } from '../../../packages/schema/src/index.mjs';

test('scoped CSV corrections derive chart and ordered wall categories from the campaign snapshot', async () => {
  const text = readFileSync(new URL('./fixtures/data-story-190.csv', import.meta.url), 'utf8');
  const contentHash = createHash('sha256').update(text).digest('hex');
  const id = 'ctx_0123456789abcdef';
  const attachments = [{ id, label: 'campaign.csv', text, contentHash }];
  const tools = createToolset({ csvAttachments: attachments });
  await tools['storyboard.propose'].run({ brief: 'Data story', scenes: [{ id: 's1', layout: 'hero', preferredFrames: 120 }, { id: 's2', layout: 'hero', preferredFrames: 120 }] });
  const bind = tools['storyboard.csv_dataset'];
  const query = { dataset_id: 'd_years', id, unit: 'starts', filters: [], group_by: 'date', group_by_transform: 'year' };
  const result = bind.run(bind.schema.parse(query));
  assert.equal(result.count, 190);
  const dataset = result.package.datasets.d_years;
  assert.deepEqual(dataset.values.map(x => x.value), [17, 20, 19, 18, 19, 21, 20, 21, 21, 14]);
  assert.equal(dataset.csv_query.sha256, contentHash);
  assert.deepEqual(JSON.parse(dataset.csv_query.description), { filters: [], group_by: 'date', group_by_transform: 'year', count: 190 });
  assert.deepEqual(validatePackage(result.package).errors, []);
  const edited = tools['storyboard.edit'].run({ scene_id: 's2', patch: { preferredFrames: 130 } }).package;
  assert.deepEqual(edited.datasets.d_years.csv_query, dataset.csv_query);
  const before = structuredClone(result.package);
  before.datasets.d_years.values[0].value = 999;
  const correction = createToolset({ initialPackage: before, csvAttachments: attachments });
  const corrected = correction['storyboard.csv_dataset'].run(query).package;
  assert.deepEqual(corrected.datasets.d_years.values, dataset.values);
  assert.deepEqual(corrected.scenes, before.scenes);
  assert.throws(() => bind.run({ ...query, id: 'other' }), /not found/);
  assert.throws(() => bind.run({ ...query, group_by: 'missing' }), /Unknown CSV column/);
  assert.throws(() => bind.run({ ...query, filters: [{ column: 'classification', op: 'eq', values: ['no such result'] }] }), /requires 1 to 64/);

  const wall = correction['storyboard.csv_tile_wall'];
  const args = { scene_id: 's1', id, filters: [], category_column: 'classification', colors: [{ value: '1', color: '#ff00aa' }, { value: '2', color: '#777777' }, { value: '3', color: '#888888' }, { value: 'DNF', color: '#111111' }, { value: 'DSQ', color: '#111111' }], default_color: '#222222', background: '#000000', columns: 19, require_categories: ['1'] };
  const rendered = wall.run(wall.schema.parse(args));
  assert.equal(rendered.package.scenes[0].drawing.elements.length, 190);
  assert.equal(rendered.package.scenes[0].drawing.elements[189].color, '#ff00aa');
  assert.equal(rendered.package.scenes[0].drawing.elements[0].color, '#111111');
  assert.ok(rendered.uncategorized.some(x => x.value === '17'));
  assert.deepEqual(rendered.package.scenes[1], before.scenes[1]);
  assert.deepEqual(validatePackage(rendered.package).errors, []);
  assert.throws(() => wall.run({ ...args, colors: args.colors.slice(1) }), /uncategorized/);
  const overlap = wall.run({ ...args, rules: [
    { filters: [{ column: 'classification', op: 'eq', values: ['1'] }], color: '#ff00aa' },
    { filters: [{ column: 'classification', op: 'in', values: ['1', '2'] }], color: '#123456' },
  ] });
  assert.equal(overlap.package.scenes[0].drawing.elements[189].color, '#ff00aa');
  assert.equal(overlap.package.scenes[0].drawing.elements[187].color, '#123456');
  assert.throws(() => wall.run({ ...args, colors: [args.colors[0], args.colors[0]] }), /Duplicate/);
});
