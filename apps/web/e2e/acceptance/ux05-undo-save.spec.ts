/**
 * UX05 pre-fix harness (browser): undo after a successful autosave.
 *
 * The real mounted editor, the real server (compare-and-set revisions), real
 * keyboard input. Asserts server state and the shared save-status element, not
 * internal store fields. `knownDefect()` (Playwright `test.fail`) marks the audited defect: this test is
 * EXPECTED to fail until UX05 lands. When it starts passing Playwright reports
 * "expected to fail"; UX05 then deletes the `knownDefect` line to lock the fix.
 */
import { api, expect, knownDefect, openEditor, resetProject, test } from './fixtures.ts';

async function serverState(env: Parameters<typeof api>[0]) {
  const response = await api(env, `/api/package/${env.packageId}`);
  expect(response.ok).toBe(true);
  const stored = await response.json() as { revision: number; package: { scenes: Array<{ id: string }> } };
  return { revision: stored.revision, order: stored.package.scenes.map(scene => scene.id) };
}

test.beforeEach(({ env }) => resetProject(env));

test('CONTROL: a keyboard reorder autosaves, advances the server revision and shows Saved', async ({ page, env }) => {
  await openEditor(page, env);
  const before = await serverState(env);
  await page.getByTestId('timeline').focus();
  await page.keyboard.press('Alt+ArrowDown');
  await expect(page.locator('#save-status')).toHaveText('Saved', { timeout: 15_000 });
  await expect.poll(async () => (await serverState(env)).revision).toBe(before.revision + 1);
  expect((await serverState(env)).order).toEqual(['s_body', 's_open', 's_close']);
});

test('UX05 baseline: edit, save, undo, save restores the original on the server without a revision conflict', async ({ page, env }) => {
  knownDefect('UX05', 'undo restores the pre-save CAS revision, so the second save conflicts (audit P1)');
  await openEditor(page, env);
  const before = await serverState(env);
  await page.getByTestId('timeline').focus();
  await page.keyboard.press('Alt+ArrowDown');
  await expect.poll(async () => (await serverState(env)).revision, { timeout: 15_000 }).toBe(before.revision + 1);
  await expect(page.locator('#save-status')).toHaveText('Saved');

  await page.keyboard.press('Control+z');
  await expect.poll(async () => (await serverState(env)).revision, { timeout: 15_000, message: 'the undo was never saved to the server' }).toBe(before.revision + 2);
  expect((await serverState(env)).order).toEqual(before.order);
  await expect(page.locator('#save-status')).toHaveText('Saved');
  await expect(page.locator('#save-status')).not.toHaveAttribute('data-state', 'conflict');
});
