import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ACTIVITY_PHASES,
  MAX_ACTIVITY_ROWS,
  activityRows,
  phaseProgress,
  renderActivity,
} from '../src/demo/activity-panel.mjs';

const at = '2026-10-20T12:00:00.000Z';

const phasesNewestFirst = rows => rows.map(row => row.phase);

test('a canned Google Colab log yields all five phases in order', () => {
  const events = [
    { type: 'run.log', at, line: 'allocating a Colab session' },
    { type: 'run.log', at, line: 'checking health' },
    { type: 'run.log', at, line: 'generating 3 jobs' },
    { type: 'run.log', at, line: 'collected 4 package files' },
    { type: 'colab.stopped', at, verified: true },
  ];

  const rows = activityRows(events);

  assert.deepEqual(phasesNewestFirst(rows), ['stopped', 'collected', 'jobs', 'health', 'vm']);
  assert.deepEqual([...phasesNewestFirst(rows)].reverse(), ACTIVITY_PHASES);
  assert.equal(rows[0].text, 'VM stopped (verified)');
  assert.equal(rows[0].tone, 'ok');
  assert.deepEqual(Object.keys(rows[0]).sort(), ['at', 'phase', 'text', 'tone']);
});

test('colab status events cover every phase', () => {
  const rows = activityRows([
    { type: 'colab.up', at, session: 'comfyrizz-pkg' },
    { type: 'colab.health', at, ok: true },
    { type: 'colab.jobs', at, jobs: 3 },
    { type: 'colab.collected', at, files: 4 },
    { type: 'colab.stopped', at, verified: true },
  ]);

  assert.deepEqual(phasesNewestFirst(rows), ['stopped', 'collected', 'jobs', 'health', 'vm']);
  assert.match(rows[3].text, /health check ok/);
  assert.match(rows[2].text, /3/);
});

test('VM stopped is only marked verified when the stop event says verified', () => {
  const plain = activityRows([{ type: 'run.log', at, line: 'VM stopped' }]);
  assert.equal(plain[0].phase, 'stopped');
  assert.doesNotMatch(plain[0].text, /verified/);
  assert.equal(phaseProgress(plain).at(-1).label, 'VM stopped');

  const stateOnly = activityRows([{ type: 'colab.stopped', at, state: 'stopped' }]);
  assert.doesNotMatch(stateOnly[0].text, /verified/);
  assert.equal(phaseProgress(stateOnly).at(-1).label, 'VM stopped');

  const verified = activityRows([{ type: 'colab.stopped', at, verified: true }]);
  assert.match(verified[0].text, /VM stopped \(verified\)/);
  assert.equal(phaseProgress(verified).at(-1).label, 'VM stopped (verified)');

  const unconfirmed = activityRows([{ type: 'colab.stopped', at, verified: false, state: 'stopped' }]);
  assert.match(unconfirmed[0].text, /unconfirmed/);
  assert.doesNotMatch(unconfirmed[0].text, /\(verified\)/);
  assert.equal(unconfirmed[0].tone, 'warn');
  assert.equal(phaseProgress(unconfirmed).at(-1).label, 'VM stopped (unconfirmed)');
});

test('nested run_phase events map to the pipeline phases', () => {
  const rows = activityRows([
    { type: 'run.event', at, event: { v: 1, event: 'run_phase', phase: 'allocating' } },
    { type: 'run.event', at, event: { v: 1, event: 'run_phase', phase: 'checking_health', message: 'waiting for ComfyUI' } },
    { type: 'run.event', at, event: { v: 1, event: 'run_phase', phase: 'ran', counts: { succeeded: 3 } } },
    { type: 'run.event', at, event: { v: 1, event: 'run_phase', phase: 'applied', assets: 4 } },
    { type: 'run.event', at, event: { v: 1, event: 'run_phase', phase: 'teardown', state: 'stopped', verified: true } },
  ]);

  assert.deepEqual(phasesNewestFirst(rows), ['stopped', 'collected', 'jobs', 'health', 'vm']);
  assert.match(rows[1].text, /4 asset\(s\) applied/);
  assert.match(rows[2].text, /3 ok/);
});

test('brief, package and scene events become their own rows', () => {
  const rows = activityRows([
    { type: 'brief.planned', at, mode: 'outline', complete: false },
    { type: 'brief.outline', at, beats: 6, seconds: 42 },
    { type: 'package.updated', at, revision: 2 },
    { type: 'scene.render.started', at, sceneId: 's_chart' },
    { type: 'scene.render.finished', at, sceneId: 's_chart' },
    { type: 'scene.render.failed', at, sceneId: 's_hero', message: 'boom' },
  ]);

  assert.deepEqual(phasesNewestFirst(rows), ['scene', 'scene', 'scene', 'package', 'brief', 'brief']);
  assert.equal(rows[0].tone, 'error');
  assert.match(rows[1].text, /scene s_chart ready/);
  assert.match(rows[2].text, /scene s_chart re-rendering/);
  assert.equal(rows[3].text, 'package updated (revision 2)');
  assert.match(rows[5].text, /questions pending/);
});

test('rows are newest-first and capped at 200', () => {
  const events = Array.from({ length: MAX_ACTIVITY_ROWS + 5 }, (_, index) => ({
    type: 'run.log',
    at: `t${index}`,
    line: `line ${index}`,
  }));

  const rows = activityRows(events);

  assert.equal(rows.length, MAX_ACTIVITY_ROWS);
  assert.equal(rows[0].text, `line ${MAX_ACTIVITY_ROWS + 4}`);
  assert.equal(rows.at(-1).text, 'line 5');
});

test('phaseProgress marks earlier phases done, the furthest current and the rest pending', () => {
  const rows = activityRows([
    { type: 'run.log', at, line: 'allocating a Colab session' },
    { type: 'run.log', at, line: 'health check passed' },
    { type: 'run.log', at, line: 'generating 3 jobs' },
  ]);

  const progress = phaseProgress(rows);

  assert.deepEqual(progress.map(step => step.phase), ACTIVITY_PHASES);
  assert.deepEqual(progress.map(step => step.status), ['done', 'done', 'current', 'pending', 'pending']);
  assert.deepEqual(phaseProgress([]).map(step => step.status), ['pending', 'pending', 'pending', 'pending', 'pending']);
});

test('renderActivity escapes every row value and the stepper labels', () => {
  const rows = activityRows([
    {
      type: 'run.log',
      at: '"><img src=x onerror=alert(1)>',
      line: '<script>alert("x")</script> & \'quoted\'',
    },
  ]);
  const html = renderActivity(rows);

  assert.doesNotMatch(html, /<script>/);
  assert.doesNotMatch(html, /<img/);
  assert.match(html, /&lt;script&gt;alert\(&quot;x&quot;\)&lt;\/script&gt; &amp; &#39;quoted&#39;/);
  assert.match(html, /datetime="&quot;&gt;&lt;img src=x onerror=alert\(1\)&gt;"/);

  const evil = renderActivity(rows, [{ phase: '<script>', label: '<b>boom</b>', status: 'current' }]);
  assert.doesNotMatch(evil, /<script>/);
  assert.doesNotMatch(evil, /<b>boom<\/b>/);
  assert.match(evil, /&lt;b&gt;boom&lt;\/b&gt;/);
});

test('renderActivity renders a phase stepper, current step and sped up label slot', () => {
  const rows = activityRows([
    { type: 'run.log', at, line: 'allocating a Colab session' },
    { type: 'run.log', at, line: 'health check passed' },
    { type: 'run.log', at, line: 'generating 3 jobs' },
  ]);
  const html = renderActivity(rows, phaseProgress(rows));

  assert.match(html, /class="activity-phases/);
  assert.match(html, /data-phase="vm"/);
  assert.match(html, /aria-current="step"/);
  assert.match(html, /data-slot="sped-up"[^>]*>sped up</);
  assert.match(html, /data-phase="jobs" data-status="current"/);
  assert.match(html, /VM up/);
  assert.match(html, /activity-row--ok/);
  assert.match(html, /generating 3 jobs/);
});

test('an empty panel still renders the five-phase stepper', () => {
  const html = renderActivity([]);
  assert.match(html, /VM up/);
  assert.match(html, /health/);
  assert.match(html, /jobs/);
  assert.match(html, /collected/);
  assert.match(html, /VM stopped/);
  assert.match(html, /No activity yet/);
});

test('unknown events are ignored and inputs are not mutated', () => {
  const events = [
    { type: 'mystery.event', at, line: 'nope' },
    { type: 'run.log', at, line: 'generating 1 job' },
  ];
  const snapshot = JSON.stringify(events);
  const rows = activityRows(events);

  assert.equal(rows.length, 1);
  assert.equal(JSON.stringify(events), snapshot);
  assert.equal(activityRows(null).length, 0);
});
