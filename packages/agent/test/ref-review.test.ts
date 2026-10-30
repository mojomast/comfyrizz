import assert from 'node:assert/strict';
import test from 'node:test';
// @ts-ignore @comfyrizz/schema ships plain .mjs contracts without type declarations.
import { validateRefVerdict } from '@comfyrizz/schema/ref-review';
// @ts-ignore Node type stripping needs the explicit .ts specifier.
import { reviewStill } from '../src/ref-review.js';
// @ts-ignore Node type stripping needs the explicit .ts specifier.
import type { ChatMessage, ImagePart } from '../src/types.ts';

const SHA = 'a'.repeat(64);

const request = {
  schema: 'comfyrizz.ref-review.request/v1',
  productionId: 'prod_1',
  runId: 'run_1',
  jobId: 'still_s03',
  shotId: 's03',
  keyframeSha256: SHA,
  imagePath: 'out/still_s03.png',
  width: 1024,
  height: 576,
  plannedWidth: 1024,
  plannedHeight: 576,
  prompt: 'Mira, a copper-haired lighthouse keeper in a yellow oilskin, stands at the lamp room window at dusk.',
  attempt: 0,
  characters: [
    {
      characterId: 'mira',
      identityLock: 'Mira: 30s, shoulder-length copper hair, centre part, freckles, green eyes',
      wardrobeState: 'W1 yellow oilskin, dry',
    },
  ],
};

const image: ImagePart = { path: 'out/still_s03.png', mediaType: 'image/png' };

function verdict(overrides: Record<string, unknown> = {}) {
  return {
    schema: 'comfyrizz.ref-review.verdict/v1',
    jobId: request.jobId,
    keyframeSha256: SHA,
    reviewer: 'fake',
    overall: 'pass',
    checks: [
      { dimension: 'identity', pass: true, severity: 'hard', evidence: 'copper hair, centre part, freckles visible' },
      { dimension: 'anatomy', pass: true, severity: 'hard', evidence: 'two hands, five fingers each' },
      { dimension: 'framing', pass: false, severity: 'soft', evidence: 'slightly wider than planned medium shot' },
    ],
    fixHints: [],
    ...overrides,
  };
}

test('the judge sees one image part and the shot prompt with every identity lock', async () => {
  const calls: ChatMessage[][] = [];
  const model = async (messages: ChatMessage[]) => {
    calls.push(messages);
    return JSON.stringify(verdict());
  };
  const result = await reviewStill({ request, image, model, signal: new AbortController().signal });

  assert.equal(result.overall, 'pass');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].length, 1);
  const message = calls[0][0];
  assert.equal(message.role, 'user');
  assert.ok(message.role === 'user');
  assert.equal(message.images?.length, 1);
  assert.deepEqual(message.images?.[0], image);
  assert.match(message.content, /Mira, a copper-haired lighthouse keeper/);
  assert.match(message.content, /Mira: 30s, shoulder-length copper hair, centre part, freckles, green eyes/);
  assert.match(message.content, /W1 yellow oilskin, dry/);
  assert.match(message.content, /hands, fingers, limbs, and eyes/);
  assert.match(message.content, /entity\|appearance\|activity\|counting\|composition/);
  assert.match(message.content, /text_artifact/);
});

test('a valid reply is returned unchanged', async () => {
  const valid = verdict();
  const result = await reviewStill({
    request,
    image,
    model: async () => JSON.stringify(valid),
    signal: new AbortController().signal,
  });
  assert.deepEqual(result, valid);
  assert.deepEqual(validateRefVerdict(result), { ok: true, errors: [] });
});

test('malformed replies are retried once and then fail closed to error', async () => {
  const calls: ChatMessage[][] = [];
  const model = async (messages: ChatMessage[]) => {
    calls.push(messages);
    return 'I could not inspect the image.';
  };
  const result = await reviewStill({ request, image, model, signal: new AbortController().signal });

  assert.equal(calls.length, 2);
  assert.equal(result.overall, 'error');
  assert.notEqual(result.overall, 'pass');
  assert.equal(result.jobId, request.jobId);
  assert.equal(result.keyframeSha256, SHA);
  assert.equal(result.checks.length, 0);
  assert.deepEqual(validateRefVerdict(result), { ok: true, errors: [] });
});

test('a contradictory pass with a failed hard check is rejected and repaired once', async () => {
  const contradiction = verdict({
    checks: [{ dimension: 'identity', pass: false, severity: 'hard', evidence: 'hair is black' }],
  });
  const valid = verdict();
  const calls: ChatMessage[][] = [];
  const model = async (messages: ChatMessage[]) => {
    calls.push(messages);
    return calls.length === 1 ? JSON.stringify(contradiction) : JSON.stringify(valid);
  };
  const result = await reviewStill({ request, image, model, signal: new AbortController().signal });

  assert.equal(calls.length, 2);
  assert.deepEqual(result, valid);
  const repair = calls[1].at(-1);
  assert.ok(repair);
  assert.equal(repair.role, 'user');
  assert.ok(repair.role === 'user');
  assert.match(repair.content, /contradicts/);
  assert.equal(calls[1].filter(message => message.role === 'user' && message.images?.length).length, 1);
});

test('a contradiction repeated twice returns overall error, never pass', async () => {
  const contradiction = verdict({
    checks: [{ dimension: 'identity', pass: false, severity: 'hard', evidence: 'hair is black' }],
  });
  let calls = 0;
  const result = await reviewStill({
    request,
    image,
    model: async () => {
      calls++;
      return JSON.stringify(contradiction);
    },
    signal: new AbortController().signal,
  });

  assert.equal(calls, 2);
  assert.equal(result.overall, 'error');
  assert.notEqual(result.overall, 'pass');
});

test('a model failure becomes an error verdict without leaking credentials or logging', async () => {
  const secret = `sk-${'a'.repeat(24)}`;
  const logged: string[] = [];
  const original = { log: console.log, error: console.error, warn: console.warn, info: console.info };
  console.log = (...args: unknown[]) => { logged.push(args.map(String).join(' ')); };
  console.error = (...args: unknown[]) => { logged.push(args.map(String).join(' ')); };
  console.warn = (...args: unknown[]) => { logged.push(args.map(String).join(' ')); };
  console.info = (...args: unknown[]) => { logged.push(args.map(String).join(' ')); };
  try {
    const result = await reviewStill({
      request,
      image,
      model: async () => {
        throw new Error(`Authorization: Bearer ${secret} OPENCODE_GO_API_KEY=${secret}`);
      },
      signal: new AbortController().signal,
    });
    assert.equal(result.overall, 'error');
    const serialized = JSON.stringify(result);
    assert.doesNotMatch(serialized, /Authorization|Bearer|OPENCODE_GO_API_KEY|sk-/);
    assert.equal(logged.length, 0);
  } finally {
    console.log = original.log;
    console.error = original.error;
    console.warn = original.warn;
    console.info = original.info;
  }
});
