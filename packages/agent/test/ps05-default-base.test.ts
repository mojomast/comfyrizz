import assert from 'node:assert/strict';
import test from 'node:test';
import { runAgent } from '../src/agent.js';
import type { ChatChunk, ChatModel, ChatRequest } from '../src/types.js';

class CapturingModel implements ChatModel {
  id = 'fake';
  system = '';
  async *stream(request: ChatRequest): AsyncIterable<ChatChunk> {
    this.system = request.system;
    yield { type: 'text', delta: 'Done.' };
  }
}

async function defaultSystemPrompt(): Promise<string> {
  const model = new CapturingModel();
  const result = await runAgent({ model, brief: 'A one-line creative brief.', tools: {} });
  assert.equal(result.ok, true);
  assert.ok(model.system.length > 0, 'the default system prompt reaches the model');
  return model.system;
}

test('DEFAULT_BASE carries a refusal contract instead of an absolute never-ask rule', async () => {
  const prompt = await defaultSystemPrompt();
  assert.match(prompt, /## Refusal contract/);
  assert.match(prompt, /REFUSAL/);
  assert.match(prompt, /contradiction/i);
  assert.match(prompt, /unsupported format/i);
  assert.match(prompt, /refuse/i, 'hard contradictions and unsupported formats are refused');
  assert.doesNotMatch(prompt, /do not ask questions/i, 'the absolute never-ask rule is gone');
  assert.doesNotMatch(prompt, /always build/i, 'the absolute always-build rule is gone');
});

test('DEFAULT_BASE invents named defaults for creative underspecification', async () => {
  const prompt = await defaultSystemPrompt();
  assert.match(prompt, /underspecified/i);
  assert.match(prompt, /invent named defaults/i);
  assert.match(prompt, /taste/i);
  assert.match(prompt, /length/i);
  assert.match(prompt, /palette/i);
});

test('DEFAULT_BASE never invents user stats and labels example datasets', async () => {
  const prompt = await defaultSystemPrompt();
  assert.match(prompt, /never invent/i);
  assert.match(prompt, /user stats|audience numbers|real user (?:data|statistics)/i);
  assert.match(prompt, /Example data/);
  assert.match(prompt, /dataset/i);
});

test('DEFAULT_BASE data-brief checklist attaches datasets and a data layout in one propose', async () => {
  const prompt = await defaultSystemPrompt();
  assert.match(prompt, /datasets/);
  assert.match(prompt, /chart, stat, compare \(or list\)/);
  assert.match(prompt, /one storyboard\.propose/);
});

test('DEFAULT_BASE motion-graphics stop gate needs four in-palette SVGs and a pending still', async () => {
  const prompt = await defaultSystemPrompt();
  assert.match(prompt, /at least 4 in-palette llm-svg/i);
  assert.match(prompt, /pending still/i);
  assert.match(prompt, /stop gate/i);
});

test('DEFAULT_BASE film checklist covers narration cues, Klein stills and brief aspect', async () => {
  const prompt = await defaultSystemPrompt();
  assert.match(prompt, /narration/);
  assert.match(prompt, /cue_phrases/);
  assert.match(prompt, /Klein stills when the motion model is klein/i);
  assert.match(prompt, /aspect and format match the brief/i);
});

test('DEFAULT_BASE forbids identical tool retries and asks for one corrected call', async () => {
  const prompt = await defaultSystemPrompt();
  assert.match(prompt, /never repeat an identical tool call/i);
  assert.match(prompt, /diagnose/i);
  assert.match(prompt, /one corrected call/i);
});
