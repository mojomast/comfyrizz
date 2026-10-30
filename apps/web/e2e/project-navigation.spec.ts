/** Real routing/bootstrap with local HTTP fixtures only: no model, render or GPU calls. */
import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';

async function fixture(page: Page) {
  const source = JSON.parse(readFileSync(new URL('../test/fixtures/editor/short/package.json', import.meta.url), 'utf8'));
  const projects = new Map(['a', 'b'].map(suffix => {
    const pkg = structuredClone(source);
    pkg.id = `pkg_navigation_${suffix}`;
    pkg.title = `Navigation project ${suffix.toUpperCase()}`;
    pkg.revision = 5;
    pkg.scenes[0].copy.headline = `Saved headline ${suffix.toUpperCase()}`;
    return [pkg.id, { package: pkg, editor: { version: 1, captionOverrides: [] } }];
  }));
  const requests: string[] = [];
  const paid: string[] = [];
  await page.route('**/api/**', async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    requests.push(path);
    if (request.method() === 'POST' && /\/(?:agent|run|render|export|dispatch)(?:\/|$)/.test(path)) {
      paid.push(path);
      return route.fulfill({ status: 500, json: { error: 'No generation in navigation tests' } });
    }
    const match = /^\/api\/package\/([^/]+)$/.exec(path);
    if (match) {
      const project = projects.get(match[1]);
      if (!project) return route.fulfill({ status: 404, json: { error: 'Project unavailable' } });
      if (request.method() === 'PATCH') {
        const payload = request.postDataJSON();
        project.package = { ...payload.package, revision: project.package.revision + 1 };
        project.editor = payload.editor;
        return route.fulfill({ json: { revision: project.package.revision, editSequence: payload.editSequence } });
      }
      return route.fulfill({ json: { ...project, revision: project.package.revision } });
    }
    if (path === '/api/events') return route.fulfill({ contentType: 'text/event-stream', body: ': navigation fixture\n\n' });
    if (path === '/api/agent/settings') return route.fulfill({ json: { profiles: [], active: { provider: 'none', model: '' } } });
    return route.fulfill({ json: { clips: [], profiles: [], characters: [], references: [], assets: [], jobs: [], runs: [], messages: [], attachments: [], productions: [] } });
  });
  return { projects, requests, paid };
}

test('saved project survives Editor/Studio mode switches, reload and browser history', async ({ page }) => {
  const api = await fixture(page);
  await page.goto('/?package=pkg_navigation_a&step=plan#token=navigation-fixture');
  await expect(page.locator('#easy-root')).toBeVisible();
  await page.getByRole('button', { name: 'Open in editor', exact: true }).click();
  await expect(page).toHaveURL(/package=pkg_navigation_a.*view=editor/);
  await expect(page.locator('#project-name')).toHaveText('Navigation project A');
  const headline = page.locator('#storyboard input[data-scene="s_open"][data-field="headline"]');
  await headline.fill('Edited navigation headline');
  await page.locator('#ui-mode-easy').click();
  await expect(page.locator('#easy-root')).toBeVisible();
  expect(api.projects.get('pkg_navigation_a')!.package.scenes[0].copy.headline).toBe('Edited navigation headline');
  await page.goBack();
  await expect(page.locator('#app')).toBeVisible();
  await expect(headline).toHaveValue('Edited navigation headline');
  await page.reload();
  await expect(page.locator('#project-name')).toHaveText('Navigation project A');
  await expect(headline).toHaveValue('Edited navigation headline');
  await page.goForward();
  await expect(page.locator('#easy-root')).toBeVisible();
  expect(api.requests).not.toContain('/api/package/pkg_pipnightshift01');
  expect(api.paid).toEqual([]);
});

test('cross-project back and forward reload the requested identity, not the previous document', async ({ page }) => {
  const api = await fixture(page);
  await page.goto('/?package=pkg_navigation_a&view=editor#token=navigation-fixture');
  await expect(page.locator('#project-name')).toHaveText('Navigation project A');
  // Reproduce an in-document history entry for a different project.
  await page.evaluate(() => {
    history.pushState({}, '', '?package=pkg_navigation_b&view=editor');
    dispatchEvent(new PopStateEvent('popstate'));
  }).catch(() => undefined);
  await expect(page.locator('#project-name')).toHaveText('Navigation project B');
  await page.goBack();
  await expect(page.locator('#project-name')).toHaveText('Navigation project A');
  await page.goForward();
  await expect(page.locator('#project-name')).toHaveText('Navigation project B');
  expect(api.requests).not.toContain('/api/package/pkg_pipnightshift01');
  expect(api.paid).toEqual([]);
});

test('hosted explicit Editor route opens the exact guest copy and preserves invite scope on return', async ({ page }) => {
  const api = await fixture(page);
  await page.goto('/?demo=1&package=pkg_navigation_a&view=editor#token=navigation-fixture');
  await expect(page.locator('#app')).toBeVisible();
  await expect(page.locator('#project-name')).toHaveText('Navigation project A');
  await page.locator('#ui-mode-easy').click();
  await expect(page.locator('#easy-root')).toBeVisible();
  expect(new URL(page.url()).searchParams.get('demo')).toBe('1');
  expect(new URL(page.url()).searchParams.get('package')).toBe('pkg_navigation_a');
  await page.reload();
  await expect(page.locator('#easy-root')).toBeVisible();
  expect(api.requests).not.toContain('/api/package/pkg_pipnightshift01');
  expect(api.requests).not.toContain('/api/events');
  expect(api.paid).toEqual([]);
});

test('an unavailable explicit project shows an actionable error and never mounts Pip', async ({ page }) => {
  const api = await fixture(page);
  await page.goto('/?package=pkg_missing&view=editor#token=navigation-fixture');
  await expect(page.locator('#app-launch-status')).toContainText('Could not open project pkg_missing');
  await expect(page.locator('#app-launch-status')).toContainText('HTTP 404');
  await expect(page.locator('#app-launch-retry')).toBeVisible();
  await expect(page.locator('#app')).toBeHidden();
  await expect(page.locator('#easy-root')).toBeHidden();
  expect(api.requests).not.toContain('/api/package/pkg_pipnightshift01');
  expect(api.paid).toEqual([]);
});
