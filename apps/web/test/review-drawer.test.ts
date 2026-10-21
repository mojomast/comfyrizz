// The web package typecheck has no @types/node; node:test imports are runtime
// only, like the other web tests that use node:test.
// @ts-nocheck
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  REVIEW_ROW_HEIGHT,
  ReviewDrawerModel,
  clipNeedsReview,
  createReviewDrawerModel,
  filterReviewClips,
  renderReviewDrawer,
  renderReviewRows,
  reviewCounts,
  reviewGroupFor,
  reviewRows,
  shortClipId,
  takeProgressLabel,
  windowRange,
} from '../src/takes/review-drawer.ts';
import { approvedPillLabel, renderRenderBar, summarizeGate } from '../src/takes/render-bar.ts';

function clip(n: number, overrides: Record<string, unknown> = {}) {
  const id = `ep2_video_a${String(n).padStart(2, '0')}`;
  return {
    clipId: id,
    sceneId: `s${Math.ceil(n / 4)}`,
    assetId: `a_${n}`,
    slot: n % 2 === 0 ? 'background' : 'presenter',
    kind: n % 2 === 0 ? 'plate' : 'presenter',
    from: (n - 1) * 90,
    durationInFrames: 90,
    state: 'review',
    selected: `tk_${String(n).repeat(12)}`,
    selectedN: 2,
    takeCount: 4,
    newTakes: 0,
    lastJob: null,
    queued: false,
    ...overrides,
  };
}

function clips(count: number, overrides: Record<string, unknown> = {}) {
  return Array.from({ length: count }, (_, index) => clip(index + 1, overrides));
}

test('one top-bar pill summarises 48 clips and renders no per-clip chips', () => {
  const list = clips(48);
  const gate = summarizeGate(list);
  const html = renderRenderBar(gate);

  assert.equal(gate.approved, 0);
  assert.equal(gate.total, 48);
  assert.match(html, /0\/48 approved/);
  assert.equal((html.match(/data-render-approved/g) ?? []).length, 1);
  assert.equal((html.match(/data-render-blocker/g) ?? []).length, 0);
  assert.equal((html.match(/data-render-run/g) ?? []).length, 0);
  assert.equal((html.match(/data-render-open-override/g) ?? []).length, 0);
  assert.match(html, /aria-controls="review-drawer"/);
  assert.match(html, /aria-keyshortcuts="R"/);
  assert.equal(approvedPillLabel(gate), '0/48 approved');
});

test('the drawer keeps every render-bar hook inside the drawer', () => {
  const blocked = renderReviewDrawer(clips(48), { open: true });
  assert.match(blocked, /id="review-drawer"/);
  assert.match(blocked, /data-review-drawer/);
  assert.match(blocked, /data-render-blocker="ep2_video_a01"/);
  assert.match(blocked, /data-render-open-override/);
  assert.match(blocked, /data-render-override/);
  assert.doesNotMatch(blocked, /data-render-run/);

  const approved = clips(3, { state: 'approved' });
  const ready = renderReviewDrawer(approved, { filter: 'approved', open: true });
  assert.match(ready, /data-render-run/);
  assert.doesNotMatch(ready, /data-render-open-override/);
  assert.match(renderRenderBar(summarizeGate(approved)), /data-render-ready/);
});

test('filters, search and sort keep timeline order and status grouping', () => {
  const list = [
    clip(4, { state: 'failed' }),
    clip(1, { state: 'review' }),
    clip(3, { state: 'stale' }),
    clip(2, { state: 'approved' }),
    clip(5, { state: 'review', sceneId: 'intro' }),
  ];

  assert.deepEqual(reviewCounts(list), { needs: 2, stale: 1, approved: 1, failed: 1, total: 5 });
  assert.equal(reviewGroupFor('rejected'), 'failed');
  assert.equal(clipNeedsReview(list[1]), true);
  assert.equal(clipNeedsReview(list[2]), false);

  assert.deepEqual(
    filterReviewClips(list, { filter: 'needs' }).map(item => item.clipId),
    ['ep2_video_a01', 'ep2_video_a05'],
  );
  assert.deepEqual(
    filterReviewClips(list, { filter: 'needs', query: 'intro' }).map(item => item.clipId),
    ['ep2_video_a05'],
  );
  assert.deepEqual(
    filterReviewClips(list, { filter: 'needs', query: 'presenter' }).map(item => item.clipId),
    ['ep2_video_a01', 'ep2_video_a05'],
  );
  assert.deepEqual(
    filterReviewClips(list, { filter: 'needs', sort: 'status' }).map(item => item.clipId),
    ['ep2_video_a01', 'ep2_video_a05'],
  );
});

test('rows use a 64x36 thumbnail contract, a short id with the full title and take n/m', () => {
  const row = reviewRows([clip(7)])[0];
  assert.equal(row.fullId, 'ep2_video_a07');
  assert.equal(row.shortId, 'ep2_video_a07');
  assert.equal(row.scene, 's2');
  assert.equal(row.statusLabel, 'Needs review');
  assert.equal(row.takeLabel, 'take 2/4');
  assert.equal(shortClipId('scene:a_really_long_asset_identifier'), 'a_really_l…tifier');
  assert.equal(takeProgressLabel(clip(1, { takeCount: 0 })), 'no takes');

  const html = renderReviewRows([row], { activeId: row.clipId });
  assert.match(html, /class="review-thumb"/);
  assert.match(html, /title="ep2_video_a07"/);
  assert.match(html, /role="option"/);
  assert.match(html, /aria-selected="true"/);
  assert.match(html, /tabindex="0"/);
  assert.match(html, /data-render-blocker="ep2_video_a07"/);
  assert.match(html, /take 2\/4/);
});

test('windowed rows keep a fixed height and only render the visible slice', () => {
  const view = windowRange(48, 0, 480, REVIEW_ROW_HEIGHT, 4);
  assert.equal(view.total, 48);
  assert.equal(view.start, 0);
  assert.equal(view.end, 14);
  assert.equal(view.top, 0);
  assert.equal(view.bottom, (48 - 14) * REVIEW_ROW_HEIGHT);

  const scrolled = windowRange(48, REVIEW_ROW_HEIGHT * 20, 480, REVIEW_ROW_HEIGHT, 4);
  assert.equal(scrolled.start, 16);
  assert.equal(scrolled.top, 16 * REVIEW_ROW_HEIGHT);
  assert.ok(scrolled.end < 48);
});

test('keyboard A approves and advances focus to the next clip needing review', async () => {
  const list = [clip(1), clip(2), clip(3)];
  const approved: string[] = [];
  const model = createReviewDrawerModel({
    clips: list,
    onApprove: async item => { approved.push(item.clipId); },
  });

  assert.equal(model.activeId, 'ep2_video_a01');
  assert.equal(await model.handleKey('a'), true);
  assert.deepEqual(approved, ['ep2_video_a01']);
  assert.equal(model.clips[0].state, 'approved');
  assert.equal(model.activeId, 'ep2_video_a02');
  assert.equal(model.liveMessage, 'Approved 1/3');
  assert.deepEqual(model.counts, { needs: 2, stale: 0, approved: 1, failed: 0, total: 3 });

  assert.equal(await model.handleKey('j'), true);
  assert.equal(model.activeId, 'ep2_video_a03');
  assert.equal(await model.handleKey('arrowup'), true);
  assert.equal(model.activeId, 'ep2_video_a02');
});

test('J/K and arrows move, D redoes, Enter opens Takes only in Advanced, and inputs suppress letters', async () => {
  const redone: string[] = [];
  const opened: string[] = [];
  const model = new ReviewDrawerModel({
    clips: [clip(1), clip(2)],
    onRedo: item => { redone.push(item.clipId); },
    onOpenTakes: clipId => { opened.push(clipId); },
    getMode: () => 'advanced',
  });

  assert.equal(await model.handleKey('j'), true);
  assert.equal(model.activeId, 'ep2_video_a02');
  assert.equal(await model.handleKey('k'), true);
  assert.equal(model.activeId, 'ep2_video_a01');
  assert.equal(await model.handleKey('arrowdown'), true);
  assert.equal(model.activeId, 'ep2_video_a02');

  assert.equal(await model.handleKey('d'), true);
  assert.deepEqual(redone, ['ep2_video_a02']);
  assert.equal(model.liveMessage, 'Redo queued for ep2_video_a02');
  assert.equal(model.clips[1].state, 'queued');

  assert.equal(await model.handleKey('enter'), true);
  assert.deepEqual(opened, ['ep2_video_a02']);

  const easy = new ReviewDrawerModel({ clips: [clip(1)], onOpenTakes: clipId => opened.push(clipId), getMode: () => 'easy' });
  assert.equal(await easy.handleKey('enter'), false);
  assert.equal(opened.length, 1);

  const before = model.activeId;
  assert.equal(await model.handleKey('a', { inEditable: true }), false);
  assert.equal(model.activeId, before);
  assert.equal(model.counts.approved, 0);
});

test('Shift+A approves all visible after a confirm and leaves nothing needing review', async () => {
  const list = [clip(1), clip(2), clip(3, { state: 'approved' })];
  const approved: string[] = [];
  let confirmed = '';
  const model = createReviewDrawerModel({
    clips: list,
    confirm: message => { confirmed = message; return true; },
    onApprove: item => { approved.push(item.clipId); },
  });

  const count = await model.approveVisible();
  assert.equal(count, 2);
  assert.deepEqual(approved, ['ep2_video_a01', 'ep2_video_a02']);
  assert.match(confirmed, /Approve 2 visible clips\?/);
  assert.equal(model.liveMessage, 'Approved 3/3');
  assert.equal(model.counts.needs, 0);
  assert.equal(model.activeId, '');
});

test('Shift+A is a no-op when the confirm is declined', async () => {
  const approved: string[] = [];
  const model = createReviewDrawerModel({
    clips: [clip(1), clip(2)],
    confirm: () => false,
    onApprove: item => { approved.push(item.clipId); },
  });

  assert.equal(await model.approveVisible(), 0);
  assert.deepEqual(approved, []);
  assert.equal(model.liveMessage, 'Approve all cancelled');
  assert.equal(model.counts.needs, 2);
});
