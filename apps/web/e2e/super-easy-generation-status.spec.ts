import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { loadEnv } from './easy-helpers.ts';

test('reload exposes completed generation, failed export and verified shutdown without restarting work', async ({ page }) => {
  const env = loadEnv();
  const pkg = JSON.parse(readFileSync(new URL('../../../examples/pip-night-shift/package.json', import.meta.url), 'utf8'));
  const timeline = JSON.parse(readFileSync(new URL('../../../examples/pip-night-shift/timeline.json', import.meta.url), 'utf8'));
  const packageId = 'pkg_generation_activity', productionId = 'prod_generation_activity', runId = 'run_123456789abc';
  pkg.id = packageId; pkg.revision = 60;
  const events = [
    { productionId, sequence: 1, type: 'plan.proposed', data: { planHash: 'approved' } },
    { productionId, sequence: 2, type: 'action.state_changed', data: { productionId, kind: 'final', state: 'failed', runId, planHash: 'approved' } },
  ];
  const mutations: string[] = [];
  let reads = 0;
  await page.route('**/api/**', route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    const send = (value: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(value) });
    if (request.method() !== 'GET') {
      if (path === '/api/compile') return send({ timeline, revision: pkg.revision });
      mutations.push(path); return send({ error: 'Unexpected mutation' }, 422);
    }
    if (path === `/api/package/${packageId}`) return send({ package: pkg, revision: pkg.revision });
    if (path === `/api/productions/${productionId}`) return send({ production: { id: productionId, packageId, revision: 2, lastSequence: 2, intent: 'active', actionIds: [] }, revision: 2, lastSequence: 2 });
    if (path === `/api/productions/${productionId}/events`) return send({ events, lastSequence: 2, nextAfter: 2, gap: false, truncated: false });
    if (path === `/api/run/${runId}`) {
      reads++;
      return send({ run: { runId, productionId, packageId, revision: 60, status: 'failed', jobs: 31, counts: { succeeded: 31 },
        startedAt: '2026-10-30T04:45:06.917Z', finishedAt: '2026-10-30T05:15:37.666Z',
        errorCode: 'RENDER_FAILED', error: 'Completed media could not pass the verified contribution gate.',
        teardown: { state: 'stopped' }, result: { package: pkg }, events: [{ event: 'run_phase', phase: 'rendering' }] } });
    }
    if (path.startsWith('/api/render/artifacts/')) return send({ error: 'No final export' }, 404);
    return send({});
  });
  await page.goto(`/#token=${env.token}`);
  await expect(page.locator('[data-super-easy-home]')).toBeVisible();
  await page.evaluate(async ({ packageId, productionId }) => {
    const { createEasyStore, storageKey } = await import('/src/easy/store.ts');
    const store = createEasyStore({ key: storageKey(packageId) });
    store.patch({ packageId, productionId, generate: { status: 'running' } }); store.flush();
  }, { packageId, productionId });
  await page.goto(`/?view=super-easy&package=${packageId}`);
  const activity = page.locator('[data-generation-status]');
  await expect(activity).toContainText('Generation status: failed');
  await expect(activity).toContainText('31 / 31');
  await expect(activity).toContainText('GPU stop confirmed');
  await expect(activity).toContainText('verified contribution gate');
  await expect(page.locator('[data-super-easy-download]')).toHaveCount(0);
  await expect(page.locator('.super-easy-progress-title')).not.toContainText('Making your video');
  await page.reload();
  await expect(activity).toContainText('31 / 31');
  await expect(activity).toContainText('GPU stop confirmed');
  expect(reads).toBeGreaterThanOrEqual(2);
  expect(mutations).toEqual([]);
});
