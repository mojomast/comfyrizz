// @ts-nocheck
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CONTEXT_DOCUMENT_MAX_BYTES,
  CONTEXT_DOCUMENT_TOTAL_MAX_BYTES,
  attachmentSignatureFor,
  contextFileError,
  createContextDocumentApi,
  createSuperEasyContextAttachments,
  renderContextAttachmentItems,
  validatePublicHttpUrl,
} from './context-attachments.ts';

function harness(options = {}) {
  let chatId = options.chatId ?? null;
  let videoType = options.videoType ?? null;
  let sequence = 0;
  const media = new Map();
  const documents = new Map();
  const calls = [];
  const changes = [];
  const statuses = [];
  const referenceApi = {
    async list() {
      calls.push({ kind: 'list-media' });
      return { references: options.media ?? [...media.values()], assignments: [] };
    },
    async upload(file) {
      calls.push({ kind: 'upload-media', file });
      if (options.uploadGate) await options.uploadGate(file);
      const record = {
        id: `ref_${++sequence}`,
        kind: String(file.type).startsWith('video/') ? 'video' : String(file.type).startsWith('audio/') || /\.(?:wav|mp3)$/iu.test(file.name) ? 'audio' : 'image',
        label: file.name,
        mime: file.type || (/\.wav$/iu.test(file.name) ? 'audio/wav' : /\.mp3$/iu.test(file.name) ? 'audio/mpeg' : undefined),
        bytes: file.size,
        ...(file.durationSec === undefined ? {} : { durationSec: file.durationSec }),
        usage: 'reference',
        rightsAsserted: true,
      };
      media.set(record.id, record);
      if (options.uploadError) throw new Error(options.uploadError);
      return { reference: record };
    },
    async patch(id, patch) {
      calls.push({ kind: 'patch-media', id, patch });
      const current = media.get(id) ?? options.media?.find(item => item.id === id) ?? {
        id, kind: 'image', label: 'Product.png', usage: 'reference', rightsAsserted: true,
      };
      const next = { ...current, ...patch, revision: (current.revision ?? 1) + 1 };
      if (patch.usage && !patch.editorialScope) delete next.editorialScope;
      media.set(id, next);
      return { reference: next };
    },
    async delete(id) {
      calls.push({ kind: 'delete-media', id });
      media.delete(id);
    },
  };
  const contextApi = {
    async list() {
      calls.push({ kind: 'list-context' });
      return { attachments: options.documents ?? [...documents.values()] };
    },
    async upload(file) {
      calls.push({ kind: 'upload-document', file });
      const record = {
        id: `ctx_${String(++sequence).padStart(16, '0')}`,
        kind: file.name.endsWith('.csv') ? 'csv' : file.name.endsWith('.md') ? 'markdown' : 'text',
        label: file.name,
        bytes: file.size,
        contentHash: `hash-${sequence}`,
        text: 'server-owned text that must not enter persisted web state',
      };
      documents.set(record.id, record);
      return { attachment: record };
    },
    async addUrl(url) {
      calls.push({ kind: 'add-url', url });
      if (options.urlError) throw new Error(options.urlError);
      const record = {
        id: `ctx_${String(++sequence).padStart(16, '0')}`,
        kind: 'url',
        label: 'Quarterly report',
        sourceUrl: url,
        contentHash: `hash-${sequence}`,
        text: 'fetched only by the fake server',
      };
      documents.set(record.id, record);
      return { attachment: record };
    },
    async delete(id) {
      calls.push({ kind: 'delete-context', id });
      documents.delete(id);
    },
  };
  const controller = createSuperEasyContextAttachments({
    referenceApi,
    contextApi,
    chatId: () => chatId,
    async ensureChatId() {
      calls.push({ kind: 'ensure-chat' });
      if (options.ensureChatId) return await options.ensureChatId();
      if (!chatId) chatId = 'chat_context123';
      return chatId;
    },
    videoType: () => videoType,
    attachmentRevision: () => options.revision ?? 0,
    generation: () => options.generation?.() ?? 0,
    onChange: change => changes.push(change),
    onStatus: status => statuses.push(status),
  });
  return {
    controller, calls, changes, statuses, media, documents, referenceApi, contextApi,
    setVideoType: type => { videoType = type; },
    chatId: () => chatId,
  };
}

const image = (name = 'product.png') => ({ name, type: 'image/png', size: 1200 });
const audio = (name = 'song.mp3') => ({ name, type: 'audio/mpeg', size: 2400, durationSec: 240 });

test('Custom requires an explicit image editorial opt-in and can revoke it', async () => {
  const h = harness();
  await h.controller.attachFiles([image('plate.png'), audio()]);
  const [plate, song] = h.controller.snapshot().attachments;
  const html = renderContextAttachmentItems([plate, song], null);
  assert.match(html, /data-super-easy-context-usage="ref_1"/u);
  assert.doesNotMatch(html, /data-super-easy-context-usage="ref_2"/u);
  assert.equal(plate.usage, 'reference');
  assert.equal(await h.controller.setUsage(song.id, true), false);
  assert.equal(await h.controller.setUsage(plate.id, true), true);
  assert.equal(h.controller.snapshot().attachments[0].usage, 'editorial');
  assert.equal(await h.controller.setUsage(plate.id, false), true);
  assert.equal(h.controller.snapshot().attachments[0].usage, 'reference');
});

test('switching image purposes displays a new unchecked opt-in and persists the chosen scope', async () => {
  const h = harness({ videoType: 'music-video' });
  await h.controller.attachFiles([image('plate.png')]);
  const id = h.controller.snapshot().attachments[0].id;
  await h.controller.setUsage(id, true);
  assert.equal(h.controller.snapshot().attachments[0].editorialScope, 'music-video');
  h.setVideoType(null);
  let html = renderContextAttachmentItems(h.controller.snapshot().attachments, null);
  assert.doesNotMatch(html, /data-super-easy-context-usage="ref_1"[^>]* checked/u);
  await h.controller.setUsage(id, true);
  assert.equal(h.controller.snapshot().attachments[0].editorialScope, 'custom');
  h.setVideoType('music-video');
  html = renderContextAttachmentItems(h.controller.snapshot().attachments, 'music-video');
  assert.doesNotMatch(html, /data-super-easy-context-usage="ref_1"[^>]* checked/u);
  h.setVideoType('product-walkthrough');
  html = renderContextAttachmentItems(h.controller.snapshot().attachments, 'product-walkthrough');
  assert.doesNotMatch(html, /data-super-easy-context-usage="ref_1"[^>]* checked/u);
  await h.controller.reload();
  assert.equal(h.controller.snapshot().attachments[0].editorialScope, 'custom');
});

test('render and invalid files create no conversation; a real file attach does', async () => {
  const h = harness();
  assert.equal(h.controller.snapshot().attachments.length, 0);
  assert.equal(h.calls.length, 0, 'constructing the controller has no network or chat side effect');
  assert.equal(await h.controller.attachFiles([{ name: 'bad.svg', type: 'image/svg+xml', size: 10 }]), false);
  assert.equal(await h.controller.attachFiles([{ name: 'unsupported.text', type: 'text/plain', size: 10 }]), false, '.text matches the server by being rejected; use .txt');
  assert.equal(h.calls.some(call => call.kind === 'ensure-chat'), false);
  assert.match(h.controller.snapshot().message, /No supported attachments/u);

  assert.equal(await h.controller.attachFiles([image()]), true);
  assert.equal(h.calls.filter(call => call.kind === 'ensure-chat').length, 1);
  assert.equal(h.chatId(), 'chat_context123');
  const [item] = h.controller.snapshot().attachments;
  assert.equal(item.usage, 'reference');
  assert.equal(item.rightsAsserted, true);
  assert.equal(h.calls.some(call => call.kind === 'patch-media'), false, 'Custom does not add a product role');
  assert.ok(h.changes.at(-1).attachmentSignature.startsWith('ctx_'));
  assert.equal(h.changes.at(-1).attachmentRevision, 1);
  assert.ok(h.statuses.some(status => /queued/u.test(status.message)));
  assert.ok(h.statuses.some(status => /Uploading product\.png/u.test(status.message)));
});

test('Product Walkthrough uploads use product/reference and editorial is an explicit reversible opt-in', async () => {
  const h = harness({ videoType: 'product-walkthrough' });
  await h.controller.attachFiles([image()]);
  const [item] = h.controller.snapshot().attachments;
  assert.deepEqual(h.calls.find(call => call.kind === 'patch-media').patch, { role: 'product', usage: 'reference' });
  assert.equal(item.role, 'product');
  assert.equal(item.usage, 'reference');
  assert.equal(item.rightsAsserted, true);

  const before = h.controller.snapshot().attachmentSignature;
  assert.equal(await h.controller.setUsage(item.id, true), true);
  assert.equal(h.controller.snapshot().attachments[0].usage, 'editorial');
  assert.deepEqual(h.calls.filter(call => call.kind === 'patch-media').at(-1).patch, { usage: 'editorial', editorialScope: 'product-walkthrough' });
  assert.notEqual(h.controller.snapshot().attachmentSignature, before);
  assert.equal(await h.controller.setUsage(item.id, false), true);
  assert.equal(h.controller.snapshot().attachments[0].usage, 'reference');
  assert.deepEqual(h.calls.filter(call => call.kind === 'patch-media').at(-1).patch, { usage: 'reference' });
});

test('Music Video audio and image uploads get editorial roles but stay reference-only by default', async () => {
  const h = harness({ videoType: 'music-video' });
  await h.controller.attachFiles([audio(), image('performer.png')]);
  const [song, performer] = h.controller.snapshot().attachments;
  assert.equal(song.kind, 'audio');
  assert.equal(song.role, 'song');
  assert.equal(song.durationSec, 240);
  assert.equal(song.usage, 'reference');
  assert.equal(song.rightsAsserted, true);
  assert.equal(performer.role, 'subject');
  assert.equal(performer.usage, 'reference');
  assert.deepEqual(h.calls.filter(call => call.kind === 'patch-media').map(call => call.patch), [
    { role: 'song', usage: 'reference' },
    { role: 'subject', usage: 'reference' },
  ]);

  const initialHtml = renderContextAttachmentItems(h.controller.snapshot().attachments, 'music-video');
  assert.match(initialHtml, /Audio · 4:00/u);
  assert.match(initialHtml, /Use as song master/u);
  assert.match(initialHtml, /Use as performer reference/u);
  assert.doesNotMatch(initialHtml, /<img/iu, 'audio metadata is a card, never a fake image thumbnail');

  const before = h.controller.snapshot().attachmentSignature;
  assert.equal(await h.controller.setUsage(song.id, true), true);
  assert.notEqual(h.controller.snapshot().attachmentSignature, before);
  assert.equal(await h.controller.setUsage(performer.id, true), true);
  assert.equal(h.controller.snapshot().attachments.find(item => item.id === song.id).usage, 'editorial');
  assert.match(renderContextAttachmentItems(h.controller.snapshot().attachments, 'music-video'), /Performance is an experimental reviewed audition/u);
});

test('Music Video permits one editorial song and never silently replaces the selected master', async () => {
  const h = harness({ videoType: 'music-video' });
  await h.controller.attachFiles([audio('first.mp3'), audio('second.wav')]);
  const [first, second] = h.controller.snapshot().attachments;
  assert.equal(await h.controller.setUsage(first.id, true), true);
  const before = h.controller.snapshot().attachmentSignature;
  const patches = h.calls.length;
  assert.equal(await h.controller.setUsage(second.id, true), false);
  assert.equal(h.calls.length, patches, 'the conflicting selection is rejected before a server patch');
  assert.equal(h.controller.snapshot().attachments.find(item => item.id === first.id).usage, 'editorial');
  assert.equal(h.controller.snapshot().attachments.find(item => item.id === second.id).usage, 'reference');
  assert.equal(h.controller.snapshot().attachmentSignature, before);
  assert.match(h.controller.snapshot().message, /Only one song master.*not replaced/u);

  assert.equal(await h.controller.setUsage(first.id, false), true);
  assert.equal(await h.controller.setUsage(second.id, true), true);
});

test('Music Video videos have no editorial control and audio limits fail before upload', async () => {
  const h = harness({ videoType: 'music-video' });
  await h.controller.attachFiles([{ name: 'dance.mp4', type: 'video/mp4', size: 1200 }]);
  const [video] = h.controller.snapshot().attachments;
  assert.equal(video.usage, 'reference');
  assert.equal(h.calls.some(call => call.kind === 'patch-media'), false);
  assert.doesNotMatch(renderContextAttachmentItems([video], 'music-video'), /data-super-easy-context-usage/u);
  assert.equal(await h.controller.setUsage(video.id, true), false);
  assert.match(h.controller.snapshot().message, /Videos stay reference-only/u);

  const calls = h.calls.length;
  assert.equal(await h.controller.attachFiles([{ name: 'huge.mp3', type: 'audio/mpeg', size: 100 * 1024 * 1024 + 1 }]), false);
  assert.equal(await h.controller.attachFiles([{ ...audio('long.wav'), type: 'audio/wav', durationSec: 301 }]), false);
  assert.equal(h.calls.length, calls, 'size and known duration prechecks make no request');
});

test('media without persisted rights evidence cannot opt into output footage', async () => {
  const h = harness({
    chatId: 'chat_context123',
    videoType: 'product-walkthrough',
    media: [{ id: 'ref_unsafe', kind: 'image', label: 'Unlicensed.png', usage: 'reference', rightsAsserted: false }],
  });
  await h.controller.reload();
  assert.equal(await h.controller.setUsage('ref_unsafe', true), false);
  assert.equal(h.calls.some(call => call.kind === 'patch-media'), false);
  assert.match(h.controller.snapshot().message, /no recorded rights assertion/u);
  const html = renderContextAttachmentItems(h.controller.snapshot().attachments, 'product-walkthrough');
  assert.match(html, /data-super-easy-context-usage="ref_unsafe"[^>]*disabled/u);
  assert.match(html, /aria-label="Use Unlicensed\.png in video"/u);
  assert.match(html, /Reference only · no recorded rights assertion/u);
});

test('other video types render Reference only instead of an editorial control', async () => {
  const h = harness({ videoType: 'motion-explainer' });
  await h.controller.attachFiles([image()]);
  const html = renderContextAttachmentItems(h.controller.snapshot().attachments, 'motion-explainer');
  assert.match(html, /Reference only/u);
  assert.doesNotMatch(html, /data-super-easy-context-usage/u);
  assert.equal(await h.controller.setUsage(h.controller.snapshot().attachments[0].id, true), false);
});

test('URL fetching happens only for an explicit valid Add URL operation', async () => {
  const h = harness();
  assert.equal(validatePublicHttpUrl('http://127.0.0.1/private'), null);
  assert.equal(validatePublicHttpUrl('http://localhost:8080/private'), null);
  assert.equal(validatePublicHttpUrl('https://user:pass@example.com/private'), null);
  assert.equal(validatePublicHttpUrl('file:///tmp/private'), null);
  assert.equal(validatePublicHttpUrl('https://example.com/report'), 'https://example.com/report');

  assert.equal(await h.controller.addUrl('http://192.168.1.4/private'), false);
  assert.equal(h.calls.length, 0, 'invalid URLs neither create a conversation nor fetch');
  assert.equal(await h.controller.addUrl('https://example.com/report'), true);
  assert.deepEqual(h.calls.filter(call => call.kind === 'add-url').map(call => call.url), ['https://example.com/report']);
  assert.equal(h.controller.snapshot().attachments[0].label, 'Quarterly report');
  assert.equal(h.controller.snapshot().attachments[0].url, 'https://example.com/report');
  assert.ok(h.statuses.some(status => /Fetching https:\/\/example\.com\/report/u.test(status.message)));
  assert.equal(Object.hasOwn(h.controller.snapshot().attachments[0], 'text'), false);
});

test('document upload and reload preserve labels/content identity without storing document text', async () => {
  const h = harness({ chatId: 'chat_context123' });
  await h.controller.attachFiles([{ name: 'brief.md', type: 'text/markdown', size: 42 }]);
  assert.equal(h.controller.snapshot().attachments[0].kind, 'markdown');
  assert.equal(h.controller.snapshot().attachments[0].contentHash, 'hash-1');
  assert.equal(Object.hasOwn(h.controller.snapshot().attachments[0], 'text'), false);
  assert.equal(contextFileError({ name: 'huge.txt', type: 'text/plain', size: CONTEXT_DOCUMENT_MAX_BYTES + 1 }) !== null, true);

  h.controller.reset();
  await h.controller.reload();
  assert.deepEqual(h.calls.filter(call => ['list-media', 'list-context'].includes(call.kind)).map(call => call.kind), ['list-media', 'list-context']);
  assert.equal(h.controller.snapshot().attachments.length, 1);
  assert.equal(h.controller.snapshot().attachmentRevision, 0, 'hydration alone does not invent a mutation');
});

test('every server-supported document extension and upload MIME combination is accepted', async () => {
  for (const extension of ['md', 'markdown', 'txt', 'csv']) {
    for (const type of ['', 'text/plain', 'text/markdown', 'text/csv']) {
      const h = harness();
      const file = { name: `brief.${extension}`, type, size: 42 };
      assert.equal(contextFileError(file), null, `${file.name} with ${type || 'no MIME'}`);
      assert.equal(await h.controller.attachFiles([file]), true);
      assert.deepEqual(h.calls.filter(call => call.kind === 'upload-document').map(call => call.file.name), [file.name]);
    }
  }
});

test('extensionless, alias and unsupported-MIME documents are rejected before conversation or upload', async () => {
  const rejected = [
    ...['text/plain', 'text/markdown', 'text/csv'].map(type => ({ name: 'brief', type, size: 42 })),
    { name: 'brief.text', type: 'text/plain', size: 42 },
    { name: 'brief.md', type: 'text/x-markdown', size: 42 },
    { name: 'brief.csv', type: 'application/csv', size: 42 },
    { name: 'brief.txt', type: 'application/octet-stream', size: 42 },
  ];
  for (const file of rejected) {
    const h = harness();
    assert.notEqual(contextFileError(file), null, `${file.name} with ${file.type}`);
    assert.equal(await h.controller.attachFiles([file]), false);
    assert.deepEqual(h.calls, []);
  }
});

test('document batches precheck the cumulative 1 MiB context cap before mocked uploads', async () => {
  const h = harness({
    chatId: 'chat_context123',
    documents: [{ id: 'ctx_ffffffffffffffff', kind: 'text', label: 'existing.txt', bytes: 768 * 1024, contentHash: 'existing' }],
  });
  await h.controller.reload();
  const accepted = await h.controller.attachFiles([
    { name: 'one.txt', type: 'text/plain', size: 128 * 1024 },
    { name: 'two.md', type: 'text/markdown', size: 128 * 1024 },
    { name: 'overflow.csv', type: 'text/csv', size: 1 },
  ]);
  assert.equal(accepted, true);
  assert.deepEqual(h.calls.filter(call => call.kind === 'upload-document').map(call => call.file.name), ['one.txt', 'two.md']);
  assert.equal(h.controller.snapshot().attachments.reduce((sum, item) => sum + (item.bytes ?? 0), 0), CONTEXT_DOCUMENT_TOTAL_MAX_BYTES);
  assert.match(h.controller.snapshot().pending.find(item => item.name === 'overflow.csv')?.error ?? '', /1 MiB/u);

  const calls = h.calls.length;
  assert.equal(await h.controller.attachFiles([{ name: 'later.txt', type: 'text/plain', size: 1 }]), false);
  assert.equal(h.calls.length, calls, 'a later cumulative overflow makes no conversation or upload request');
});

test('deferred conversation creation and upload cannot commit across a generation reset', async () => {
  let generation = 0;
  let releaseConversation;
  const conversation = new Promise(resolve => { releaseConversation = resolve; });
  const first = harness({ generation: () => generation, ensureChatId: () => conversation });
  const attaching = first.controller.attachFiles([image()]);
  generation += 1;
  first.controller.reset();
  releaseConversation('chat_oldproject');
  assert.equal(await attaching, false);
  assert.equal(first.calls.some(call => call.kind === 'upload-media'), false);
  assert.equal(first.controller.snapshot().attachments.length, 0);
  assert.equal(first.controller.snapshot().attachmentSignature, null);
  assert.equal(first.controller.snapshot().pending.length, 0);

  let releaseUpload;
  const second = harness({
    chatId: 'chat_context123',
    generation: () => generation,
    uploadGate: () => new Promise(resolve => { releaseUpload = resolve; }),
  });
  const uploading = second.controller.attachFiles([image('late.png')]);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(second.calls.some(call => call.kind === 'upload-media'), true);
  generation += 1;
  second.controller.reset();
  releaseUpload();
  assert.equal(await uploading, false);
  assert.equal(second.controller.snapshot().attachments.length, 0);
  assert.equal(second.controller.snapshot().attachmentSignature, null);
  assert.equal(second.controller.snapshot().pending.length, 0);
});

test('context reload restores audio metadata, role, editorial usage and a stable signature', async () => {
  const h = harness({
    chatId: 'chat_context123',
    videoType: 'music-video',
    media: [{
      id: 'ref_song', kind: 'audio', label: 'Master.wav', mime: 'audio/wav', bytes: 4800,
      durationSec: 212.5, role: 'song', usage: 'editorial', rightsAsserted: true, revision: 4,
    }],
  });
  await h.controller.reload();
  const loaded = h.controller.snapshot();
  assert.equal(loaded.attachmentRevision, 0);
  assert.deepEqual(loaded.attachments[0], {
    id: 'ref_song', source: 'media', kind: 'audio', label: 'Master.wav', mime: 'audio/wav', bytes: 4800,
    durationSec: 212.5, role: 'song', usage: 'editorial', rightsAsserted: true, revision: 4,
  });
  const signature = loaded.attachmentSignature;
  h.controller.reset();
  assert.equal(h.controller.snapshot().attachmentSignature, null);
  await h.controller.reload();
  assert.equal(h.controller.snapshot().attachmentSignature, signature);
  assert.match(renderContextAttachmentItems(h.controller.snapshot().attachments, 'music-video'), /Audio · 3:33/u);
  assert.match(renderContextAttachmentItems(h.controller.snapshot().attachments, 'music-video'), /data-super-easy-context-usage="ref_song"[^>]*checked/u);
});

test('removal uses the owning collection and clears the persisted signature', async () => {
  const h = harness();
  await h.controller.attachFiles([image()]);
  const [item] = h.controller.snapshot().attachments;
  assert.ok(h.controller.snapshot().attachmentSignature);
  assert.equal(await h.controller.remove('media', item.id), true);
  assert.deepEqual(h.calls.filter(call => call.kind === 'delete-media').map(call => call.id), [item.id]);
  assert.equal(h.controller.snapshot().attachments.length, 0);
  assert.equal(h.controller.snapshot().attachmentSignature, null);
  assert.equal(h.controller.snapshot().attachmentRevision, 2);
});

test('attachment signatures are stable, media/text-free and sensitive to notes and usage', () => {
  const item = {
    id: 'ref_1', source: 'media', kind: 'image', label: 'Product', usage: 'reference', rightsAsserted: true, note: 'front',
  };
  const first = attachmentSignatureFor([item]);
  assert.equal(first, attachmentSignatureFor([{ ...item }]));
  assert.notEqual(first, attachmentSignatureFor([{ ...item, note: 'back' }]));
  assert.notEqual(first, attachmentSignatureFor([{ ...item, usage: 'editorial' }]));
  assert.notEqual(first, attachmentSignatureFor([{ ...item, kind: 'audio', durationSec: 200 }]));
  assert.notEqual(first, attachmentSignatureFor([{ ...item, mime: 'audio/mpeg', bytes: 4000 }]));
  assert.equal(JSON.stringify(first).includes('front'), false);
  assert.equal(attachmentSignatureFor([]), null);
});

test('context document API uses raw text, X-Filename, explicit URL JSON and authenticated chat paths', async () => {
  const calls = [];
  let chatId = 'chat_context123';
  let ensures = 0;
  const api = createContextDocumentApi({
    chatId: () => chatId,
    ensureChatId: async () => { ensures += 1; return chatId; },
    apiFetch: async (input, init = {}) => {
      calls.push({ input, init });
      return Response.json({ attachment: { id: 'ctx_0123456789abcdef', kind: 'text', label: 'brief.md' } });
    },
  });
  await api.list();
  assert.equal(ensures, 0);
  const file = new Blob(['# Brief'], { type: 'text/markdown' });
  Object.defineProperty(file, 'name', { value: 'brief.md' });
  await api.upload(file);
  const upload = calls[1];
  assert.equal(upload.input, '/api/chat/chat_context123/context-attachments/file');
  assert.equal(upload.init.method, 'POST');
  assert.equal(upload.init.headers['content-type'], 'text/markdown');
  assert.equal(upload.init.headers['x-filename'], 'brief.md');
  assert.equal(upload.init.body, file, 'raw Blob, never base64');

  await api.addUrl('https://example.com/brief');
  assert.deepEqual(JSON.parse(calls[2].init.body), { url: 'https://example.com/brief' });
  assert.equal(calls[2].input, '/api/chat/chat_context123/context-attachments/url');
  await api.delete('ctx_0123456789abcdef');
  assert.equal(calls[3].input, '/api/chat/chat_context123/context-attachments/ctx_0123456789abcdef');
  assert.equal(calls[3].init.method, 'DELETE');
  assert.equal(ensures, 2, 'only upload and explicit Add URL ensure the conversation');
});
