// UR24: Generate view and Google Colab banner.
//
// These are pure string tests. No DOM, network, Google Colab session or paid
// backend is involved.
// @ts-nocheck
import test from 'node:test';
import assert from 'node:assert/strict';
import { COPY, fill } from '../src/easy/copy.ts';
import {
  GENERATE_STATUS_ICONS,
  generatePrimary,
  generateReadiness,
  renderGenerate,
  renderGenerateShots,
} from '../src/easy/steps/generate.ts';
import { renderColabBanner } from '../src/easy/colab-banner.ts';

const SHOT_STATUSES = ['planned', 'queued', 'generating', 'review', 'approved', 'rejected', 'failed', 'stale'];

const EXPECTED = {
  planned: { text: COPY.generate.status.planned, icon: '◌' },
  queued: { text: COPY.generate.status.queued, icon: '◌' },
  waiting_gpu: { text: COPY.generate.status.waiting_gpu, icon: '◌' },
  generating: { text: fill(COPY.generate.status.generating, { i: 1, count: 2 }), icon: '◔' },
  generatingUnknown: { text: COPY.generate.status.generatingUnknown, icon: '◔' },
  review: { text: COPY.generate.status.review, icon: '✓' },
  approved: { text: COPY.generate.status.approved, icon: '✓' },
  rejected: { text: COPY.generate.status.rejected, icon: '–' },
  failed: { text: COPY.generate.status.failed, icon: '⚠' },
  stale: { text: COPY.generate.status.stale, icon: '⚠' },
};

function shotsForEveryStatus() {
  return SHOT_STATUSES.map((status, index) => ({
    shotId: `shot_${index + 1}`,
    label: `Shot ${index + 1}`,
    status,
    ...(status === 'generating' ? { takeCount: 2, completedTakes: 0 } : {}),
  }));
}

function rowFor(html, status) {
  const match = html.match(new RegExp(`<li[^>]*data-status="${status}"[\\s\\S]*?</li>`));
  assert.ok(match, `missing row for ${status}`);
  return match[0];
}

test('every shot status maps to its text and icon, plus the Google Colab wait', () => {
  const html = renderGenerateShots(shotsForEveryStatus(), { session: { state: 'running' } });

  for (const status of SHOT_STATUSES) {
    const row = rowFor(html, status);
    assert.ok(row.includes(EXPECTED[status].text), `${status} text`);
    assert.ok(row.includes(EXPECTED[status].icon), `${status} icon`);
  }

  const waiting = renderGenerateShots(
    [{ shotId: 'shot_wait', status: 'queued' }],
    { session: { state: 'starting' } },
  );
  const waitingRow = rowFor(waiting, 'waiting_gpu');
  assert.ok(waitingRow.includes(EXPECTED.waiting_gpu.text));
  assert.ok(waitingRow.includes(EXPECTED.waiting_gpu.icon));

  const unknown = renderGenerateShots([{ shotId: 'shot_unknown', status: 'generating' }]);
  assert.ok(rowFor(unknown, 'generatingUnknown').includes(EXPECTED.generatingUnknown.text));
  assert.ok(rowFor(unknown, 'generatingUnknown').includes(EXPECTED.generatingUnknown.icon));
});

test('the counter reads "2 of 4 shots ready" and review and approved are ready', () => {
  const snapshot = {
    shots: [
      { shotId: 'shot_1', status: 'review' },
      { shotId: 'shot_2', status: 'approved' },
      { shotId: 'shot_3', status: 'planned' },
      { shotId: 'shot_4', status: 'generating', takeCount: 2, completedTakes: 0 },
    ],
  };

  assert.equal(generateReadiness(snapshot).ready, 2);
  assert.equal(generateReadiness(snapshot).total, 4);
  const html = renderGenerate({}, {}, snapshot);
  assert.ok(html.includes('2 of 4 shots ready'));
});

test('stop_unconfirmed is an alert with the exact text, dismiss and Google Colab link', () => {
  const html = renderColabBanner(
    { state: 'stop_unconfirmed' },
    { state: 'running', used: 0.4, cap: 6 },
  );

  assert.match(html, /role="alert"/);
  assert.ok(html.includes("We couldn't confirm the session stopped. Check Google Colab now."));
  assert.match(html, /data-easy-colab-dismiss/);
  assert.match(html, /data-easy-colab-open/);
  assert.match(html, /data-easy-colab-state="stop_unconfirmed"/);
});

test('no Google Colab session renders an empty banner', () => {
  assert.equal(renderColabBanner(null, null), '');
  assert.equal(renderColabBanner(undefined, undefined), '');
  assert.equal(renderColabBanner(null, { state: 'idle' }), '');
});

test('Review is disabled with the reason while shots are still being made', () => {
  const primary = generatePrimary({
    shots: [
      { shotId: 'shot_1', status: 'review' },
      { shotId: 'shot_2', status: 'planned' },
      { shotId: 'shot_3', status: 'queued' },
      { shotId: 'shot_4', status: 'generating', takeCount: 2, completedTakes: 0 },
    ],
  });

  assert.equal(primary.label, COPY.generate.review);
  assert.equal(primary.disabled, true);
  assert.equal(primary.reason, fill(COPY.generate.notReady, { left: 3 }));
});

test('a failed shot offers Try again for exactly that shot', () => {
  const html = renderGenerateShots([{ shotId: 'shot_9', status: 'failed' }]);
  assert.match(html, /data-easy-generate-retry="shot_9"/);
  assert.ok(html.includes(COPY.generate.retry));
});


test('each Google Colab session state uses its copy', () => {
  const cases = [
    ['starting', COPY.colab.starting],
    ['running', fill(COPY.colab.running, { used: 0.4, cap: 6 })],
    ['collecting', COPY.colab.collecting],
    ['stopping', COPY.colab.stopping],
    ['stopped', COPY.colab.stopped],
  ];
  for (const [state, text] of cases) {
    const html = renderColabBanner(null, { state, used: 0.4, cap: 6 });
    assert.ok(html.includes(text), `${state} text`);
  }
});

test('a running banner never invents a spend cap', () => {
  const html = renderColabBanner(null, { state: 'running', used: 0.4 });
  assert.ok(html.includes('Used 0.4 of'));
  assert.doesNotMatch(html, /\b15\b/);
});

test('the icon map covers every Easy status key', () => {
  for (const key of Object.keys(EXPECTED)) {
    assert.equal(GENERATE_STATUS_ICONS[key], EXPECTED[key].icon, key);
  }
});
