import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCpuAgentRunner } from '../src/agent-runner.mjs';
import { validatePackage } from '../../../packages/schema/src/index.mjs';
import { replayProvider, withPlannedPlate } from './fake-provider.mjs';

test('real unapproved duration failure is repaired in place with a source-backed no-data scene', async t => {
  const brief = 'A narrated motion explainer about the Red-Headed League: the League dissolved and John Clay was caught.';
  const provider = await replayProvider(withPlannedPlate([
    { name: 'storyboard.propose', args: { brief, title: 'The Red-Headed League', proposal: { logline: 'A peculiar job conceals a robbery.', look: 'A theatrical map.', soundtrack: 'Quiet strings.' }, datasets: { d_duration: { source: 'example', unit: 'weeks', values: [{ label: 'Duration', value: 8 }] } }, scenes: [{ id: 's8', layout: 'stat', copy: { headline: 'Eight weeks' }, data: { dataset: 'd_duration', display: 'number' }, narration: 'Eight weeks. The shop sits empty.', motion: { entry: 'countUp' }, preferredFrames: 168 }] } },
    { name: 'storyboard.draw', args: { scene_id: 's8', drawing: { background: '#ffffff', elements: [{ type: 'path', points: [[100, 100], [300, 100]], color: '#111111', width: 3, start: 0, end: 20 }] } } },
    null,
    { name: 'storyboard.remove_example_dataset', args: { dataset_id: 'd_duration', scenes: [{ scene_id: 's8', headline: 'The League dissolves', narration: 'The League dissolves, and John Clay is caught.' }] } },
  ]));
  const runtimeDir = mkdtempSync(join(tmpdir(), 'dataset-repair-'));
  t.after(async () => { await provider.close(); rmSync(runtimeDir, { recursive: true, force: true }); });
  const events = [];
  const result = await createCpuAgentRunner({ runtimeDir, providers: { custom: { baseUrl: provider.url } } })({ brief, provider: 'custom', sessionId: 'dataset-repair', onEvent: event => events.push(event) });
  assert.match(events.find(event => event.phase === 'initial' && event.status === 'validation').problems.join(' '), /SEM_DATASET_UNAPPROVED/);
  const repair = provider.requests.find(request => JSON.stringify(request.messages).includes('Unapproved example dataset'));
  assert.ok(repair);
  assert.match(JSON.stringify(repair.tools), /storyboard_remove_example_dataset/);
  assert.doesNotMatch(JSON.stringify(repair.tools), /storyboard_propose/);
  assert.deepEqual(result.package.datasets, {});
  const scene = result.package.scenes[0];
  assert.equal(scene.layout, 'hero');
  assert.equal(scene.data, undefined);
  assert.notEqual(scene.motion?.entry, 'countUp');
  assert.equal(scene.copy.headline, 'The League dissolves');
  assert.match(scene.narration, /John Clay/);
  assert.ok(scene.drawing);
  assert.equal(validatePackage(result.package).valid, true);
  assert.equal(result.pendingGpu.length, 1, 'only a pending editorial plate, never generated in this test');
});
