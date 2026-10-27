/**
 * Procedure capture in the real Super Easy app against the scripted
 * production fixture. Headless Chromium has no screen capture, so the first
 * test hands getDisplayMedia a canvas stream: the browser's own MediaRecorder
 * still encodes a real video. The second test keeps headless as it is and
 * checks the step-log-only path. No Google Colab call is made.
 */
import { readFileSync } from 'node:fs';
import { expect, test, type Download, type Page } from '@playwright/test';
import { procedureBackend } from './procedure-fixture.mjs';

const PROMPT = 'A friendly robot who learns to bake bread';

async function stubStudioStepTests(page: Page): Promise<void> {
  await page.route(/\/src\/easy\/steps\/[^/]+\.test\.ts(?:\?.*)?$/u, (route) => route.fulfill({
    status: 200,
    contentType: 'application/javascript',
    body: 'export {};',
  }));
}

async function shareCanvasAsTab(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const devices = navigator.mediaDevices;
    if (!devices) return;
    devices.getDisplayMedia = async () => {
      const canvas = document.createElement('canvas');
      canvas.width = 640;
      canvas.height = 360;
      const context = canvas.getContext('2d')!;
      let frame = 0;
      const draw = () => {
        frame += 1;
        context.fillStyle = `hsl(${frame % 360} 60% 40%)`;
        context.fillRect(0, 0, 640, 360);
        context.fillStyle = 'white';
        context.font = '32px sans-serif';
        context.fillText(`frame ${frame}`, 40, 80);
      };
      draw();
      setInterval(draw, 33);
      (window as unknown as { __shared: number }).__shared = ((window as unknown as { __shared?: number }).__shared ?? 0) + 1;
      return canvas.captureStream(30);
    };
  });
}

function collectDownloads(page: Page): Download[] {
  const downloads: Download[] = [];
  page.on('download', (download) => downloads.push(download));
  return downloads;
}

async function readDownload(download: Download): Promise<Buffer> {
  const path = await download.path();
  return readFileSync(path);
}

async function generateWithCapture(page: Page): Promise<void> {
  await page.goto('/?capture=1', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('[data-super-easy-home]')).toBeVisible({ timeout: 30_000 });
  const toggle = page.getByLabel('Record this run');
  await expect(toggle).toBeChecked();
  await page.locator('#super-easy-prompt').fill(PROMPT);
  await page.getByRole('button', { name: 'Generate', exact: true }).click();
}

test('Record this run saves a tab recording and a redacted step log when the video is ready', async ({ page }) => {
  test.setTimeout(120_000);
  await stubStudioStepTests(page);
  await shareCanvasAsTab(page);
  const backend = procedureBackend({ phaseMs: 400 });
  await page.route('**/api/**', (route) => backend.handle(route));
  const downloads = collectDownloads(page);

  await generateWithCapture(page);

  const badge = page.locator('[data-procedure-capture]');
  await expect(badge).toHaveAttribute('data-state', 'recording');
  await expect(badge).toContainText('Recording this run');
  await expect(page.locator('html')).toHaveAttribute('data-procedure-recording', 'true');
  await expect(page.locator('[data-super-easy-progress]')).toBeVisible();
  await expect(badge.locator('[data-procedure-capture-step]')).toContainText(/Plan|Characters|Shots|Google Colab/u, { timeout: 30_000 });

  await expect(page.locator('[data-super-easy-gallery-item="final"]')).toBeVisible({ timeout: 45_000 });
  // The finished screen stays in the recording for the tail, then both files save.
  await expect.poll(() => downloads.length, { timeout: 20_000 }).toBe(2);
  await expect(badge).toHaveAttribute('data-state', 'saved');
  await expect(badge).toContainText('Saved to your Downloads');
  await expect(page.locator('html')).not.toHaveAttribute('data-procedure-recording', 'true');

  const names = downloads.map((download) => download.suggestedFilename());
  const videoName = names.find((name) => /\.(?:webm|mp4)$/u.test(name));
  const journalName = names.find((name) => name.endsWith('.json'));
  expect(videoName).toMatch(/^comfyrizz-procedure-a-friendly-robot-who-learns-to-bake-brea-\d{8}-\d{6}\.(?:webm|mp4)$/u);
  expect(journalName).toBe(videoName!.replace(/\.(?:webm|mp4)$/u, '.json'));

  const video = await readDownload(downloads[names.indexOf(videoName!)]);
  expect(video.byteLength).toBeGreaterThan(1000);
  const isWebm = video.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]));
  const isMp4 = video.subarray(4, 8).toString('latin1') === 'ftyp';
  expect(isWebm || isMp4).toBe(true);

  const raw = (await readDownload(downloads[names.indexOf(journalName!)])).toString('utf8');
  const journal = JSON.parse(raw);
  expect(journal.format).toBe('comfyrizz.procedure/1');
  expect(journal.video.fileName).toBe(videoName);
  expect(journal.videoUnavailable).toBeNull();
  const labels: string[] = journal.entries.map((entry: { label: string }) => entry.label);
  expect(labels[0]).toBe('Procedure capture started');
  expect(labels).toContain(`Prompt: ${PROMPT}`);
  expect(labels).toContain('Starting on This computer');
  for (const expected of ['Plan: Done', 'Characters: Done', 'Shots: Done', 'Voice: Done', 'Video: Done', 'Final video ready', 'Google Colab session stopped']) {
    expect(labels).toContain(expected);
  }
  expect(labels.some((label) => label.startsWith('Starting a Google Colab session'))).toBe(true);
  expect(labels.at(-1)).toBe('Procedure capture stopped');
  const times = journal.entries.map((entry: { atMs: number }) => entry.atMs);
  expect(times).toEqual([...times].sort((left, right) => left - right));
  expect(raw).not.toMatch(/token|ticket|data:|https?:/u);
  expect(backend.calls.some((call) => call.startsWith('paid:'))).toBe(false);
});

test('without screen capture the run is still logged and only the step log is saved', async ({ page }) => {
  test.setTimeout(120_000);
  await stubStudioStepTests(page);
  await page.addInitScript(() => {
    if (navigator.mediaDevices) {
      navigator.mediaDevices.getDisplayMedia = async () => {
        throw new DOMException('Permission denied', 'NotAllowedError');
      };
    }
  });
  const backend = procedureBackend({ phaseMs: 300 });
  await page.route('**/api/**', (route) => backend.handle(route));
  const downloads = collectDownloads(page);

  await generateWithCapture(page);

  const badge = page.locator('[data-procedure-capture]');
  await expect(badge).toHaveAttribute('data-state', 'logging');
  await expect(badge).toContainText('Logging this run (no screen recording)');
  await expect(page.locator('[data-super-easy-gallery-item="final"]')).toBeVisible({ timeout: 45_000 });
  await expect.poll(() => downloads.length, { timeout: 20_000 }).toBe(1);
  expect(downloads[0].suggestedFilename()).toMatch(/\.json$/u);
  const journal = JSON.parse((await readDownload(downloads[0])).toString('utf8'));
  expect(journal.video).toBeNull();
  expect(journal.videoUnavailable).toBe('Screen sharing was not allowed, so only the step log is saved.');
  expect(journal.entries.map((entry: { label: string }) => entry.label)).toContain('Final video ready');
});

test('Stop and save ends the capture early, and an unticked box records nothing', async ({ page, browser, baseURL }) => {
  test.setTimeout(120_000);
  await stubStudioStepTests(page);
  await shareCanvasAsTab(page);
  const backend = procedureBackend({ phaseMs: 60_000 });
  await page.route('**/api/**', (route) => backend.handle(route));
  const downloads = collectDownloads(page);

  await generateWithCapture(page);
  const badge = page.locator('[data-procedure-capture]');
  await expect(badge).toHaveAttribute('data-state', 'recording');
  await page.waitForTimeout(1500);
  await badge.getByRole('button', { name: 'Stop and save' }).click();
  await expect.poll(() => downloads.length, { timeout: 20_000 }).toBe(2);
  await expect(badge).toHaveAttribute('data-state', 'saved');
  await badge.getByRole('button', { name: 'Dismiss' }).click();
  await expect(badge).toHaveCount(0);

  // A new context: the armed checkbox and the Super Easy choice live in storage.
  const context = await browser.newContext({ baseURL });
  const fresh = await context.newPage();
  await stubStudioStepTests(fresh);
  await shareCanvasAsTab(fresh);
  const freshBackend = procedureBackend({ phaseMs: 60_000 });
  await fresh.route('**/api/**', (route) => freshBackend.handle(route));
  await fresh.goto('/', { waitUntil: 'domcontentloaded' });
  await expect(fresh.locator('[data-super-easy-home]')).toBeVisible({ timeout: 30_000 });
  await expect(fresh.getByLabel('Record this run')).not.toBeChecked();
  await fresh.locator('#super-easy-prompt').fill(PROMPT);
  await fresh.getByRole('button', { name: 'Generate', exact: true }).click();
  await expect(fresh.locator('[data-super-easy-progress]')).toBeVisible();
  await expect(fresh.locator('[data-procedure-capture]')).toHaveCount(0);
  expect(await fresh.evaluate(() => (window as unknown as { __shared?: number }).__shared ?? 0)).toBe(0);
  await context.close();
});
