import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const history = JSON.parse(readFileSync(new URL('../../../../examples/pip-night-shift/colab-history.json', import.meta.url), 'utf8'));

const SCHEMA = 'comfyrizz.colab-history/v1';
const STAGES = new Set(['phase', 'job', 'tqdm', 'sampler', 'sampler-log', 'node', 'frames', 'render']);
const GAUGE_KEYS = new Set(['runId', 'job', 'stage', 'label', 'n', 'total', 'rate', 'eta', 'ts', 'state', 'current', 'node']);
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const JOB_SCENES = ['s1_dawn', 's2_counter', 's3_juno'];

const jobsOf = run => [...new Set(run.gauges.map(gauge => gauge.job))];
const findGauge = (run, job, stage, label) => run.gauges.find(gauge => gauge.job === job && gauge.stage === stage && gauge.label === label);
const isNumberOrNull = value => value === null || (typeof value === 'number' && Number.isFinite(value));

function strings(value, out = []) {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) value.forEach(item => strings(item, out));
  else if (value && typeof value === 'object') Object.values(value).forEach(item => strings(item, out));
  return out;
}

test('PN13: the history is a synthetic Google Colab replay recorded by simulate-progress', () => {
  assert.equal(history.schema, SCHEMA);
  assert.equal(history.synthetic, true);
  assert.equal(history.label, 'Google Colab');
  assert.equal(history.projectId, 'pkg_pipnightshift01');
  assert.equal(history.recordedWith, 'scripts/colab/simulate-progress.mjs');
  assert.match(history.recordedAt, ISO);
  assert.ok(Array.isArray(history.runs));
  assert.equal(history.runs.length, 2);

  for (const run of history.runs) {
    assert.match(run.runId, /^simulated\.(?:run|regen)\.\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/);
    assert.ok(Date.parse(history.recordedAt) >= Date.parse(run.updatedAt));
  }
});

test('PN13: every run and gauge has the readColabProgress snapshot shape', () => {
  for (const run of history.runs) {
    assert.deepEqual(Object.keys(run).sort(), ['active', 'gauges', 'runId', 'updatedAt', 'updates']);
    assert.equal(run.active, false, 'a past run is never reported live');
    assert.match(run.updatedAt, ISO);
    assert.equal(Number.isInteger(run.updates), true);
    assert.ok(run.updates > 0);
    assert.ok(Array.isArray(run.gauges) && run.gauges.length > 0);

    for (const gauge of run.gauges) {
      assert.ok(Object.keys(gauge).every(key => GAUGE_KEYS.has(key)), `unexpected gauge key in ${Object.keys(gauge)}`);
      assert.equal(gauge.runId, run.runId);
      assert.equal(typeof gauge.job, 'string');
      assert.ok(gauge.job.length > 0 && gauge.job.length <= 160);
      assert.ok(STAGES.has(gauge.stage), `unknown stage ${gauge.stage}`);
      assert.equal(typeof gauge.label, 'string');
      assert.match(gauge.ts, ISO);
      assert.ok(isNumberOrNull(gauge.n));
      assert.ok(isNumberOrNull(gauge.total));
      assert.ok(isNumberOrNull(gauge.rate));
      assert.ok(isNumberOrNull(gauge.eta));
      if (gauge.n !== null && gauge.total !== null) assert.ok(gauge.n <= gauge.total);
      if (gauge.state !== undefined) assert.ok(['running', 'done', 'failed'].includes(gauge.state));
    }
  }

  const [newest, oldest] = history.runs;
  assert.ok(Date.parse(newest.updatedAt) > Date.parse(oldest.updatedAt), 'newest run first');
});

test('PN13: the original run records three generation jobs', () => {
  const run = history.runs.find(candidate => jobsOf(candidate).length === 3);
  assert.ok(run, 'expected one three-job run');
  assert.deepEqual(jobsOf(run), JOB_SCENES);
  assert.equal(run.gauges.filter(gauge => gauge.stage === 'sampler' && gauge.label === 'node 3').length, 3);

  const download = findGauge(run, 's1_dawn', 'tqdm', 'flux2-klein.safetensors');
  assert.ok(download, 'the shared model download is recorded once');
  assert.equal(download.n, 8.2e9);
  assert.equal(download.total, 8.2e9);
  assert.equal(run.gauges.filter(gauge => gauge.stage === 'tqdm').length, 1);

  for (const job of JOB_SCENES) {
    const sampler = findGauge(run, job, 'sampler', 'node 3');
    assert.deepEqual([sampler.n, sampler.total], [30, 30], `${job} sampler`);
    const nodes = findGauge(run, job, 'node', 'nodes');
    assert.deepEqual([nodes.n, nodes.total, nodes.state], [5, 5, 'done'], `${job} nodes`);
    assert.deepEqual([findGauge(run, job, 'frames', 'frames render').n, findGauge(run, job, 'frames', 'frames render').total], [150, 150]);
    assert.deepEqual([findGauge(run, job, 'frames', 'frames encode').n, findGauge(run, job, 'frames', 'frames encode').total], [150, 150]);
  }
});

test('PN13: the regeneration run records exactly one s3 take-2 job', () => {
  const run = history.runs.find(candidate => jobsOf(candidate).length === 1);
  assert.ok(run, 'expected one regeneration run');
  assert.deepEqual(jobsOf(run), ['s3_juno.take2']);

  assert.deepEqual([findGauge(run, 's3_juno.take2', 'sampler', 'node 3').n, findGauge(run, 's3_juno.take2', 'sampler', 'node 3').total], [30, 30]);
  assert.deepEqual([findGauge(run, 's3_juno.take2', 'node', 'nodes').n, findGauge(run, 's3_juno.take2', 'node', 'nodes').total], [5, 5]);
  assert.equal(findGauge(run, 's3_juno.take2', 'frames', 'frames render').n, 150);
  assert.equal(findGauge(run, 's3_juno.take2', 'frames', 'frames encode').n, 150);
  assert.equal(run.gauges.some(gauge => gauge.stage === 'tqdm'), false, 'the regen reuses the downloaded model');
});

test('PN13: the history contains no secrets and uses the full product name', () => {
  const all = strings(history).join('\n');
  const shortName = ['Co', 'lab'].join('');
  const withoutFullName = all.replace(/Google Colab/g, '');
  assert.equal(new RegExp(`\\b${shortName}\\b`).test(withoutFullName), false);
  assert.equal(/\bhf_[A-Za-z0-9]{10,}/.test(all), false);
  assert.equal(/\bgh[pousr]_[A-Za-z0-9]{10,}/.test(all), false);
  assert.equal(/\bsk-[A-Za-z0-9]{10,}/.test(all), false);
  assert.equal(/(?:authorization|bearer)\s*[:=]/i.test(all), false);
  assert.equal(/(?:api[_-]?key|secret|password)\s*[:=]/i.test(all), false);
  assert.equal(/COMFYRIZZ_[A-Z0-9_]+\s*=/.test(all), false);
});
