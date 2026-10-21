// @ts-nocheck
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CharacterApiError,
  castPath,
  characterPath,
  charactersPath,
  createCharacterApi,
} from '../src/characters/api.ts';

type Call = { url: string; init?: RequestInit };

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function bytesOf(value: Uint8Array): ArrayBuffer {
  return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength);
}

function fakeFile(name: string, type: string, bytes: Uint8Array) {
  return {
    name,
    type,
    size: bytes.byteLength,
    arrayBuffer: async () => bytesOf(bytes),
  };
}

function character(id = 'chr_0123456789abcdef', overrides: Record<string, unknown> = {}) {
  return {
    schema: 'comfyrizz.character/v1',
    id,
    revision: 1,
    name: 'Pip',
    handle: 'pip',
    role: 'mascot',
    kind: 'fictional',
    summary: 'Round coffee bean',
    visual: { images: [] },
    voice: { engine: 'none', sampleLines: [] },
    bible: {},
    tags: [],
    createdAt: '2026-10-20T00:00:00.000Z',
    updatedAt: '2026-10-20T00:00:00.000Z',
    ...overrides,
  };
}

function castEntry(castId = 'c_pip', overrides: Record<string, unknown> = {}) {
  return {
    castId,
    characterId: 'chr_0123456789abcdef',
    pinnedRevision: 2,
    snapshot: character(),
    overrides: {},
    detached: false,
    orphaned: false,
    ...overrides,
  };
}

test('paths encode ids and CRUD goes through the injected apiFetch', async () => {
  const calls: Call[] = [];
  const api = createCharacterApi({
    apiFetch: async (input, init) => {
      calls.push({ url: String(input), init });
      if (init?.method === 'DELETE') return new Response(null, { status: 204 });
      if (init?.method === 'POST') return json(character(undefined, { revision: 1 }), 201);
      if (init?.method === 'PATCH') return json(character(undefined, { revision: 2, summary: 'Edited' }));
      if (String(input) === '/api/characters') {
        return json({ characters: [character(), character('chr_fedcba9876543210', { name: 'Bean' })] });
      }
      return json(character());
    },
  });

  assert.equal(charactersPath(), '/api/characters');
  assert.equal(characterPath('chr_0123456789abcdef', '/images'), '/api/characters/chr_0123456789abcdef/images');
  assert.equal(characterPath('chr_/odd'), '/api/characters/chr_%2Fodd');
  assert.equal(castPath('chat_abcdefgh'), '/api/chat/chat_abcdefgh/cast');
  assert.equal(castPath('chat_abcdefgh', 'c_pip', '/detach'), '/api/chat/chat_abcdefgh/cast/c_pip/detach');

  const listed = await api.list();
  assert.deepEqual(listed.map(item => item.name), ['Pip', 'Bean']);
  assert.equal(calls[0]?.url, '/api/characters');
  assert.equal(calls[0]?.init?.method, undefined);

  const created = await api.create(
    { name: 'Pip', role: 'mascot', visual: { identityPrompt: 'glossy bean' } },
    { fictional: true },
  );
  assert.equal(created.id, 'chr_0123456789abcdef');
  assert.equal(calls[1]?.url, '/api/characters');
  assert.equal(calls[1]?.init?.method, 'POST');
  const createHeaders = calls[1]?.init?.headers as Record<string, string>;
  assert.equal(createHeaders['content-type'], 'application/json');
  assert.deepEqual(JSON.parse(String(calls[1]?.init?.body)), {
    name: 'Pip',
    role: 'mascot',
    visual: { identityPrompt: 'glossy bean' },
    fictional: true,
  });

  await api.get('chr_0123456789abcdef');
  assert.equal(calls[2]?.url, '/api/characters/chr_0123456789abcdef');

  const updated = await api.update('chr_0123456789abcdef', { summary: 'Edited' });
  assert.equal(updated.revision, 2);
  assert.equal(calls[3]?.init?.method, 'PATCH');
  assert.deepEqual(JSON.parse(String(calls[3]?.init?.body)), { summary: 'Edited' });

  await api.remove('chr_0123456789abcdef');
  assert.equal(calls[4]?.init?.method, 'DELETE');
  assert.equal(calls[4]?.url, '/api/characters/chr_0123456789abcdef');

  await api.listRevisions('chr_0123456789abcdef');
  assert.equal(calls[5]?.url, '/api/characters/chr_0123456789abcdef/revisions');

  await api.getRevision('chr_0123456789abcdef', 3);
  assert.equal(calls[6]?.url, '/api/characters/chr_0123456789abcdef/revisions/3');

  await api.listImages('chr_0123456789abcdef');
  assert.equal(calls[7]?.url, '/api/characters/chr_0123456789abcdef/images');
});

test('revision and image responses unwrap their arrays', async () => {
  const first = character(undefined, { revision: 1 });
  const second = character(undefined, { revision: 2 });
  const images = [
    { imgId: 'img_0123456789abcdef', view: 'front', primary: true, source: 'upload', sha256: 'a'.repeat(64), width: 64, height: 64 },
  ];
  const api = createCharacterApi({
    apiFetch: async input => {
      const url = String(input);
      if (url.endsWith('/revisions')) {
        return json({ characterId: 'chr_0123456789abcdef', current: 2, revisions: [first, second] });
      }
      if (url.endsWith('/images')) return json({ images });
      return json(second);
    },
  });

  const revisions = await api.listRevisions('chr_0123456789abcdef');
  assert.equal(revisions.current, 2);
  assert.deepEqual(revisions.revisions.map(item => item.revision), [1, 2]);

  const listedImages = await api.listImages('chr_0123456789abcdef');
  assert.equal(listedImages[0]?.imgId, 'img_0123456789abcdef');
  assert.equal(listedImages[0]?.primary, true);
});

test('image upload sends the raw bytes and the character upload headers', async () => {
  const calls: Call[] = [];
  const bytes = new TextEncoder().encode('\x89PNG\r\n\x1a\nfixture');
  const api = createCharacterApi({
    apiFetch: async (input, init) => {
      calls.push({ url: String(input), init });
      return json({
        image: { imgId: 'img_0123456789abcdef', view: 'three_quarter', primary: true, source: 'upload', sha256: 'b'.repeat(64), width: 8, height: 8 },
        character: character(undefined, { revision: 2 }),
      }, 201);
    },
  });

  const progress: Array<{ loaded: number; total: number }> = [];
  const result = await api.uploadImage(
    'chr_0123456789abcdef',
    fakeFile('pip pose.png', 'image/png', bytes),
    { view: 'three_quarter', primary: true, onProgress: value => progress.push(value) },
  );

  assert.equal(result.character.revision, 2);
  assert.equal(calls[0]?.url, '/api/characters/chr_0123456789abcdef/images?view=three_quarter&primary=1');
  assert.equal(calls[0]?.init?.method, 'POST');
  const headers = calls[0]?.init?.headers as Record<string, string>;
  assert.equal(headers['content-type'], 'image/png');
  assert.equal(headers['x-filename'], 'pip%20pose.png');
  assert.equal(headers['x-rights-asserted'], '1');
  assert.equal(headers['content-disposition'], undefined, 'no multipart wrapper');
  assert.deepEqual(new Uint8Array(calls[0]?.init?.body as ArrayBuffer), bytes);
  assert.deepEqual(progress, [
    { loaded: 0, total: bytes.byteLength },
    { loaded: bytes.byteLength, total: bytes.byteLength },
  ]);

  await api.uploadImage('chr_0123456789abcdef', fakeFile('pip.webp', '', bytes));
  const fallbackHeaders = calls[1]?.init?.headers as Record<string, string>;
  assert.equal(calls[1]?.url, '/api/characters/chr_0123456789abcdef/images');
  assert.equal(fallbackHeaders['content-type'], 'image/webp', 'extension fallback when File.type is empty');
  assert.equal(fallbackHeaders['x-filename'], 'pip.webp');
});

test('thumbs and full images are fetched as blobs through apiFetch, never as bare URLs', async () => {
  const calls: Call[] = [];
  const png = new Uint8Array([1, 2, 3, 4]);
  const api = createCharacterApi({
    apiFetch: async (input, init) => {
      calls.push({ url: String(input), init });
      return new Response(png, { status: 200, headers: { 'content-type': 'image/jpeg' } });
    },
  });

  const primary = await api.primaryThumb('chr_0123456789abcdef');
  assert.ok(primary instanceof Blob);
  assert.equal(primary.type, 'image/jpeg');
  assert.deepEqual(new Uint8Array(await primary.arrayBuffer()), png);
  assert.equal(calls[0]?.url, '/api/characters/chr_0123456789abcdef/thumb');

  const thumb = await api.thumb('chr_0123456789abcdef', 'img_0123456789abcdef');
  assert.deepEqual(new Uint8Array(await thumb.arrayBuffer()), png);
  assert.equal(calls[1]?.url, '/api/characters/chr_0123456789abcdef/thumbs/img_0123456789abcdef');

  const file = await api.imageFile('chr_0123456789abcdef', 'img_0123456789abcdef');
  assert.deepEqual(new Uint8Array(await file.arrayBuffer()), png);
  assert.equal(calls[2]?.url, '/api/characters/chr_0123456789abcdef/images/img_0123456789abcdef/file');

  assert.equal('thumbUrl' in api, false, 'the caller must use the blob wrapper for auth');
  assert.equal('fileUrl' in api, false, 'the caller must use the blob wrapper for auth');
});

test('cast wrappers use the chat routes, pin snapshots and keep overrides', async () => {
  const calls: Call[] = [];
  const entry = castEntry();
  const api = createCharacterApi({
    apiFetch: async (input, init) => {
      calls.push({ url: String(input), init });
      if (init?.method === 'DELETE') return json({ cast: [], removed: 'c_pip' });
      if (init?.method === 'POST' && String(input).endsWith('/cast')) {
        return json({ cast: [entry], entry, castId: 'c_pip', added: true }, 201);
      }
      if (init?.method === 'PATCH') return json({ cast: [entry], entry, changed: true });
      if (init?.method === 'POST') return json({ cast: [entry], entry, changed: true });
      if (String(input).endsWith('/cast')) return json({ cast: [entry] });
      return json(entry);
    },
  });

  const listed = await api.listCast('chat_abcdefgh');
  assert.equal(listed[0]?.castId, 'c_pip');
  assert.equal(calls[0]?.url, '/api/chat/chat_abcdefgh/cast');

  const added = await api.addCast('chat_abcdefgh', 'chr_0123456789abcdef', {
    role: 'presenter',
    overrides: { wardrobeId: 'w1' },
  });
  assert.equal(added.added, true);
  assert.equal(calls[1]?.init?.method, 'POST');
  assert.deepEqual(JSON.parse(String(calls[1]?.init?.body)), {
    characterId: 'chr_0123456789abcdef',
    role: 'presenter',
    overrides: { wardrobeId: 'w1' },
  });

  await api.getCast('chat_abcdefgh', 'c_pip');
  assert.equal(calls[2]?.url, '/api/chat/chat_abcdefgh/cast/c_pip');

  await api.patchCast('chat_abcdefgh', 'c_pip', {
    overrides: { expressionId: 'e1' },
    replace: true,
  });
  assert.equal(calls[3]?.init?.method, 'PATCH');
  assert.deepEqual(JSON.parse(String(calls[3]?.init?.body)), {
    overrides: { expressionId: 'e1' },
    replace: true,
  });

  await api.updateCast('chat_abcdefgh', 'c_pip');
  assert.equal(calls[4]?.url, '/api/chat/chat_abcdefgh/cast/c_pip/update');
  assert.equal(calls[4]?.init?.method, 'POST');

  await api.detachCast('chat_abcdefgh', 'c_pip');
  assert.equal(calls[5]?.url, '/api/chat/chat_abcdefgh/cast/c_pip/detach');

  await api.attachCast('chat_abcdefgh', 'c_pip');
  assert.equal(calls[6]?.url, '/api/chat/chat_abcdefgh/cast/c_pip/attach');

  const removed = await api.removeCast('chat_abcdefgh', 'c_pip');
  assert.equal(removed.removed, 'c_pip');
  assert.equal(calls[7]?.url, '/api/chat/chat_abcdefgh/cast/c_pip');
  assert.equal(calls[7]?.init?.method, 'DELETE');
});

test('errors keep the status and server code, and invalid revisions stay local', async () => {
  let calls = 0;
  const api = createCharacterApi({
    apiFetch: async () => {
      calls += 1;
      return json({ error: 'upload exceeds the 20971520 byte limit', code: 'TOO_LARGE' }, 413);
    },
  });

  await assert.rejects(
    () => api.uploadImage('chr_0123456789abcdef', fakeFile('huge.png', 'image/png', new Uint8Array([1]))),
    error => {
      assert.ok(error instanceof CharacterApiError);
      assert.equal(error.status, 413);
      assert.equal(error.code, 'TOO_LARGE');
      assert.match(error.message, /exceeds/);
      return true;
    },
  );

  await assert.rejects(
    () => api.primaryThumb('chr_0123456789abcdef'),
    error => {
      assert.ok(error instanceof CharacterApiError);
      assert.equal(error.status, 413);
      assert.equal(error.code, 'TOO_LARGE');
      return true;
    },
  );

  const before = calls;
  await assert.rejects(
    () => api.getRevision('chr_0123456789abcdef', 0),
    error => {
      assert.ok(error instanceof CharacterApiError);
      assert.equal(error.code, 'INVALID_REVISION');
      return true;
    },
  );
  assert.equal(calls, before, 'an invalid revision never reaches the network');

  assert.throws(() => createCharacterApi(undefined), /apiFetch/);
});
