import { expect, test, type Page } from '@playwright/test';
import { compileTimeline } from '../../../packages/planner/dist/src/browser.js';
import { validateEditor } from '../../server/src/editor-sidecar.mjs';
import { neon } from '../test/fixtures/editor/neon.ts';

async function openNeon(page: Page, limited = false) {
  let pkg = neon();
  if (limited) pkg.scenes.slice(0, 2).forEach(scene => { scene.background!.trim = { startSeconds: 0, endSeconds: 4 }; });
  let editor: any = { version: 1, captionOverrides: [] };
  const saves: any[] = [];
  await page.route('**/api/**', async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const json = (value: unknown, status = 200) => route.fulfill({ status, json: value });
    if (path === `/api/package/${pkg.id}`) {
      if (request.method() === 'GET') return json({ package: pkg, revision: pkg.revision, editor, timeline: compileTimeline({ package: pkg, editor }), live: true });
      const payload = request.postDataJSON();
      expect(payload.baseRevision).toBe(pkg.revision);
      expect(compileTimeline({ package: payload.package, editor: payload.editor }).durationInFrames).toBe(360);
      const checked = validateEditor(payload.editor);
      expect(checked.error).toBeUndefined();
      saves.push(payload);
      pkg = { ...payload.package, revision: pkg.revision! + 1 }; editor = checked.editor;
      return json({ revision: pkg.revision, editSequence: payload.editSequence });
    }
    if (/\/(agent|runs|dispatch|render|export)$/.test(path) && request.method() === 'POST') throw new Error(`Unexpected production request ${path}`);
    if (path === '/api/events') return route.fulfill({ status: 200, contentType: 'text/event-stream', body: ': fixture\n\n' });
    if (path === '/api/agent/settings') return json({ profiles: [], active: { provider: 'none', model: '' } });
    return json({ profiles: [], productions: [], characters: [], references: [], assets: [], clips: [], jobs: [], runs: [], messages: [], attachments: [] });
  });
  await page.addInitScript(() => localStorage.setItem('comfyrizz.ui', JSON.stringify({ mode: 'advanced', density: 'compact' })));
  await page.goto(`/?package=${pkg.id}#token=exact-transition-test`);
  await expect(page.locator('#save-status')).toHaveAttribute('data-revision', '22');
  return { saves, pkg: () => pkg };
}
async function saved(page: Page, revision: number) {
  await expect(page.locator('#save-status')).toHaveAttribute('data-state', 'saved');
  await expect(page.locator('#save-status')).toHaveAttribute('data-revision', String(revision));
}

test('Neon normal overlap field applies atomically, refreshes selected durations, and survives reload/removal', async ({ page }) => {
  const api = await openNeon(page);
  const inspector = page.getByLabel('Transition and trim inspector');
  await page.getByTestId('scene-select').selectOption('shot1');
  await inspector.getByLabel('Transition frames', { exact: true }).fill('10');
  await inspector.getByLabel('Transition frames', { exact: true }).press('Enter');
  await saved(page, 23);
  expect(api.saves).toHaveLength(1);
  expect(api.pkg().scenes.map(scene => scene.preferredFrames)).toEqual([130, 120, 120]);
  await expect(inspector.getByLabel('Preferred frames', { exact: true })).toHaveValue('130');
  await page.getByTestId('scene-select').selectOption('shot2');
  await expect(inspector.getByLabel('Preferred frames', { exact: true })).toHaveValue('120');
  await inspector.getByLabel('Transition frames', { exact: true }).fill('10');
  await inspector.getByLabel('Transition frames', { exact: true }).press('Enter');
  await saved(page, 24);
  expect(api.pkg().scenes.map(scene => scene.preferredFrames)).toEqual([130, 130, 120]);
  const toolbar = page.getByRole('toolbar', { name: 'Timeline' });
  await toolbar.getByRole('button', { name: 'Undo', exact: true }).click();
  await saved(page, 25);
  expect(api.pkg().scenes.map(scene => scene.preferredFrames)).toEqual([130, 120, 120]);
  await toolbar.getByRole('button', { name: 'Redo', exact: true }).click();
  await saved(page, 26);
  expect(api.pkg().scenes.map(scene => scene.preferredFrames)).toEqual([130, 130, 120]);
  await page.reload();
  await page.getByTestId('scene-select').selectOption('shot1');
  await inspector.getByLabel('Transition type', { exact: true }).selectOption('cut');
  await saved(page, 27);
  expect(api.pkg().scenes.map(scene => scene.preferredFrames)).toEqual([120, 130, 120]);
  await page.getByTestId('scene-select').selectOption('shot3');
  await expect(inspector.getByLabel('Transition type', { exact: true })).toBeDisabled();
  await expect(inspector.getByLabel('Transition frames', { exact: true })).toBeDisabled();
});

test('insufficient adjacent footage shows rejection; combined normal controls redistribute available coverage', async ({ page }) => {
  const api = await openNeon(page, true);
  const inspector = page.getByLabel('Transition and trim inspector');
  await page.getByTestId('scene-select').selectOption('shot1');
  await inspector.getByLabel('Transition frames', { exact: true }).fill('10');
  await inspector.getByLabel('Transition frames', { exact: true }).press('Enter');
  await expect(page.getByTestId('edit-status')).toContainText('Cannot change this overlap');
  expect(api.saves).toHaveLength(0);
  await inspector.getByText('Transition + scene durations', { exact: true }).click();
  await inspector.getByLabel('Combined overlap frames', { exact: true }).fill('10');
  await inspector.getByLabel('shot3 combined frames', { exact: true }).fill('130');
  await inspector.getByRole('button', { name: 'Apply transition + durations', exact: true }).click();
  await saved(page, 23);
  expect(api.saves).toHaveLength(1);
  expect(api.pkg().scenes.map(scene => scene.preferredFrames)).toEqual([120, 120, 130]);
});
