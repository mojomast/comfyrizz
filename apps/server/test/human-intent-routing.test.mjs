import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { FICTIONAL_DATA_STORY, FICTIONAL_DATA_STORY_UI } from '../../../packages/agent/dist/test/fixtures/fictional-data-story.js';
import { compileTimeline } from '../../../packages/planner/dist/src/index.js';
import { createCpuAgentRunner } from '../src/agent-runner.mjs';
import { createContextAttachmentStore } from '../src/context-attachments.mjs';
import { replayProvider } from './fake-provider.mjs';

const HUMAN_CONSTRAINT = /Hard creative constraint: use photorealistic live-action fictional human adults/;
const conversationId = 'chat_0123456789abcdef';

async function setup(t) {
  const runtimeDir = mkdtempSync('/tmp/opencode/human-intent-routing-');
  // Real HTTP/SSE adapter, deterministic replies; no external provider or GPU.
  const provider = await replayProvider([], { svgStatus: 503 });
  t.after(async () => { await provider.close(); rmSync(runtimeDir, { recursive: true, force: true }); });
  return { runtimeDir, provider, runner: createCpuAgentRunner({ runtimeDir, providers: { custom: { baseUrl: provider.url } } }) };
}

function saveEvidence(name, provider, result) {
  const dir = process.env.HUMAN_ROUTING_EVIDENCE_DIR;
  if (!dir) return;
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}-requests.json`), JSON.stringify(provider.requests, null, 2));
  writeFileSync(join(dir, `${name}-result.json`), JSON.stringify({
    method: 'Server runner through OpenAI-compatible HTTP/SSE transport to scripted loopback provider; no live generation or rendering.',
    requests: provider.requests.length, fallback: result.fallback,
    pendingGpu: result.pendingGpu, durationInFrames: compileTimeline(result.package).durationInFrames,
    package: result.package,
  }, null, 2));
}

for (const [name, brief] of [['recorded-raw', FICTIONAL_DATA_STORY], ['recorded-ui', FICTIONAL_DATA_STORY_UI]]) {
  test(`${name}: scripted provider receives no injected human constraint and returns a native 20-second Data Story`, async t => {
    const { runtimeDir, provider, runner } = await setup(t);
    const csv = readFileSync(new URL('../../../docs/submission/fictional-study.csv', import.meta.url));
    assert.equal(createHash('sha256').update(csv).digest('hex'), '454ac73a55b4426e7d37ed5013becfe802c551bee7f5f6457acd7ae07c8a3ca8');
    const { record } = createContextAttachmentStore({ rootDir: runtimeDir, chatId: conversationId }).addFile({
      bytes: csv, filename: 'fictional-study.csv', mime: 'text/csv',
    });
    provider.setCalls([
      { name: 'context.read_csv', args: { id: record.id, offset: 0, limit: 40 } },
      { name: 'storyboard.propose', args: {
        brief, title: 'FICTIONAL STUDY LOG',
        proposal: { logline: 'Four fictional practice measurements.', look: 'Native navy and cream charts.', soundtrack: 'No narration.' },
        datasets: {
          d_days: { source: 'user', unit: 'minutes', values: ['Monday', 'Tuesday', 'Wednesday', 'Thursday'].map((label, i) => ({ label, value: 10 + 5 * i })) },
          d_thursday: { source: 'user', unit: 'minutes', values: [{ label: 'Thursday', value: 25 }] },
        },
        scenes: [
          { id: 's_title', layout: 'title', preferredFrames: 120, copy: { headline: 'FICTIONAL STUDY LOG' } },
          { id: 's_chart', layout: 'chart', preferredFrames: 300, copy: { headline: 'Fictional practice minutes' }, data: { dataset: 'd_days', display: 'bar' } },
          { id: 's_stat', layout: 'stat', preferredFrames: 180, copy: { headline: 'Thursday', body: '25 minutes' }, data: { dataset: 'd_thursday' } },
        ],
      } },
    ]);
    const result = await runner({ brief, videoType: 'data-story', provider: 'custom', conversationId });
    saveEvidence(name, provider, result);
    assert.equal(result.fallback, false);
    assert.deepEqual(result.pendingGpu, []);
    assert.deepEqual(result.svgAssets, []);
    assert.equal(provider.requests.length, 3, 'CSV read, proposal, and final text; no repair or SVG request');
    for (const request of provider.requests) {
      assert.equal(request.stream, true);
      assert.ok(request.tools.some(tool => tool.type === 'function' && tool.function.name === 'storyboard_propose'));
      const system = request.messages.filter(message => message.role === 'system');
      assert.ok(system.length > 0, 'assert against actual provider-shaped system messages');
      assert.doesNotMatch(JSON.stringify(system), HUMAN_CONSTRAINT);
      assert.doesNotMatch(JSON.stringify(request.messages), HUMAN_CONSTRAINT);
    }
    assert.ok(provider.requests[0].messages.some(message => message.content?.includes(brief)), 'the exact submitted brief reaches the provider');
    const csvResult = provider.requests[1].messages.find(message => message.role === 'tool');
    assert.deepEqual(JSON.parse(csvResult.content).rows, [['Monday', '10'], ['Tuesday', '15'], ['Wednesday', '20'], ['Thursday', '25']]);
    assert.equal(compileTimeline(result.package).durationInFrames, 600);
    assert.equal(result.package.format.fps, 30);
    assert.deepEqual(result.package.duration, { mode: 'target', targetFrames: 600, exact: true });
    assert.doesNotMatch(result.package.proposal.look, /human|people|skin/i);
  });
}

test('a later positive human request still injects the hard constraint on the provider wire', async t => {
  const { provider, runner } = await setup(t);
  const brief = 'Create a 6-second wordless film. No real people in a chart. Separately, show live-action human adults dancing. No captions.';
  provider.setCalls([
    { name: 'storyboard.propose', args: {
      brief, title: 'Dancers', proposal: { logline: 'Adults dance in a studio.', look: 'Photorealistic live-action dancers.', soundtrack: 'Quiet room tone.' },
      scenes: [{ id: 's1', layout: 'hero', preferredFrames: 180 }],
    } },
    { name: 'assets.generate_video', args: {
      scene_id: 's1', subject: 'Fictional human adult dancers.', composition: 'Photorealistic studio in natural light.',
      action: 'The dancers turn.', camera: 'Locked camera.', characterCount: 2, motion_model: 'klein',
      soundscape: 'Quiet room tone.', finishing_sound: 'Quiet room tone without speech.',
    } },
  ]);
  const result = await runner({ brief, videoType: 'action-scene', provider: 'custom', motionModel: 'klein' });
  saveEvidence('positive-control', provider, result);
  assert.equal(result.fallback, false);
  assert.ok(provider.requests.length >= 3);
  assert.match(JSON.stringify(provider.requests[0].messages), HUMAN_CONSTRAINT);
  assert.ok(result.pendingGpu.length > 0, 'only pending generation descriptors; no GPU jobs are executed');
});
