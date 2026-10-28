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
  assert.deepEqual(snapshot.usage, { input: 10, output: 20, total: 30 });
  assert.equal(snapshot.status, 'failed');
  assert.equal(snapshot.elapsedMs, 4125);
  now += 5000;
  assert.equal(progress.snapshot().elapsedMs, 4125, 'terminal elapsed time stays frozen');
  assert.deepEqual(snapshot.problems, ['scenes.0.copy: too long']);
  assert.ok(snapshot.recentEvents.length >= 7);
  assert.doesNotMatch(JSON.stringify(snapshot), /do-not-retain/);
});

test('progress exposes the brief and tool arguments with secret-field redaction', () => {
  const progress = createAgentProgress('session-detail', () => 1000);
  progress.update({ type: 'request', brief: 'A robot opens a shop.' });
  progress.update({
    type: 'tool_call', name: 'assets.generate_video', step: 1,
    args: { intent: 'A brass robot opens a shop', nested: { apiKey: 'do-not-retain', safe: true } },
  });
  progress.update({ type: 'text', delta: 'raw model text must not flood history' });
  const snapshot = progress.snapshot();
  assert.equal(snapshot.recentEvents[0].brief, 'A robot opens a shop.');
  assert.equal(snapshot.recentEvents[1].args.intent, 'A brass robot opens a shop');
  assert.equal(snapshot.recentEvents[1].args.nested.apiKey, '[redacted]');
  assert.equal(snapshot.recentEvents[1].args.nested.safe, true);
  assert.equal(snapshot.recentEvents.length, 2);
  assert.doesNotMatch(JSON.stringify(snapshot), /do-not-retain|raw model text/);
});

test('progress builds a live proposal, scene and asset view from tool calls', () => {
  const progress = createAgentProgress('session-build', () => 1000);
  progress.update({
    type: 'tool_call', name: 'storyboard.propose',
    args: {
      title: 'Real Human Skaters',
      proposal: { logline: 'Two skaters learn.', look: 'Photorealistic people.', soundtrack: 'Foley.' },
      scenes: [{ id: 's1', layout: 'hero', preferredFrames: 150, copy: { headline: 'First fall' } }],
    },
  });
  progress.update({ type: 'tool_call', name: 'assets.generate_video', args: { scene_id: 's1', action: 'A human skater falls.' } });
  progress.update({ type: 'tool_result', name: 'assets.generate_video', ok: true });
  const build = progress.snapshot().build;
  assert.equal(build.title, 'Real Human Skaters');
  assert.equal(build.proposal.look, 'Photorealistic people.');
  assert.equal(build.scenes[0].generationCalls, 1);
  assert.equal(build.assets[0].kind, 'video');
  assert.equal(build.assets[0].status, 'planned');
});

test('schema failures include actionable validation details, not a generic placeholder', () => {
  const problems = packageSchemaProblems({});
  assert.ok(problems.length > 0);
  assert.ok(problems.every(problem => problem !== 'package schema validation failed'));
  assert.match(problems.join('\n'), /package|required|missing|scene|schema/i);
});
