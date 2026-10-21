// The web package typecheck has no @types/node; node:test imports are only
// for this file's runtime, so type checking is skipped here like panel.test.ts.
// @ts-nocheck
import test from 'node:test';
import assert from 'node:assert/strict';
import { createReferenceApi } from './api.ts';
import {
  ReferenceThumbCache,
  isAuthedThumbUrl,
  renderReferenceCard,
  thumbKey,
  type Reference,
} from './panel.ts';

function reference(id: string, overrides: Partial<Reference> = {}): Reference {
  return {
    id,
    kind: 'image',
    label: `File ${id}`,
    note: '',
    role: 'other',
    bytes: 1024,
    ...overrides,
  };
}

function stubObjectUrls() {
  const originalCreate = URL.createObjectURL;
  const originalRevoke = URL.revokeObjectURL;
  const created: Blob[] = [];
  const revoked: string[] = [];
  let next = 0;
  URL.createObjectURL = blob => {
    created.push(blob);
    next += 1;
    return `blob:thumb-${next}`;
  };
  URL.revokeObjectURL = url => { revoked.push(url); };
  return {
    created,
    revoked,
    restore() {
      URL.createObjectURL = originalCreate;
      URL.revokeObjectURL = originalRevoke;
    },
  };
}

test('loadThumb fetches the /api thumb through the injected apiFetch and returns an object URL', async () => {
  const objectUrls = stubObjectUrls();
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  try {
    const api = createReferenceApi({
      chatId: () => 'chat_abcdefgh',
      apiFetch: async (input, init) => {
        calls.push({ url: String(input), init });
        return new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), {
          status: 200,
          headers: { 'content-type': 'image/png' },
        });
      },
    });

    const url = await api.loadThumb(reference('ref_1', { updatedAt: 'v1' }));

    assert.equal(url, 'blob:thumb-1');
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.url, '/api/chat/chat_abcdefgh/references/ref_1/thumb');
    assert.equal(calls[0]?.init, undefined, 'the host apiFetch adds the auth header');
    assert.equal(objectUrls.created.length, 1);
    assert.ok(objectUrls.created[0] instanceof Blob);
  } finally {
    objectUrls.restore();
  }
});

test('a failed thumb fetch returns undefined and never creates an object URL', async () => {
  const objectUrls = stubObjectUrls();
  try {
    const unauthorized = createReferenceApi({
      chatId: () => 'chat_abcdefgh',
      apiFetch: async () => new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 }),
    });
    assert.equal(await unauthorized.loadThumb(reference('ref_401')), undefined);

    const offline = createReferenceApi({
      chatId: () => 'chat_abcdefgh',
      apiFetch: async () => { throw new Error('network down'); },
    });
    assert.equal(await offline.loadThumb(reference('ref_offline')), undefined);

    const noChat = createReferenceApi({
      chatId: () => null,
      apiFetch: async () => { throw new Error('must not be called'); },
    });
    assert.equal(await noChat.loadThumb(reference('ref_no_chat')), undefined);
    assert.equal(objectUrls.created.length, 0);
  } finally {
    objectUrls.restore();
  }
});

test('non-/api thumb URLs stay direct and are not fetched', async () => {
  const calls: string[] = [];
  const api = createReferenceApi({
    chatId: () => 'chat_abcdefgh',
    apiFetch: async input => {
      calls.push(String(input));
      return new Response(new Uint8Array([1]));
    },
  });

  const data = 'data:image/png;base64,AAAA';
  const blob = 'blob:already-local';
  assert.equal(await api.loadThumb(reference('ref_data', { thumbUrl: data })), data);
  assert.equal(await api.loadThumb(reference('ref_blob', { thumbUrl: blob })), blob);
  assert.deepEqual(calls, []);
});

test('the cache keeps one object URL per reference id and updatedAt', async () => {
  const objectUrls = stubObjectUrls();
  try {
    let loads = 0;
    const cache = new ReferenceThumbCache({
      async loadThumb() {
        loads += 1;
        return `blob:fake-${loads}`;
      },
    });
    const first = reference('ref_a', { updatedAt: 'v1' });

    cache.retain([first]);
    assert.equal(await cache.load(first), 'blob:fake-1');
    assert.equal(await cache.load({ ...first }), 'blob:fake-1', 'a re-render reuses the cached URL');
    assert.equal(loads, 1);
    assert.equal(cache.current(first), 'blob:fake-1');

    const updated = reference('ref_a', { updatedAt: 'v2' });
    cache.retain([updated]);
    assert.deepEqual(objectUrls.revoked, ['blob:fake-1'], 'a replaced card revokes its old URL');
    assert.equal(cache.current(updated), undefined);
    assert.equal(await cache.load(updated), 'blob:fake-2');
    assert.equal(objectUrls.revoked.length, 1);
  } finally {
    objectUrls.restore();
  }
});

test('removing a reference or unmounting the panel revokes its object URLs', async () => {
  const objectUrls = stubObjectUrls();
  try {
    let loads = 0;
    const cache = new ReferenceThumbCache({
      async loadThumb() {
        loads += 1;
        return `blob:fake-${loads}`;
      },
    });
    const card = reference('ref_a', { updatedAt: 'v1' });

    cache.retain([card]);
    assert.equal(await cache.load(card), 'blob:fake-1');
    cache.retain([]);
    assert.deepEqual(objectUrls.revoked, ['blob:fake-1'], 'a deleted card revokes its URL');

    const other = reference('ref_b', { updatedAt: 'v1' });
    cache.retain([other]);
    assert.equal(await cache.load(other), 'blob:fake-2');
    cache.destroy();
    assert.deepEqual(objectUrls.revoked, ['blob:fake-1', 'blob:fake-2'], 'unmount revokes everything');
    assert.equal(objectUrls.revoked.length, 2);
  } finally {
    objectUrls.restore();
  }
});

test('a failed load leaves the card without an object URL so the placeholder stays', async () => {
  const objectUrls = stubObjectUrls();
  try {
    const cache = new ReferenceThumbCache({ loadThumb: async () => undefined });
    const card = reference('ref_broken', {
      thumbUrl: '/api/chat/chat_abcdefgh/references/ref_broken/thumb',
    });
    const html = renderReferenceCard(card, []);
    assert.match(html, /class="ref-thumb-placeholder[^"]*" data-ref-thumb=/);

    cache.retain([card]);
    assert.equal(await cache.load(card), undefined);
    assert.equal(cache.current(card), undefined);
    assert.equal(objectUrls.created.length, 0);
  } finally {
    objectUrls.restore();
  }
});

test('only /api thumbnails render as placeholders; data: and blob: stay as img src', () => {
  assert.equal(isAuthedThumbUrl('/api/chat/chat_abcdefgh/references/ref_1/thumb'), true);
  assert.equal(isAuthedThumbUrl('data:image/png;base64,AAAA'), false);
  assert.equal(isAuthedThumbUrl('blob:local'), false);
  assert.equal(isAuthedThumbUrl(undefined), false);

  const authed = reference('ref_authed', {
    label: 'Authed texture',
    thumbUrl: '/api/chat/chat_abcdefgh/references/ref_authed/thumb',
    updatedAt: 'v7',
  });
  const authedHtml = renderReferenceCard(authed, []);
  assert.ok(!/<img[^>]+src="\/api\//.test(authedHtml));
  assert.match(authedHtml, /data-ref-thumb="\/api\/chat\/chat_abcdefgh\/references\/ref_authed\/thumb"/);
  assert.match(authedHtml, /data-ref-id="ref_authed"/);
  assert.match(authedHtml, /data-ref-updated="v7"/);

  const inline = reference('ref_inline', {
    label: 'Inline texture',
    thumbUrl: 'data:image/png;base64,AAAA',
  });
  const inlineHtml = renderReferenceCard(inline, []);
  assert.match(inlineHtml, /<img src="data:image\/png;base64,AAAA" alt="Inline texture"/);
  assert.ok(!inlineHtml.includes('data-ref-thumb'));

  const local = reference('ref_local', { label: 'Local blob', thumbUrl: 'blob:preview' });
  assert.match(renderReferenceCard(local, []), /<img src="blob:preview" alt="Local blob"/);

  assert.equal(thumbKey(authed), 'ref_authed\u0000v7');
});
