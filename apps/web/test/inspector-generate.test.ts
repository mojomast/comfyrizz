// @ts-nocheck
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { COPY } from '../src/easy/copy.ts';
import { createEasyStore } from '../src/easy/store.ts';
import { generateTabButton, onGeneratePrimary, renderGenerateTab } from '../src/editor/inspector/generate.ts';

const PRODUCTION_ID = 'prod_0123456789abcdef01234567';
const PLAN_HASH = 'c'.repeat(64);

const main = readFileSync(fileURLToPath(new URL('../src/main.ts', import.meta.url)), 'utf8');
const html = readFileSync(fileURLToPath(new URL('../index.html', import.meta.url)), 'utf8');
const voice = readFileSync(fileURLToPath(new URL('../src/voice-settings.ts', import.meta.url)), 'utf8');

function snapshot() {
  return {
    productionId: PRODUCTION_ID,
    production: { id: PRODUCTION_ID, revision: 4 },
    revision: 4,
    events: [{
      id: 'evt_plan_1',
      sequence: 3,
      productionId: PRODUCTION_ID,
      type: 'plan.proposed',
      data: {
        id: 'plan_1',
        productionId: PRODUCTION_ID,
        revision: 0,
        planHash: PLAN_HASH,
        reservationCeiling: 6,
        collectAndStopReserve: 0,
        requiredDecisions: [],
        actions: [{ id: 'act_1', kind: 'shot.generate', targetId: 'shot_1', upperBound: 6, reuse: false }],
      },
    }],
    gap: false,
    stale: false,
  };
}

test('the inspector has a Generate tab', () => {
  const tab = generateTabButton();
  assert.match(tab, /role="tab"/);
  assert.match(tab, /data-inspector-tab="generate"/);
  assert.match(tab, />Generate</);
  const body = renderGenerateTab({ compute: 'colab', spendCap: 15, snapshot: snapshot() });
  assert.match(body, /data-il-slot="iteration-level-picker"/);
  assert.match(body, /data-approve-generate/);
  assert.match(body, /Up to 6 Google Colab units \(spend cap 15\)/);
  assert.match(main, /mountInspectorGenerate\(/);
});

test('no button is named Run on backend', () => {
  assert.equal(html.includes('Run on backend'), false);
  assert.equal(main.includes('Run on backend'), false);
  assert.equal(main.includes('runOnBackend'), false);
  assert.equal(html.includes('id="run-backend"'), false);
});

test('the Voice tab has no Generate video', () => {
  assert.equal(voice.includes('Generate video'), false);
  assert.equal(voice.includes('Approve ceiling & generate'), false);
  assert.equal(voice.includes('Visual generation'), false);
});

test('the Generate tab primary calls approveAndGenerate', async () => {
  const calls = [];
  const store = createEasyStore({
    key: 'generate-tab',
    storage: { getItem: () => null, setItem() {}, removeItem() {} },
  });
  store.patch({ packageId: 'pkg_generate', productionId: PRODUCTION_ID, compute: 'colab', spendCap: 9, level: 'balanced' });
  const api = {
    async setSpendCap(id, body) {
      calls.push({ kind: 'spend-cap', id, body });
      return { ceiling: body.ceiling };
    },
    async sendCommand(id, command) {
      calls.push({ kind: 'approve', id, command });
      return { ok: true };
    },
    async dispatchAction(id, body) {
      calls.push({ kind: 'dispatch', id, body });
      return { revision: 6 };
    },
    async startRun(body) {
      calls.push({ kind: 'run', body });
      return { runId: 'run_1' };
    },
    async colabStatus() {
      return { backendId: 'colab:G4' };
    },
    async getProduction() {
      return snapshot();
    },
    async proposeEasyPlan() {
      return snapshot();
    },
  };
  const result = await onGeneratePrimary(store.get(), { api, store, snapshot: snapshot() });
  assert.equal(result, undefined);
  assert.deepEqual(calls.map((call) => call.kind), ['spend-cap', 'approve', 'dispatch', 'run']);
  assert.equal(calls.at(-1).body.budgetUnits, 9);
  assert.equal(COPY.plan.approve, 'Approve and generate');
});
