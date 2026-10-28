import test from 'node:test';
import assert from 'node:assert/strict';
import { agentConsoleEventText, agentConsoleMarkup } from './agent-console.ts';

test('agent console has an expandable activity region', () => {
  const html = agentConsoleMarkup();
  assert.match(html, /<details class="agent-console"/);
  assert.match(html, /Agent activity/);
  assert.match(html, /data-agent-console-events/);
});

test('agent console explains model decisions, tools, repairs and validation', () => {
  assert.equal(agentConsoleEventText({ type: 'request' }), 'Submitted brief');
  assert.match(agentConsoleEventText({ type: 'model_result', toolCalls: ['assets.generate_video'], durationMs: 1200 }), /1 tool call · 1s/);
  assert.equal(agentConsoleEventText({ type: 'tool_call', name: 'assets.generate_video' }), 'Tool call: assets.generate_video');
  assert.match(agentConsoleEventText({ type: 'repair', name: 'storyboard.propose', repairs: 1 }), /Repairing storyboard.propose arguments/);
  assert.match(agentConsoleEventText({ type: 'runner_phase', phase: 'initial', status: 'validation', ok: false }), /validation found issues/);
});
