/**
 * Browser tests against the Vite app and the local server. Chromium, loopback,
 * no GPU. MIT, same as the repo.
 */
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Locator, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

interface Env {
  web: string;
  api: string;
  token: string;
  packageId: string;
  runtimeDir: string;
}

interface SceneShot { id: string; from: number; duration: number }
interface CaptionShot { sceneId: string; text: string; from: number; to: number }
interface Shot { duration: number; scenes: SceneShot[]; captions: CaptionShot[] }

function loadEnv(): Env {
  return JSON.parse(readFileSync(new URL('./.e2e-env.json', import.meta.url), 'utf8')) as Env;
}

function resetProject(env: Env): void {
  const seed = join(env.runtimeDir, 'seed');
  copyFileSync(join(seed, 'package.json'), join(env.runtimeDir, 'packages', `${env.packageId}.json`));
  copyFileSync(join(seed, 'editor.json'), join(env.runtimeDir, 'editor', `${env.packageId}.json`));
  copyFileSync(join(seed, 'durations.json'), join(env.runtimeDir, 'packages', 'audio', 'durations.json'));
}

async function api(env: Env, path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set('x-comfyrizz-token', env.token);
  headers.set('origin', env.api);
  return fetch(`${env.api}${path}`, { ...init, headers });
}

async function openEditor(page: Page, env: Env): Promise<void> {
  await page.goto(`/?package=${encodeURIComponent(env.packageId)}#token=${encodeURIComponent(env.token)}`);
  await expect(page.getByTestId('scene')).toHaveCount(3);
  await expect(page.getByTestId('caption').first()).toHaveText('one two three four.');
  await expectSave(page, 'Saved');
  await expect(page).not.toHaveURL(/token=/);
}

async function expectSave(page: Page, text: string): Promise<void> {
  await expect(page.locator('#save-status')).toHaveText(text);
  await expect(page.locator('.tl-status')).toHaveText(text);
  await expect(page.getByTestId('script-save-status')).toHaveText(text);
}

async function shot(page: Page): Promise<Shot> {
  const timeline = page.getByTestId('timeline');
  const duration = Number(await timeline.getAttribute('data-duration'));
  const scenes = await page.getByTestId('scene').evaluateAll(nodes => nodes.map(node => ({
    id: node.getAttribute('data-scene-id') ?? '',
    from: Number(node.getAttribute('data-from')),
    duration: Number(node.getAttribute('data-duration')),
  })));
  const captions = await page.getByTestId('caption').evaluateAll(nodes => nodes.map(node => ({
    sceneId: node.getAttribute('data-scene-id') ?? '',
    text: (node.textContent ?? '').trim(),
    from: Number(node.getAttribute('data-from')),
    to: Number(node.getAttribute('data-to')),
  })));
  return { duration, scenes, captions };
}

function scene(page: Page, id: string): Locator {
  return page.locator(`[data-testid="scene"][data-scene-id="${id}"]`);
}

async function sceneOrder(page: Page): Promise<string[]> {
  return (await shot(page)).scenes.map(item => item.id);
}

async function setZoom(page: Page, value: number): Promise<void> {
  await page.getByTestId('zoom').evaluate((input, next) => {
    const field = input as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    setter?.call(field, String(next));
    field.dispatchEvent(new Event('input', { bubbles: true }));
  }, value);
  await expect(page.getByTestId('zoom')).toHaveValue(String(value));
}

async function correctCaption(page: Page, text: string): Promise<void> {
  await page.getByTestId('sentences').locator('button').first().click();
  await page.getByTestId('caption-text').fill(text);
  await page.getByTestId('apply-caption').click();
  await expect(page.locator('[data-action]')).toHaveText('Edit applied.');
}

const toolbar = (page: Page) => page.getByRole('toolbar', { name: 'Timeline' });

/**
 * UO08: the scene panel keeps its less used controls in a collapsed "Advanced"
 * section, so the split control is only in view once that section is open.
 */
async function openSceneAdvanced(page: Page): Promise<void> {
  const details = page.getByTestId('script-audio').locator('details.sa-advanced');
  if (await details.evaluate(node => (node as HTMLDetailsElement).open)) return;
  await details.locator('summary').click();
  await expect.poll(() => details.evaluate(node => (node as HTMLDetailsElement).open)).toBe(true);
}

/** Pointer events the timeline listens for. Playwright's mouse path does not reach that handler. */
async function pointerDrag(page: Page, from: { x: number; y: number }, to: { x: number; y: number }, options: { alt?: boolean; release?: boolean; selector?: string } = {}): Promise<void> {
  await page.evaluate(async ({ from, to, alt, release, selector }) => {
    const downTarget = selector ? document.querySelector(selector) : document.elementFromPoint(from.x, from.y);
    const scroll = document.querySelector('.tl-scroll');
    if (!downTarget || !scroll) throw new Error('nothing under the pointer');
    const event = (x: number, y: number, buttons: number) => ({
      bubbles: true,
      cancelable: true,
      composed: true,
      pointerId: 1,
      pointerType: 'mouse',
      isPrimary: true,
      clientX: x,
      clientY: y,
      button: 0,
      buttons,
      altKey: alt,
    });
    downTarget.dispatchEvent(new PointerEvent('pointerdown', event(from.x, from.y, 1)));
    const steps = 8;
    for (let step = 1; step <= steps; step += 1) {
      const x = from.x + ((to.x - from.x) * step) / steps;
      const y = from.y + ((to.y - from.y) * step) / steps;
      scroll.dispatchEvent(new PointerEvent('pointermove', event(x, y, 1)));
      await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
    }
    if (release) scroll.dispatchEvent(new PointerEvent('pointerup', event(to.x, to.y, 0)));
  }, { from, to, alt: options.alt ?? false, release: options.release !== false, selector: options.selector ?? '' });
}

async function dragScene(page: Page, sceneId: string, dropX: number, release = true): Promise<void> {
  const scroll = page.locator('.tl-scroll');
  await scroll.scrollIntoViewIfNeeded();
  const scrollBox = await scroll.boundingBox();
  const box = await scene(page, sceneId).boundingBox();
  if (!scrollBox || !box) throw new Error('timeline is not visible');
  const from = { x: box.x + Math.min(36, box.width / 2), y: box.y + box.height / 2 };
  await pointerDrag(page, from, { x: scrollBox.x + dropX, y: from.y }, { release });
}

test.describe.configure({ mode: 'serial' });

test.beforeEach(() => {
  resetProject(loadEnv());
});

test('opens the fixture without putting the session token on media URLs', async ({ page }) => {
  const env = loadEnv();
  const urls: string[] = [];
  page.on('request', request => urls.push(request.url()));
  await openEditor(page, env);
  await expect(page.locator('#save-status')).toHaveAttribute('data-state', 'saved');
  const media = urls.filter(url => /\/media(?:\?|$)/.test(url));
  for (const url of media) expect(url).not.toContain(env.token);
  const srcs = await page.locator('img, audio, video, source').evaluateAll(nodes => nodes.map(node => {
    const element = node as HTMLImageElement | HTMLMediaElement | HTMLSourceElement;
    return element.getAttribute('src') ?? '';
  }));
  for (const src of srcs) {
    expect(src.includes('token=')).toBe(false);
    expect(src).not.toContain(env.token);
  }
});

test('zooms around the project and fits it back', async ({ page }) => {
  await openEditor(page, loadEnv());
  await expect(page.getByTestId('zoom')).toHaveValue('2');
  await toolbar(page).getByRole('button', { name: 'Zoom in' }).click();
  await expect(page.getByTestId('zoom')).toHaveValue('2.5');
  await page.getByTestId('timeline').focus();
  await page.keyboard.press('=');
  await expect.poll(async () => Number(await page.getByTestId('zoom').inputValue())).toBeGreaterThan(2.5);
  const zoomed = await page.getByTestId('zoom').inputValue();
  await toolbar(page).getByRole('button', { name: 'Fit' }).click();
  await expect(page.getByTestId('zoom')).not.toHaveValue(zoomed);
  const fitted = Number(await page.getByTestId('zoom').inputValue());
  expect(fitted).toBeGreaterThanOrEqual(0.2);
  expect(fitted).toBeLessThanOrEqual(14);
});

test('drags a scene to a new index and undo puts it back', async ({ page }) => {
  await openEditor(page, loadEnv());
  await setZoom(page, 1);
  await toolbar(page).getByRole('button', { name: 'Snap' }).click();
  const before = await sceneOrder(page);
  expect(before[0]).toBe('s_open');
  await dragScene(page, 's_open', 400);
  await expect.poll(() => sceneOrder(page)).not.toEqual(before);
  expect((await sceneOrder(page))[0]).not.toBe('s_open');
  await toolbar(page).getByRole('button', { name: 'Undo' }).click();
  await expect.poll(() => sceneOrder(page)).toEqual(before);
});

test('escape cancels a reorder drag', async ({ page }) => {
  await openEditor(page, loadEnv());
  await setZoom(page, 1);
  await toolbar(page).getByRole('button', { name: 'Snap' }).click();
  const before = await sceneOrder(page);
  await dragScene(page, 's_open', 400, false);
  await page.keyboard.press('Escape');
  await page.locator('.tl-scroll').dispatchEvent('pointerup', { pointerId: 1, buttons: 0 });
  await expect(page.getByTestId('edit-status')).toHaveText('Drag cancelled');
  expect(await sceneOrder(page)).toEqual(before);
});

test('reorders, trims, and undoes from the keyboard', async ({ page }) => {
  await openEditor(page, loadEnv());
  const before = await shot(page);
  await page.getByTestId('timeline').focus();
  await page.keyboard.press('Alt+ArrowDown');
  await expect.poll(() => sceneOrder(page)).toEqual(['s_body', 's_open', 's_close']);
  await page.keyboard.press('Control+z');
  await expect.poll(() => sceneOrder(page)).toEqual(before.scenes.map(item => item.id));
  await page.getByTestId('timeline').focus();
  await page.keyboard.press('[');
  await expect(scene(page, 's_open')).toHaveAttribute('data-duration', String(before.scenes[0].duration - 1));
  await page.keyboard.press('Control+z');
  await expect(scene(page, 's_open')).toHaveAttribute('data-duration', String(before.scenes[0].duration));
  const snap = toolbar(page).getByRole('button', { name: 'Snap' });
  await expect(snap).toHaveAttribute('aria-pressed', 'true');
  await page.getByTestId('timeline').focus();
  await page.keyboard.press('s');
  await expect(snap).toHaveAttribute('aria-pressed', 'false');
});

test('a focused field takes shortcut keys without editing the timeline', async ({ page }) => {
  await openEditor(page, loadEnv());
  const before = await shot(page);
  const snap = toolbar(page).getByRole('button', { name: 'Snap' });
  const preferred = page.getByLabel('Preferred frames');
  await preferred.click();
  await preferred.press('s');
  await preferred.press('[');
  await preferred.press(' ');
  await preferred.press('Alt+ArrowDown');
  await expect(snap).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#play')).toHaveText('Play');
  expect(await shot(page)).toEqual(before);
  const caption = page.getByTestId('caption-text');
  await caption.click();
  await caption.pressSequentially('s f [');
  await caption.press(' ');
  await caption.press('Alt+ArrowDown');
  await expect(caption).toHaveValue('s f [ ');
  await expect(snap).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#play')).toHaveText('Play');
  expect(await shot(page)).toEqual(before);
});

test('trim below the speech floor reports the effective length and undo restores it', async ({ page }) => {
  await openEditor(page, loadEnv());
  const before = Number(await scene(page, 's_open').getAttribute('data-duration'));
  const narration = await page.getByTestId('narration').inputValue();
  await page.getByLabel('Preferred frames').fill('1');
  await page.getByLabel('Preferred frames').press('Enter');
  await expect(page.getByTestId('edit-status')).toContainText(/Requested 1, effective \d+ \(floored/);
  const message = await page.getByTestId('edit-status').innerText();
  const effective = Number(/effective (\d+)/.exec(message)?.[1]);
  expect(effective).toBeGreaterThan(1);
  expect(effective).toBeLessThan(before);
  await expect(scene(page, 's_open')).toHaveAttribute('data-duration', String(effective));
  await expect(page.getByTestId('narration')).toHaveValue(narration);
  await toolbar(page).getByRole('button', { name: 'Undo' }).click();
  await expect(scene(page, 's_open')).toHaveAttribute('data-duration', String(before));
  await expect(page.getByTestId('edit-status')).toHaveText('');
});

test('dragging the trim handle floors a short request', async ({ page }) => {
  await openEditor(page, loadEnv());
  await setZoom(page, 4);
  const handle = scene(page, 's_open').getByTestId('trim-end');
  await handle.scrollIntoViewIfNeeded();
  const box = await handle.boundingBox();
  if (!box) throw new Error('trim handle is not visible');
  const before = Number(await scene(page, 's_open').getAttribute('data-duration'));
  const from = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  await pointerDrag(page, from, { x: from.x - 320, y: from.y }, {
    alt: true,
    selector: '[data-scene-id="s_open"] [data-testid="trim-end"]',
  });
  await expect(page.getByTestId('edit-status')).toContainText(/Requested \d+, effective \d+ \(floored/);
  const duration = Number(await scene(page, 's_open').getAttribute('data-duration'));
  expect(duration).toBeLessThan(before);
  expect(duration).toBeGreaterThan(1);
  await toolbar(page).getByRole('button', { name: 'Undo' }).click();
  await expect(scene(page, 's_open')).toHaveAttribute('data-duration', String(before));
});

test('reorder clears the outgoing transition on the new last scene', async ({ page }) => {
  await openEditor(page, loadEnv());
  await page.getByTestId('scene-select').selectOption('s_body');
  await expect(page.getByLabel('Transition type')).toHaveValue('slide');
  await toolbar(page).getByRole('button', { name: 'Move later' }).click();
  await expect.poll(() => sceneOrder(page)).toEqual(['s_open', 's_close', 's_body']);
  await expect(page.getByLabel('Transition type')).toHaveValue('cut');
  await expect(page.getByLabel('Transition frames')).toHaveValue('0');
  await expect(page.locator('.tl-inspector')).toContainText('out 0');
  await toolbar(page).getByRole('button', { name: 'Undo' }).click();
  await expect.poll(() => sceneOrder(page)).toEqual(['s_open', 's_body', 's_close']);
  await page.getByTestId('scene-select').selectOption('s_body');
  await expect(page.getByLabel('Transition type')).toHaveValue('slide');
});

test('a caption edit does not change narration, and a narration edit stales only that scene', async ({ page }) => {
  await openEditor(page, loadEnv());
  const narration = await page.getByTestId('narration').inputValue();
  await correctCaption(page, 'Open, carefully.');
  await expect(page.getByTestId('caption').first()).toHaveText('Open, carefully.');
  await expect(page.getByTestId('narration')).toHaveValue(narration);
  await expect(page.getByTestId('freshness')).toHaveText('Take fresh. Alignment fresh. Presenter unused.');
  await page.getByTestId('narration').fill(`${narration} edited`);
  await page.getByTestId('apply-narration').click();
  await expect(page.locator('[data-action]')).toHaveText('Edit applied.');
  await expect(page.getByTestId('freshness')).toHaveText('Take stale. Alignment stale. Presenter unused.');
  await expect(page.getByTestId('caption').filter({ hasText: 'Open, carefully.' })).toHaveCount(0);
  await page.getByTestId('scene-select').selectOption('s_body');
  await expect(page.getByTestId('freshness')).toHaveText('Take fresh. Alignment fresh. Presenter unused.');
  await expect(page.getByTestId('caption').filter({ hasText: 'The middle beat stays fresh.' })).toHaveCount(1);
  await toolbar(page).getByRole('button', { name: 'Undo' }).click();
  await page.getByTestId('scene-select').selectOption('s_open');
  await expect(page.getByTestId('freshness')).toHaveText('Take fresh. Alignment fresh. Presenter unused.');
});

test('split divides the captions and undo joins them', async ({ page }) => {
  await openEditor(page, loadEnv());
  await page.getByTestId('sentences').locator('button').nth(1).click();
  await expect(page.getByTestId('split-frame')).not.toHaveValue('0');
  await openSceneAdvanced(page);
  await page.getByTestId('split').click();
  await expect(page.locator('[data-action]')).toHaveText('Edit applied.');
  await expect(page.getByTestId('scene')).toHaveCount(4);
  const captions = (await shot(page)).captions;
  const left = captions.filter(item => item.sceneId === 's_open').map(item => item.text).join(' ');
  const right = captions.filter(item => item.sceneId === 's_open_2').map(item => item.text).join(' ');
  expect(left).toContain('one two three four.');
  expect(left).not.toContain('second sentence');
  expect(right).toContain('And a second sentence.');
  expect(right).not.toContain('one two');
  await page.getByTestId('scene-select').selectOption('s_body');
  await expect(page.getByTestId('freshness')).toHaveText('Take fresh. Alignment fresh. Presenter unused.');
  await toolbar(page).getByRole('button', { name: 'Undo' }).click();
  await expect(page.getByTestId('scene')).toHaveCount(3);
  const restored = (await shot(page)).captions.filter(item => item.sceneId === 's_open').map(item => item.text);
  expect(restored).toEqual(['one two three four.', 'And a second sentence.']);
});

test('autosave reports saving then saved, and reload keeps frames and captions', async ({ page }) => {
  const env = loadEnv();
  let release = () => {};
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/package/**', async route => {
    if (route.request().method() !== 'PATCH') return route.continue();
    await gate;
    await route.continue();
  });
  await openEditor(page, env);
  const before = await shot(page);
  await correctCaption(page, 'Saved caption.');
  await expectSave(page, 'Saving changes');
  await expect(page.locator('#save-status')).toHaveAttribute('data-state', 'pending');
  release();
  await expectSave(page, 'Saved');
  const edited = await shot(page);
  expect(edited.duration).toBe(before.duration);
  expect(edited.scenes).toEqual(before.scenes);
  expect(edited.captions.some(item => item.text === 'Saved caption.')).toBe(true);
  await page.reload();
  await expect(page.getByTestId('scene')).toHaveCount(3);
  const reloaded = await shot(page);
  expect(reloaded).toEqual(edited);
  await expectSave(page, 'Saved');
});

test('a rejected save keeps the edit and names the reason', async ({ page }) => {
  const env = loadEnv();
  await page.route('**/api/package/**', async route => {
    if (route.request().method() !== 'PATCH') return route.continue();
    await route.fulfill({
      status: 422,
      contentType: 'application/json',
      body: JSON.stringify({
        error: 'invalid package',
        details: [{ path: '/scenes/0/narration', message: 'narration is not speech you can save' }],
      }),
    });
  });
  await openEditor(page, env);
  await correctCaption(page, 'Kept locally.');
  await expectSave(page, 'Save rejected: invalid package: /scenes/0/narration narration is not speech you can save');
  await expect(page.locator('#save-status')).toHaveAttribute('data-state', 'rejected');
  await expect(page.getByTestId('caption').filter({ hasText: 'Kept locally.' })).toHaveCount(1);
});

test('an unreachable save is offline and keeps the edit', async ({ page }) => {
  await page.route('**/api/package/**', async route => {
    if (route.request().method() !== 'PATCH') return route.continue();
    return route.abort('failed');
  });
  await openEditor(page, loadEnv());
  await correctCaption(page, 'Still here.');
  await expectSave(page, 'Offline. Changes are kept on this device');
  await expect(page.locator('#save-status')).toHaveAttribute('data-state', 'offline');
  await expect(page.getByTestId('caption').filter({ hasText: 'Still here.' })).toHaveCount(1);
});

test('a real revision conflict keeps the local edit', async ({ page }) => {
  const env = loadEnv();
  let release = () => {};
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/package/**', async route => {
    if (route.request().method() !== 'PATCH') return route.continue();
    await gate;
    await route.continue();
  });
  await openEditor(page, env);
  const stored = await (await api(env, `/api/package/${env.packageId}`)).json() as { package: { revision: number } };
  await correctCaption(page, 'Conflicted caption.');
  await expectSave(page, 'Saving changes');
  const bump = await api(env, `/api/package/${env.packageId}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ baseRevision: stored.package.revision, package: stored.package }),
  });
  expect(bump.status).toBe(200);
  release();
  await expectSave(page, 'Revision conflict. A recovery copy is kept on this device');
  await expect(page.locator('#save-status')).toHaveAttribute('data-state', 'conflict');
  await expect(page.getByTestId('caption').filter({ hasText: 'Conflicted caption.' })).toHaveCount(1);
});

test('export zip matches the timeline and reimport keeps frames, starts and captions', async ({ page }) => {
  test.setTimeout(60_000);
  const env = loadEnv();
  await openEditor(page, env);
  const visible = await shot(page);
  const stored = await (await api(env, `/api/package/${env.packageId}`)).json() as {
    package: unknown;
    editor: unknown;
    revision: number;
  };
  const compiled = await (await api(env, '/api/compile', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      doc: { package: stored.package, editor: stored.editor, editSequence: 0 },
      revision: stored.revision,
      editSequence: 0,
    }),
  })).json() as {
    timeline: {
      durationInFrames: number;
      scenes: Array<{ id: string; from: number; durationInFrames: number }>;
      captions: Array<{ sceneId: string; text: string; from: number; to: number }>;
    };
  };
  expect(projectionOf(compiled.timeline)).toEqual(visible);

  await page.locator('#export-bundle').click();
  await expect(page.locator('#export-state')).toContainText(/\d+ captions/);
  await expect(page.locator('#export-state')).not.toContainText('export failed');
  const zip = readFileSync(join(env.runtimeDir, 'out', 'export', env.packageId, 'package.zip'));
  expect(zip.includes(env.token)).toBe(false);
  const entries = unzip(zip);
  const archivedTimeline = JSON.parse(entries.get('timeline.json')!.toString('utf8')) as typeof compiled.timeline;
  const archivedPackage = JSON.parse(entries.get('package.json')!.toString('utf8')) as { id: string };
  expect(archivedPackage.id).toBe(env.packageId);
  expect(projectionOf(archivedTimeline)).toEqual(visible);

  writeFileSyncPackage(env, entries.get('package.json')!);
  await page.reload();
  await expect(page.getByTestId('scene')).toHaveCount(3);
  expect(await shot(page)).toEqual(visible);
});

test('the editor page has no serious or critical accessibility violations', async ({ page }) => {
  await openEditor(page, loadEnv());
  const results = await new AxeBuilder({ page }).analyze();
  const blocking = results.violations.filter(item => item.impact === 'serious' || item.impact === 'critical');
  expect(blocking.map(item => ({
    id: item.id,
    impact: item.impact,
    nodes: item.nodes.slice(0, 3).map(node => node.target),
  }))).toEqual([]);
});

function projectionOf(timeline: {
  durationInFrames: number;
  scenes: Array<{ id: string; from: number; durationInFrames: number }>;
  captions: Array<{ sceneId: string; text: string; from: number; to: number }>;
}): Shot {
  return {
    duration: timeline.durationInFrames,
    scenes: timeline.scenes.map(item => ({ id: item.id, from: item.from, duration: item.durationInFrames })),
    captions: timeline.captions.map(item => ({ sceneId: item.sceneId, text: item.text, from: item.from, to: item.to })),
  };
}

function writeFileSyncPackage(env: Env, bytes: Buffer): void {
  writeFileSync(join(env.runtimeDir, 'packages', `${env.packageId}.json`), bytes);
}

function unzip(buffer: Buffer): Map<string, Buffer> {
  const entries = new Map<string, Buffer>();
  let offset = 0;
  while (offset + 30 <= buffer.length) {
    if (buffer.readUInt32LE(offset) !== 0x04034b50) break;
    const method = buffer.readUInt16LE(offset + 8);
    const nameLength = buffer.readUInt16LE(offset + 26);
    const extraLength = buffer.readUInt16LE(offset + 28);
    const size = buffer.readUInt32LE(offset + 22);
    const name = buffer.subarray(offset + 30, offset + 30 + nameLength).toString('utf8');
    const start = offset + 30 + nameLength + extraLength;
    if (method !== 0) throw new Error(`compressed zip entry ${name}`);
    entries.set(name, Buffer.from(buffer.subarray(start, start + size)));
    offset = start + size;
  }
  return entries;
}
