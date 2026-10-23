import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const source = readFileSync(fileURLToPath(new URL('../src/main.ts', import.meta.url)), 'utf8');
const indexHtml = readFileSync(fileURLToPath(new URL('../index.html', import.meta.url)), 'utf8');

function loadSummary(): (ok: boolean, notes: number) => string {
  const match = source.match(/export function qaPanelSummary\(ok: boolean, notes: number\): string \{[\s\S]*?\n\}/);
  if (!match) throw new Error('qaPanelSummary missing from main.ts');
  const body = match[0]
    .replace(/^export /, '')
    .replace(/: boolean/g, '')
    .replace(/: number/g, '')
    .replace(/: string/g, '');
  return new Function(`${body}\nreturn qaPanelSummary;`)();
}

test('frame quality check wording matches after a fixture render', async ({ page }) => {
  const summary = loadSummary();
  const passed = summary(true, 4);
  const problems = summary(false, 1);
  expect(passed).toBe('Quality check passed · 4 notes');
  expect(problems).toBe('Quality check found problems · 1 notes');
  expect(source).toContain('qaPanelSummary(qaState.ok, qaState.findings.length)');
  expect(source).not.toContain('QA pass');

  await page.setContent(`<div id="qa-panel"><span class="chip qa-ok">${passed}</span></div>`);
  await expect(page.locator('#qa-panel')).toHaveText('Quality check passed · 4 notes');
  await page.setContent(`<div id="qa-panel"><span class="chip qa-bad">${problems}</span></div>`);
  await expect(page.locator('#qa-panel')).toHaveText('Quality check found problems · 1 notes');
});

test('in Advanced there is no easy actions bar or storyboard re-render buttons', async ({ page }) => {
  expect(source).not.toContain('mountEasyActions');
  expect(source).not.toContain('renderModeSummary');
  expect(source).not.toContain('modeSummaryLabels');
  expect(source).not.toContain('id="easy-actions"');
  expect(source).not.toContain("id = 'easy-actions'");
  expect(source).not.toContain('Re-render scene');
  expect(source).not.toContain('data-scene-action="rerender"');
  expect(indexHtml).not.toContain('id="easy-actions"');
  expect(indexHtml).not.toContain('id="render-changes"');

  await page.setContent(indexHtml);
  await page.locator('html').evaluate(root => root.setAttribute('data-mode', 'advanced'));
  await expect(page.locator('#easy-actions')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Render changes' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Re-render scene' })).toHaveCount(0);
});

test('the top bar contains no text Storyboard', async ({ page }) => {
  expect(indexHtml).not.toContain('flow-stepper');
  expect(indexHtml).not.toContain('stepper-label');
  await page.setContent(indexHtml);
  await expect(page.locator('#topbar')).not.toContainText('Storyboard');
});

test('exactly one Export MP4 button, More contains Export bundle, and the rail has no Export bundle', async ({ page }) => {
  expect(source).not.toContain('>Export bundle</button>');
  expect(source).not.toContain('id="export-bundle"');
  expect(indexHtml).not.toContain('id="topbar-export-mp4"');
  await page.setContent(indexHtml);
  await expect(page.getByRole('button', { name: 'Export MP4' })).toHaveCount(1);
  await expect(page.locator('#export-menu')).toContainText('Export bundle');
  await expect(page.locator('#activity-pane')).not.toContainText('Export bundle');
  await expect(page.locator('#topbar')).not.toContainText('approved');
});

test('there is no Express button and Skip questions is a labelled checkbox', async ({ page }) => {
  expect(indexHtml).not.toContain('id="mode-express"');
  expect(source).toContain("briefMode = skipQuestions.checked ? 'express' : 'plan'");
  await page.setContent(indexHtml);
  await expect(page.getByRole('button', { name: 'Express' })).toHaveCount(0);
  const skip = page.getByRole('checkbox', { name: 'Skip questions' });
  await expect(skip).toHaveCount(1);
  await expect(skip).not.toBeChecked();
});

test('presenter quick chips and Regenerate media are gone, and scene chip ids stay', async () => {
  expect(source).not.toContain('WEB_PRESENTER_PRESETS');
  expect(source).not.toContain('Intro/outro');
  expect(source).not.toContain('data-presenter-preset');
  expect(source).not.toContain('>Regenerate media</button>');
  expect(source).toContain('>Try again</button>');
  expect(source).toContain("id: 'warmer'");
  expect(source).toContain("id: 'calmer-motion'");
  expect(source).toContain("id: 'more-depth'");
  expect(source).toContain("id: 'less-busy'");
  expect(source).toContain("label: 'Warmer'");
  expect(source).toContain("label: 'Calmer'");
  expect(source).toContain("label: 'More detail'");
  expect(source).toContain("label: 'Simpler'");
});
