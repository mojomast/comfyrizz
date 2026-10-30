import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { loadEnv } from './easy-helpers.ts';

test('a CPU-blocked saved plan survives reload and Colab setup without another planning request', async ({ page }) => {
  const env = loadEnv();
  const pkg = JSON.parse(readFileSync(new URL('../../../examples/pip-night-shift/package.json', import.meta.url), 'utf8'));
  const timeline = JSON.parse(readFileSync(new URL('../../../examples/pip-night-shift/timeline.json', import.meta.url), 'utf8'));
  pkg.id = 'pkg_compute_recovery';
  pkg.revision = 59;
  pkg.assets.a_pending_video = { kind: 'video', status: 'pending', gen: { generator: 'fasth3-omni' } };
  pkg.scenes[0].media = [{ asset: 'a_pending_video' }];
  const productionId = 'prod_compute_recovery';
  const events = [{ id: 'evt_cpu_plan', sequence: 1, type: 'plan.proposed', productionId,
    data: { id: 'plan_cpu', productionId, revision: 2, planHash: 'c'.repeat(64), actions: [], requiredDecisions: [], reservationCeiling: 0, collectAndStopReserve: 0 } }];
  const mutations: string[] = [];
  await page.route('**/api/**', async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    const send = (body: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (request.method() !== 'GET') mutations.push(path);
    if (path === '/api/compile') return send({ timeline, revision: 59 });
    if (request.method() !== 'GET') return send({ error: 'Stopped at execution boundary for browser verification' }, 422);
    if (path === `/api/package/${pkg.id}`) return send({ package: pkg, revision: 59 });
    if (path === `/api/productions/${productionId}`) return send({ production: { id: productionId, packageId: pkg.id, revision: 2, lastSequence: 1, intent: 'active', actionIds: [] }, revision: 2, lastSequence: 1 });
    if (path === `/api/productions/${productionId}/events`) return send({ events, lastSequence: 1, nextAfter: 1, gap: false, truncated: false });
    if (path === '/api/colab/status') return send({ signedIn: true, installed: true, tokenChecked: true, tokenReady: true, units: 200, ratePerHour: 0 });
    if (path === '/api/agent/settings') return send({ active: { provider: 'custom', model: 'test-model' }, profiles: [{ id: 'custom', label: 'Test provider', preset: 'custom', model: 'test-model', configured: true, hasApiKey: true }], presets: [] });
    return send({});
  });
  await page.goto(`/#token=${env.token}`);
  await expect(page.locator('[data-super-easy-home]')).toBeVisible();
  await page.evaluate(async ({ packageId, productionId }) => {
    // Vite serves the actual store: this is a persisted pre-upgrade failure fixture.
    const { createEasyStore, planInputsHash } = await import('/src/easy/store.ts');
    const store = createEasyStore({ key: 'comfyrizz.easy.new' });
    store.patch({ packageId, productionId, compute: 'cpu', level: 'draft', spendCap: 9,
      idea: { ...store.get().idea, text: 'Keep the entire saved film exactly as reviewed.' },
      plan: { status: 'ready', error: null, errorAt: null, wordsChanged: false }, generate: { status: 'error' } });
    store.patch({ planHash: planInputsHash(store.get()), builtPackageInputsHash: planInputsHash(store.get()) });
    store.flush();
    localStorage.setItem('comfyrizz.super-easy.setup.v1', JSON.stringify({ compute: 'cpu', motionModel: 'auto', spendCap: 9, confirmed: false }));
  }, { packageId: pkg.id, productionId });
  await page.reload();
  await expect(page.locator('[data-super-easy-proposal]')).toBeVisible();
  await expect(page.locator('[data-super-easy-proposal] h1')).toHaveText(pkg.title);
  expect(mutations.every(path => path === '/api/compile')).toBe(true);
  await page.getByRole('button', { name: 'Make this film', exact: true }).click();
  const setup = page.getByRole('dialog', { name: 'Set up your video maker' });
  await expect(setup).toBeVisible();
  await expect(setup.locator('input[value="colab"]')).toBeChecked();
  await setup.getByRole('button', { name: 'Save setup', exact: true }).click();
  const confirmation = page.getByRole('dialog', { name: 'Use Google Colab automatically?' });
  await expect(confirmation).toBeVisible();
  await expect(confirmation).toContainText('9 Google Colab credits');
  await confirmation.getByRole('button', { name: 'Save and use Google Colab' }).click();
  await expect(page.locator('[data-super-easy-error-message]')).toContainText('Stopped at execution boundary');
  expect(mutations).not.toContain('/api/agent');
  expect(mutations).not.toContain('/api/run');
  expect(mutations).toContain(`/api/productions/${productionId}/easy-plan`);
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('comfyrizz.easy.new') ?? '{}').compute)).toBe('colab');
  const state = await page.evaluate(async () => (await import('/src/easy/store.ts')).createEasyStore({ key: 'comfyrizz.easy.new' }).get());
  expect(state.packageId).toBe(pkg.id);
  expect(state.productionId).toBe(productionId);
  expect(state.compute).toBe('colab');
  expect(state.spendCap).toBe(9);
});
