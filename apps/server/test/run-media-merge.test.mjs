import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeRunMedia, changedRunMedia } from '../src/run-media-merge.mjs';

test('completed media rebases onto timeline edits made during generation', () => {
  const staged = { revision: 1, scenes: [{ id: 's1', preferredFrames: 96 }], assets: {
    a: { status: 'pending', gen: { inputs: { prompt: 'original' } } },
    b: { status: 'pending', gen: { inputs: { prompt: 'original' } } },
  } };
  const current = structuredClone(staged);
  current.revision = 4;
  current.scenes[0].preferredFrames = 124;
  current.assets.b.gen.inputs.prompt = 'owner correction';
  const generated = structuredClone(staged);
  for (const asset of Object.values(generated.assets)) Object.assign(asset, { status: 'ready', file: 'assets/result.mp4' });
  const next = mergeRunMedia({ staged, current, generated });
  assert.equal(next.revision, 4);
  assert.equal(next.scenes[0].preferredFrames, 124);
  assert.equal(next.assets.a.status, 'ready');
  assert.deepEqual(next.assets.b, current.assets.b);
  assert.equal(current.assets.a.status, 'pending');
  assert.deepEqual(Object.keys(changedRunMedia(current, next).assets), ['a']);
});

test('failed, deleted and preexisting assets cannot be replaced by late output', () => {
  const staged = { assets: { a: { status: 'ready', file: 'approved.mp4' }, b: { status: 'pending' }, c: { status: 'pending' } } };
  const current = structuredClone(staged);
  delete current.assets.c;
  const generated = { assets: { a: { status: 'ready', file: 'candidate.mp4' }, b: { status: 'failed' }, c: { status: 'ready', file: 'deleted.mp4' } } };
  assert.deepEqual(mergeRunMedia({ staged, current, generated }), current);
});

test('an upscale variant can attach to an unchanged base while recording the backend', () => {
  const staged = { assets: { a: { status: 'ready', file: 'base.mp4', sha256: 'base' } }, compliance: { backends_used: ['cpu'], warnings: ['owner note'] } };
  const generated = structuredClone(staged);
  generated.assets.a.variants = { upscaled: { file: 'large.mp4' } };
  generated.compliance.backends_used.push('colab');
  const next = mergeRunMedia({ staged, current: staged, generated });
  assert.deepEqual(next.assets.a.variants, generated.assets.a.variants);
  assert.deepEqual(next.compliance, { backends_used: ['cpu', 'colab'], warnings: ['owner note'] });
});
