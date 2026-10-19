import assert from 'node:assert/strict';
import test from 'node:test';
import { createToolset } from '../src/tools.js';
import { runAgent } from '../src/agent.js';
import { createScriptedModel } from '../src/scripted-model.js';

const SHORT = "export function hello() {\n  return 'ok';\n}\n";
const RATE = 1 / 0.035;

test('scene.code via the scripted model types a short snippet and refuses an overflowing line', async () => {
  const tools = createToolset({ now: () => '2026-10-18T12:00:00.000Z' });
  const longLine = 'x'.repeat(80);
  const result = await runAgent({
    model: createScriptedModel([
      { name: 'scene.code', args: { scene_id: 's_code', language: 'typescript', code: SHORT, highlights: [1] } },
      { name: 'scene.code', args: { scene_id: 's_long', language: 'typescript', code: longLine } },
    ]),
    brief: 'Add a code scene that types a function, then a line that does not fit.',
    tools,
    maxSteps: 6,
  });
  assert.equal(result.ok, true);
  assert.equal(result.stopped, 'final');
  assert.equal(result.toolCalls.length, 2);

  const written = result.toolCalls[0];
  assert.equal(written.name, 'scene.code');
  assert.equal(written.ok, true);
  const body = written.result as {
    ok: boolean;
    scene_id: string;
    findings: unknown[];
    scene: { layout: string; preferredFrames: number; code: { language: string; code: string; highlights: number[]; typing: { charsPerSecond: number } } };
    package: { scenes: Array<{ id: string }> };
  };
  assert.equal(body.ok, true);
  assert.equal(body.scene_id, 's_code');
  assert.deepEqual(body.findings, []);
  assert.equal(body.scene.layout, 'code');
  assert.equal(body.scene.code.language, 'typescript');
  assert.equal(body.scene.code.code, SHORT);
  assert.deepEqual(body.scene.code.highlights, [1]);
  assert.ok(Math.abs(body.scene.code.typing.charsPerSecond - RATE) < 1e-9);
  const words = SHORT.trim().split(/\s+/).filter(Boolean).length;
  const holdSeconds = 1 + 0.25 * Math.max(0, words - 3);
  const typingFrames = (SHORT.length / RATE) * 30;
  assert.ok(body.scene.preferredFrames >= Math.ceil(typingFrames + holdSeconds * 30));
  assert.deepEqual(body.package.scenes.map(scene => scene.id), ['s_code']);

  const refused = result.toolCalls[1];
  assert.equal(refused.ok, true);
  const refusal = refused.result as { ok: boolean; scene_id: string; findings: Array<{ code: string; width: number }>; package?: unknown };
  assert.equal(refusal.ok, false);
  assert.equal(refusal.scene_id, 's_long');
  assert.equal(refusal.package, undefined);
  assert.ok(refusal.findings.some(item => item.code === 'CODE_LINE_TOO_LONG' && item.width === 360));
  assert.deepEqual(body.package.scenes.map(scene => scene.id), ['s_code']);
});
