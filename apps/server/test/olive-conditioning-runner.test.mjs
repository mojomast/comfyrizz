import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createCpuAgentRunner } from '../src/agent-runner.mjs';
import { compilePackage } from '../src/compile-package.mjs';
import { replayProvider } from './fake-provider.mjs';
import { OLIVE_BRIEF, OLIVE_IMAGE, OLIVE_VIDEO, OLIVE_PROPOSE } from '../../../packages/agent/dist/test/fixtures/olive-action.js';

test('offline olive Action replay stays subject-neutral through server enforcement and compilation', async t => {
  const runtimeDir = mkdtempSync(join(tmpdir(), 'olive-conditioning-'));
  let conditioningId;
  const provider = await replayProvider([
    { name: 'storyboard.propose', args: OLIVE_PROPOSE },
    { name: 'assets.generate_image', args: OLIVE_IMAGE },
    request => {
      const image = request.messages.filter(message => message.role === 'tool')
        .map(message => JSON.parse(message.content)).map(body => body.result ?? body)
        .findLast(body => body.asset?.kind === 'image');
      assert.ok(image?.asset?.id, 'the video uses the actual returned conditioning image');
      conditioningId = image.asset.id;
      return { name: 'assets.generate_video', args: { ...OLIVE_VIDEO, image: image.asset.id } };
    },
  ]);
  t.after(async () => {
    await provider.close();
    rmSync(runtimeDir, { recursive: true, force: true });
  });
  const runner = createCpuAgentRunner({ runtimeDir, providers: { custom: { baseUrl: provider.url } } });
  const result = await runner({ brief: OLIVE_BRIEF, provider: 'custom', motionModel: 'ltx', videoType: 'action-scene' });
  assert.equal(result.fallback, false);
  assert.equal(provider.calls, 4, 'three recorded tools and completion, no repair/model service');
  assert.doesNotMatch(JSON.stringify(provider.requests[0].messages), /Hard creative constraint: use photorealistic live-action fictional human adults/);
  const pkg = result.package;
  assert.equal(pkg.scenes.length, 1);
  assert.equal(pkg.scenes[0].id, OLIVE_VIDEO.scene_id);
  assert.deepEqual(pkg.scenes[0].foreground, []);
  const timeline = compilePackage(pkg);
  assert.equal(timeline.durationInFrames, 180);
  assert.deepEqual(timeline.scenes[0].foreground, []);
  assert.equal(pkg.proposal.look, OLIVE_PROPOSE.proposal.look);
  assert.equal(Object.keys(pkg.assets).length, 2);
  const video = pkg.assets[pkg.scenes[0].background.asset];
  assert.equal(video.gen.inputs.image, conditioningId);
  assert.equal(pkg.assets[conditioningId].gen.generator, 'flux3-klein');
  for (const asset of Object.values(pkg.assets)) {
    assert.equal(asset.status, 'pending');
    assert.equal(asset.gen.inputs.width, 1920);
    assert.equal(asset.gen.inputs.height, 1080);
    assert.doesNotMatch(asset.gen.inputs.prompt, /human|adults|natural skin/i);
  }
});
