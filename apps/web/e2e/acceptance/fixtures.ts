/**
 * UX20 shared Playwright fixtures.
 *
 *   env      the isolated acceptance server (token, ports, labelled media manifest)
 *   egress   automatic: every request that leaves loopback is aborted and recorded.
 *            A test that must observe a blocked request calls `egress.expectBlocked()`;
 *            otherwise any blocked request, and any line in the server's egress
 *            log, fails the test at teardown.
 *   project  `resetProject()` restores the seeded editor project between tests.
 *
 * Specs must assert real product behavior. They must never inject UI into the
 * page to make an assertion pass.
 */
import { copyFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test as base, type BrowserContext } from '@playwright/test';

export interface AcceptanceEnv {
  web: string;
  api: string;
  mediaBase: string;
  token: string;
  packageId: string;
  runtimeDir: string;
  egressLog: string;
  scrubbedEnvNames: string[];
  media: Record<string, { id: number; png: string; wav: string; mp4: string | null; mp4Skipped: string | null }>;
}

export function loadEnv(): AcceptanceEnv {
  return JSON.parse(readFileSync(new URL('../.output/acceptance-env.json', import.meta.url), 'utf8')) as AcceptanceEnv;
}

export function resetProject(env: AcceptanceEnv): void {
  const seed = join(env.runtimeDir, 'seed');
  copyFileSync(join(seed, 'package.json'), join(env.runtimeDir, 'packages', `${env.packageId}.json`));
  copyFileSync(join(seed, 'editor.json'), join(env.runtimeDir, 'editor', `${env.packageId}.json`));
  copyFileSync(join(seed, 'durations.json'), join(env.runtimeDir, 'packages', 'audio', 'durations.json'));
}

export async function api(env: AcceptanceEnv, path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set('x-comfyrizz-token', env.token);
  headers.set('origin', env.api);
  return fetch(`${env.api}${path}`, { ...init, headers });
}

const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

export interface EgressRecorder {
  /** Requests the browser tried to send off loopback (each was aborted). */
  blocked: string[];
  /** Declare that this test deliberately provokes `count` blocked requests. */
  expectBlocked(count: number): void;
}

async function installEgressRoute(context: BrowserContext, blocked: string[]): Promise<void> {
  await context.route('**/*', route => {
    const url = new URL(route.request().url());
    const local = ['data:', 'blob:', 'about:'].includes(url.protocol) || LOCAL_HOSTS.has(url.hostname);
    if (local) return route.fallback();
    blocked.push(`${route.request().method()} ${url.origin}${url.pathname}`);
    return route.abort('blockedbyclient');
  });
}

export const test = base.extend<{ env: AcceptanceEnv; egress: EgressRecorder }>({
  env: async ({}, use) => { await use(loadEnv()); },
  egress: [async ({ context, env }, use) => {
    const blocked: string[] = [];
    let expected = 0;
    await installEgressRoute(context, blocked);
    const serverBefore = readFileSync(env.egressLog, 'utf8').split('\n').filter(Boolean).length;
    await use({ blocked, expectBlocked(count) { expected = count; } });
    const serverLines = readFileSync(env.egressLog, 'utf8').split('\n').filter(Boolean);
    expect(serverLines.slice(serverBefore), 'the acceptance server tried to reach an external host').toEqual([]);
    expect(blocked.length, `unexpected outbound browser requests: ${blocked.join(', ')}`).toBe(expected);
  }, { auto: true }],
});

export { expect };

/** Open the seeded editor project in Advanced mode and wait for the first saved state. */
export async function openEditor(page: import('@playwright/test').Page, env: AcceptanceEnv): Promise<void> {
  await page.addInitScript(() => localStorage.setItem('comfyrizz.ui', JSON.stringify({ mode: 'advanced', density: 'compact' })));
  await page.goto(`/?package=${encodeURIComponent(env.packageId)}#token=${encodeURIComponent(env.token)}`);
  await expect(page.getByTestId('scene')).toHaveCount(3);
  await expect(page.locator('#save-status')).toHaveText('Saved');
  await expect(page).not.toHaveURL(/token=/);
}
