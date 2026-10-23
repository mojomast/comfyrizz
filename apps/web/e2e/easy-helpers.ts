/**
 * Shared Easy flow helpers. `loadEnv`, `resetProject` and `api` match
 * editor.spec.ts so a studio test can reset the same seeded project.
 */
import { copyFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, type Page } from '@playwright/test';

export interface Env {
  web: string;
  api: string;
  token: string;
  packageId: string;
  runtimeDir: string;
}

export function loadEnv(): Env {
  return JSON.parse(readFileSync(new URL('./.e2e-env.json', import.meta.url), 'utf8')) as Env;
}

export function resetProject(env: Env): void {
  const seed = join(env.runtimeDir, 'seed');
  copyFileSync(join(seed, 'package.json'), join(env.runtimeDir, 'packages', `${env.packageId}.json`));
  copyFileSync(join(seed, 'editor.json'), join(env.runtimeDir, 'editor', `${env.packageId}.json`));
  copyFileSync(join(seed, 'durations.json'), join(env.runtimeDir, 'packages', 'audio', 'durations.json'));
}

export async function api(env: Env, path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set('x-comfyrizz-token', env.token);
  headers.set('origin', env.api);
  return fetch(`${env.api}${path}`, { ...init, headers });
}

/** A new video: empty studio storage, then the token link. */
export async function openEasyNew(page: Page): Promise<Env> {
  const env = loadEnv();
  await page.addInitScript(() => {
    // A reload must keep the studio. Clear storage once per tab, not on every document.
    if (!sessionStorage.getItem('easy-e2e-booted')) {
      localStorage.clear();
      sessionStorage.setItem('easy-e2e-booted', '1');
    }
    const record = window as Window & { __easyClicks?: number };
    record.__easyClicks = 0;
    document.addEventListener('click', () => {
      record.__easyClicks = (record.__easyClicks ?? 0) + 1;
    }, true);
  });
  await page.goto(`/#token=${encodeURIComponent(env.token)}`);
  await expect(page.locator('#easy-root')).toBeVisible();
  await expect(page.locator('[data-easy-heading]')).toHaveText("What's your video about?");
  await expect(page).not.toHaveURL(/token=/);
  return env;
}

export async function clickCount(page: Page): Promise<number> {
  return page.evaluate(() => (window as Window & { __easyClicks?: number }).__easyClicks ?? 0);
}

export function primary(page: Page) {
  return page.locator('[data-easy-primary]');
}

export async function clickPrimary(page: Page): Promise<void> {
  const button = primary(page);
  await expect(button).toBeEnabled();
  await button.click();
}

/** The primary is at most five Tab presses forward from the step heading. */
export async function assertPrimaryWithinFiveTabs(page: Page): Promise<void> {
  const heading = page.locator('[data-easy-heading]');
  await heading.focus();
  const button = primary(page);
  for (let presses = 0; presses < 5; presses += 1) {
    const focused = await button.evaluate((element) => element === document.activeElement);
    if (focused) return;
    await page.keyboard.press('Tab');
  }
  await expect(button).toBeFocused();
}

const BANNED: string[] = [];

function isRunRequest(url: string): boolean {
  try {
    const path = new URL(url).pathname;
    return path === '/api/run' || path.startsWith('/api/run/');
  } catch {
    return false;
  }
}

/**
 * A paid call names a run backend (`backendId`, or `backend` outside an asset
 * `gen` record). Saving a package still carries `gen.backend` labels such as
 * `colab:G4` on assets the scripted agent already wrote. That save is not a run.
 */
function namesColabRunBackend(body: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return /"backendId"\s*:\s*"colab/.test(body);
  }
  const walk = (value: unknown, key: string | null): boolean => {
    if (key === 'gen') return false;
    if (typeof value === 'string') {
      if (key === 'backendId' && (value === 'colab' || value.startsWith('colab:'))) return true;
      if (key === 'backend' && value.startsWith('colab:')) return true;
      return false;
    }
    if (Array.isArray(value)) return value.some((item) => walk(item, null));
    if (value && typeof value === 'object') {
      return Object.entries(value as Record<string, unknown>).some(([child, next]) => walk(next, child));
    }
    return false;
  };
  return walk(parsed, null);
}

export function watchPaidCalls(page: Page): void {
  BANNED.length = 0;
  page.on('request', (request) => {
    const url = request.url();
    if (isRunRequest(url)) {
      BANNED.push(url);
      return;
    }
    const body = request.postData() ?? '';
    if (body.includes('colab') && namesColabRunBackend(body)) BANNED.push(body.slice(0, 180));
  });
}

export function assertNoPaidCalls(): void {
  expect(BANNED, `paid calls: ${BANNED.join(' | ')}`).toEqual([]);
}
