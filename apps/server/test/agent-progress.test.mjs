import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAgentProgress } from '../src/agent-progress.mjs';
import { packageSchemaProblems } from '../src/agent-runner.mjs';

test('agent progress tracks phases and timings without retaining private content', () => {
  let now = 1000;
  const progress = createAgentProgress('session-test', () => now);
  progress.update({ type: 'runner_phase', phase: 'initial', status: 'started' });
  progress.update({ type: 'step', step: 2, maxSteps: 16 });
  now += 1250;
  progress.update({ type: 'model_milestone', step: 2, milestone: 'first_reasoning', durationMs: 1250 });
  now += 2750;
  progress.update({ type: 'model_result', step: 2, durationMs: 4000, firstChunkMs: 1000, reasoningChars: 800, textChars: 0, toolCalls: ['assets.generate_video'], usage: { input: 10, output: 20 } });
  progress.update({ type: 'tool_call', step: 2, name: 'assets.generate_video', args: { secret: 'do-not-retain' } });
  now += 125;
  progress.update({ type: 'tool_result', step: 2, name: 'assets.generate_video', ok: true, durationMs: 125 });
  progress.update({ type: 'runner_phase', phase: 'repair', status: 'validation', ok: false, problems: ['scenes.0.copy: too long'] });
  progress.finish('failed', 'invalid package');

  const snapshot = progress.snapshot();
  assert.equal(snapshot.sessionId, 'session-test');
  assert.equal(snapshot.phase, 'repair');
  assert.equal(snapshot.step, 2);
  assert.equal(snapshot.maxSteps, 16);
  assert.equal(snapshot.lastModel.durationMs, 4000);
  assert.equal(snapshot.lastModel.firstChunkMs, 1000);
  assert.equal(snapshot.lastTool.durationMs, 125);
  assert.equal(snapshot.status, 'failed');
  assert.equal(snapshot.elapsedMs, 4125);
  now += 5000;
  assert.equal(progress.snapshot().elapsedMs, 4125, 'terminal elapsed time stays frozen');
  assert.deepEqual(snapshot.problems, ['scenes.0.copy: too long']);
  assert.ok(snapshot.recentEvents.length >= 7);
  assert.doesNotMatch(JSON.stringify(snapshot), /do-not-retain/);
});

test('schema failures include actionable validation details, not a generic placeholder', () => {
  const problems = packageSchemaProblems({});
  assert.ok(problems.length > 0);
  assert.ok(problems.every(problem => problem !== 'package schema validation failed'));
  assert.match(problems.join('\n'), /package|required|missing|scene|schema/i);
});
