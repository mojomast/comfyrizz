import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { renderSpendCard } from '../src/demo/spend-card.mjs';

const fixturePlan = {
  planHash: 'abc123def456',
  backendId: 'colab',
  jobs: 3,
  estimate: { gpuMinutes: 42.5, overheadMinutes: 6, ratePerHour: 8.9 },
  budget: {
    allowed: true,
    warn: false,
    state: 'ok',
    required: 50,
    budget: 100,
    remaining: 50,
    message: '50 units (estimate) of 100 budgeted; 50 left after this job and the reserve.',
  },
};

const countEstimateLabels = html => (html.match(/data-estimate="estimate"/g) ?? []).length;

test('a fixture dry-run plan renders every field with estimate labels', () => {
  const html = renderSpendCard(fixturePlan, { backendLabel: 'Google Colab G4' });

  assert.match(html, /^<section class="spend-card"/);
  assert.match(html, /aria-label="Spend estimate"/);
  assert.match(html, /Google Colab G4/);
  assert.match(html, /data-metric="jobs"/);
  assert.match(html, />3<\/span> jobs/);
  assert.match(html, /data-metric="estimated-units"/);
  assert.match(html, />50<\/span> units/);
  assert.match(html, /data-metric="estimated-time"/);
  assert.match(html, />48\.5<\/span> min/);
  assert.match(html, /data-metric="budget-ceiling"/);
  assert.match(html, />100<\/span> units/);
  assert.match(html, /data-metric="remaining"/);
  assert.match(html, />50<\/span> units/);
  assert.match(html, /50 units \(estimate\) of 100 budgeted/);
  assert.equal(countEstimateLabels(html), 5);
  assert.ok(!html.includes('undefined'));
  assert.ok(!html.includes('NaN'));
});

test('a plan over the budget renders the blocked tone and text', () => {
  const html = renderSpendCard({
    ...fixturePlan,
    budget: {
      allowed: false,
      warn: true,
      state: 'refused',
      required: 140,
      budget: 100,
      remaining: -40,
      message: 'Refusing the next job: 140 units (estimate) would exceed the 100-unit budget.',
    },
  });

  assert.match(html, /data-tone="blocked"/);
  assert.match(html, /<strong>Blocked<\/strong>/);
  assert.match(html, /over budget/);
  assert.match(html, /would exceed the 100-unit budget/);
  assert.match(html, />140<\/span> units/);
  assert.match(html, />-40<\/span> units/);
});

test('a plan over 80% of budget warns; a plan within 80% stays ok', () => {
  const warning = renderSpendCard({
    ...fixturePlan,
    budget: { allowed: true, warn: false, state: 'ok', required: 85, budget: 100, remaining: 15 },
  });
  assert.match(warning, /data-tone="warn"/);
  assert.match(warning, /<strong>Warning<\/strong>/);
  assert.match(warning, /over 80%/);

  const within = renderSpendCard(fixturePlan);
  assert.match(within, /data-tone="ok"/);
  assert.ok(!within.includes('<strong>Warning</strong>'));
  assert.ok(!within.includes('<strong>Blocked</strong>'));
});

test('a missing or no-budget plan is blocked rather than reported as ok', () => {
  const html = renderSpendCard({
    backendId: 'colab',
    jobs: 1,
    estimate: {},
    budget: { allowed: false, state: 'no_budget', budget: null, message: 'No project unit budget is set.' },
  });

  assert.match(html, /data-tone="blocked"/);
  assert.match(html, /<strong>Blocked<\/strong>/);
  assert.match(html, /No project unit budget is set\./);
});

test('estimated units fall back to the estimate minutes and rate', () => {
  const html = renderSpendCard({
    backendId: 'colab',
    jobs: 2,
    estimate: { gpuMinutes: 60, overheadMinutes: 0, ratePerHour: 8.9 },
    budget: { allowed: true, warn: false, state: 'ok', budget: 100 },
  });

  assert.match(html, />8\.9<\/span> units/);
  assert.match(html, />60<\/span> min/);
  assert.match(html, />91\.1<\/span> units/);
  assert.match(html, /data-tone="ok"/);
});

test('cpu and byo plans render their exact no-spend lines', () => {
  const cpu = renderSpendCard({ backendId: 'cpu', jobs: 0, estimate: {}, budget: {} });
  assert.match(cpu, /data-tone="free"/);
  assert.match(cpu, /CPU - free/);
  assert.match(cpu, />CPU</);

  const byo = renderSpendCard({ backendId: 'byo', jobs: 2, estimate: {}, budget: { state: 'external' } });
  assert.match(byo, /data-tone="external"/);
  assert.match(byo, /BYO ComfyUI - no spend/);
  assert.match(byo, />BYO ComfyUI</);
  assert.ok(!countEstimateLabels(byo));
});

test('missing fields render dashes and never undefined or NaN', () => {
  const html = renderSpendCard({ backendId: 'colab', planHash: 'only-a-hash' });

  assert.match(html, /Google Colab G4/);
  assert.equal(countEstimateLabels(html), 5);
  assert.equal((html.match(/data-missing="true"/g) ?? []).length, 5);
  assert.ok((html.match(/>—<\/span>/g) ?? []).length >= 5);
  assert.ok(!html.includes('undefined'));
  assert.ok(!html.includes('NaN'));

  const empty = renderSpendCard(null);
  assert.match(empty, /data-metric="jobs"/);
  assert.equal((empty.match(/data-missing="true"/g) ?? []).length, 5);
  assert.ok(!empty.includes('undefined'));
  assert.ok(!empty.includes('NaN'));
});

test('backend labels and budget messages are escaped', () => {
  const html = renderSpendCard(
    {
      ...fixturePlan,
      budget: {
        ...fixturePlan.budget,
        message: '"><img src=x onerror="alert(1)"><script>alert(2)</script>',
      },
    },
    { backendLabel: '<b>Colab</b>' },
  );

  assert.ok(!html.includes('<img'));
  assert.ok(!html.includes('<script>'));
  assert.ok(!html.includes('<b>Colab</b>'));
  assert.match(html, /&lt;b&gt;Colab&lt;\/b&gt;/);
  assert.match(html, /&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;/);
});

test('rendering does not mutate the plan and is deterministic', () => {
  const before = structuredClone(fixturePlan);
  const first = renderSpendCard(fixturePlan);
  const second = renderSpendCard(fixturePlan);

  assert.deepEqual(fixturePlan, before);
  assert.equal(first, second);
});

test('the module is pure: no imports and no DOM globals at load time', () => {
  const source = readFileSync(fileURLToPath(new URL('../src/demo/spend-card.mjs', import.meta.url)), 'utf8');
  assert.ok(!/^\s*import\s/m.test(source));
  assert.ok(!/document|window|globalThis/.test(source));
});
