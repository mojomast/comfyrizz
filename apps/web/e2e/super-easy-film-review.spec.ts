import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { loadEnv } from './easy-helpers.ts';

// Scripted HTTP repair backend; all browser API traffic is intercepted. No
// provider, GPU job, real repair turn or render is started by this fixture.
for (const output of ['verified', 'missing'] as const) {
  test(`finished-film review, explicit repair, ${output} output and status-only reload`, async ({ page }) => {
    const env = loadEnv();
    const pkg = JSON.parse(readFileSync(new URL('../../../examples/pip-night-shift/package.json', import.meta.url), 'utf8'));
    const timeline = JSON.parse(readFileSync(new URL('../../../examples/pip-night-shift/timeline.json', import.meta.url), 'utf8'));
    const packageId = `pkg_film_review_${output}`, productionId = 'prod_film_review';
    const runId = 'run_123456789abc', exportId = 'r_123456789abc';
    pkg.id = packageId; pkg.revision = 4;
    const original = Buffer.from('original scripted MP4 bytes');
    const repaired = Buffer.from('repaired scripted MP4 bytes');
    const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
    const events = [
      { id: 'evt_1', productionId, sequence: 1, type: 'plan.proposed', data: { planHash: 'approved' } },
      { id: 'evt_2', productionId, sequence: 2, type: 'action.state_changed', data: { productionId, kind: 'final', state: 'completed', runId, planHash: 'approved' } },
    ];
    const report = { reviewId: `rr_${'a'.repeat(64)}`, packageId, packageRevision: 4,
      artifact: { renderId: runId, videoSha256: hash(original) },
      capabilities: { visual: 'unavailable', humanAcceptance: 'not_assessed', speechTiming: 'measured' },
      speech: { status: 'measured', segments: [{ start: 0.1, end: 2, text: 'Scripted observed dialogue.' }] },
      findings: [{ check: 'visual_quality', status: 'unknown' }, { check: 'speech_transition_overlap', sceneId: pkg.scenes[0].id, status: 'needs_review' }] };
    let repair: any = null, finish = false, starts = 0, reviews = 0;
    const mutations: string[] = [];
    await page.route('**/api/**', async route => {
      const request = route.request(), path = new URL(request.url()).pathname;
      const send = (value: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(value) });
      if (request.method() !== 'GET') mutations.push(path);
      if (path === '/api/compile') return send({ timeline, revision: pkg.revision });
      if (path === `/api/package/${packageId}`) return send({ package: pkg, revision: pkg.revision });
      if (path === `/api/productions/${productionId}`) return send({ production: { id: productionId, packageId, revision: 2, lastSequence: 2, intent: 'active', actionIds: [] }, revision: 2, lastSequence: 2 });
      if (path === `/api/productions/${productionId}/events`) return send({ events, lastSequence: 2, nextAfter: 2, gap: false, truncated: false });
      if (path === `/api/run/${runId}`) return send({ run: { runId, productionId, packageId, revision: 4, status: 'completed' } });
      if (path === `/api/run/${runId}/video`) return route.fulfill({ status: 200, contentType: 'video/mp4', body: original });
      if (path === '/api/render-reviews') {
        reviews++;
        expect(request.postDataJSON()).toEqual({ packageId, expectedRevision: 4, renderId: runId });
        return send(report);
      }
      if (path === '/api/conversations') {
        expect(request.postDataJSON()).toEqual({ packageId });
        return send({ chatId: 'chat_film_review' });
      }
      if (path === '/api/self-repairs') {
        starts++;
        const input = request.postDataJSON();
        expect(input.maxRepairs).toBe(2);
        expect(input.authorizeExistingMediaRepair).toBe(true);
        expect(input.renderId).toBe(runId);
        // Script a committed existing-media edit before CPU-render completion.
        pkg.revision = 5;
        repair = { repairId: input.repairId, input, status: 'running', stage: 'render',
          currentRevision: 5, attempts: 1, renders: 1, reports: [report], packageRoundsReserved: 1 };
        return send(repair, 202);
      }
      if (path.startsWith('/api/self-repairs/')) {
        if (finish) repair = { ...repair, status: output === 'verified' ? 'completed' : 'stopped',
          stage: output === 'verified' ? 'inspect_render' : 'render',
          reason: output === 'verified' ? 'scoped_checks_satisfied' : 'render_failed',
          checksSatisfied: output === 'verified',
          ...(output === 'verified' ? { lastRenderId: exportId } : { error: { code: 'MISSING_OUTPUT', message: 'CPU output is missing.' } }) };
        return send(repair);
      }
      if (path.startsWith('/api/render/artifacts/')) {
        if (!finish || output === 'missing') return send({ error: 'No verified current-revision export' }, 404);
        if (path.endsWith('/video')) return route.fulfill({ status: 200, contentType: 'video/mp4', body: repaired, headers: { 'x-comfyrizz-video-sha256': hash(repaired) } });
        return send({ exportId, packageId, revision: 5, intent: 'final', videoSha256: hash(repaired), files: [{ bytes: repaired.length }], videoUrl: `/api/render/artifacts/${exportId}/video` });
      }
      if (request.method() !== 'GET') return send({ error: 'Unexpected mutation in scripted browser flow' }, 422);
      return send({});
    });
    await page.goto(`/#token=${env.token}`);
    await expect(page.locator('[data-super-easy-home]')).toBeVisible();
    await page.evaluate(async ({ packageId, productionId }) => {
      const { createEasyStore, storageKey } = await import('/src/easy/store.ts');
      const store = createEasyStore({ key: storageKey(packageId) });
      store.patch({ packageId, productionId, generate: { status: 'done' }, chatId: null }); store.flush();
    }, { packageId, productionId });
    await page.goto(`/?view=super-easy&package=${packageId}`);
    await expect(page.locator('[data-super-easy-download]')).toBeVisible();
    await page.getByRole('button', { name: 'Review & repair', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Review & repair', exact: true });
    await expect(dialog).toBeVisible(); expect(reviews).toBe(0); expect(starts).toBe(0);
    await dialog.getByRole('button', { name: 'Review finished film', exact: true }).click();
    await expect(dialog).toContainText('Speech evidence: measured');
    await expect(dialog).toContainText('human acceptance: not assessed');
    await dialog.getByRole('button', { name: 'Confirm existing-media repair' }).click();
    await expect(dialog).toContainText('explicitly authorize'); expect(starts).toBe(0);
    await dialog.locator('[data-film-rounds]').selectOption('2');
    await dialog.locator('[data-film-authorize]').check();
    await dialog.getByRole('button', { name: 'Confirm existing-media repair' }).click();
    await expect(dialog).toContainText('Previous video — not the current saved revision');
    await expect(page.locator('[data-super-easy-download]')).toHaveCount(0);
    expect(starts).toBe(1);
    const stored = await page.evaluate(packageId => JSON.parse(localStorage.getItem(`comfyrizz.film-repair.v1:${packageId}`)!), packageId);
    await dialog.getByRole('button', { name: 'Close', exact: true }).click();
    finish = true;
    await page.reload();
    await page.getByRole('button', { name: 'Review & repair', exact: true }).click();
    await expect(dialog).toContainText(stored.repairId);
    await expect(dialog).toContainText(output === 'verified' ? 'Scoped checks satisfied; human acceptance remains not assessed.' : 'CPU output is missing.');
    await expect(dialog).toContainText('Previous video — not the current saved revision');
    if (output === 'verified') {
      await expect(page.locator('[data-super-easy-download]')).toBeVisible();
      const bytes = await page.locator('[data-super-easy-download]').evaluate(async (link: HTMLAnchorElement) => (await fetch(link.href)).text());
      expect(bytes).toBe(repaired.toString());
    } else await expect(page.locator('[data-super-easy-download]')).toHaveCount(0);
    expect(starts).toBe(1); expect(reviews).toBe(1);
    expect(mutations.every(path => ['/api/compile', '/api/render-reviews', '/api/conversations', '/api/self-repairs'].includes(path))).toBe(true);
    await page.goto(`/?view=super-easy&package=${packageId}&demo=1`);
    await expect(page.locator('[data-super-easy-progress]')).toBeVisible();
    await expect(page.locator('[data-super-easy-review-repair]')).toHaveCount(0);
    expect(starts).toBe(1);
  });
}
