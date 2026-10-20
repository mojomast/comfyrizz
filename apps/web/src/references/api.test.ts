// The web package typecheck has no @types/node; node:test imports are only
// for this file's runtime, so type checking is skipped here like panel.test.ts.
// @ts-nocheck
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ReferenceApiError,
  createReferenceApi,
  referencesPath,
} from './api.ts';
import type { Reference } from './panel.ts';

type Call = { url: string; init?: RequestInit };

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function fakeFile(name: string, type: string, bytes: Uint8Array) {
  return {
    name,
    type,
    size: bytes.byteLength,
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  };
}

test('list builds the conversation URL and stays local before an id exists', async () => {
  const calls: Call[] = [];
  let id: string | null = null;
  const api = createReferenceApi({
    chatId: () => id,
    apiFetch: async (input, init) => {
      calls.push({ url: String(input), init });
      return json({ references: [{ id: 'ref_1' }], assignments: [{ refId: 'ref_1', sceneId: 's1', slot: 'style_reference' }] });
    },
  });

  assert.deepEqual(await api.list(), { references: [], assignments: [] });
  assert.equal(calls.length, 0, 'no request is made before the chat exists');

  id = 'chat_abcdefgh';
  const listed = await api.list();
  assert.equal(calls[0]?.url, '/api/chat/chat_abcdefgh/references');
  assert.equal(calls[0]?.init?.method, undefined);
  assert.equal(listed.references[0]?.id, 'ref_1');
  assert.equal(listed.assignments?.[0]?.slot, 'style_reference');
});

test('the first upload creates the conversation id and sends a raw body with the R08 headers', async () => {
  const calls: Call[] = [];
  let id: string | null = null;
  let created = 0;
  const bytes = new TextEncoder().encode('\x89PNG\r\n\x1a\nfixture');
  const api = createReferenceApi({
    chatId: () => id,
    ensureChatId: () => {
      created += 1;
      id = 'chat_lazy_upload';
      return id;
    },
    randomId: () => 'unused',
    apiFetch: async (input, init) => {
      calls.push({ url: String(input), init });
      return json({ id: 'ref_abc', kind: 'image', label: 'grain texture.png' }, 201);
    },
  });

  const progress: Array<number | { loaded?: number; total?: number }> = [];
  const record = await api.upload(fakeFile('grain texture.png', 'image/png', bytes), {
    onProgress: value => progress.push(value),
  });

  assert.equal(created, 1, 'the conversation is created once, before the upload');
  assert.equal(record.id, 'ref_abc');
  assert.equal(calls[0]?.url, '/api/chat/chat_lazy_upload/references');
  assert.equal(calls[0]?.init?.method, 'POST');
  const headers = calls[0]?.init?.headers as Record<string, string>;
  assert.equal(headers['content-type'], 'image/png');
  assert.equal(headers['x-filename'], 'grain%20texture.png');
  assert.equal(headers['x-rights-asserted'], '1');
  assert.equal(headers['content-disposition'], undefined, 'no multipart wrapper');
  assert.deepEqual(new Uint8Array(calls[0]?.init?.body as ArrayBuffer), bytes);
  assert.deepEqual(progress[0], { loaded: 0, total: bytes.byteLength });
  assert.deepEqual(progress[1], { loaded: bytes.byteLength, total: bytes.byteLength });

  await api.list();
  assert.equal(created, 1, 'a later request reuses the same id');
  assert.equal(calls[1]?.url, '/api/chat/chat_lazy_upload/references');
});

test('patch, delete, file and thumb URLs target the encoded reference', async () => {
  const calls: Call[] = [];
  const api = createReferenceApi({
    chatId: () => 'chat_abcdefgh',
    apiFetch: async (input, init) => {
      calls.push({ url: String(input), init });
      if (init?.method === 'DELETE') return new Response(null, { status: 204 });
      return json({ id: 'ref_1', kind: 'image' });
    },
  });

  const updated = await api.patch('ref_1', { role: 'style', note: 'warm grain' });
  assert.equal(updated.id, 'ref_1');
  assert.equal(calls[0]?.url, '/api/chat/chat_abcdefgh/references/ref_1');
  assert.equal(calls[0]?.init?.method, 'PATCH');
  assert.equal((calls[0]?.init?.headers as Record<string, string>)['content-type'], 'application/json');
  assert.deepEqual(JSON.parse(String(calls[0]?.init?.body)), { role: 'style', note: 'warm grain' });

  await api.delete('ref_1');
  assert.equal(calls[1]?.url, '/api/chat/chat_abcdefgh/references/ref_1');
  assert.equal(calls[1]?.init?.method, 'DELETE');

  const ref: Reference = { id: 'ref_/1', kind: 'image' };
  assert.equal(api.fileUrl(ref), '/api/chat/chat_abcdefgh/references/ref_%2F1/file');
  assert.equal(api.thumbUrl(ref), '/api/chat/chat_abcdefgh/references/ref_%2F1/thumb');
  assert.equal(referencesPath('chat_abcdefgh', '/ref_1/frames/0'), '/api/chat/chat_abcdefgh/references/ref_1/frames/0');
});

test('an error response keeps the status and server code for the panel', async () => {
  const api = createReferenceApi({
    chatId: () => 'chat_abcdefgh',
    apiFetch: async () => json({ error: 'upload exceeds the limit', code: 'TOO_LARGE' }, 413),
  });

  await assert.rejects(
    () => api.upload(fakeFile('huge.png', 'image/png', new Uint8Array([1]))),
    (error: unknown) => {
      assert.ok(error instanceof ReferenceApiError);
      assert.equal(error.status, 413);
      assert.equal(error.code, 'TOO_LARGE');
      assert.match(error.message, /exceeds the limit/);
      return true;
    },
  );
});
