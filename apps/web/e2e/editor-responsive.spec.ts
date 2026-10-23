import { test, expect } from '@playwright/test';

async function openEditor(page: import('@playwright/test').Page): Promise<void> {
  await page.goto('/');
  await page.getByRole('button', { name: 'Open in editor' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-mode', 'advanced');
  await expect(page.locator('#topbar')).toBeVisible();
}

test('at 1024px nothing in the top bar is clipped', async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 800 });
  await openEditor(page);
  const overflow = await page.locator('#topbar').evaluate(bar => {
    const limit = document.documentElement.clientWidth;
    const nodes = [bar, ...bar.querySelectorAll<HTMLElement>('*')];
    const outside: string[] = [];
    for (const element of nodes) {
      if (element.hidden || element.closest('[hidden]')) continue;
      const style = getComputedStyle(element);
      if (style.display === 'none' || style.visibility === 'hidden') continue;
      const box = element.getBoundingClientRect();
      if (box.width <= 1 && box.height <= 1) continue;
      if (box.left < -1 || box.right > limit + 1 || box.top < -1) {
        const name = element.id || element.getAttribute('aria-label') || element.className || element.tagName;
        outside.push(`${name} ${box.left.toFixed(1)}..${box.right.toFixed(1)}`);
      }
    }
    const wrap = getComputedStyle(bar).flexWrap;
    return { outside, wrap, scrolls: bar.scrollWidth > bar.clientWidth + 1 };
  });
  expect(overflow.wrap).toBe('nowrap');
  expect(overflow.scrolls).toBe(false);
  expect(overflow.outside).toEqual([]);
  const tabSize = await page.locator('#activity-pane .rail-tab').evaluateAll(tabs => (
    tabs.map(tab => getComputedStyle(tab).fontSize)
  ));
  expect(tabSize.length).toBeGreaterThan(0);
  expect(tabSize.every(size => size === '0px')).toBe(true);
});

test('at 800px the editor asks for a larger screen', async ({ page }) => {
  await page.setViewportSize({ width: 800, height: 700 });
  await openEditor(page);
  const gate = page.locator('#editor-small-screen');
  await expect(gate).toBeVisible();
  await expect(gate).toContainText('The editor works best on a larger screen.');
  await gate.getByRole('button', { name: 'Back to studio' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-mode', 'easy');
});
