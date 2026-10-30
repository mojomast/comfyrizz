import { existsSync } from 'node:fs';
import { expect, test } from '@playwright/test';

const chromium = ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome'].find(existsSync);
if (chromium) test.use({ launchOptions: { executablePath: chromium, args: ['--no-sandbox'] } });
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nGQAAAAASUVORK5CYII=', 'base64');
const HARNESS = `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/src/ui/tokens.css"><link rel="stylesheet" href="/src/easy/components.css"><link rel="stylesheet" href="/src/easy/super-easy/progress-view.css"></head><body><div id="root"></div><script type="module">
import { mountSuperEasy } from '/src/easy/super-easy/mount.ts';
import { defaultEasyState } from '/src/easy/store.ts';
let allReady = sessionStorage.getItem('fixture-ready') === 'yes';
const state = { ...defaultEasyState(), productionId: 'prod_fixture', packageId: 'pkg_fixture' };
window.created = []; window.revoked = [];
const create = URL.createObjectURL.bind(URL), revoke = URL.revokeObjectURL.bind(URL);
URL.createObjectURL = blob => { const url = create(blob); window.created.push(url); return url; };
URL.revokeObjectURL = url => { window.revoked.push(url); revoke(url); };
const snapshot = () => {
  const pkg = { id:'pkg_fixture', scenes:[], assets:{} };
  for (let i = 0; i < 10; i++) {
    const video = 'video-'+(i+1), reference = 'ref-'+(i+1), ready = allReady || i === 0 || i === 7;
    pkg.scenes.push({id:'s'+(i+1), background:{asset:video}, media:[{asset:video},{asset:video}], foreground:i===0||i===7?[{asset:reference}]:[]});
    pkg.assets[video] = {kind:'video', status:'generating', gen:{inputs:{image:reference, prompt:'Pending motion '+(i+1)}, model:'ltx-2.5'}};
    pkg.assets[reference] = {kind:'image', status:ready?'ready':'queued', file:'assets/'+reference+'.png', media:{width:1920,height:1088,durationInSeconds:6},
      gen:{model:'flux-3-klein',workflow:'workflows/flux3_klein_t2i.api.json',inputs:{prompt:'Exact shot '+(i+1)+' prompt.\\nKeep the red door <open>.',seed:0}}};
  }
  return {production:{id:'prod_fixture',packageId:pkg.id},run:{runId:'run_fixture',productionId:'prod_fixture',packageId:pkg.id,result:{package:pkg}}};
};
const mount = mountSuperEasy({ root:document.getElementById('root'), state:()=>state, snapshot,
  previewFetch:(input, init)=>fetch(input, {...init, headers:{Authorization:'Bearer fixture-session'}}), onMoreControl(){} });
window.refreshAssets = () => { allReady = true; sessionStorage.setItem('fixture-ready','yes'); mount.render(); };
window.changeProject = () => { state.packageId = 'pkg_other'; state.productionId = null; state.generate.status = 'idle'; mount.render(); };
window.destroyFixture = () => mount.destroy();
window.fixtureReady = true;
</script></body></html>`;

for (const width of [1440, 390]) test(`ten-shot refreshed gallery and accessible exact-detail inspector at ${width}px`, async ({ page }) => {
  await page.setViewportSize({ width, height: 900 });
  const requests: string[] = [];
  await page.route('**/gallery-inspector-fixture', route => route.fulfill({ contentType: 'text/html', body: HARNESS }));
  await page.route('**/api/package/pkg_fixture/media?*', async route => {
    expect(route.request().headers().authorization).toBe('Bearer fixture-session');
    expect(route.request().url()).not.toContain('fixture-session');
    requests.push(route.request().url());
    await route.fulfill({ contentType: 'image/png', body: PNG });
  });
  await page.goto('/gallery-inspector-fixture');
  await page.waitForFunction(() => (window as any).fixtureReady);
  const thumbnails = page.locator('[data-gallery-kind="shot"] img');
  await expect(thumbnails).toHaveCount(2);
  await expect.poll(() => thumbnails.evaluateAll(nodes => nodes.filter(node => (node as HTMLImageElement).naturalWidth > 0).length)).toBe(2);
  await page.getByRole('button', { name: 'Inspect Shot 2', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('No preview yet · generating');
  await expect(page.getByRole('dialog')).toContainText('Pending motion 2');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: 'Inspect Shot 2', exact: true })).toBeFocused();
  await page.evaluate(() => (window as any).refreshAssets());
  await expect(thumbnails).toHaveCount(10);
  await expect.poll(() => thumbnails.evaluateAll(nodes => nodes.filter(node => (node as HTMLImageElement).naturalWidth > 0).length)).toBe(10);
  await page.reload();
  await expect(thumbnails).toHaveCount(10);
  await expect.poll(() => thumbnails.evaluateAll(nodes => nodes.filter(node => (node as HTMLImageElement).naturalWidth > 0).length)).toBe(10);
  await page.locator('[data-super-easy-gallery-item="shot:s3"] img').click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.locator('img')).toHaveJSProperty('naturalWidth', 1);
  await expect(dialog).toContainText('Conditioning reference — not a generated clip');
  await expect(dialog.locator('dd').filter({ hasText: /^Exact shot 3 prompt/ })).toHaveText('Exact shot 3 prompt.\nKeep the red door <open>.');
  await expect(dialog).toContainText('flux-3-klein');
  await expect(dialog).toContainText('workflows/flux3_klein_t2i.api.json');
  await expect(dialog).toContainText('1920 × 1088');
  await expect(dialog).toContainText('6 seconds');
  const bounds = await dialog.boundingBox();
  expect(bounds!.width).toBeLessThanOrEqual(width);
  await page.mouse.click(2, 2);
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Inspect Shot 3', exact: true })).toBeFocused();
  expect(requests.length).toBe(20);
  await page.evaluate(() => (window as any).changeProject());
  expect(await page.evaluate(() => (window as any).created.every((url: string) => (window as any).revoked.includes(url)))).toBe(true);
  await expect(page.getByRole('dialog')).toHaveCount(0);
});
