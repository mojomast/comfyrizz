/**
 * UX06 pre-fix harness (browser): the Super Easy CPU journey on the real app.
 *
 * Drives the real mounted Easy Studio against the real server: home -> prompt ->
 * Generate on "This computer". The server's offline planner builds the package, a
 * production is created and an Easy plan proposed. Nothing leaves loopback and no
 * paid backend is reachable (the server preloads the egress guard).
 *
 * Audit finding: the CPU build finishes but the Super Easy session waits for a
 * production "final ready" that the CPU path never produces (mount.ts gives the
 * session a no-op `go`), so the user is left on "Making your video 0%" with every
 * stage "Waiting", no Review/Export handoff and no way out. These tests assert the
 * behavior UX06 must deliver and are marked as known defects until it lands.
 */
import { expect, knownDefect, test, type Page } from './fixtures.ts';

const PROMPT = 'A friendly robot who learns to bake bread';
const SETTLE_MS = 20_000;

interface Journey {
  requests: string[];
  builtPackageId: () => string | null;
}

async function startCpuJourney(page: Page, token: string): Promise<Journey> {
  const requests: string[] = [];
  let builtPackageId: string | null = null;
  page.on('response', async response => {
    const url = new URL(response.url());
    if (!url.pathname.startsWith('/api/')) return;
    const method = response.request().method();
    if (method !== 'GET') requests.push(`${method} ${url.pathname.replace(/prod_[0-9a-f]+/u, ':production')} ${response.status()}`);
    if (method === 'POST' && url.pathname === '/api/agent' && response.ok()) {
      const body = await response.json().catch(() => null) as { package?: { id?: string } } | null;
      builtPackageId = body?.package?.id ?? builtPackageId;
    }
  });
  await page.goto(`/#token=${encodeURIComponent(token)}`);
  await page.locator('#super-easy-prompt').fill(PROMPT);
  await page.locator('[data-super-easy-generate]').click();
  await expect(page.locator('[data-super-easy-progress]')).toBeVisible();
  await expect.poll(() => builtPackageId, { message: 'the offline planner never built a package', timeout: SETTLE_MS }).not.toBeNull();
  return { requests, builtPackageId: () => builtPackageId };
}

test('CONTROL: Generate on This computer builds a real package and a production without any paid dispatch', async ({ page, env }) => {
  const journey = await startCpuJourney(page, env.token);
  await expect.poll(() => journey.requests.some(item => item.startsWith('POST /api/productions ')), { timeout: SETTLE_MS }).toBe(true);

  const stored = await (await fetch(`${env.api}/api/package/${journey.builtPackageId()}`, { headers: { 'x-comfyrizz-token': env.token, origin: env.api } })).json() as { package: { scenes: unknown[] } };
  expect(stored.package.scenes.length, 'the built package has scenes on the server').toBeGreaterThan(0);

  const paid = journey.requests.filter(item => /colab|pipeline|render|dispatch/iu.test(item));
  expect(paid, 'no paid or render dispatch from the CPU path').toEqual([]);
  await expect(page.locator('[data-super-easy-live]'), 'progress keeps a persistent polite live region').toHaveAttribute('aria-live', 'polite');
  await expect(page.getByText(/your video is ready/iu), 'no final-ready claim before an artifact exists').toHaveCount(0);
});

test('UX06 baseline: after the CPU build the user is handed to Review or Export', async ({ page, env }) => {
  knownDefect('UX06', 'CPU build completes but progress stays on "Making your video 0%" with no Review/Export handoff (audit P0/P1)');
  await startCpuJourney(page, env.token);
  const handoff = page.locator('[data-super-easy-progress]').getByRole('button', { name: /review|export|open|watch|edit/iu })
    .or(page.locator('[data-super-easy-progress]').getByRole('link', { name: /review|export|open|watch|edit/iu }))
    .or(page.locator('[data-super-easy-progress] video'));
  const reviewStep = page.locator('[data-easy-step="review"], [data-step="review"]');
  await expect(handoff.or(reviewStep).first(), 'a Review/Export handoff or a playable preview must appear').toBeVisible({ timeout: SETTLE_MS });
});

test('UX06 baseline: the progress view always offers a keyboard-reachable way out', async ({ page, env }) => {
  knownDefect('UX06', 'the progress view renders no controls at all, so there is no stop, retry or escape (audit P1)');
  await startCpuJourney(page, env.token);
  const escape = page.locator('[data-super-easy-progress]').getByRole('button', { name: /stop|cancel|back|start over|new video|try again/iu })
    .or(page.locator('[data-super-easy-progress]').getByRole('link', { name: /back|start over|new video/iu }));
  await expect(escape.first(), 'an escape control must be present while the build runs').toBeVisible({ timeout: 5_000 });
  await escape.first().focus();
  await expect(escape.first()).toBeFocused();
});
