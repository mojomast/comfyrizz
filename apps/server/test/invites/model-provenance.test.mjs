import test from 'node:test';
import assert from 'node:assert/strict';
import { completedModels, packageModels } from '../../src/invites/model-provenance.mjs';

test('completed attribution uses verified workflow checkpoints and excludes pending models', () => {
  const pkg = { assets: {
    image: { kind: 'image', status: 'ready', gen: { generator: 'flux3-klein', model: 'planner-alias', inputs: { prompt: 'private workflow detail' } } },
    unused: { kind: 'video', status: 'pending', gen: { generator: 'ltx25' } },
  }, voice: { enabled: true, engine: 'qwen3-tts' } };
  const models = completedModels(pkg, { contribution: { evidence: [{ assetId: 'image', receipt: {
    status: 'succeeded', family: 'FLUX 3 Image Klein', checkpoint: 'flux-3-image-klein-bf16.safetensors', generator: 'flux3-klein',
    conditioning: { secret: 'must not be copied' },
  } }] } });
  assert.deepEqual(models.map(m => m.name), ['FLUX 3 Image Klein', 'qwen3-tts']);
  assert.equal(models[0].evidence, 'verified_workflow');
  assert.ok(!JSON.stringify(models).includes('secret'));
  assert.ok(packageModels(pkg).some(m => m.name === 'ltx25'));
});
