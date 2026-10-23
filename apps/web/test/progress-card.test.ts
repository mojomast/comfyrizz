// IP30: the per-shot progress strip reports an honest status for every shot.
//
// The eight statuses are the take system's clip states. The tests drive only
// pure functions and an injected clock: no DOM, network, Google Colab session
// or paid backend is involved.
// @ts-nocheck
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PROGRESS_ANNOUNCE_INTERVAL_MS,
  SHOT_STATUSES,
  SHOT_STATUS_TEXT,
  createProgressAnnouncer,
  normalizeShots,
  progressAnnouncement,
  progressCardHtml,
  progressSummary,
  renderProgressCard,
  shotStatusLabel,
  summarizeProgress,
} from '../src/productions/cards/progress.ts';

function shot(shotId, status, extra = {}) {
  return { shotId, status, ...extra };
}

test('the eight shot statuses have eight distinct visible labels', () => {
  assert.deepEqual([...SHOT_STATUSES], [
    'planned',
    'queued',
    'generating',
    'review',
    'approved',
    'rejected',
    'failed',
    'stale',
  ]);
  const labels = SHOT_STATUSES.map(status => SHOT_STATUS_TEXT[status]);
  assert.equal(labels.length, 8);
  assert.equal(new Set(labels).size, 8, 'no two statuses rely on the same text');
  for (const label of labels) {
    assert.equal(typeof label, 'string');
    assert.ok(label.trim().length > 0);
  }
  assert.equal(shotStatusLabel('review'), 'Needs review');
  assert.equal(shotStatusLabel('APPROVED'), 'Approved');
});

test('every status renders its text, not only a colour or icon', () => {
  const html = renderProgressCard({
    shots: SHOT_STATUSES.map((status, index) => shot(`shot_${index + 1}`, status)),
  });

  assert.match(html, /data-production-card="progress"/);
  for (const status of SHOT_STATUSES) {
    assert.match(html, new RegExp(`data-status="${status}"`));
    assert.match(html, new RegExp(`>${SHOT_STATUS_TEXT[status]}<`));
  }
  assert.match(html, /aria-live="polite"/);
  assert.match(html, /data-shot-progress-strip/);
});

test('a shot row names its shot and status for assistive technology', () => {
  const html = renderProgressCard({
    shots: [shot('s_hero', 'generating', { label: 'Hero reveal' })],
  });
  assert.match(html, /data-shot-id="s_hero"/);
  assert.match(html, /aria-label="Hero reveal: Generating"/);
  assert.match(html, /data-shot-label[^>]*>Hero reveal</);
  assert.match(html, /data-shot-status[^>]*>Generating</);
});

test('missing and unrecognised states are unknown, never silently planned or done', () => {
  const normalized = normalizeShots([
    { shotId: 's_missing' },
    { shotId: 's_done', status: 'completed' },
    { id: 's_review', state: 'review' },
    { shotId: 's_approved', clip: { state: 'approved' } },
  ]);

  assert.deepEqual(normalized.map(entry => entry.status), [null, null, 'review', 'approved']);
  assert.deepEqual(normalized.map(entry => entry.shotId), ['s_missing', 's_done', 's_review', 's_approved']);
  assert.equal(normalized[0].statusText, 'Unknown');
  assert.equal(normalized[1].statusText, 'Unknown');
  assert.notEqual(normalized[0].statusText, 'Planned');
  assert.notEqual(normalized[1].statusText, 'Approved');

  const html = renderProgressCard({ shots: [{ shotId: 's_missing' }] });
  assert.match(html, /data-status="unknown"/);
  assert.match(html, /Unknown/);
  assert.doesNotMatch(html, /data-status="planned"/);
});

test('the summary counts only approved shots as finished', () => {
  const summary = summarizeProgress([
    shot('s1', 'planned'),
    shot('s2', 'queued'),
    shot('s3', 'generating'),
    shot('s4', 'review'),
    shot('s5', 'approved'),
    shot('s6', 'rejected'),
    shot('s7', 'failed'),
    shot('s8', 'stale'),
  ]);

  assert.equal(summary.total, 8);
  assert.equal(summary.approved, 1);
  assert.equal(summary.done, 1);
  assert.equal(summary.remaining, 7);
  assert.equal(summary.isComplete, false);
  assert.equal(summary.text, '1 of 8 shots approved');
  assert.equal(summary.counts.review, 1);
  assert.equal(summary.counts.failed, 1);
  assert.equal(summary.counts.stale, 1);
  assert.equal(summary.counts.unknown, 0);
  assert.equal(progressSummary, summarizeProgress, 'the short alias is the same view');
});

test('an honest announcement never calls a failed or unreviewed strip complete', () => {
  const mixed = progressAnnouncement([
    shot('s1', 'approved'),
    shot('s2', 'review'),
    shot('s3', 'failed'),
  ]);
  assert.match(mixed, /1 of 3 shots approved/);
  assert.match(mixed, /1 need review/);
  assert.match(mixed, /1 failed/);
  assert.doesNotMatch(mixed, /All shots approved/);

  assert.equal(progressAnnouncement([]), 'No shots yet.');
  assert.equal(progressAnnouncement([shot('s1', 'approved')]), 'The shot is approved.');
  assert.equal(
    progressAnnouncement([shot('s1', 'approved'), shot('s2', 'approved')]),
    'All 2 shots approved.',
  );
});

test('empty, loading, error and stale card states are explicit', () => {
  const empty = renderProgressCard([]);
  assert.match(empty, /data-card-state="empty"/);
  assert.match(empty, /No shots yet/);

  const loading = renderProgressCard([], { state: 'loading' });
  assert.match(loading, /data-card-state="loading"/);
  assert.match(loading, /aria-busy="true"/);
  assert.match(loading, /Loading shot progress/);

  const failed = renderProgressCard([], { error: 'Shot progress could not be read' });
  assert.match(failed, /data-card-state="error"/);
  assert.match(failed, /role="alert"/);
  assert.match(failed, /Shot progress could not be read/);

  const stale = renderProgressCard({ shots: [shot('s1', 'review')] }, { stale: true });
  assert.match(stale, /data-card-state="stale"/);
  assert.match(stale, /data-progress-stale/);
  assert.match(stale, /Snapshot may be out of date/);
  assert.match(stale, /Needs review/);
});

test('shot labels and ids are escaped in markup', () => {
  const html = renderProgressCard({
    shots: [shot('<s1>', 'failed', { label: 'A & B <script>' })],
  }, { error: undefined });
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /A &amp; B &lt;script&gt;/);
  assert.match(html, /data-shot-id="&lt;s1&gt;"/);
});

test('announcements are throttled and coalesce to the newest status', () => {
  let now = 0;
  const announced = [];
  const announcer = createProgressAnnouncer({
    intervalMs: 1000,
    now: () => now,
    onAnnounce: message => { announced.push(message); },
  });

  let shots = [shot('s1', 'planned'), shot('s2', 'planned')];
  assert.equal(announcer.update(shots), '0 of 2 shots approved.');
  assert.deepEqual(announced, ['0 of 2 shots approved.']);

  now = 200;
  shots = [shot('s1', 'generating'), shot('s2', 'planned')];
  assert.equal(announcer.update(shots), null, 'inside the interval nothing is announced');
  assert.equal(announcer.pending(), 'Shot s1: Generating. 0 of 2 shots approved. 1 generating.');

  now = 400;
  shots = [shot('s1', 'review'), shot('s2', 'planned')];
  assert.equal(announcer.update(shots), null);
  assert.equal(announced.length, 1);

  now = 1000;
  shots = [shot('s1', 'approved'), shot('s2', 'planned')];
  const trailing = announcer.update(shots);
  assert.equal(announced.length, 2);
  assert.match(trailing, /Shot s1: Approved/);
  assert.match(trailing, /1 of 2 shots approved/);
  assert.doesNotMatch(trailing, /Needs review/, 'the suppressed middle state is not replayed');
  assert.equal(announcer.pending(), null);
  assert.equal(announcer.lastMessage, trailing);
});

test('flush releases a pending announcement without waiting for another update', () => {
  let now = 0;
  const announced = [];
  const announcer = createProgressAnnouncer({
    intervalMs: PROGRESS_ANNOUNCE_INTERVAL_MS,
    now: () => now,
    onAnnounce: message => { announced.push(message); },
  });

  announcer.update([shot('s1', 'planned')]);
  now = 500;
  assert.equal(announcer.update([shot('s1', 'failed')]), null);
  assert.match(announcer.pending(), /Shot s1: Failed/);

  now = 700;
  const message = announcer.flush();
  assert.match(message, /Shot s1: Failed/);
  assert.equal(announcer.pending(), null);
  assert.deepEqual(announced, ['0 of 1 shots approved.', message]);
});

test('an unchanged strip is not announced again', () => {
  let now = 0;
  const announced = [];
  const announcer = createProgressAnnouncer({
    intervalMs: 100,
    now: () => now,
    onAnnounce: message => { announced.push(message); },
  });

  const shots = [shot('s1', 'review'), shot('s2', 'approved')];
  assert.equal(announcer.update(shots), '1 of 2 shots approved. 1 need review.');
  now = 1000;
  assert.equal(announcer.update(shots), null);
  assert.equal(announcer.flush(), null);
  assert.equal(announced.length, 1);
});

test('the live announcement region is a polite status, and the card can carry a message', () => {
  const html = renderProgressCard(
    { shots: [shot('s1', 'review')] },
    { liveMessage: 'Shot s1 needs review.' },
  );
  assert.match(html, /role="status"/);
  assert.match(html, /aria-live="polite"/);
  assert.match(html, /aria-atomic="true"/);
  assert.match(html, /data-progress-live[^>]*>Shot s1 needs review\.</);
});

test('the HTML helper aliases the renderer and still returns the same card', () => {
  const data = { shots: [shot('s1', 'approved')] };
  assert.equal(progressCardHtml(data), renderProgressCard(data));
  assert.match(renderProgressCard(data), /All shots approved|The shot is approved/);
});
