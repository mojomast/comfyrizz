import { expect, test } from '@playwright/test';

test('a bare visit opens the home screen', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('[data-easy-home-screen]')).toBeVisible();
  await expect(page.getByRole('link', { name: 'New video' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Try the example' })).toBeVisible();
  await expect(page.locator('[data-easy-step]')).toHaveCount(0);
});
