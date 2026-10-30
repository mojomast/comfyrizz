// @ts-nocheck
import test from 'node:test';
import assert from 'node:assert/strict';
import { assetDetailMarkup, createAssetInspector } from './asset-detail.ts';
import { readGalleryAssetDetails, safeGalleryUrl } from './gallery-asset.ts';
import { buildGalleryModel } from './gallery-model.ts';
import { superEasyProgressParts } from './progress-view.ts';
import { mergeLiveGallery } from './live-gallery.ts';

test('canonical details preserve exact prompt and numeric zero, excluding provider payloads and private values', () => {
  const prompt = '  Wide shot.\nMove slowly <toward> the red door.  ';
  const details = readGalleryAssetDetails({ prompt, model: 'flux-3-klein', seed: 0, width: 1920, height: 1088,
    workflow: 'workflows/flux3_klein_t2i.api.json', payload: { apiKey: 'NEVER' }, file: '/home/person/private.png' });
  assert.equal(details.prompt, prompt);
  assert.equal(details.seed, 0);
  assert.equal(details.payload, undefined);
  assert.equal(details.file, undefined);
  const html = assetDetailMarkup({ id: 'shot:s1', label: 'Shot 1', kind: 'shot', state: 'loading', details });
  assert.match(html, /Move slowly &lt;toward&gt;/u);
  assert.match(html, /<dt>Seed<\/dt><dd>0<\/dd>/u);
  assert.match(html, /flux-3-klein/u);
  assert.doesNotMatch(html, /NEVER|private.png/u);
  const unsafe = readGalleryAssetDetails({ prompt: 'token=SECRET /tmp/private/file https://user:pass@host/file?key=abc Bearer secret-token' });
  assert.doesNotMatch(unsafe.prompt, /SECRET|\/tmp|user:pass|secret-token/u);
});

test('rejects unsafe, credential-bearing and protocol-relative URLs', () => {
  for (const url of ['javascript:alert(1)', 'file:///tmp/a', '//other.test/file', '/\\evil.test', 'https://user:pass@host/a', '/api/file?token=SECRET', '/api/file?t%6fken=SECRET', '/home/private/media.png', 'data:image/svg+xml,<svg/>']) assert.equal(safeGalleryUrl(url), null, url);
  assert.equal(safeGalleryUrl('/api/media/opaque-ticket'), '/api/media/opaque-ticket');
});

test('ten-shot refresh discovers all previews and canonical metadata changes invalidate slots', () => {
  const snapshot = ready => ({ shots: Array.from({ length: 10 }, (_, index) => ({
    id: `s${index + 1}`, status: 'generating', url: ready || index === 0 || index === 7 ? `/api/assets/ref-${index + 1}` : null,
    details: { sceneId: `s${index + 1}`, assetId: `ref-${index + 1}`, role: 'reference', mediaType: 'image', status: 'ready', prompt: `Exact reference ${index + 1}`, model: 'flux-3-klein' },
  })) });
  const before = superEasyProgressParts(snapshot(false)), after = superEasyProgressParts(snapshot(true));
  assert.equal((before.galleryHtml.match(/data-gallery-media=/gu) ?? []).length, 2);
  assert.equal((after.galleryHtml.match(/data-gallery-media=/gu) ?? []).length, 10);
  assert.equal(after.finalReady, false);
  assert.equal(buildGalleryModel(snapshot(true)).items.filter(item => item.kind === 'shot' && item.state === 'loading').length, 10);
  const revised = snapshot(true); revised.shots[2].details.prompt = 'Changed prompt';
  assert.notEqual(after.gallerySlots[2].key, superEasyProgressParts(revised).gallerySlots[2].key);
  assert.match(after.galleryHtml, /Conditioning reference · not a generated clip/u);
});

test('generation details are read only from canonical records, not legacy alias/provider containers', () => {
  const model = buildGalleryModel({ shots: [{ id: 's1', metadata: { prompt: 'invented', model: 'wrong', details: { prompt: 'also wrong' } } }],
    events: [{ type: 'shot.updated', data: { shotId: 's1', details: { prompt: 'untrusted' } } }] });
  assert.equal(model.items[0].details, undefined);
  assert.match(assetDetailMarkup(model.items[0]), /Not recorded/u);
});

test('opaque authenticated media uses its canonical type and live URL-only polling preserves metadata binding', () => {
  const snapshot = { shots: [{ id: 's1', status: 'ready', url: '/api/media/opaque', details: {
    role: 'generated', mediaType: 'video', assetId: 'video-1', prompt: 'Actual video prompt', model: 'ltx-2.5',
  } }] };
  const gallery = buildGalleryModel(snapshot);
  assert.match(superEasyProgressParts(snapshot).gallerySlots[0].html, /<video/u);
  assert.doesNotMatch(superEasyProgressParts(snapshot).gallerySlots[0].html, /<img/u);
  const result = mergeLiveGallery(gallery, [{ ...gallery.items[0], url: '/api/media/older-ticket', details: undefined }]);
  assert.equal(result.items[0].url, '/api/media/opaque');
  assert.equal(result.items[0].details.prompt, 'Actual video prompt');
});

test('audio metadata is canonical and late media from a previous authenticated scope is discarded', async () => {
  let gallery = buildGalleryModel({ voices: [{ id: 'v1', status: 'ready', url: '/api/audio/one', details: { mediaType: 'audio', model: 'kokoro', prompt: 'Exact narration.' } }] });
  assert.equal(gallery.items[0].details.model, 'kokoro');
  assert.match(assetDetailMarkup(gallery.items[0]), /Exact narration\./u);
  let scope = 'invite-a', resolveResponse;
  let signal, creations = 0;
  const original = URL.createObjectURL;
  URL.createObjectURL = () => { creations++; return 'blob:late'; };
  const node = { isConnected: true, src: '', getAttribute: () => gallery.items[0].id, setAttribute() {} };
  let nodes = [node];
  const root = { ownerDocument: { baseURI: 'https://gallery.test/' }, querySelectorAll: () => nodes, addEventListener() {}, removeEventListener() {} };
  const inspector = createAssetInspector({ root, gallery: () => gallery, scope: () => scope, fetch: (_url, init) => { signal = init.signal; return new Promise(resolve => { resolveResponse = resolve; }); } });
  try {
    inspector.sync();
    scope = 'invite-b'; gallery = buildGalleryModel(null); nodes = []; inspector.sync();
    assert.equal(signal.aborted, true);
    resolveResponse(new Response(new Blob(['private audio'], { type: 'audio/wav' })));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(creations, 0);
    assert.equal(node.src, '');
  } finally { inspector.destroy(); URL.createObjectURL = original; }
});
