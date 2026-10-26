// EX07: the shot panel says what is happening while versions load and offers a
// way back when loading fails. Rendering is pure, so these tests need no DOM.
// @ts-nocheck
import test from 'node:test';
import assert from 'node:assert/strict';

import { mountShotCard, renderShotCard } from './shot-card.ts';

function model(patch = {}) {
  return {
    shot: { shotId: 'scene-1', clipId: 'clip-1', number: 1, title: 'Opening' },
    versions: [],
    selectedVersionId: null,
    compute: 'cpu',
    ...patch,
  };
}

test('loading versions shows a skeleton and a written status, not a blank Keep', () => {
  const html = renderShotCard(model({ versionsStatus: 'loading' }));

  assert.match(html, /data-easy-shot-versions="loading"/u);
  assert.match(html, /role="status"/u);
  assert.match(html, /aria-live="polite"/u);
  assert.match(html, /Loading versions…/u);
  assert.match(html, /data-easy-shot-action="keep"[^>]*disabled/u);
  assert.doesNotMatch(html, /data-easy-shot-action="reload-versions"/u);
});

test('a failed versions load says so and offers Try again', () => {
  const html = renderShotCard(model({ versionsStatus: 'error' }));

  assert.match(html, /data-easy-shot-versions="error"/u);
  assert.match(html, /role="alert"/u);
  assert.match(html, /We couldn(?:&#39;|')t load versions for this shot\./u);
  assert.match(html, /data-easy-shot-action="reload-versions"/u);
  assert.match(html, />Try again</u);
  assert.match(html, /data-easy-shot-action="keep"[^>]*disabled/u);
  assert.doesNotMatch(html, /data-easy-shot-versions="loading"/u);
});

test('loaded versions replace the loading and error states', () => {
  const html = renderShotCard(model({
    versionsStatus: 'loading',
    selectedVersionId: 'take-1',
    versions: [{ takeId: 'take-1', n: 1, verdict: 'unreviewed' }],
  }));

  assert.doesNotMatch(html, /data-easy-shot-versions=/u);
  assert.match(html, /data-easy-shot-action="keep"/u);
});

test('Try again asks the host to load the versions again', async (t) => {
  const listeners = new Map();
  const el = {
    innerHTML: '',
    addEventListener(type, handler) {
      listeners.set(type, handler);
    },
    removeEventListener() {},
    querySelector() {
      return null;
    },
    contains() {
      return true;
    },
  };
  const previous = globalThis.HTMLElement;
  class FakeElement {}
  globalThis.HTMLElement = FakeElement;
  t.after(() => {
    if (previous === undefined) delete globalThis.HTMLElement;
    else globalThis.HTMLElement = previous;
  });

  let reloads = 0;
  const target = new FakeElement();
  target.closest = (selector) => (
    selector === '[data-easy-shot-action="reload-versions"]' ? {} : null
  );
  const controller = mountShotCard(el, model({ versionsStatus: 'error' }), {
    host: { previewTake() {}, refreshClips() {} },
    reloadVersions: async () => {
      reloads += 1;
    },
  });

  listeners.get('click')({ target });
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(reloads, 1);
  assert.match(el.innerHTML, /data-easy-shot-versions="loading"/u);
  controller.destroy();
});
