/**
 * Late and replayed event fixture (UX04, UX07 extend it).
 *
 * `serveEventStream` answers a matching EventSource request with a scripted SSE
 * body, so a spec can deliver "late" events for another project/session, an
 * expired cursor, or a replay that restarts at id 1 after a server restart. The
 * frames are data only; whether the page ignores a late event for the wrong
 * project is the behavior under test.
 */
import type { Page } from '@playwright/test';

export interface SseFrame {
  id?: string | number;
  event?: string;
  data: unknown;
}

export function sseBody(frames: SseFrame[]): string {
  return frames.map(frame => [
    frame.id !== undefined ? `id: ${frame.id}` : '',
    frame.event ? `event: ${frame.event}` : '',
    `data: ${typeof frame.data === 'string' ? frame.data : JSON.stringify(frame.data)}`,
  ].filter(Boolean).join('\n')).join('\n\n') + '\n\n';
}

export async function serveEventStream(page: Page, pattern: RegExp, frames: SseFrame[] | (() => SseFrame[])): Promise<{ requests: string[] }> {
  const requests: string[] = [];
  await page.route(url => pattern.test(url.href), route => {
    requests.push(route.request().url());
    return route.fulfill({
      status: 200,
      headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' },
      body: sseBody(typeof frames === 'function' ? frames() : frames),
    });
  });
  return { requests };
}
