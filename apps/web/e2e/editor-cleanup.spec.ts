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
