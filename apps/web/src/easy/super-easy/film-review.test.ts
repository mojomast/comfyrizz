// @ts-nocheck
import test from 'node:test';
import assert from 'node:assert/strict';
import { createFilmReview, readFilmRepair } from './film-review.ts';
import { filmReviewMarkup } from './film-review-view.ts';

const target = { packageId: 'pkg_film', expectedRevision: 4, renderId: 'run_123456789abc' };
const report = { reviewId: `rr_${'a'.repeat(64)}`, packageId: target.packageId, packageRevision: 4,
  artifact: { renderId: target.renderId, videoSha256: 'b'.repeat(64) },
  speech: { status: 'unavailable', reason: 'No final-media speech evidence available.' },
  capabilities: { visual: 'unavailable', humanAcceptance: 'not_assessed' },
  findings: [{ check: 'speech_evidence', status: 'unknown', limitation: 'Speech unavailable' }, { check: 'visual_quality', status: 'unknown' }] };
function harness(overrides = {}) {
  const values = new Map(), calls = [], syncs = [];
  let currentTarget = { ...target }, active = true;
  const storage = { getItem: k => values.get(k) ?? null, setItem: (k, v) => values.set(k, v) };
  const request = async (path, init) => {
    const body = init?.body ? JSON.parse(init.body) : undefined;
    calls.push({ path, body });
    if (overrides.fetch) return overrides.fetch(path, body);
    let value = {};
    if (path === '/api/render-reviews') value = report;
    if (path === '/api/conversations') value = { chatId: 'chat_film' };
    if (path === '/api/self-repairs') value = { repairId: body.repairId, input: body, status: 'stopped',
      currentRevision: 4, stage: 'inspect_render', reason: 'speech_evidence_unknown', attempts: 0, renders: 0, reports: [report] };
    return Response.json(value);
  };
  const options = { packageId: target.packageId, fetch: request, storage,
    target: () => currentTarget, current: () => active, chatId: () => null,
    sync: async record => { syncs.push(record); }, changed() {}, owner: true, ...overrides.options };
  const controller = createFilmReview(options);
  return { controller, options, calls, storage, syncs, change: () => { currentTarget = { ...target, expectedRevision: 5 }; }, leave: () => { active = false; } };
}

test('review is exact, read-only, and unknown speech/visual evidence remains unknown in the panel', async () => {
  const h = harness();
  await h.controller.review();
  assert.deepEqual(h.calls, [{ path: '/api/render-reviews', body: target }]);
  const html = filmReviewMarkup(h.controller.state());
  assert.match(html, /Speech evidence: <strong>unavailable/);
  assert.match(html, /speech evidence: unknown/);
  assert.match(html, /human acceptance: <strong>not assessed/);
  assert.match(html, /Unknown or unavailable evidence is not a pass/);
  await h.controller.start(2, false);
  assert.equal(h.calls.length, 1);
  h.controller.close();
});

test('explicit bounded authorization starts once, records identity first and creates a package-bound conversation', async () => {
  const h = harness();
  await h.controller.review();
  await Promise.all([h.controller.start(2, true), h.controller.start(2, true)]);
  assert.deepEqual(h.calls.find(c => c.path === '/api/conversations').body, { packageId: target.packageId });
  const posts = h.calls.filter(c => c.path === '/api/self-repairs');
  assert.equal(posts.length, 1);
  assert.deepEqual(Object.keys(posts[0].body).sort(), ['packageId', 'expectedRevision', 'renderId', 'repairId', 'conversationId', 'maxRepairs', 'authorizeExistingMediaRepair'].sort());
  assert.equal(posts[0].body.maxRepairs, 2);
  assert.equal(posts[0].body.authorizeExistingMediaRepair, true);
  assert.equal(readFilmRepair(h.storage, target.packageId).repairId, posts[0].body.repairId);
  assert.equal(h.controller.state().record.reason, 'speech_evidence_unknown');
  await h.controller.start(2, true);
  assert.equal(h.calls.filter(c => c.path === '/api/self-repairs').length, 1);
  h.controller.close();
});

test('ambiguous start failure and status reload never resubmit or allocate a new repair ID', async () => {
  const h = harness({ fetch: async (path, body) => {
    if (path === '/api/render-reviews') return Response.json(report);
    if (path === '/api/conversations') return Response.json({ chatId: 'chat_film' });
    throw Error('Connection lost after dispatch');
  } });
  await h.controller.review(); await h.controller.start(1, true);
  const saved = h.controller.state().saved;
  assert.ok(saved);
  assert.match(h.controller.state().error, /Check this repair ID/);
  assert.equal(h.syncs.length, 1, 'uncertain failure reconciles saved revision');
  h.controller.close();
  const reopened = createFilmReview(h.options);
  await reopened.start(2, true); await reopened.refresh(); await reopened.refresh();
  assert.equal(h.calls.filter(c => c.path === '/api/self-repairs').length, 1);
  assert.equal(reopened.state().saved.repairId, saved.repairId);
  assert.equal(h.calls.filter(c => c.path === `/api/self-repairs/${saved.repairId}`).length, 2);
  assert.match(reopened.state().error, /no repair has been restarted/);
  reopened.close();
});

test('changed target, wrong reports, guests and navigation block repair effects', async () => {
  const h = harness(); await h.controller.review(); h.change(); await h.controller.start(1, true);
  assert.equal(h.calls.length, 1);
  const wrong = harness({ fetch: async () => Response.json({ ...report, packageRevision: 3 }) });
  await wrong.controller.review(); assert.equal(wrong.controller.state().report, null);
  const guest = harness({ options: { owner: false } });
  await guest.controller.review(); assert.equal(guest.calls.length, 0);
  const late = harness(); late.leave(); await late.controller.review(); assert.equal(late.calls.length, 0);
  for (const item of [h, wrong, guest, late]) item.controller.close();
});

test('status identity mismatch is refused; restart-interrupted status is readable without any resume POST', async () => {
  const h = harness(); await h.controller.review(); await h.controller.start(1, true); h.controller.close();
  const saved = readFilmRepair(h.storage, target.packageId);
  let status = { repairId: saved.repairId, input: { ...target, maxRepairs: 1 }, status: 'interrupted',
    currentRevision: 5, stage: 'chat_turn', attempts: 1, renders: 0, reports: [report], reason: 'restart_interrupted' };
  const controller = createFilmReview({ ...h.options, fetch: async () => Response.json(status) });
  await controller.refresh();
  assert.equal(controller.state().record.status, 'interrupted');
  assert.match(filmReviewMarkup(controller.state()), /restart interrupted/);
  status = { ...status, input: { ...status.input, packageId: 'other' } };
  await controller.refresh(); assert.match(controller.state().error, /does not match/);
  controller.close();
});

test('report text is escaped and repair limits and previous-video distinction remain visible', () => {
  const html = filmReviewMarkup({ target, report: { ...report, findings: [{ check: '<img>', status: 'unknown', limitation: '<script>x</script>' }] }, record: null, saved: null, busy: false, error: null }, 'blob:previous');
  assert.doesNotMatch(html, /<script>|<img>/);
  assert.match(html, /At most two rounds per package/);
  assert.match(html, /Model-provider charges may apply/);
  assert.match(html, /Previous video — not the current saved revision/);
});

test('a valid existing project conversation is reused; a missing or foreign one is replaced with a bound empty conversation', async () => {
  for (const kind of ['matching', 'missing', 'foreign']) {
    let creates = 0;
    const h = harness({ options: { chatId: () => 'chat_old' }, fetch: async (path, body) => {
      if (path === '/api/render-reviews') return Response.json(report);
      if (path === '/api/agent/chat/chat_old') return kind === 'missing' ? Response.json({ error: 'Missing' }, { status: 404 })
        : Response.json({ conversation: { id: 'chat_old', packageId: kind === 'matching' ? target.packageId : 'other', revision: 1 } });
      if (path === '/api/conversations') { creates++; return Response.json({ chatId: 'chat_new' }); }
      return Response.json({ repairId: body.repairId, input: body, status: 'stopped', stage: 'inspect_render',
        currentRevision: 4, attempts: 0, renders: 0, reports: [report] });
    } });
    await h.controller.review(); await h.controller.start(1, true);
    assert.equal(creates, kind === 'matching' ? 0 : 1, kind);
    assert.equal(h.calls.find(c => c.path === '/api/self-repairs').body.conversationId, kind === 'matching' ? 'chat_old' : 'chat_new');
    h.controller.close();
  }
});

test('closing while status is in flight aborts local polling and cannot publish or synchronize late state', async () => {
  const h = harness(); await h.controller.review(); await h.controller.start(1, true); h.controller.close();
  let release, signal, changes = 0, syncs = 0;
  const controller = createFilmReview({ ...h.options,
    fetch: async (_path, init) => { signal = init.signal; return new Promise(resolve => { release = resolve; }); },
    changed: () => { changes++; }, sync: async () => { syncs++; },
  });
  const waiting = controller.refresh();
  controller.close();
  assert.equal(signal.aborted, true);
  const before = changes;
  release(Response.json(h.controller.state().record)); await waiting;
  assert.equal(changes, before);
  assert.equal(syncs, 0);
});
