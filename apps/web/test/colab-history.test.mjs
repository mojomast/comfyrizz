// PN14: the Activity panel's read-only replay of the recorded Google Colab history. Pure strings, no
// DOM harness, no network; the seeder check at the end uses a temporary runtime and an injected fs.
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  COLAB_HISTORY_LABEL,
  COLAB_HISTORY_SCHEMA,
  colabHistoryActivity,
  colabHistoryHtml,
  colabHistoryRuns,
  colabRunJobs,
  compact,
  formatEta,
  gaugeHtml,
  gaugePercent,
  mountColabHistory,
  parseColabHistory,
  readColabHistory,
} from '../src/colab-history.ts';
import {
  HISTORY_SCHEMA,
  loadExampleHistory,
  seedDemoHistory,
} from '../../server/src/seed-demo-history.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(HERE, '..', '..', '..');
const exampleDir = join(repoRoot, 'examples', 'pip-night-shift');
const historyText = readFileSync(join(exampleDir, 'colab-history.json'), 'utf8');
const history = JSON.parse(historyText);
const webSource = readFileSync(join(repoRoot, 'apps', 'web', 'src', 'colab-history.ts'), 'utf8');
const serverSource = readFileSync(join(repoRoot, 'apps', 'server', 'src', 'seed-demo-history.mjs'), 'utf8');

function tempDir(t, label) {
  const directory = mkdtempSync(join(tmpdir(), `comfyrizz-${label}-`));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function write(path, bytes) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, bytes);
}

test('PN14: the seeded fixture is a valid, finished Google Colab replay', () => {
  const parsed = parseColabHistory(historyText);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.history.schema, COLAB_HISTORY_SCHEMA);
  assert.equal(parsed.history.schema, HISTORY_SCHEMA);
  assert.equal(parsed.history.label, COLAB_HISTORY_LABEL);
  assert.equal(parsed.history.label, 'Google Colab');
  assert.equal(parsed.history.runs.length, 2);
  for (const run of parsed.history.runs) assert.equal(run.active, false);

  const runs = colabHistoryRuns(historyText);
  assert.deepEqual(runs.map(run => run.runId), history.runs.map(run => run.runId));
  assert.deepEqual(colabRunJobs(runs[0]), ['s3_juno.take2']);
  assert.deepEqual(colabRunJobs(runs[1]), ['s1_dawn', 's2_counter', 's3_juno']);
});

test('PN14: the replay draws gauges with the live component markup', () => {
  const html = colabHistoryHtml(history);
  assert.match(html, /Google Colab history/);
  assert.match(html, /Past run · read-only replay/);
  assert.match(html, /data-readonly="true"/);
  assert.match(html, /simulated\.regen\.2026-10-20T21-21-40-000Z/);
  assert.match(html, /simulated\.run\.2026-10-20T21-05-00-000Z/);
  assert.match(html, /class="colab-gauge"/);
  assert.match(html, /role="progressbar"/);
  assert.match(html, /aria-valuenow="100"/);
  assert.match(html, /data-stage="sampler"/);
  assert.match(html, /8\.20G\/8\.20G/);
  assert.match(html, /347|s3_juno\.take2/);
  assert.equal((html.match(/class="colab-run"/g) ?? []).length, 2);
});

test('PN14: gauge helpers match the live panel and labels are escaped', () => {
  assert.equal(gaugePercent({ job: 'j', stage: 'tqdm', label: '', n: 1, total: 4 }), 25);
  assert.equal(gaugePercent({ job: 'j', stage: 'tqdm', label: '', n: 1, total: null }), null);
  assert.equal(gaugePercent({ job: 'j', stage: 'node', label: '', n: 0, total: 0, state: 'done' }), 100);
  assert.equal(formatEta(125), '2m05s');
  assert.equal(formatEta(3725), '1h02m');
  assert.equal(compact(8.2e9), '8.20G');

  const html = gaugeHtml({ job: 'p1', stage: 'sampler', label: 'KSampler #3 <b>', n: 15, total: 30, rate: 2.5, eta: 6 });
  assert.match(html, /15\/30 · 2\.50\/s · ETA 6s/);
  assert.match(html, /&lt;b&gt;/);
  assert.equal(html.includes('<b>'), false);
});

test('PN14: a caller can inject the live colab-progress.ts renderers', () => {
  const renderers = { gaugeHtml: gauge => `<div class="injected" data-job="${gauge.job}"></div>` };
  for (const options of [{ gaugeHtml: renderers.gaugeHtml }, { renderers }]) {
    const html = colabHistoryHtml(history, options);
    assert.match(html, /class="injected"/);
    assert.match(html, /data-job="s3_juno\.take2"/);
    assert.equal(html.includes('class="colab-gauge"'), false);
  }

  const whole = colabHistoryHtml(history, { progressHtml: (runs) => `<div class="whole-body">${runs?.length}</div>` });
  assert.match(whole, /class="whole-body">2</);
  assert.match(whole, /data-readonly="true"/);
});

test('PN14: replaying never mutates the recording', () => {
  const before = structuredClone(history);
  readColabHistory(historyText);
  colabHistoryHtml(historyText);
  colabHistoryRuns(historyText);
  colabHistoryActivity(historyText);
  assert.deepEqual(history, before);
  assert.notEqual(colabHistoryRuns(historyText)[0], history.runs[0], 'runs are copies');
});

test('PN14: each finished run becomes an Activity row plus a replay', () => {
  const rows = colabHistoryActivity(history);
  assert.equal(rows.length, 2);
  assert.ok(rows.every(row => row.text.startsWith('Google Colab ·')));
  assert.deepEqual(rows.map(row => row.gauges), history.runs.map(run => run.gauges.length));
  assert.equal(rows[0].runId, history.runs[0].runId);
});

test('PN14: an invalid recording is refused and renders a warning, not markup', () => {
  const broken = { ...structuredClone(history), label: 'Google Colab', runs: [] };
  const parsed = parseColabHistory(broken);
  assert.equal(parsed.ok, false);
  assert.throws(() => readColabHistory(broken), /Invalid Google Colab history/);
  const html = colabHistoryHtml(broken);
  assert.match(html, /Could not read Google Colab history/);
  assert.equal(html.includes('class="colab-gauge"'), false);
});

test('PN14: mounting is a one-shot read-only render, including async sources', async () => {
  const host = { innerHTML: '' };
  const stop = mountColabHistory(host, history);
  assert.match(host.innerHTML, /data-readonly="true"/);
  stop();

  const asyncHost = { innerHTML: '' };
  mountColabHistory(asyncHost, async () => history);
  assert.match(asyncHost.innerHTML, /Loading Google Colab history/);
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.match(asyncHost.innerHTML, /data-readonly="true"/);
  assert.match(asyncHost.innerHTML, /Google Colab history/);
});

test('PN14: the seeder writes the sidecar once and never overwrites owner edits', (t) => {
  const runtimeDir = tempDir(t, 'history-runtime');
  const first = seedDemoHistory({ runtimeDir, exampleDir });
  assert.equal(first.packageId, history.projectId);
  assert.equal(first.changed, true);
  assert.equal(first.noop, false);
  assert.deepEqual(first.written, ['colab-history']);
  assert.equal(first.historyPath, join(runtimeDir, 'colab-history', `${history.projectId}.json`));
  assert.deepEqual(JSON.parse(readFileSync(first.historyPath, 'utf8')), history);
  assert.equal(existsSync(join(runtimeDir, 'packages', history.projectId, 'colab-history.json')), true, 'history sits beside the package too');

  write(first.historyPath, '{"owner":"history"}\n');
  const second = seedDemoHistory({ runtimeDir, exampleDir });
  assert.equal(second.changed, false);
  assert.equal(second.noop, true);
  assert.deepEqual(second.written, []);
  assert.equal(readFileSync(first.historyPath, 'utf8'), '{"owner":"history"}\n');

  const loaded = loadExampleHistory({ exampleDir });
  assert.equal(loaded.history.label, 'Google Colab');
  assert.equal(loaded.history.runs.length, 2);
});

test('PN14: the sources and the fixture use the full product name and carry no credentials', () => {
  const shortName = ['Co', 'lab'].join('');
  for (const [name, text] of [['web source', webSource], ['server source', serverSource], ['fixture', historyText]]) {
    const withoutFullName = text.replaceAll('Google Colab', '');
    assert.equal(new RegExp(`\\b${shortName}\\b`).test(withoutFullName), false, `${name} uses the bare short name`);
    assert.doesNotMatch(text, /\bhf_[A-Za-z0-9]{10,}/, name);
    assert.doesNotMatch(text, /\bgh[pousr]_[A-Za-z0-9]{10,}/, name);
    assert.doesNotMatch(text, /\bsk-[A-Za-z0-9]{10,}/, name);
    assert.doesNotMatch(text, /(?:authorization|bearer)\s*[:=]\s*\S+/i, name);
    assert.doesNotMatch(text, /(?:api[_-]?key|secret|password)\s*[:=]\s*\S+/i, name);
  }
});
