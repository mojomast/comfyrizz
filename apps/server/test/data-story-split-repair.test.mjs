import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createToolset } from '../../../packages/agent/dist/src/index.js';
import { validatePackage } from '../../../packages/schema/src/index.mjs';
import { createCpuAgentRunner } from '../src/agent-runner.mjs';
import { replayProvider } from './fake-provider.mjs';

test('recorded 190-start wall survives a different scene’s split layout repair with its source and timing intact', () => {
  const text = readFileSync(new URL('./fixtures/data-story-190.csv', import.meta.url), 'utf8');
  const hash = createHash('sha256').update(text).digest('hex');
  assert.equal(hash, 'eb9561f8100be27146f219d865767d92e8cba6cad4c9e28ed923c32655ede941');
  const id = 'ctx_0123456789abcdef';
  const tools = createToolset({ csvAttachments: [{ id, label: 'perez-first-190-starts.csv', text, contentHash: hash }] });
  tools['storyboard.propose'].run({ brief: 'Tell the supplied data story', title: '190 Starts, One Win', scenes: [
    { id: 's1', layout: 'title', preferredFrames: 82 }, { id: 's2', layout: 'hero', preferredFrames: 105 },
    { id: 's3', layout: 'hero', preferredFrames: 225 }, { id: 's4', layout: 'split', preferredFrames: 135, narration: 'One win.' },
  ] });
  const wall = tools['storyboard.csv_tile_wall'].run({ scene_id: 's3', id, filters: [], category_column: 'classification', colors: [{ value: '1', color: '#ff00aa' }], default_color: '#333333', background: '#000000', columns: 19 });
  const sourceDrawing = structuredClone(wall.package.scenes[2].drawing);
  const before = structuredClone(wall.package.scenes[3]);
  assert.equal(sourceDrawing.elements.length, 190);
  assert.ok(validatePackage(wall.package).errors.some(e => e.code === 'SEM_LAYOUT_REQUIRES_MEDIA' && e.path === '/scenes/3/media'));
  const fixed = tools['storyboard.edit'].run({ scene_id: 's4', patch: { layout: 'list' } }).package;
  assert.deepEqual(fixed.scenes[2].drawing, sourceDrawing);
  assert.equal(fixed.scenes[3].preferredFrames, 135);
  assert.equal(fixed.scenes[3].narration, 'One win.');
  assert.equal(fixed.scenes[3].media, undefined);
  assert.equal(fixed.scenes[2].drawing.source.sha256, hash);
  assert.ok(!validatePackage(fixed).errors.some(e => e.code === 'SEM_LAYOUT_REQUIRES_MEDIA'));
});

test('bounded repair identifies the exact scene and accepts its drawing; unfinished repair remains actionable', async t => {
  const brief = 'Tell a data story with drawings.';
  const scenes = ['title', 'hero', 'hero', 'split', 'hero', 'hero', 'title'].map((layout, i) => ({ id: `s${i + 1}`, layout, preferredFrames: 135 }));
  const drawing = { background: '#ffffff', elements: [{ type: 'path', points: [[100, 100], [300, 100]], color: '#111111', width: 3, start: 0, end: 20 }] };
  const initial = [
    { name: 'storyboard.propose', args: { brief, title: '190 Starts, One Win', proposal: { logline: 'A single win.', look: 'Graphic tiles.', soundtrack: 'Quiet pulse.' }, scenes } },
    ...scenes.filter(scene => scene.id !== 's4').map(scene => ({ name: 'storyboard.draw', args: { scene_id: scene.id, drawing } })), null,
  ];
  const provider = await replayProvider([...initial, { name: 'storyboard.draw', args: { scene_id: 's4', drawing } }]);
  const runtimeDir = mkdtempSync(join(tmpdir(), 'split-repair-'));
  t.after(async () => { await provider.close(); rmSync(runtimeDir, { recursive: true, force: true }); });
  const runner = createCpuAgentRunner({ runtimeDir, providers: { custom: { baseUrl: provider.url } } });
  const result = await runner({ brief, videoType: 'data-story', provider: 'custom', sessionId: 'fixed' });
  const repairRequest = provider.requests.find(request => JSON.stringify(request.messages).includes('requires two actual media plates'));
  assert.ok(repairRequest);
  assert.match(JSON.stringify(repairRequest.messages), /Scene.*s4.*storyboard.edit/);
  assert.equal(result.package.scenes[3].layout, 'split');
  assert.deepEqual(result.package.scenes[3].drawing, drawing);
  assert.equal(result.package.scenes[3].media, undefined);
  provider.setCalls(initial);
  await assert.rejects(runner({ brief, videoType: 'data-story', provider: 'custom', sessionId: 'unfixed' }), error => {
    assert.equal(error.code, 'MOTION_GRAPHICS_INCOMPLETE');
    assert.match(error.message, /SEM_LAYOUT_REQUIRES_MEDIA/);
    assert.match(error.message, /s4.*storyboard.edit/);
    return true;
  });
});
