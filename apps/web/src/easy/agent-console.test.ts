import test from 'node:test';
import assert from 'node:assert/strict';
import { agentConsoleBuildMarkup, agentConsoleEventText, agentConsoleMarkup } from './agent-console.ts';

test('agent console has an expandable, resizable popup drawer and Build view', () => {
  const html = agentConsoleMarkup();
  assert.match(html, /data-agent-console-toggle/);
  assert.match(html, /<aside[^>]*role="dialog"/);
  assert.match(html, /data-agent-console-drag/);
  assert.match(html, /data-agent-console-tab="build"/);
});

test('agent console explains model decisions, tools, repairs and validation', () => {
  assert.equal(agentConsoleEventText({ type: 'request' }), 'Submitted brief');
  assert.match(agentConsoleEventText({ type: 'model_result', toolCalls: ['assets.generate_video'], durationMs: 1200 }), /1 tool call · 1s/);
  assert.equal(agentConsoleEventText({ type: 'tool_call', name: 'assets.generate_video' }), 'Tool call: assets.generate_video');
  assert.match(agentConsoleEventText({ type: 'repair', name: 'storyboard.propose', repairs: 1 }), /Repairing storyboard.propose arguments/);
  assert.match(agentConsoleEventText({ type: 'runner_phase', phase: 'initial', status: 'validation', ok: false }), /validation found issues/);
});

test('Build view renders the live proposal, scenes and asset states', () => {
  const html = agentConsoleBuildMarkup({
    build: {
      title: 'Real Human Skaters',
      proposal: { logline: 'Two skaters learn.', look: 'Photorealistic people.', soundtrack: 'Foley.' },
      scenes: [{ id: 's1', preferredFrames: 150, headline: 'First fall', generationCalls: 1 }],
      assets: [{ kind: 'video', sceneId: 's1', intent: 'A human skater falls.', status: 'planned' }],
      coverageScenes: 4,
    },
  });
  assert.match(html, /Real Human Skaters/);
  assert.match(html, /Photorealistic people/);
  assert.match(html, /150 frames · 1 generation call/);
  assert.match(html, /A human skater falls/);
  assert.match(html, /Coverage split: 4 total shots/);
});
