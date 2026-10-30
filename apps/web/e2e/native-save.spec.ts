/** Real main.ts, native timeline/storyboard controls and autosave; HTTP-only fake backend. */
import { readFileSync, writeFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { compileTimeline } from '../../../packages/planner/dist/src/browser.js';

function fixture() {
  const pkg = JSON.parse(readFileSync(new URL('../test/fixtures/editor/short/package.json', import.meta.url), 'utf8'));
  pkg.id = 'pkg_native_save_browser';
  pkg.revision = 5;
  pkg.title = 'MORNING STILL';
  pkg.voice = { ...pkg.voice, enabled: false };
  pkg.scenes = [pkg.scenes[0], pkg.scenes[2]];
  pkg.scenes[0].copy.headline = 'MORNING STILL';
  pkg.scenes[1].copy.headline = 'A SMALL PAUSE';
  return pkg;
}

async function backend(page: Page) {
  let pkg = fixture();
  let editor = { version: 1, captionOverrides: [] };
  const saves: any[] = [];
  const forbidden: string[] = [];
  let gate: Promise<void> | null = null;
  let release = () => {};
  const body = () => ({ package: pkg, revision: pkg.revision, editor, timeline: compileTimeline({ package: pkg, editor, editSequence: 0 }), live: true });
  await page.route('**/api/**', async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const json = (value: unknown, status = 200) => route.fulfill({ status, json: value });
    if (path === `/api/package/${pkg.id}`) {
      if (request.method() === 'GET') return json(body());
      const payload = request.postDataJSON();
      saves.push(payload);
      if (gate) await gate;
      if (payload.baseRevision !== pkg.revision) return json({ error: 'conflict', currentRevision: pkg.revision }, 409);
      pkg = { ...payload.package, revision: pkg.revision + 1 };
      editor = payload.editor;
      return json({ revision: pkg.revision, editSequence: payload.editSequence });
    }
    if (path === '/api/agent') return json(body());
    if (path === '/api/agent/settings') return json({ profiles: [], active: { provider: 'none', model: '' } });
    if (/\/runs|\/dispatch|\/render|\/export/.test(path) && request.method() === 'POST') {
      forbidden.push(path);
      return json({ error: 'Production is outside this editor test' }, 500);
    }
    if (path === '/api/events') return route.fulfill({ status: 200, contentType: 'text/event-stream', body: ': fixture\n\n' });
    if (path.endsWith('/clips')) return json({ clips: [] });
    if (path === '/api/chat' && request.method() === 'POST') return json({ id: 'chat_native_save_browser', chatId: 'chat_native_save_browser', messages: [] });
    if (path.startsWith('/api/chat/')) return json({ id: 'chat_native_save_browser', messages: [], attachments: [], references: [], characters: [] });
    if (path === '/api/productions') return json({ productions: [] });
    return json({ profiles: [], characters: [], references: [], assets: [], clips: [], jobs: [], runs: [], messages: [], attachments: [] });
  });
  return {
    saves, forbidden, pkg: () => pkg,
    hold() { gate = new Promise<void>(resolve => { release = resolve; }); },
    release() { gate = null; release(); },
    externalEdit() { pkg = { ...pkg, revision: pkg.revision + 1 }; },
  };
}

async function open(page: Page, mode: 'easy' | 'advanced' = 'advanced') {
  await page.addInitScript(mode => {
    localStorage.setItem('comfyrizz.ui', JSON.stringify({ mode, density: 'compact' }));
    localStorage.setItem('comfyrizz.super-easy.setup.v1', JSON.stringify({ compute: 'cpu', motionModel: 'klein', spendCap: 15, confirmed: true }));
  }, mode);
  await page.goto('/?package=pkg_native_save_browser#token=native-save-test');
  await expect(page.locator('#save-status')).toHaveAttribute('data-revision', '5');
}

const headline = (page: Page, id = 's_open_2') => page.locator(`#storyboard input[data-scene="${id}"][data-field="headline"]`);
const saved = async (page: Page, revision: number) => {
  await expect(page.locator('#save-status')).toHaveAttribute('data-state', 'saved');
  await expect(page.locator('#save-status')).toHaveAttribute('data-revision', String(revision));
};

test('real main returns a newly saved timeline/copy/presenter proposal at revisions 5 → 6 → 7 → 8', async ({ page }, testInfo) => {
  const api = await backend(page);
  await open(page, 'easy');
  await page.getByRole('link', { name: 'Comfyrizz — return to Super Easy' }).click();
  await page.locator('#super-easy-prompt').fill('MORNING STILL, a quiet photograph with A SMALL PAUSE as the closing title.');
  await page.locator('[data-super-easy-generate]').click();
  await expect(page.locator('[data-super-easy-proposal]')).toBeVisible();
  await page.locator('[data-super-easy-review-edit-plan]').click();
  await page.getByRole('button', { name: 'Open in editor', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-mode', 'advanced');

  // Both native timeline commands in one debounce, matching the original correction.
  await page.getByTestId('scene-select').selectOption('s_close');
  const toolbar = page.getByRole('toolbar', { name: 'Timeline' });
  await toolbar.getByRole('button', { name: 'Delete', exact: true }).click();
  await toolbar.getByRole('button', { name: 'Duplicate', exact: true }).click();
  await saved(page, 6);
  expect(api.pkg().scenes.map((scene: any) => scene.id)).toEqual(['s_open', 's_open_2']);

  await headline(page).fill('A SMALL PAUSE');
  await saved(page, 7);
  await page.locator('[data-presenter-scene="s_open_2"]').selectOption('off');
  await saved(page, 8);
  expect(api.saves.map(save => save.baseRevision)).toEqual([5, 6, 7]);
  expect(api.pkg().scenes[1].copy.headline).toBe('A SMALL PAUSE');
  expect(api.pkg().scenes[1].presenter).toBe('off');
  await expect(page.locator('#draft')).toHaveText('saved · revision 8');
  // The standard mode return invokes refreshProposal through the actual host.getPackage.
  await page.keyboard.press('Control+Shift+A');
  await page.getByRole('link', { name: 'Comfyrizz — return to Super Easy' }).click();
  await expect(page.locator('[data-super-easy-proposal]')).toBeVisible();
  await expect(page.locator('[data-super-easy-proposal]')).toContainText('A SMALL PAUSE');
  await expect(page.getByRole('region', { name: 'Proposal changes' })).toContainText('s_open_2');
  expect(api.forbidden).toEqual([]);
  const screenshot = testInfo.outputPath('returned-proposal.png');
  await page.screenshot({ path: screenshot, fullPage: true });
  const evidence = testInfo.outputPath('saved-native-revisions.json');
  writeFileSync(evidence, JSON.stringify({ bases: api.saves.map(save => save.baseRevision), package: api.pkg() }, null, 2));
  await testInfo.attach('saved-native-revisions', { path: evidence, contentType: 'application/json' });
  await testInfo.attach('returned-proposal', { path: screenshot, contentType: 'image/png' });
});

test('real main preserves typing across delayed acknowledgements, serializes presenter and surfaces 409', async ({ page }) => {
  const api = await backend(page);
  await open(page);
  api.hold();
  await headline(page, 's_open').fill('First local edit');
  await expect.poll(() => api.saves.length).toBe(1);
  // Real input events, including focus/caret preservation when onDocument paints.
  await headline(page, 's_open').fill('Newer local edit');
  await headline(page, 's_open').pressSequentially(' stays');
  await page.locator('#storyboard input[data-scene="s_open"][data-field="kicker"]').fill('A QUIET MOMENT');
  await page.locator('#storyboard input[data-scene="s_open"][data-field="sub"]').fill('Supporting copy is saved too');
  await page.locator('[data-presenter-scene="s_open"]').selectOption('off');
  await expect(page.locator('#save-status')).toHaveAttribute('data-state', 'pending');
  api.release();
  await saved(page, 7);
  expect(api.saves.map(save => save.baseRevision)).toEqual([5, 6]);
  expect(api.pkg().scenes[0].copy.headline).toBe('Newer local edit stays');
  expect(api.pkg().scenes[0].copy.kicker).toBe('A QUIET MOMENT');
  expect(api.pkg().scenes[0].copy.sub).toBe('Supporting copy is saved too');
  expect(api.pkg().scenes[0].presenter).toBe('off');
  await expect(headline(page, 's_open')).toHaveValue('Newer local edit stays');
  api.externalEdit();
  await headline(page, 's_open').fill('Keep my conflicted text');
  await expect(page.locator('#save-status')).toHaveAttribute('data-state', 'conflict');
  await expect(headline(page, 's_open')).toHaveValue('Keep my conflicted text');
  await page.locator('[data-presenter-scene="s_open"]').selectOption('pip');
  await expect(page.locator('#activity')).toContainText('Revision conflict');
  expect(api.saves.map(save => save.baseRevision)).toEqual([5, 6, 7]);
  expect(api.pkg().scenes[0].copy.headline).toBe('Newer local edit stays');
  expect(api.forbidden).toEqual([]);
});
