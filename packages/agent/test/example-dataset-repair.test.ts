import assert from 'node:assert/strict';
import test from 'node:test';
import { createToolset } from '../src/tools.js';

test('dataset removal is atomic, requires every dependent narration, and protects approved or user data', async () => {
  const initial = {
    revision: 7, datasets: {
      d_duration: { source: 'example', unit: 'weeks', values: [{ label: 'Duration', value: 8 }] },
      d_user: { source: 'user', unit: 'weeks', values: [{ label: 'Duration', value: 3 }] },
      d_approved: { source: 'example', approved: true, unit: 'weeks', values: [{ label: 'Duration', value: 2 }] },
    },
    scenes: [
      { id: 's8', layout: 'stat', data: { dataset: 'd_duration', display: 'number' }, copy: { headline: 'Eight weeks' }, narration: 'Eight weeks.', motion: { entry: 'countUp' } },
      { id: 's9', layout: 'chart', data: { dataset: 'd_duration', display: 'bar' }, copy: { headline: 'Duration' } },
      { id: 's10', layout: 'stat', data: { dataset: 'd_user', display: 'number' } },
    ], assets: { a_existing: { kind: 'svg' } },
  };
  const changes: any[] = [];
  const tools = createToolset({ initialPackage: initial, onPackageChange: pkg => { changes.push(pkg); } });
  const run = tools['storyboard.remove_example_dataset'].run;
  await assert.rejects(async () => run({ dataset_id: 'd_duration', scenes: [{ scene_id: 's8', headline: 'League dissolves', narration: 'The League dissolves.' }] }), /exactly one replacement/);
  await assert.rejects(async () => run({ dataset_id: 'd_duration', scenes: [{ scene_id: 's8', headline: 'League dissolves' }, { scene_id: 's9', headline: 'The scheme' }] }), /replacement narration/);
  await assert.rejects(async () => run({ dataset_id: 'd_user', scenes: [] }), /only an existing unapproved/);
  await assert.rejects(async () => run({ dataset_id: 'd_approved', scenes: [] }), /only an existing unapproved/);
  assert.equal(changes.length, 0);
  await run({ dataset_id: 'd_duration', scenes: [{ scene_id: 's8', headline: 'League dissolves', narration: 'The League dissolves.' }, { scene_id: 's9', headline: 'The scheme' }] });
  const changed = changes[0];
  assert.equal(changed.revision, 8);
  assert.equal(changed.datasets.d_duration, undefined);
  assert.deepEqual(changed.datasets.d_user, initial.datasets.d_user);
  assert.deepEqual(changed.datasets.d_approved, initial.datasets.d_approved);
  assert.deepEqual(changed.scenes[2], initial.scenes[2]);
  assert.deepEqual(changed.assets, initial.assets);
  assert.ok(changed.scenes.slice(0, 2).every((scene: any) => scene.layout === 'hero' && !scene.data));
});
