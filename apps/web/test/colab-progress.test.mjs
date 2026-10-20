// The Google Colab runs panel: gauges rendered from /api/colab/progress, as strings (no DOM harness).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { colabProgressHtml, gaugePercent, formatEta } from '../src/colab-progress.ts';

const SRC = readFileSync(new URL('../src/colab-progress.ts', import.meta.url), 'utf8');
const MAIN = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');
const HTML = readFileSync(new URL('../index.html', import.meta.url), 'utf8');

test('gauges show percent, count, rate and ETA, and escape labels', () => {
  const html = colabProgressHtml([{ runId: 'comfyrizz-demo.run.1', updatedAt: '2026-10-20T19:00:00Z', active: true, updates: 4, gauges: [
    { job: 'p1', stage: 'sampler', label: 'KSampler #3 <b>', n: 15, total: 30, rate: 2.5, eta: 6 },
    { job: 'p1', stage: 'node', label: 'nodes', n: 9, total: 9, state: 'done' },
    { job: 'render', stage: 'phase', label: 'chromium', n: null, total: null },
  ] }]);
  assert.match(html, /Google Colab runs/);
  assert.match(html, /aria-valuenow="50"/);
  assert.match(html, /15\/30 · 2\.50\/s · ETA 6s/);
  assert.match(html, /&lt;b&gt;/);
  assert.match(html, /class="indeterminate"/);
  assert.match(html, /data-state="done"/);
});

test('helpers', () => {
  assert.equal(gaugePercent({ job: 'j', stage: 'tqdm', label: '', n: 1, total: 4 }), 25);
  assert.equal(gaugePercent({ job: 'j', stage: 'tqdm', label: '', n: 1, total: null }), null);
  assert.equal(formatEta(125), '2m05s');
  assert.equal(formatEta(3725), '1h02m');
});

test('empty state and wiring use the full name Google Colab', () => {
  assert.match(colabProgressHtml([]), /No Google Colab runs yet/);
  assert.equal(/[^ ]Colab\b/.test(SRC.replace(/Google Colab/g, '')), false);
  assert.match(MAIN, /mountColabProgress\(colabProgressHost, apiFetch\)/);
  assert.match(HTML, /id="colab-progress-host"/);
});
