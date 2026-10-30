/**
 * Saved-project continuity against the shipped Vite app and real HTTP server.
 * Only the model is scripted (a loopback Chat Completions endpoint). No page
 * harness, mocked package/chat responses, generation, or paid provider calls.
 */
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { join } from 'node:path';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { api, loadEnv } from './easy-helpers.ts';

const PROJECTS = [
  { id: 'pkg_continuity_lantern', title: 'Lanterns over the harbour', revision: 7, headline: 'Lanterns light the harbour' },
  { id: 'pkg_continuity_orchard', title: 'The midnight orchard', revision: 12, headline: 'An orchard beneath the moon' },
] as const;
type Project = typeof PROJECTS[number];
const PIP = 'pkg_pipnightshift01';
const MODEL = 'continuity-scripted';
const REPLY = 'Scripted continuity reply: your saved project is unchanged.';
test.describe.configure({ timeout: 120_000 });
let provider: Server;
let providerId: string;
let modelCalls: Array<{ model: string; messages: unknown[] }> = [];
let forbiddenRequests: string[] = [];

function seedProjects(): void {
  const env = loadEnv();
  const seed = JSON.parse(readFileSync(join(env.runtimeDir, 'seed/package.json'), 'utf8'));
  for (const project of PROJECTS) {
    const pkg = structuredClone(seed);
    Object.assign(pkg, { id: project.id, title: project.title, revision: project.revision });
    pkg.scenes[0].copy.headline = project.headline;
    writeFileSync(join(env.runtimeDir, 'packages', `${project.id}.json`), JSON.stringify(pkg));
    copyFileSync(join(env.runtimeDir, 'seed/editor.json'), join(env.runtimeDir, 'editor', `${project.id}.json`));
  }
}

function card(page: Page, project: Project): Locator {
  return page.locator(`[data-project-id="${project.id}"]`);
}

async function openGallery(page: Page): Promise<void> {
  await page.goto(`/?view=projects#token=${encodeURIComponent(loadEnv().token)}`);
  await expect(page.getByRole('heading', { name: 'Projects', exact: true })).toBeVisible({ timeout: 20_000 });
  for (const project of PROJECTS) await expect(card(page, project).getByRole('heading')).toHaveText(project.title);
  await expect(page).not.toHaveURL(/token=/);
}

async function expectIdentity(page: Page, project: Project): Promise<void> {
  await expect(page).toHaveURL(url => url.searchParams.get('package') === project.id);
  await expect(page.locator('#project-name')).toHaveText(project.title);
  await expect(page.locator('#save-status')).toHaveAttribute('data-revision', String(project.revision));
  // Scene content distinguishes the documents, rather than trusting the URL alone.
  await expect(page.getByTestId('scene').first()).toContainText(project.headline);
  await expect(page.getByTestId('scene')).toHaveCount(3);
}

async function expectEditor(page: Page, project: Project): Promise<void> {
  await expect(page.locator('#app')).toBeVisible();
  await expectIdentity(page, project);
  await expect(page.locator('#project-name')).toBeVisible();
}

async function projectsLink(page: Page): Promise<Locator> {
  const link = page.getByRole('link', { name: 'Projects', exact: true });
  await expect(link).toBeVisible();
  const href = await link.getAttribute('href');
  const query = new URL(href!, page.url()).searchParams;
  expect(query.get('view')).toBe('projects');
  for (const key of ['package', 'chat', 'production', 'step']) expect(query.has(key)).toBe(false);
  return link;
}

test.beforeAll(async () => {
  provider = createServer(async (request, response) => {
    if (request.url === '/v1/models') {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ data: [{ id: MODEL }] }));
      return;
    }
    if (request.method !== 'POST' || request.url !== '/v1/chat/completions') {
      response.writeHead(404).end();
      return;
    }
    let raw = '';
    for await (const chunk of request) raw += chunk;
    modelCalls.push(JSON.parse(raw));
    response.setHeader('content-type', 'text/event-stream');
    response.end(`data: ${JSON.stringify({ choices: [{ delta: { content: REPLY }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve));
  const address = provider.address();
  if (!address || typeof address === 'string') throw new Error('Scripted provider did not bind to loopback');
  const result = await api(loadEnv(), '/api/agent/settings', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'save', preset: 'custom', label: 'Continuity scripted model', baseUrl: `http://127.0.0.1:${address.port}/v1`, model: MODEL, use: true }),
  });
  const settings = await result.json();
  expect(result.status, JSON.stringify(settings)).toBe(200);
  providerId = settings.savedId;
  expect(providerId).toBeTruthy();
});

test.afterAll(async () => {
  if (providerId) {
    await api(loadEnv(), '/api/agent/settings', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'delete', id: providerId }),
    });
  }
  if (provider) await new Promise<void>((resolve, reject) => provider.close(error => error ? reject(error) : resolve()));
});

test.beforeEach(async ({ page }) => {
  seedProjects();
  modelCalls = [];
  forbiddenRequests = [];
  // Enforce read-only navigation plus conversational turns. A regression cannot
  // quietly turn an editor-open click into generation or a provider probe.
  await page.route('**/api/**', async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    // Take-preview tickets are authenticated read access, not generation.
    const mediaTicket = /^\/api\/package\/[^/]+\/clips\/[^/]+\/takes\/[^/]+\/ticket$/.test(path);
    if (request.method() === 'POST' && path !== '/api/agent/chat' && !mediaTicket
      && !(path === '/api/agent/settings' && request.postDataJSON()?.action === 'select')) {
      forbiddenRequests.push(`${request.method()} ${path}`);
      await route.abort('blockedbyclient');
      return;
    }
    await route.continue();
  });
  await page.addInitScript(() => {
    if (sessionStorage.getItem('continuity-initialized')) return;
    sessionStorage.setItem('continuity-initialized', '1');
    // Deliberately stale global chat: an explicitly selected project must win.
    localStorage.setItem('comfyrizz.project-chat', 'chat_pipnightshift01');
    // Start in the shipped Easy default. An Editor link must still open Editor.
    localStorage.setItem('comfyrizz.ui', JSON.stringify({ mode: 'easy', density: 'compact' }));
  });
});

test.afterEach(() => {
  expect(forbiddenRequests, 'navigation must not start generation or probe a model').toEqual([]);
});

test('gallery exposes project-scoped links and opens both saved versions in Editor', async ({ page }) => {
  const packageRequests: string[] = [];
  page.on('request', (request) => {
    const path = new URL(request.url()).pathname;
    if (path.startsWith('/api/package/')) packageRequests.push(path);
  });
  await openGallery(page);
  // The collection route is not a project boot, even with a saved Pip alongside.
  expect(packageRequests).toEqual([]);
  for (const project of PROJECTS) {
    for (const [label, view] of [
      ['Super Easy', 'super-easy'], ['Easy', null],
      // Chat is the editor's package-scoped agent, so it keeps the same route.
      ['Editor', 'editor'], ['Chat with agent', 'editor'],
    ] as const) {
      const href = await card(page, project).getByRole('link', { name: label, exact: true }).getAttribute('href');
      const query = new URL(href!, page.url()).searchParams;
      expect(query.get('package')).toBe(project.id);
      expect(query.get('view')).toBe(view);
      // Easy derives the resume step; forcing `step=idea` would reopen finished work.
      expect(query.has('step')).toBe(false);
      expect(query.has('chat')).toBe(false);
    }
    // Navigation links flush autosave before assigning the real URL, so the
    // click intentionally does not schedule a navigation synchronously.
    await card(page, project).getByRole('link', { name: 'Editor', exact: true }).click({ noWaitAfter: true });
    await expectEditor(page, project);
    await page.reload();
    await expectEditor(page, project);
    await (await projectsLink(page)).click({ noWaitAfter: true });
    await expect(page.getByRole('heading', { name: 'Projects', exact: true })).toBeVisible();
    await expect(card(page, project)).toBeVisible();
  }
});

for (const project of PROJECTS) {
  test(`${project.title}: Super Easy → Easy → Editor survives reload and browser history`, async ({ page }) => {
    await openGallery(page);
    await card(page, project).getByRole('link', { name: 'Super Easy', exact: true }).click({ noWaitAfter: true });
    await expect(page.locator('[data-super-easy-home]')).toBeVisible({ timeout: 20_000 });
    await expect(page).toHaveURL(url => url.searchParams.get('package') === project.id);
    const more = page.locator('[data-super-easy-more-control]');
    expect(new URL((await more.getAttribute('href'))!, page.url()).searchParams.get('package')).toBe(project.id);
    await more.click();
    await expect(page.locator('[data-easy-shell]')).toBeVisible({ timeout: 20_000 });
    await expect(page.locator('[data-easy-name]')).toHaveText(project.title);
    await page.reload();
    await expect(page.locator('[data-easy-name]')).toHaveText(project.title, { timeout: 20_000 });
    await page.locator('[data-easy-open-editor]').click();
    await expectEditor(page, project);
    await page.goBack();
    await expect(page.locator('[data-easy-shell]')).toBeVisible({ timeout: 20_000 });
    await expect(page.locator('[data-easy-name]')).toHaveText(project.title);
    await page.goForward();
    await expectEditor(page, project);
    await page.reload();
    await expectEditor(page, project);
  });
}

async function sendChatTurn(page: Page, project: Project): Promise<{ prompt: string; reply: {
  built: boolean; conversation: { id: string; projectId: string | null; projectRevision: number | null };
} }> {
  const prompt = `Just a question about ${project.title}. Do not build or change anything.`;
  await page.locator('#prompt').fill(prompt);
  const pending = page.waitForResponse(response => new URL(response.url()).pathname === '/api/agent/chat'
    && response.request().method() === 'POST');
  await page.locator('#composer-send').click();
  const response = await pending;
  const request = response.request().postDataJSON();
  expect(request.expectedPackageId).toBe(project.id);
  expect(request.expectedPackageRevision).toBe(project.revision);
  expect(request.adoptPackageId ?? project.id).toBe(project.id);
  expect(request.provider).toBe(providerId);
  expect(request.model).toBe(MODEL);
  expect(response.status(), await response.text()).toBe(200);
  const reply = await response.json();
  expect(reply.built).toBe(false);
  expect(reply.conversation.projectId).toBe(project.id);
  expect(reply.conversation.projectRevision).toBe(project.revision);
  expect(reply.conversation.id).not.toBe('chat_pipnightshift01');
  await expect(page.locator('#messages')).toContainText(REPLY);
  return { prompt, reply };
}

test('gallery chat turns bind to each saved package and its exact revision', async ({ page }) => {
  await openGallery(page);
  const conversations: string[] = [];
  for (const [index, project] of PROJECTS.entries()) {
    await card(page, project).getByRole('link', { name: 'Chat with agent', exact: true }).click({ noWaitAfter: true });
    await expectEditor(page, project);
    const { reply } = await sendChatTurn(page, project);
    conversations.push(reply.conversation.id);
    if (index < PROJECTS.length - 1) {
      await (await projectsLink(page)).click({ noWaitAfter: true });
      await expect(page.getByRole('heading', { name: 'Projects', exact: true })).toBeVisible();
      await expect(card(page, project)).toBeVisible();
    }
  }
  expect(new Set(conversations).size).toBe(2);
  expect(modelCalls).toHaveLength(2);
  for (const project of PROJECTS) {
    const response = await api(loadEnv(), `/api/package/${project.id}`);
    expect(response.status).toBe(200);
    const stored = await response.json();
    expect(stored.package.title).toBe(project.title);
    expect(stored.revision).toBe(project.revision);
  }
});

test('reload restores the package-scoped conversation instead of a fresh Pip chat', async ({ page }) => {
  await openGallery(page);
  const project = PROJECTS[1];
  await card(page, project).getByRole('link', { name: 'Chat with agent', exact: true }).click({ noWaitAfter: true });
  await expectEditor(page, project);
  const { prompt } = await sendChatTurn(page, project);

  await page.reload();
  await expectEditor(page, project);
  await expect(page.locator('#messages')).toContainText(prompt);
  await expect(page.locator('#messages')).toContainText(REPLY);
  await expect(page.locator('#messages')).not.toContainText('Pip’s Night Shift is open for now');
  await expect(page.locator('#messages')).not.toContainText(`Just a question about ${PROJECTS[0].title}`);
});

for (const mode of ['view=editor', 'view=super-easy', 'step=idea']) {
  test(`missing project fails explicitly instead of showing Pip (${mode})`, async ({ page }) => {
    const loaded: string[] = [];
    page.on('request', request => loaded.push(new URL(request.url()).pathname));
    const missing = 'pkg_continuity_does_not_exist';
    await page.goto(`/?package=${missing}&${mode}#token=${encodeURIComponent(loadEnv().token)}`);
    await expect(page.getByText(/could(?:n['’]t| not) (?:open|load)|project (?:unavailable|not found)/i).first()).toBeVisible();
    await expect(page.locator('#app')).toBeHidden();
    await expect(page.locator('[data-easy-shell], [data-super-easy-home]')).toBeHidden();
    await expect(page).toHaveURL(url => url.searchParams.get('package') === missing);
    expect(loaded).not.toContain(`/api/package/${PIP}`);
  });
}

test('phone viewport can reach Projects and reopen the selected project', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/?view=super-easy#token=${encodeURIComponent(loadEnv().token)}`);
  const link = await projectsLink(page);
  await expect(link).toBeInViewport();
  await link.click({ noWaitAfter: true });
  await expect(page.getByRole('heading', { name: 'Projects', exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  const project = PROJECTS[1];
  await card(page, project).getByRole('link', { name: 'Easy', exact: true }).click({ noWaitAfter: true });
  await expect(page.locator('[data-easy-name]')).toHaveText(project.title, { timeout: 20_000 });
  await expect(page).toHaveURL(url => url.searchParams.get('package') === project.id);
  const back = await projectsLink(page);
  await expect(back).toBeInViewport();
  await back.click({ noWaitAfter: true });
  await expect(page.getByRole('heading', { name: 'Projects', exact: true })).toBeVisible();
  await expect(card(page, project)).toBeVisible();
});
