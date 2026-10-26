/**
 * UX20 cross-browser acceptance configuration.
 *
 * Separate from `e2e/playwright.config.ts` (Chromium only, owned by the
 * component packets). Run it with `pnpm -C apps/web test:acceptance`.
 *
 * Projects
 *   chromium-desktop / firefox-desktop / webkit-desktop   1280x800 desktop
 *   chromium-390 / webkit-390                              390x844 touch emulation
 *   firefox-390                                            390x844 viewport only (Firefox has no mobile emulation)
 *   chromium-320                                           320x640 reflow stress width
 *
 * "webkit" is Playwright's WebKit build, "390" projects are emulation. Neither is
 * real iOS Safari or a real phone; reports must say so. Select a subset with
 * QA_BROWSERS=chromium,firefox (names are matched as substrings of project names).
 * `node e2e/acceptance/browser-report.mjs` prints which engines launch on this host.
 */
import { defineConfig, devices, type Project } from '@playwright/test';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const webPort = Number(process.env.QA_WEB_PORT ?? 4276);

const all: Project[] = [
  { name: 'chromium-desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 800 } } },
  { name: 'firefox-desktop', use: { ...devices['Desktop Firefox'], viewport: { width: 1280, height: 800 } } },
  { name: 'webkit-desktop', use: { ...devices['Desktop Safari'], viewport: { width: 1280, height: 800 } } },
  { name: 'chromium-390', use: { ...devices['Pixel 7'], viewport: { width: 390, height: 844 } } },
  { name: 'webkit-390', use: { ...devices['iPhone 13'], viewport: { width: 390, height: 844 } } },
  { name: 'firefox-390', use: { ...devices['Desktop Firefox'], viewport: { width: 390, height: 844 } } },
  { name: 'chromium-320', use: { ...devices['Pixel 7'], viewport: { width: 320, height: 640 } } },
];

const wanted = (process.env.QA_BROWSERS ?? '').split(',').map(part => part.trim()).filter(Boolean);
const projects = wanted.length ? all.filter(project => wanted.some(name => project.name.includes(name))) : all;

export default defineConfig({
  testDir: '.',
  testMatch: '*.spec.ts',
  outputDir: '../.output/acceptance-results',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  forbidOnly: Boolean(process.env.CI),
  reporter: [['list'], ['json', { outputFile: '../.output/acceptance-report.json' }], ['html', { open: 'never', outputFolder: '../.output/acceptance-html' }]],
  use: {
    baseURL: `http://127.0.0.1:${webPort}`,
    headless: true,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
    actionTimeout: 10_000,
    navigationTimeout: 20_000,
  },
  projects,
  webServer: {
    command: 'node --experimental-strip-types e2e/acceptance/serve.mjs',
    cwd: webRoot,
    url: `http://127.0.0.1:${webPort}`,
    reuseExistingServer: false,
    timeout: 90_000,
    stdout: 'pipe',
    stderr: 'pipe',
  },
});
