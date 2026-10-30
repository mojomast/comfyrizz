import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/app.mjs';
import { createCpuAgentRunner } from '../src/agent-runner.mjs';
import { createReferenceStore } from '../src/references/store.mjs';
import { replayProvider } from './fake-provider.mjs';
import { planJobs } from '../../../packages/jobs/src/index.mjs';

test('normal Custom HTTP planning carries uploaded reference bytes into the Klein-to-LTX dependency chain', async t => {
  const runtimeDir = mkdtempSync(join(tmpdir(), 'reference-runner-http-'));
  const conversationId = 'chat_reference_http_001';
  const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=', 'base64');
  const store = createReferenceStore({ rootDir: runtimeDir, chatId: conversationId });
  const ref = store.add({ bytes, filename: 'character.png', meta: { note: 'Use this person as the identity reference.' } });
  const brief = 'Create exactly 6 seconds of landscape cinematic generated film in one shot. Use the uploaded character reference for a person sipping tea on a spaceship bridge. Fully silent. No captions, titles or overlays.';
  const provider = await replayProvider([
    { name: 'storyboard.propose', args: { brief, title: 'Out of Office', proposal: { logline: 'Tea on the bridge.', look: 'Photographic.', soundtrack: 'Silent.' }, scenes: [{ id: 's1', layout: 'title', copy: { headline: 'OUT OF OFFICE' }, preferredFrames: 180 }] } },
    { name: 'assets.generate_image', args: { scene_id: 's1', kind: 'composition-reference', intent: 'Preserve the referenced person and place them on a spaceship bridge with a teacup.', refs: [ref.id] } },
    request => {
      const image = request.messages.filter(m => m.role === 'tool').map(m => JSON.parse(m.content)).map(v => v.result ?? v).findLast(v => v.asset?.kind === 'image');
      return { name: 'assets.generate_video', args: { scene_id: 's1', motion_model: 'ltx', image: image.asset.id, subject: 'The reference person.', composition: 'Medium close-up on a spaceship bridge.', action: 'Calmly sips from a teacup.', camera: 'Slow push in.', soundscape: 'Silent.', finishing_sound: 'Fully silent; no audio.', characterCount: 1, wordless: true } };
    },
  ]);
  const token = 'reference-runner-http-token';
  const app = createApp({ runtimeDir, token, agentRunner: createCpuAgentRunner({ runtimeDir, providers: { custom: { baseUrl: provider.url } } }) });
  const server = createServer(app.handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { app.close(); await new Promise(resolve => server.close(resolve)); await provider.close(); rmSync(runtimeDir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const response = await fetch(base + '/api/agent', { method: 'POST', headers: { origin: base, 'content-type': 'application/json', 'x-comfyrizz-token': token }, body: JSON.stringify({ brief, motionModel: 'ltx', conversationId, provider: 'custom' }) });
  const result = await response.json();
  assert.equal(response.status, 200, JSON.stringify({ result, toolResponses: provider.requests.flatMap(r => r.messages.filter(m => m.role === 'tool')) }));
  const pkg = result.package;
  const uploadEntry = Object.entries(pkg.assets).find(([, a]) => a.source?.id === ref.id);
  assert.ok(uploadEntry, 'uploaded reference is a real package dependency');
  const [uploadId, upload] = uploadEntry;
  assert.equal(upload.sha256, ref.sha256);
  assert.deepEqual(readFileSync(join(runtimeDir, 'packages', upload.file)), bytes);
  assert.equal(store.get(ref.id).usage, 'reference');
  assert.ok(!JSON.stringify(pkg.scenes).includes(uploadId), 'reference is not composited as a foreground photograph');
  const video = pkg.assets[pkg.scenes[0].background.asset];
  const composition = pkg.assets[video.gen.inputs.image];
  assert.equal(composition.gen.inputs.reference, uploadId);
  assert.equal(video.gen.generator, 'ltx25');
  assert.deepEqual(planJobs(pkg).jobs.map(job => job.generator).sort(), ['flux3-klein', 'ltx25']);
  const context = JSON.stringify(provider.requests[0].messages);
  assert.match(context, /server verifies and adopts original pixels/);
  assert.doesNotMatch(context, /never pass them to image or video generation inputs/);
});
