/** Reflow probes for 320/390px and zoomed layouts (UX19 extends these). */
import type { Page } from '@playwright/test';

export interface ReflowReport {
  viewport: { width: number; height: number };
  documentScrollWidth: number;
  /** Horizontal overflow of the document: content wider than the viewport (WCAG 1.4.10 reflow). */
  horizontalOverflowPx: number;
  /** Visible, focusable controls that are partly or wholly outside the horizontal viewport. */
  offscreenControls: string[];
}

export async function reflowReport(page: Page): Promise<ReflowReport> {
  return page.evaluate(() => {
    const width = document.documentElement.clientWidth;
    const controls = Array.from(document.querySelectorAll<HTMLElement>('a[href], button, input, select, textarea, [tabindex]:not([tabindex="-1"])'));
    const offscreen = controls.filter(el => {
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      if (rect.width === 0 || rect.height === 0 || style.visibility === 'hidden' || style.display === 'none') return false;
      return rect.right > width + 1 || rect.left < -1;
    }).map(el => `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''}`);
    return {
      viewport: { width: window.innerWidth, height: window.innerHeight },
      documentScrollWidth: document.documentElement.scrollWidth,
      horizontalOverflowPx: Math.max(0, document.documentElement.scrollWidth - width),
      offscreenControls: offscreen.slice(0, 20),
    };
  });
}
