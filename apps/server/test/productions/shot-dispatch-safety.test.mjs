import assert from 'node:assert/strict';
import test from 'node:test';
import { hashFor } from '../../src/productions/plan-from-package.mjs';
import { shotDispatchProblem } from '../../src/productions/shot-dispatch-safety.mjs';

test('a shot slot is redeemed only for the approved inputs and exact pipeline work', () => {
  const pkg = { assets: { a: { gen: { generator: 'ltx25', inputs: { prompt: 'original' } } } } };
  const slot = { kind: 'shot.generate', targetId: 's1', takes: 1, assetIds: ['a'],
    effectiveInputHash: hashFor('s1', [{ assetId: 'a', gen: pkg.assets.a.gen }]) };
  const plan = { jobs: [{ assetId: 'a' }] };
  assert.equal(shotDispatchProblem(pkg, slot, plan), null);
  assert.match(shotDispatchProblem(pkg, slot, { jobs: [] }), /exactly/);
  assert.match(shotDispatchProblem(pkg, slot, { jobs: [{ assetId: 'a' }, { assetId: 'other' }] }), /exactly/);
  assert.match(shotDispatchProblem(pkg, slot, { ...plan, remoteVoice: true }), /additional remote/);
  assert.match(shotDispatchProblem(pkg, { ...slot, takes: 2 }, plan), /number of shot takes/);
  pkg.assets.a.gen.inputs.prompt = 'changed';
  assert.match(shotDispatchProblem(pkg, slot, plan), /changed after approval/);
});
