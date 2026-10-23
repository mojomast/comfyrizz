import { expect, test } from '@playwright/test';

test('the iteration step shows Draft, Balanced, Director, and Custom', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('comfyrizz.easy.new', JSON.stringify({
      version: 1,
      idea: { text: 'A bakery video at dawn with warm light' },
    }));
  });
  await page.goto('/?step=level');
  const step = page.locator('[data-easy-level]');
  await expect(step.locator('[data-iteration-choice="draft"]')).toBeVisible();
  await expect(step.locator('[data-iteration-choice="balanced"]')).toBeVisible();
  await expect(step.locator('[data-iteration-choice="director"]')).toBeVisible();
  await expect(step.getByRole('button', { name: 'Custom' })).toBeVisible();
  await expect(step).not.toContainText('Iteration level: Draft');
  await expect(step).not.toContainText('Estimate unavailable');

  await step.locator('[data-iteration-choice="balanced"]').click();
  await expect(step.locator('[data-iteration-card]')).toHaveAttribute('data-iteration-selected', 'balanced');
  await step.getByRole('button', { name: 'Custom' }).click();
  await expect(step.getByRole('button', { name: 'Custom' })).toHaveAttribute('aria-pressed', 'true');
});
