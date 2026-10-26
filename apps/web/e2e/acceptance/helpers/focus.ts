/** Keyboard and focus probes shared by acceptance specs (UX12, UX13, UX19 extend these). */
import type { Page } from '@playwright/test';

export interface FocusInfo {
  tag: string;
  role: string | null;
  name: string;
  testId: string | null;
  inViewport: boolean;
  /** True when something else (a fixed footer, an overlay, a toast) covers the focused control's centre. */
  obscured: boolean;
  /** The element that covers it, when obscured. */
  coveredBy: string | null;
}

export async function describeFocus(page: Page): Promise<FocusInfo | null> {
  return page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    if (!el || el === document.body || el === document.documentElement) return null;
    const rect = el.getBoundingClientRect();
    const centre = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    const inViewport = rect.width > 0 && rect.height > 0 && centre.x >= 0 && centre.y >= 0 && centre.x <= window.innerWidth && centre.y <= window.innerHeight;
    const top = inViewport ? document.elementFromPoint(centre.x, centre.y) : null;
    const covered = inViewport && top && !(el === top || el.contains(top) || top.contains(el)) ? top : null;
    const describe = (node: Element) => `${node.tagName.toLowerCase()}${node.id ? `#${node.id}` : ''}${typeof node.className === 'string' && node.className ? `.${node.className.split(/\s+/)[0]}` : ''}`;
    return {
      tag: el.tagName.toLowerCase(),
      role: el.getAttribute('role'),
      name: (el.getAttribute('aria-label') ?? el.textContent ?? (el as HTMLInputElement).value ?? '').trim().slice(0, 60),
      testId: el.getAttribute('data-testid'),
      inViewport,
      obscured: Boolean(covered),
      coveredBy: covered ? describe(covered) : null,
    };
  });
}

/** Press Tab up to `max` times and return what was focused each time (stops on wrap-around). */
export async function tabThrough(page: Page, max = 40): Promise<FocusInfo[]> {
  const seen: FocusInfo[] = [];
  const keys = new Set<string>();
  for (let step = 0; step < max; step += 1) {
    await page.keyboard.press('Tab');
    const info = await describeFocus(page);
    if (!info) continue;
    const key = `${info.tag}|${info.testId}|${info.name}`;
    if (keys.has(key)) break;
    keys.add(key);
    seen.push(info);
  }
  return seen;
}
