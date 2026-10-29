import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { atomicJson, runTitle } from '../src/runner.mjs';

// Optional, explicitly OFFLINE integration evidence. This scripted provider is
// test-only. Pi, native tools, acceptance and CPU renders are real.
test('OFFLINE SCRIPTED Pi draft/correction through real CPU previews and MP4', {
  skip: !process.env.PI_TITLE_CPU_EVIDENCE, timeout: 240000,
}, async () => {
  const dir = resolve(process.env.PI_TITLE_CPU_EVIDENCE);
  const brief = { prompt: 'Create exactly 4 seconds of one native landscape title called CPU TEST. Silent, no narration or music.', exactText: 'CPU TEST', revealSeconds: 1 };
  let calls = 0;
  const chatModel = { async *stream(request) {
    assert.ok(request.tools.length > 0, 'Pi transcript must declare real tools');
    calls++;
    assert.ok(calls <= 2, 'Single correction budget');
    const name = calls === 1 ? 'storyboard.propose' : 'storyboard.edit';
    const args = calls === 1
      ? { brief: brief.prompt, title: 'OFFLINE SCRIPTED CPU TEST', theme: { palette: ['#fffdf5', '#fffdf5', '#2457eb', '#111111'], text: '#111111' }, scenes: [{ id: 's1', layout: 'title', preferredFrames: 120, headline_size: 180, copy: { headline: 'WRONG' }, transitionOut: { type: 'cut', frames: 0 } }] }
      : { scene_id: 's1', patch: { copy: { headline: 'CPU TEST' } } };
    yield { type: 'tool_call', id: `TEST-${calls}`, name, args };
    yield { type: 'done' };
  } };
  const result = await runTitle({ dir, brief, mode: 'live', chatModel, timeoutMs: 210000,
    config: { provider: 'OFFLINE-TEST-SCRIPTED-NO-NETWORK', model: 'OFFLINE-TEST-SCRIPTED-NOT-MODEL-QUALITY', thinking: 'disabled', maxTokens: 8192 } });
  assert.equal(calls, 2); assert.equal(result.initialCalls, 1); assert.equal(result.repairCalls, 1);
  assert.equal(result.findings.items.find(f => f.code === 'title-text').status, 'pass');
  assert.ok(existsSync(join(dir, 'export.mp4')));
  for (const sample of result.findings.samples) assert.equal(readFileSync(join(dir, sample.file)).subarray(1, 4).toString(), 'PNG');
  const resumed = await runTitle({ dir, mode: 'resume', chatModel });
  assert.equal(calls, 2); assert.equal(resumed.export.sha256, result.export.sha256);
  atomicJson(join(dir, 'OFFLINE-TEST-REPORT.json'), {
    provenance: 'TEST-ONLY scripted provider; real Pi/native tools/CPU PNG and MP4; zero network calls; not model-quality evidence',
    scriptedResponses: calls, initialCalls: result.initialCalls, repairCalls: result.repairCalls, resumedWithoutProviderCall: true,
    export: result.export, findings: result.findings.items,
  });
});
