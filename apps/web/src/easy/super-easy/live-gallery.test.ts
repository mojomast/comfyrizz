import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildGalleryModel } from './gallery-model.ts';
import type { ClipSummary } from '../../takes/api.ts';
import { createLiveAssetGallery, mergeLiveGallery } from './live-gallery.ts';

const clip = (state: ClipSummary['state'] = 'generating'): ClipSummary => ({
  clipId: 'clip-1', sceneId: 's_01', assetId: 'a_shot', slot: 'plate', kind: 'plate',
  from: 0, durationInFrames: 48, state, selected: null, selectedN: null,
  takeCount: state === 'review' ? 1 : 0, newTakes: 0, lastJob: null, queued: false,
});

function fakeApi(state: ClipSummary['state'] = 'review') {
  const calls: string[] = [];
  return {
    calls,
    async listClips() { calls.push('clips'); return { packageId: 'pkg', revision: 1, clips: [clip(state)] }; },
    async getTakes() {
      calls.push('takes');
      return {
        packageId: 'pkg', revision: 1, clip: clip('review'), assetId: 'a_shot', selected: 'take-1',
        takes: [{ takeId: 'take-1', assetId: 'a_shot', n: 1, file: 'a.mp4', sha256: 'abc', bytes: 100, media: {}, gen: {}, createdAt: 'now', verdict: 'unreviewed' as const }],
        history: [], lastJob: null, queued: null,
      };
    },
    async takeTicket(_pkg: string, _clip: string, takeId: string) {
      calls.push('ticket');
      return { kind: 'ticket' as const, takeId, ticket: 'secret', url: '/api/media/ticket', expiresAt: new Date(Date.now() + 300_000).toISOString() };
    },
  };
}

test('live gallery merges actual take media and keeps final ownership', () => {
  const base = buildGalleryModel({ shotIds: ['s_01'], finalVideo: { url: 'blob:final', status: 'ready' } });
  const merged = mergeLiveGallery(base, [{ id: 'shot:s_01', kind: 'shot', label: 'Shot 1', state: 'ready', url: '/api/media/ticket', reason: null, highlighted: false, index: 0 }]);
  assert.equal(merged.items[0].url, '/api/media/ticket');
  assert.equal(merged.final.url, 'blob:final');
  assert.equal(merged.states.ready, 2);
});

test('live gallery collects only landed media and caches short-lived tickets', async () => {
  const api = fakeApi();
  let items: unknown[] = [];
  const gallery = createLiveAssetGallery({ api, onUpdate: next => { items = next; }, pollMs: 60000 });
  gallery.start('pkg');
  await gallery.refresh();
  assert.deepEqual(items[0], { id: 'shot:s_01', kind: 'shot', label: 'Shot 1', state: 'ready', url: '/api/media/ticket', reason: null, highlighted: false, index: 0 });
  await gallery.refresh();
  assert.deepEqual(api.calls.filter(call => call === 'ticket'), ['ticket']);
  gallery.stop();
});

test('landed visual references pop into the live gallery before final collection', async () => {
  const api = fakeApi('generating');
  api.listClips = async () => ({
    packageId: 'pkg', revision: 1, clips: [clip('generating')],
    references: [{ assetId: 'a_character_ref', takeId: 'take-ref', kind: 'image', state: 'review' }],
  });
  let items: any[] = [];
  const gallery = createLiveAssetGallery({ api, onUpdate: next => { items = next; }, pollMs: 60000 });
  gallery.start('pkg');
  await gallery.refresh();
  assert.equal(items[0].id, 'character:a_character_ref');
  assert.equal(items[0].kind, 'character');
  assert.equal(items[0].state, 'ready');
  assert.equal(items[0].url, '/api/media/ticket');
  assert.equal(items[1].state, 'loading');
  gallery.stop();
});

test('a planned clip is pending and no take or ticket request is made', async () => {
  const api = fakeApi('generating');
  let items: any[] = [];
  const gallery = createLiveAssetGallery({ api, onUpdate: next => { items = next; }, pollMs: 60000 });
  gallery.start('pkg');
  await gallery.refresh();
  assert.equal(items[0].state, 'loading');
  assert.equal(items[0].url, null);
  assert.deepEqual(api.calls, ['clips']);
  gallery.stop();
});

test('late results from a previous package cannot publish after stop', async () => {
  let resolve: ((value: any) => void) | null = null;
  let published = false;
  const gallery = createLiveAssetGallery({
    api: {
      listClips: () => new Promise(next => { resolve = next; }),
      getTakes: async () => { throw new Error('not expected'); },
      takeTicket: async () => { throw new Error('not expected'); },
    },
    onUpdate: () => { published = true; },
  });
  gallery.start('pkg');
  gallery.stop();
  const finish = resolve as ((value: any) => void) | null;
  finish?.({ packageId: 'pkg', revision: 1, clips: [clip('review')] });
  await new Promise(next => setTimeout(next, 0));
  assert.equal(published, false);
});
