import { expect, test } from '@playwright/test';

test('a bare visit opens the home screen', async ({ page }) => {
  // Vite's dev socket stays open on this exact URL, so wait for the document
  // instead of the load event.
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('[data-easy-home-screen]')).toBeVisible();
  await expect(page.getByRole('link', { name: 'New video' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Try the example' })).toBeVisible();
  await expect(page.locator('[data-easy-step]')).toHaveCount(0);
});
