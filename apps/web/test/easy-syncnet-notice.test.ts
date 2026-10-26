// The SyncNet skip has to be visible in Easy Studio before Generate and Export.

import test from 'node:test';
import assert from 'node:assert/strict';

import { COPY } from '../src/easy/copy.ts';
import { defaultEasyState } from '../src/easy/store.ts';
import {
  loadSyncnetBanner,
  packageUsesPresenter,
  renderSyncnetBanner,
  syncnetSkipWarning,
} from '../src/easy/syncnet-notice.ts';
import { renderGenerate } from '../src/easy/steps/generate.ts';
import { renderPlan } from '../src/easy/steps/plan.ts';
import { renderReview } from '../src/easy/steps/review.ts';

const FACTS = {
  hasPackage: true,
  planApproved: true,
  actionsActive: false,
  allShotsKept: false,
  exportCurrent: false,
};

const NOTICE = renderSyncnetBanner(syncnetSkipWarning({
  syncnet: { configured: false, code: 'SYNCNET_UNAVAILABLE', message: 'server wording that Easy does not repeat' },
}));

test('a skipped SyncNet check is a visible Easy banner', () => {
  assert.match(NOTICE, /data-easy-syncnet-warning/);
  assert.match(NOTICE, /easy-banner-warn/);
  assert.match(NOTICE, /role="status"/);
  assert.match(NOTICE, new RegExp(COPY.syncnet.skipped.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.equal(NOTICE.includes('server wording'), false);
  assert.equal(renderSyncnetBanner(null), '');
  assert.equal(renderSyncnetBanner(syncnetSkipWarning({ syncnet: { configured: true } })), '');
});

test('plan warnings for a skipped SyncNet check use the same Easy banner', () => {
  for (const code of ['SYNCNET_UNAVAILABLE', 'SYNCNET_SKIPPED']) {
    const warning = syncnetSkipWarning({ warnings: [{ code, message: 'pipeline text' }] });
    assert.equal(warning?.code, code);
    assert.equal(warning?.message, COPY.syncnet.skipped);
    assert.match(renderSyncnetBanner(warning), /data-easy-syncnet-warning/);
  }
  assert.equal(syncnetSkipWarning({ warnings: [{ code: 'PLAN_ORBIT_UNRELIABLE', message: 'orbit' }] }), null);
});

test('the Plan, Generate and Review steps show the SyncNet warning before the next action', () => {
  const state = {
    ...defaultEasyState(),
    packageId: 'pkg_plan',
    productionId: 'prod_0123456789abcdef01234567',
    compute: 'cpu' as const,
    plan: { status: 'ready' as const, error: null, errorAt: null, wordsChanged: false },
  };
  const plan = renderPlan(state, FACTS, {
    snapshot: {
      productionId: state.productionId,
      production: { id: state.productionId, revision: 1 },
      revision: 1,
      events: [],
      gap: false,
      stale: false,
    },
    package: { id: 'pkg_plan', scenes: [] },
    syncnetNotice: NOTICE,
  });
  assert.match(plan, /data-easy-plan/);
  assert.match(plan, /data-easy-syncnet-warning/);
  assert.match(plan, /lip-sync will not be checked/);

  const review = renderReview({
    shots: [],
    gate: { ok: true, approved: 1, total: 1, blocking: [] },
    syncnetNotice: NOTICE,
  });
  assert.match(review, /data-easy-review/);
  assert.match(review, /data-easy-syncnet-warning/);

  const generate = renderGenerate(state, FACTS, { snapshot: { shots: [] }, syncnetNotice: NOTICE });
  assert.match(generate, /data-easy-generate/);
  assert.match(generate, /data-easy-syncnet-warning/);
});

test('the banner is loaded only for presenter projects when SyncNet is not configured', async () => {
  assert.equal(packageUsesPresenter({ presenter: { enabled: false } }), false);
  assert.equal(packageUsesPresenter({ presenter: { enabled: true } }), true);
  assert.equal(packageUsesPresenter({
    assets: { a_presenter: { kind: 'video', gen: { generator: 'ltx25-a2v' } } },
  }), true);

  const calls: string[] = [];
  const banners: string[] = [];
  const skipped = await loadSyncnetBanner({
    host: { getPackage: () => ({ presenter: { enabled: true } }) },
    api: {
      pipelineDiagnostics: async () => {
        calls.push('diagnostics');
        return { syncnet: { configured: false, code: 'SYNCNET_UNAVAILABLE' } };
      },
    },
  });
  assert.deepEqual(calls, ['diagnostics']);
  assert.match(skipped ?? '', /data-easy-syncnet-warning/);
  banners.push(skipped ?? '');

  const ready = await loadSyncnetBanner({
    host: { getPackage: () => ({ assets: { a_talking: { gen: { generator: 'ltx25-a2v' } } } }) },
    api: { pipelineDiagnostics: async () => ({ syncnet: { configured: true } }) },
  });
  assert.equal(ready, '');

  let asked = false;
  const absent = await loadSyncnetBanner({
    host: { getPackage: () => ({ presenter: { enabled: false }, assets: {} }) },
    api: {
      pipelineDiagnostics: async () => {
        asked = true;
        return { syncnet: { configured: false } };
      },
    },
  });
  assert.equal(absent, null);
  assert.equal(asked, false);
  assert.equal(banners[0]?.includes(COPY.syncnet.skipped), true);
});
