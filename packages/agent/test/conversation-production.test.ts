import assert from 'node:assert/strict';
import test from 'node:test';
import { CONVERSATION_TOOLS, runConversationTurn } from '../src/conversation.js';
import type { ConversationCharacters, ConversationClips, ConversationReferences } from '../src/conversation.js';
import { CHARACTER_TOOLS } from '../src/character-tools.js';
import { CLIP_TOOLS } from '../src/clip-tools.js';
import { REFERENCE_TOOLS } from '../src/reference-tools.js';
import { PRODUCTION_TOOL_NAMES, productionToolsFor } from '../src/production-tools.js';
import type { ProductionToolContext } from '../src/production-tools.js';
import type { ChatChunk, ChatModel, ChatRequest } from '../src/types.js';

const SHOTS = [
  { id: 's1', lines: ['s1:l1', 's1:l2'] },
  { id: 's2', lines: ['s2:l1', 's2:l2'] },
];

function fake(responses: ChatChunk[][]) {
  const requests: Omit<ChatRequest, 'signal'>[] = [];
  const model: ChatModel = {
    id: 'test',
    async *stream(request) {
      const { signal, ...snapshot } = request;
      void signal;
      requests.push(structuredClone(snapshot));
      yield* responses[requests.length - 1] ?? [];
    },
  };
  return { model, requests };
}

const call = (name: string, args: unknown): ChatChunk => ({ type: 'tool_call', id: `call-${name}-${Math.random()}`, name, args });
const text = (delta: string): ChatChunk => ({ type: 'text', delta });

function context(options: {
  intent?: string;
  revision?: number;
  requestedShotIds?: string[];
  requestedLineIds?: string[];
} = {}) {
  const revision = options.revision ?? 4;
  const intent = options.intent ?? 'active';
  const dispatched: Array<{ envelope: unknown; attribution: unknown }> = [];
  const ctx: ProductionToolContext = {
    productionId: 'prod_1',
    userEventId: 'ue_1',
    turnId: 'turn_1',
    read: () => ({
      production: { id: 'prod_1', revision, intent, shotIds: SHOTS.map(shot => shot.id) },
      revision,
      lastSequence: revision,
    }),
    command: (envelope, attribution) => {
      dispatched.push({ envelope, attribution });
      return { ok: true, revision: revision + 1 };
    },
    capabilities: { read: true, proposePlan: true, commands: true },
    productionState: {
      intent,
      shots: SHOTS,
      requestedShotIds: options.requestedShotIds ?? ['s1'],
      requestedLineIds: options.requestedLineIds ?? ['s1:l2'],
    },
  };
  return { ctx, dispatched };
}

const plan = (shotId: string, lineId: string, summary = `Improve ${lineId}.`) => ({
  edits: [{ shotId, lineId, instruction: summary }],
  actions: [],
  summary,
});

const turn = (
  model: ChatModel,
  production?: ProductionToolContext,
  extra: {
    references?: ConversationReferences;
    clips?: ConversationClips;
    characters?: ConversationCharacters;
  } = {},
) => runConversationTurn({
  model,
  plan: null,
  messages: [{ role: 'user', content: 'Improve s1 line 2.' }],
  sessionId: 'conversation-production-test',
  signal: AbortSignal.timeout(5000),
  ...extra,
  ...(production ? { production } : {}),
  build: async () => ({ packageId: 'pkg_test', revision: 1 }),
});

test('IP66: a production context offers the production tools and a plain turn does not', async () => {
  const plain = fake([[text('No production here.')]]);
  const plainResult = await turn(plain.model);
  assert.equal(plainResult.reply, 'No production here.');
  assert.deepEqual(plain.requests[0].tools.map(tool => tool.name), CONVERSATION_TOOLS.map(tool => tool.name));
  assert.doesNotMatch(plain.requests[0].system, /Production agent rules/);

  const existing = fake([[text('Existing contexts only.')]]);
  await turn(existing.model, undefined, {
    references: { block: 'reference manifest' },
    clips: { block: 'clip manifest' },
    characters: { block: 'cast manifest' },
  });
  assert.deepEqual(
    existing.requests[0].tools.map(tool => tool.name),
    [
      ...CONVERSATION_TOOLS.map(tool => tool.name),
      ...REFERENCE_TOOLS.map(tool => tool.name),
      ...CLIP_TOOLS.map(tool => tool.name),
      ...CHARACTER_TOOLS.map(tool => tool.name),
    ],
  );
  assert.ok(!existing.requests[0].tools.some(tool => tool.name.startsWith('production_')));

  const { ctx } = context();
  const scoped = fake([[text('Ready.')]]);
  await turn(scoped.model, ctx);
  const names = scoped.requests[0].tools.map(tool => tool.name);
  assert.deepEqual(names.slice(-PRODUCTION_TOOL_NAMES.length), PRODUCTION_TOOL_NAMES);
  assert.match(scoped.requests[0].system, /Production agent rules/);
  assert.match(scoped.requests[0].messages[0].content ?? '', /s1:l2/);
});

test('IP66: a mutation before production_read is refused and nothing is dispatched', async () => {
  const { ctx, dispatched } = context();
  const { model, requests } = fake([
    [call('production_propose_plan', { expected_revision: 4, plan: plan('s1', 's1:l2') })],
    [text('I need to read first.')],
  ]);
  const result = await turn(model, ctx);
  assert.equal(dispatched.length, 0);
  assert.match(result.trace.tools[0].error ?? '', /production_read/);
  assert.match(String(requests[1].messages.at(-1)?.content), /production_read/);
});

test('IP66: out-of-scope and unknown shot or line ids are refused without dispatch', async () => {
  for (const [shotId, lineId] of [['s2', 's2:l1'], ['s9', 's9:l1'], ['s1', 's1:l9']] as const) {
    const { ctx, dispatched } = context();
    const { model } = fake([
      [call('production_read', {})],
      [call('production_propose_plan', { expected_revision: 4, plan: plan(shotId, lineId) })],
      [text('Refused.')],
    ]);
    const result = await turn(model, ctx);
    const refused = result.trace.tools.find(item => item.name === 'production_propose_plan');
    assert.equal(refused?.ok, false, `${shotId}/${lineId}`);
    assert.match(refused?.error ?? '', /outside the production state or the requested scope/);
    assert.equal(dispatched.length, 0, `${shotId}/${lineId}`);
  }
});

test('IP66: a stale expected revision and a paused production are refused without dispatch', async () => {
  const stale = context();
  const staleModel = fake([
    [call('production_read', {})],
    [call('production_propose_plan', { expected_revision: 3, plan: plan('s1', 's1:l2') })],
    [text('Stale.')],
  ]);
  const staleResult = await turn(staleModel.model, stale.ctx);
  assert.match(staleResult.trace.tools.find(item => item.name === 'production_propose_plan')?.error ?? '', /revision/);
  assert.equal(stale.dispatched.length, 0);

  const paused = context({ intent: 'paused' });
  const pausedModel = fake([
    [call('production_read', {})],
    [call('production_propose_plan', { expected_revision: 4, plan: plan('s1', 's1:l2') })],
    [text('Paused.')],
  ]);
  const pausedResult = await turn(pausedModel.model, paused.ctx);
  assert.match(pausedResult.trace.tools.find(item => item.name === 'production_propose_plan')?.error ?? '', /paused/);
  assert.equal(paused.dispatched.length, 0);
});

test('IP66: an in-scope edit after the read reaches the dispatcher exactly once', async () => {
  const { ctx, dispatched } = context();
  const { model } = fake([
    [call('production_read', {})],
    [call('production_propose_plan', { expected_revision: 4, plan: plan('s1', 's1:l2') })],
    [call('production_propose_plan', { expected_revision: 4, plan: plan('s1', 's1:l2') })],
    [text('Proposed the scoped edit.')],
  ]);
  const result = await turn(model, ctx);
  assert.equal(result.reply, 'Proposed the scoped edit.');
  assert.equal(dispatched.length, 1);
  const envelope = dispatched[0].envelope as { kind: string; payload: { edits: Array<{ lineId: string }> } };
  assert.equal(envelope.kind, 'plan.propose');
  assert.equal(envelope.payload.edits[0].lineId, 's1:l2');
  assert.deepEqual(dispatched[0].attribution, { actor: 'agent', userEventId: 'ue_1' });
  assert.equal(result.trace.tools.filter(item => item.name === 'production_propose_plan' && item.ok).length, 1);
});

test('IP66: productionToolsFor is the only tool-list source for the contextual turn', () => {
  const { ctx } = context();
  assert.deepEqual(productionToolsFor(ctx).map(tool => tool.name), PRODUCTION_TOOL_NAMES);
  assert.deepEqual(productionToolsFor(null), []);
});
