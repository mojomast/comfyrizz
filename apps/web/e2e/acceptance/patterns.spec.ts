/**
 * UX20 cross-system pattern stubs. Each block exercises one reusable fixture
 * against the real app so later packets extend a proven harness instead of
 * building their own:
 *
 *   keyboard/focus   helpers/focus.ts     UX12, UX13, UX19
 *   ticket expiry    helpers/tickets.ts   UX11, UX12
 *   late events      helpers/events.ts    UX04, UX07
 *   mobile reflow    helpers/reflow.ts    UX19, UX16
 *   reload           real reload          UX05, UX07, UX16
 *
 * `test.fixme` entries name the packet that owns the real assertion and say what
 * it must check. They run nowhere today; the fixture they depend on is covered
 * by the working tests above them.
 */
import { expect, knownDefect, openEditor, resetProject, test, api } from './fixtures.ts';
import { describeFocus, tabThrough } from './helpers/focus.ts';
import { reflowReport } from './helpers/reflow.ts';
import { expireMediaAfter } from './helpers/tickets.ts';
import { serveEventStream } from './helpers/events.ts';
import { mediaUrl } from './helpers/media.ts';

test.describe('keyboard and focus', () => {
  test.beforeEach(({ env }) => resetProject(env));

  test('Tab order in the editor never loses focus to the page and the probe reports each stop', async ({ page, env }) => {
    await openEditor(page, env);
    const stops = await tabThrough(page, 30);
    expect(stops.length, 'Tab reached focusable controls').toBeGreaterThanOrEqual(3);
    for (const stop of stops) expect(stop.name.length + (stop.testId?.length ?? 0) + stop.tag.length, 'every stop is describable').toBeGreaterThan(0);
    expect(await describeFocus(page)).not.toBeNull();
  });

  test.fixme('UX12: viewer keyboard model (play, seek, compare) works without a pointer and focus is never obscured', async () => {
    // UX12 extends tabThrough/describeFocus: every stop in the viewer is in the viewport and `obscured` is false.
  });
  test.fixme('UX13: the character audition dialog traps and restores focus', async () => {});
  test.fixme('UX19: no focused control is covered by a toast or fixed footer at 390px and 320px', async () => {});
});

test.describe('media ticket expiry', () => {
  test('the fixture serves, expires with 410 and renews; the media server bytes are unchanged', async ({ page, env }) => {
    await page.goto(`${env.mediaBase}/blank.html`);
    const url = mediaUrl(env, 'take-intro-a', 'wav');
    const ticket = await expireMediaAfter(page, new RegExp(url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), 1);
    const status = () => page.evaluate(async (target: string) => (await fetch(target, { cache: 'no-store' })).status, url);
    expect(await status()).toBe(200);
    expect(await status()).toBe(410);
    expect(ticket).toMatchObject({ served: 1, expired: 1 });
    ticket.renew();
    expect(await status()).toBe(200);
  });

  test.fixme('UX11: an expired ticket mid-play is renewed once, playback position is kept and the decoded take is unchanged', async () => {
    // Use expireMediaAfter on the take URL, then assert helpers/media.ts decodedAudioId/decodedVideoFrameId before and
    // after renewal name the same take and that ticket.expired stays bounded (no renewal storm).
  });
});

test.describe('late and replayed events', () => {
  test('a scripted event stream reaches the page in this engine, including a late event for another project', async ({ page, env }) => {
    await page.goto(`${env.mediaBase}/blank.html`);
    const stream = await serveEventStream(page, /\/qa-events$/, [
      { id: 1, event: 'production', data: { productionId: 'prod_current', revision: 3 } },
      { id: 2, event: 'production', data: { productionId: 'prod_previous_project', revision: 9 } },
    ]);
    const received = await page.evaluate(() => new Promise<string[]>(resolve => {
      const seen: string[] = [];
      const source = new EventSource('/qa-events');
      source.addEventListener('production', event => {
        seen.push(String((event as MessageEvent).data));
        if (seen.length === 2) { source.close(); resolve(seen); }
      });
      setTimeout(() => { source.close(); resolve(seen); }, 5000);
    }));
    expect(received.map(item => JSON.parse(item).productionId)).toEqual(['prod_current', 'prod_previous_project']);
    expect(stream.requests.length).toBeGreaterThan(0);
  });

  test.fixme('UX04: an event for another production after "Make another" changes neither progress nor identity', async () => {});
  test.fixme('UX07: a replay that restarts at id 1 after a server restart does not start a second run', async () => {});
});

test.describe('mobile reflow', () => {
  test('the Super Easy home does not scroll horizontally and keeps its controls on screen', async ({ page, env }) => {
    await page.goto(`/#token=${encodeURIComponent(env.token)}`);
    await expect(page.locator('#super-easy-prompt')).toBeVisible();
    const report = await reflowReport(page);
    test.info().annotations.push({ type: 'reflow', description: JSON.stringify(report) });
    expect(report.horizontalOverflowPx, `document overflows by ${report.horizontalOverflowPx}px at ${report.viewport.width}px`).toBeLessThanOrEqual(1);
    expect(report.offscreenControls).toEqual([]);
  });

  test.fixme('UX19: Easy steps, Review and Export reflow at 320px and at 400% zoom without two-axis scrolling', async () => {});
  test.fixme('UX16: the export panel stays reachable at 390px', async () => {});
});

test.describe('reload', () => {
  test.beforeEach(({ env }) => resetProject(env));

  test('a saved reorder survives a reload: same server revision, same on-screen order', async ({ page, env }) => {
    await openEditor(page, env);
    await page.getByTestId('timeline').focus();
    await page.keyboard.press('Alt+ArrowDown');
    await expect(page.locator('#save-status')).toHaveText('Saved', { timeout: 15_000 });
    const readRevision = async () => ((await (await api(env, `/api/package/${env.packageId}`)).json()) as { revision: number }).revision;
    const revision = await readRevision();
    await page.reload();
    await expect(page.getByTestId('scene')).toHaveCount(3);
    await expect(page.locator('#save-status')).toHaveText('Saved');
    expect(await readRevision(), 'reload must not write').toBe(revision);
    expect(await page.getByTestId('scene').evaluateAll(nodes => nodes.map(node => node.getAttribute('data-scene-id')))).toEqual(['s_body', 's_open', 's_close']);
  });

  test.fixme('UX07: reloading the Super Easy progress view or re-approving starts no second run', async () => {});
  test.fixme('UX16: after reload the finished export is still downloadable', async () => {});
});
