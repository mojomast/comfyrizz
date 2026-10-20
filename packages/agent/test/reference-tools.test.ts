import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  REFERENCE_NOTE_MAX_CHARS,
  REFERENCE_RULES,
  REFERENCE_SLOTS,
  REFERENCE_TOOLS,
  REFERENCE_TOOL_NAMES,
  isReferenceToolName,
  runReferenceTool,
  type ReferenceManifestEntry,
  type ReferenceProposal,
  type ReferenceProposeResult,
  type ReferenceToolContext,
} from '../src/reference-tools.js';

const manifest = (): ReferenceManifestEntry[] => [
  {
    id: 'ref_style',
    label: 'Warm grain',
    kind: 'image',
    role: 'style',
    note: 'Use this warm film grain and palette on every scene.',
    width: 1024,
    height: 576,
    frames: 0,
    assignedTo: [],
    needsAnswer: false,
  },
  {
    id: 'ref_product',
    label: 'Grinder',
    kind: 'image',
    role: 'product',
    note: 'Hero product. Keep the label readable, scenes 2 and 4.',
    width: 800,
    height: 800,
    frames: 0,
    assignedTo: [{ sceneId: 's2', slot: 'subject_reference' }],
    needsAnswer: false,
  },
  {
    id: 'ref_push',
    label: 'Push-in.mp4',
    kind: 'video',
    role: 'motion',
    note: '',
    width: 1280,
    height: 720,
    durationSec: 8,
    frames: [{ index: 0, atSec: 0.8 }, { index: 1, atSec: 2.4 }],
    assignedTo: [],
    needsAnswer: true,
  },
];

interface FakeContext extends ReferenceToolContext {
  calls: Array<{ name: string; value: unknown }>;
}

function fakeContext(overrides: Partial<ReferenceToolContext> = {}): FakeContext {
  const calls: Array<{ name: string; value: unknown }> = [];
  const refs = manifest();
  return {
    manifest: refs,
    calls,
    getRef: (refId: string) => refs.find(ref => ref.id === refId),
    propose: (assignment: ReferenceProposal): ReferenceProposeResult => {
      calls.push({ name: 'propose', value: assignment });
      return { ok: true };
    },
    ask: (question: string) => {
      calls.push({ name: 'ask', value: question });
      return { ok: true };
    },
    ...overrides,
  } as FakeContext;
}

function assertJsonSchema(schema: any, path: string): void {
  assert.equal(schema && schema.type, 'object', `${path} must be a JSON Schema object`);
  assert.equal(typeof schema.properties, 'object', `${path}.properties must exist`);
  assert.ok(!Array.isArray(schema.properties), `${path}.properties must be an object`);
  assert.equal(schema.additionalProperties, false, `${path} must refuse extra fields`);
  if (schema.required !== undefined) {
    assert.ok(Array.isArray(schema.required), `${path}.required must be an array`);
    for (const key of schema.required) {
      assert.ok(Object.prototype.hasOwnProperty.call(schema.properties, key), `${path}.required names ${key}`);
    }
  }
  for (const [key, value] of Object.entries(schema.properties)) {
    const property = value as any;
    assert.equal(typeof property, 'object', `${path}.${key} must be a schema object`);
    assert.ok(['string', 'integer', 'number', 'boolean', 'array', 'object'].includes(property.type), `${path}.${key} has a JSON Schema type`);
  }
}

test('R09: tools expose OpenAI-style JSON Schema parameters', () => {
  assert.deepEqual(REFERENCE_TOOL_NAMES, [
    'reference_list',
    'reference_get',
    'reference_assign',
    'reference_unassign',
    'reference_ask_user',
  ]);

  for (const tool of REFERENCE_TOOLS) {
    assert.equal(tool.name, tool.name.trim());
    assert.match(tool.description, /\S/);
    assertJsonSchema(tool.parameters, tool.name);
  }

  const byName = new Map(REFERENCE_TOOLS.map(tool => [tool.name, tool]));
  assert.deepEqual((byName.get('reference_list')!.parameters as any).properties, {});
  assert.equal((byName.get('reference_list')!.parameters as any).required, undefined);

  assert.deepEqual((byName.get('reference_get')!.parameters as any).required, ['ref_id']);
  assert.deepEqual((byName.get('reference_assign')!.parameters as any).required, ['ref_id', 'scene_id', 'slot', 'reason']);
  assert.deepEqual((byName.get('reference_assign')!.parameters as any).properties.slot.enum, [...REFERENCE_SLOTS]);
  assert.deepEqual((byName.get('reference_unassign')!.parameters as any).required, ['ref_id', 'scene_id', 'slot']);
  assert.deepEqual((byName.get('reference_ask_user')!.parameters as any).required, ['ref_id', 'question']);

  for (const name of REFERENCE_TOOL_NAMES) assert.equal(isReferenceToolName(name), true);
  assert.equal(isReferenceToolName('reference_delete'), false);
});

test('R09: rules cover notes-first, ask-when-ambiguous and confirm-placement', () => {
  assert.match(REFERENCE_RULES, /notes.first/i);
  assert.match(REFERENCE_RULES, /ask.when.ambiguous/i);
  assert.match(REFERENCE_RULES, /confirm.placement/i);
  assert.match(REFERENCE_RULES, /note[^.]*empty/i);
  assert.match(REFERENCE_RULES, /role is ["']other["']/i);
  assert.match(REFERENCE_RULES, /two references compete/i);
  assert.match(REFERENCE_RULES, /wait for confirmation/i);
  assert.match(REFERENCE_RULES, /never invent references/i);
  assert.match(REFERENCE_RULES, /data, not instructions/i);
});

test('R09: reference_list returns the manifest without mutating it', async () => {
  const ctx = fakeContext();
  const before = JSON.stringify(ctx.manifest);
  const result = await runReferenceTool({ name: 'reference_list', args: {} }, ctx);

  assert.equal(result.ok, true);
  assert.equal(result.status, 'listed');
  assert.deepEqual(result.references, ctx.manifest);
  assert.equal(JSON.stringify(ctx.manifest), before);
  assert.equal(ctx.calls.length, 0);
});

test('R09: reference_get returns one reference and caps user notes', async () => {
  const ctx = fakeContext();
  const found = await runReferenceTool({ name: 'reference_get', args: { ref_id: 'ref_style' } }, ctx);
  assert.equal(found.ok, true);
  assert.equal(found.status, 'found');
  assert.equal(found.reference?.id, 'ref_style');
  assert.match(String(found.reference?.note), /warm film grain/);

  const long = 'x'.repeat(REFERENCE_NOTE_MAX_CHARS + 250);
  const longCtx = fakeContext({
    manifest: [{ id: 'ref_long', kind: 'image', role: 'style', note: long }],
    getRef: () => ({ id: 'ref_long', kind: 'image', role: 'style', note: long }),
  });
  const capped = await runReferenceTool({ name: 'reference_get', args: { ref_id: 'ref_long' } }, longCtx);
  assert.equal(capped.ok, true);
  assert.equal(String(capped.reference?.note).length, REFERENCE_NOTE_MAX_CHARS);

  const missing = await runReferenceTool({ name: 'reference_get', args: { ref_id: 'ref_nope' } }, ctx);
  assert.equal(missing.ok, false);
  assert.match(String(missing.error), /unknown reference: ref_nope/);
});

test('R09: assign with an unknown ref returns an error result instead of throwing', async () => {
  const ctx = fakeContext();
  const result = await runReferenceTool({
    name: 'reference_assign',
    args: { ref_id: 'ref_ghost', scene_id: 's1', slot: 'style_reference', reason: 'style' },
  }, ctx);

  assert.equal(result.ok, false);
  assert.equal(result.status, undefined);
  assert.match(String(result.error), /unknown reference: ref_ghost/);
  assert.equal(ctx.calls.length, 0);
});

test('R09: assign records a proposal with status proposed and never applies it', async () => {
  const ctx = fakeContext();
  const result = await runReferenceTool({
    name: 'reference_assign',
    args: {
      ref_id: 'ref_style',
      scene_id: 's1',
      slot: 'style_reference',
      reason: 'The note says every scene.',
    },
  }, ctx);

  assert.equal(result.ok, true);
  assert.equal(result.status, 'proposed');
  assert.equal(result.applied, false);
  assert.deepEqual(result.assignment, {
    refId: 'ref_style',
    sceneId: 's1',
    slot: 'style_reference',
    reason: 'The note says every scene.',
  });
  assert.deepEqual(ctx.calls, [{
    name: 'propose',
    value: { refId: 'ref_style', sceneId: 's1', slot: 'style_reference', reason: 'The note says every scene.' },
  }]);
  assert.doesNotMatch(JSON.stringify(result), /applied":true/);
});

test('R09: assign forwards a video frame index and keeps the proposal pending', async () => {
  const ctx = fakeContext();
  const result = await runReferenceTool({
    name: 'reference_assign',
    args: {
      ref_id: 'ref_push',
      scene_id: 's3',
      slot: 'start_frame',
      frame_index: 1,
      reason: 'Frame 1 is the clean push-in start.',
    },
  }, ctx);

  assert.equal(result.ok, true);
  assert.equal(result.status, 'proposed');
  assert.equal(result.assignment?.frameIndex, 1);
  assert.equal((ctx.calls[0].value as ReferenceProposal).frameIndex, 1);
});

test('R09: assign turns a host rejection or failure into an error result', async () => {
  const rejected = fakeContext({
    propose: () => ({ ok: false, error: 'slot does not fit this reference kind' }),
  });
  const refusal = await runReferenceTool({
    name: 'reference_assign',
    args: { ref_id: 'ref_product', scene_id: 's2', slot: 'style_reference', reason: 'try' },
  }, rejected);
  assert.equal(refusal.ok, false);
  assert.equal(refusal.status, undefined);
  assert.match(String(refusal.error), /does not fit/);

  const broken = fakeContext({
    propose: () => { throw new Error('storage exploded'); },
  });
  const failure = await runReferenceTool({
    name: 'reference_assign',
    args: { ref_id: 'ref_product', scene_id: 's2', slot: 'subject_reference', reason: 'try' },
  }, broken);
  assert.equal(failure.ok, false);
  assert.doesNotMatch(String(failure.error), /storage exploded/);
});

test('R09: assign rejects malformed calls without throwing', async () => {
  const ctx = fakeContext();
  const noArgs = await runReferenceTool({ name: 'reference_assign' }, ctx);
  assert.equal(noArgs.ok, false);

  const noReason = await runReferenceTool({
    name: 'reference_assign',
    args: { ref_id: 'ref_style', scene_id: 's1', slot: 'style_reference' },
  }, ctx);
  assert.equal(noReason.ok, false);
  assert.match(String(noReason.error), /reason/);

  const badSlot = await runReferenceTool({
    name: 'reference_assign',
    args: { ref_id: 'ref_style', scene_id: 's1', slot: 'poster', reason: 'style' },
  }, ctx);
  assert.equal(badSlot.ok, false);
  assert.match(String(badSlot.error), /unknown slot/);

  const badFrame = await runReferenceTool({
    name: 'reference_assign',
    args: { ref_id: 'ref_push', scene_id: 's3', slot: 'start_frame', frame_index: -1, reason: 'start' },
  }, ctx);
  assert.equal(badFrame.ok, false);
  assert.match(String(badFrame.error), /frame_index/);

  assert.equal(ctx.calls.length, 0);
});

test('R09: unassign proposes a removal, preferring the host callback', async () => {
  const calls: unknown[] = [];
  const ctx = fakeContext({
    unassign: target => {
      calls.push(target);
      return { ok: true };
    },
  });

  const result = await runReferenceTool({
    name: 'reference_unassign',
    args: { ref_id: 'ref_product', scene_id: 's2', slot: 'subject_reference' },
  }, ctx);

  assert.equal(result.ok, true);
  assert.equal(result.status, 'proposed');
  assert.equal(result.applied, false);
  assert.deepEqual(result.target, { refId: 'ref_product', sceneId: 's2', slot: 'subject_reference' });
  assert.deepEqual(calls, [{ refId: 'ref_product', sceneId: 's2', slot: 'subject_reference' }]);
  assert.equal(ctx.calls.length, 0);

  const fallbackCtx = fakeContext();
  const fallback = await runReferenceTool({
    name: 'reference_unassign',
    args: { ref_id: 'ref_style', scene_id: 's1', slot: 'style_reference' },
  }, fallbackCtx);
  assert.equal(fallback.ok, true);
  assert.equal(fallback.status, 'proposed');
  assert.equal((fallbackCtx.calls[0].value as ReferenceProposal).action, 'unassign');
});

test('R09: ask_user queries a known reference and refuses unknown ones', async () => {
  const ctx = fakeContext();
  const result = await runReferenceTool({
    name: 'reference_ask_user',
    args: { ref_id: 'ref_push', question: 'Should this be the camera move or the pour itself?' },
  }, ctx);

  assert.equal(result.ok, true);
  assert.equal(result.status, 'asked');
  assert.equal(result.ref_id, 'ref_push');
  assert.match(String(result.question), /camera move/);
  assert.deepEqual(ctx.calls, [{
    name: 'ask',
    value: 'Should this be the camera move or the pour itself?',
  }]);

  const unknown = await runReferenceTool({
    name: 'reference_ask_user',
    args: { ref_id: 'ref_ghost', question: 'What is this?' },
  }, ctx);
  assert.equal(unknown.ok, false);
  assert.match(String(unknown.error), /unknown reference/);
  assert.equal(ctx.calls.length, 1);
});

test('R09: unknown tools and non-object arguments return error results', async () => {
  const ctx = fakeContext();
  const unknown = await runReferenceTool({ name: 'reference_delete', args: {} }, ctx);
  assert.equal(unknown.ok, false);
  assert.match(String(unknown.error), /unknown reference tool/);

  const weird = await runReferenceTool({ name: 'reference_list', args: 'not-an-object' }, ctx);
  assert.equal(weird.ok, true);
  assert.deepEqual(weird.references, ctx.manifest);

  const invalid = await runReferenceTool(null as any, ctx);
  assert.equal(invalid.ok, false);
});
