/**
 * Media ticket expiry fixture (UX11 extends it).
 *
 * The server hands out short-lived media URLs. `expireMediaAfter` makes the
 * browser see an expired ticket without waiting for a real TTL: requests that
 * match `pattern` succeed until `allow` of them have been served, then answer
 * 410 until `renew()` is called. Only the HTTP answer is simulated; the
 * product code under test still has to notice, renew and keep its playback
 * position. Counters let a spec assert that renewal was bounded.
 */
import type { Page } from '@playwright/test';

export interface TicketFixture {
  served: number;
  expired: number;
  renew(): void;
  expire(): void;
}

export async function expireMediaAfter(page: Page, pattern: RegExp, allow: number): Promise<TicketFixture> {
  const state = { served: 0, expired: 0, dead: false };
  await page.route(url => pattern.test(url.href), route => {
    if (state.dead || state.served >= allow) {
      state.dead = true;
      state.expired += 1;
      return route.fulfill({ status: 410, contentType: 'application/json', body: JSON.stringify({ error: 'ticket expired', code: 'TICKET_EXPIRED' }) });
    }
    state.served += 1;
    return route.fallback();
  });
  return {
    get served() { return state.served; },
    get expired() { return state.expired; },
    renew() { state.dead = false; state.served = 0; },
    expire() { state.dead = true; },
  };
}
