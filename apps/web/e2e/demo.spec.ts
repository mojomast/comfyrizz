import { expect, test, type Page } from '@playwright/test';

const DEMO_URL = '/demo.html?fixture=1';

interface Network {
  api: string[];
  external: string[];
}

function watchNetwork(page: Page): Network {
  const seen: Network = { api: [], external: [] };
  page.on('request', request => {
    const url = new URL(request.url());
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return;
    if (url.hostname !== '127.0.0.1' && url.hostname !== 'localhost') {
      seen.external.push(request.url());
    }
    if (url.pathname.startsWith('/api/')) {
      seen.api.push(`${request.method()} ${url.pathname}`);
    }
  });
  return seen;
}

async function openDemo(page: Page): Promise<Network> {
  const network = watchNetwork(page);
  await page.goto(DEMO_URL);
  await expect(page.locator('#demo-mode')).toHaveAttribute('data-mode', 'fixture');
  await expect(page.locator('#storyboard .storyboard-scene')).toHaveCount(6);
  await expect(page.locator('#activity .activity-phase')).toHaveCount(5);
  return network;
}

function expectOffline(network: Network): void {
  expect(network.external, 'fixture mode must not call the network').toEqual([]);
  expect(network.api, 'fixture mode must not call the server API').toEqual([]);
}

test('fixture mode shows six scene chips, licence receipts and the verified stop', async ({ page }) => {
  const network = await openDemo(page);

  await expect(page.locator('#storyboard .storyboard-chip')).toHaveCount(6);
  await expect(page.locator('#storyboard .storyboard-scene[data-status="ready"]')).toHaveCount(6);

  const ok = page.locator('#licence-chips .licence-chip[data-tone="ok"]');
  const blocked = page.locator('#licence-chips .licence-chip[data-tone="blocked"]');
  await expect(ok).toHaveCount(1);
  await expect(blocked).toHaveCount(1);
  await expect(ok).toContainText('CC BY 4.0');
  await expect(blocked).toContainText('non-commercial');

  await expect(page.locator('#activity .activity-phase')).toHaveText([
    'VM up',
    'health',
    'jobs',
    'collected',
    'VM stopped (verified)',
  ]);
  expectOffline(network);
});

test('typing in chat shows an agent reply', async ({ page }) => {
  const network = await openDemo(page);
  const messages = page.locator('#chat .chat-message');
  await expect(messages).toHaveCount(2);

  await page.locator('#chat .chat-input').fill('make scene 3 warmer');
  await page.locator('#chat button.chat-send').click();

  await expect(messages).toHaveCount(4);
  await expect(messages.last()).toHaveAttribute('data-role', 'assistant');
  await expect(messages.last()).toContainText('Storyboard ready: 6 scenes');
  expectOffline(network);
});

test('editing a chart value patches the preview without a render', async ({ page }) => {
  const network = await openDemo(page);
  await expect(page.locator('#demo-preview-player')).toContainText('Comfyrizz');

  await page.locator('#demo-edit-scene').selectOption('s_chart');
  await page.locator('#demo-edit-value').fill('42');
  await page.locator('#demo-instant-edit button[type="submit"]').click();

  await expect(page.locator('#demo-edit-status')).toContainText('Updated s_chart in memory');
  await expect(page.locator('#demo-preview-player')).toContainText(/Google Colab renders\s*42/);
  await expect(page.locator('#storyboard .storyboard-scene[data-scene-id="s_chart"]')).toHaveAttribute('data-status', 'stale');
  expectOffline(network);
});

test('re-running scene 3 marks only scene 3 rerendering, then ready', async ({ page }) => {
  const network = await openDemo(page);
  const scene = page.locator('#storyboard .storyboard-scene[data-scene-id="s_stat"]');
  await expect(scene).toHaveAttribute('data-status', 'ready');

  await scene.locator('button.storyboard-rerun').click();

  await expect(page.locator('#storyboard .storyboard-scene[data-status="rerendering"]')).toHaveCount(1);
  await expect(scene).toHaveAttribute('data-status', 'rerendering');
  await expect(scene).toHaveAttribute('data-status', 'ready', { timeout: 15_000 });
  await expect(page.locator('#storyboard .storyboard-scene[data-status="rerendering"]')).toHaveCount(0);
  await expect(page.locator('#activity .activity-row').first()).toContainText('scene s_stat ready');
  expectOffline(network);
});

test('activity stays below chat at desktop, laptop and mobile widths', async ({ page }) => {
  await openDemo(page);

  for (const viewport of [
    { width: 1440, height: 900 },
    { width: 1100, height: 900 },
    { width: 390, height: 844 },
  ]) {
    await page.setViewportSize(viewport);
    const layout = await page.evaluate(() => {
      const chat = document.getElementById('chat')?.getBoundingClientRect();
      const activity = document.getElementById('activity')?.getBoundingClientRect();
      const send = document.querySelector('#chat .chat-send')?.getBoundingClientRect();
      const hit = send
        ? document.elementFromPoint(send.x + send.width / 2, send.y + send.height / 2)
        : null;
      return {
        chatBottom: chat ? chat.bottom : 0,
        activityTop: activity ? activity.top : 0,
        sendHit: Boolean(hit?.closest('#chat .chat-send')),
      };
    });

    expect(layout.activityTop, `activity overlaps chat at ${viewport.width}px`).toBeGreaterThanOrEqual(layout.chatBottom);
    expect(layout.sendHit, `chat send is covered at ${viewport.width}px`).toBe(true);
  }
});
