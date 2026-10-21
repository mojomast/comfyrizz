import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page, type Route } from '@playwright/test';

let clip: Buffer;
test.beforeAll(() => {
  const { runtimeDir } = JSON.parse(readFileSync(new URL('./.e2e-env.json', import.meta.url), 'utf8'));
  const file = join(runtimeDir, 'playback.mp4');
  execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=30',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', '6',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac',
    '-movflags', '+faststart', '-y', file]);
  clip = readFileSync(file);
});

async function sendClip(route: Route) {
  const range = /^bytes=(\d+)-(\d*)$/.exec(route.request().headers().range ?? '');
  const start = range ? Number(range[1]) : 0;
  const end = range?.[2] ? Math.min(Number(range[2]), clip.length - 1) : clip.length - 1;
  await route.fulfill({ status: range ? 206 : 200, contentType: 'video/mp4',
    headers: { 'cache-control': 'no-store', 'accept-ranges': 'bytes',
      ...(range ? { 'content-range': `bytes ${start}-${end}/${clip.length}` } : {}) },
    body: clip.subarray(start, end + 1) });
}
async function open(page: Page) {
  await page.goto('/e2e/playback.html');
  await page.waitForFunction(() => (window as any).testPlayer && document.querySelector('video')?.readyState! >= 2);
}
const frame = (page: Page) => page.evaluate(() => (window as any).testPlayer.getCurrentFrame());

test('next clip decodes before its cut and reuses the warmed element without a buffering gap', async ({ page }) => {
  const requestedAt: Record<string, number> = {};
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/playback-media/*.mp4', async route => {
    const name = new URL(route.request().url()).pathname;
    requestedAt[name] = await page.evaluate(() => (window as any).testPlayer?.getCurrentFrame() ?? 0);
    await new Promise(resolve => setTimeout(resolve, 500));
    await sendClip(route);
  });
  await open(page);
  expect(await page.locator('video').count()).toBe(1);
  await page.evaluate(() => (window as any).testPlayer.play());
  await page.waitForFunction(() => {
    const next = document.querySelector<HTMLVideoElement>('video[src*="/2.mp4"]');
    return next && next.readyState >= 2 && Math.abs(next.currentTime - 0.5) < 0.1;
  });
  expect(await frame(page)).toBeLessThan(150);
  // The hidden clip is frozen on its trimmed opening frame, not playing early.
  await page.evaluate(() => { (window as any).warmedVideo = document.querySelector('video[src*="/2.mp4"]'); });
  expect(await page.locator('video[src*="/2.mp4"]').evaluate(v => (v as HTMLVideoElement).paused)).toBe(true);
  expect(requestedAt['/playback-media/2.mp4']).toBeLessThan(120);
  expect(requestedAt['/playback-media/3.mp4']).toBeUndefined();
  await page.waitForFunction(() => (window as any).testPlayer.getCurrentFrame() >= 165);
  await page.evaluate(() => (window as any).testPlayer.pause());
  expect(await page.evaluate(() => (window as any).warmedVideo === document.querySelector('video[src*="/2.mp4"]'))).toBe(true);
  expect(await page.evaluate(() => (window as any).playbackEvents.filter((e: any) => e.type === 'waiting' && e.frame > 10))).toEqual([]);
  expect(errors).toEqual([]);
});

test('a cold seek waits for the missing clip without advancing the timeline, then resumes', async ({ page }) => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/playback-media/*.mp4', async route => {
    if (route.request().url().endsWith('/3.mp4')) await gate;
    await sendClip(route);
  });
  try {
    await open(page);
    await page.evaluate(() => { (window as any).testPlayer.seekTo(300); (window as any).testPlayer.play(); });
    await page.waitForFunction(() => (window as any).playbackEvents.some((e: any) => e.type === 'waiting' && e.frame >= 300));
    const frozen = await frame(page);
    await page.waitForTimeout(350);
    expect(await frame(page)).toBe(frozen);
    release();
    await page.waitForFunction(() => (window as any).testPlayer.getCurrentFrame() >= 315);
    expect(await page.evaluate(() => (window as any).playbackEvents.some((e: any) => e.type === 'resume' && e.frame >= 300))).toBe(true);
  } finally { release(); }
});
