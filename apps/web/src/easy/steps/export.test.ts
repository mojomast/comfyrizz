// EX08: a current export without a blob must offer a working "Export again"
// path, while a cached blob must land on done plus Download without starting
// another render when the editor sends the user back.
//
// The mount is checked against a tiny fake root: no browser, no network and no
// real media. node:test imports are runtime-only.
// @ts-nocheck
import test from 'node:test';
import assert from 'node:assert/strict';

import { COPY } from '../copy.ts';
import { defaultEasyState } from '../store.ts';
import { step } from './export.ts';

class FakeElement {
  constructor(tagName, ownerDocument) {
    this.tagName = tagName;
    this.ownerDocument = ownerDocument;
    this.innerHTML = '';
    this.textContent = '';
    this.style = {};
    this.listeners = new Map();
  }

  addEventListener(type, handler) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(handler);
  }

  removeEventListener(type, handler) {
    this.listeners.get(type)?.delete(handler);
  }

  querySelector() {
    return null;
  }

  querySelectorAll() {
    return [];
  }

  append() {}

  remove() {}

  click() {
    this.clicked = (this.clicked ?? 0) + 1;
  }

  focus() {
    this.ownerDocument.activeElement = this;
  }

  fire(type, event) {
    for (const handler of this.listeners.get(type) ?? []) handler(event);
  }
}

class FakeDocument {
  constructor() {
    this.activeElement = null;
    this.heading = new FakeElement('h2', this);
    this.created = [];
  }

  querySelector(selector) {
    return selector === '[data-easy-heading]' ? this.heading : null;
  }

  createElement(tagName) {
    const element = new FakeElement(tagName, this);
    this.created.push(element);
    return element;
  }

  get body() {
    return this.bodyElement ?? (this.bodyElement = new FakeElement('body', this));
  }
}

function clickOn(attribute) {
  return {
    target: {
      closest(selector) {
        if (selector !== 'button, a') return null;
        return {
          tagName: 'BUTTON',
          hasAttribute(name) {
            return name === attribute.replace(/^\[|\]$/g, '');
          },
        };
      },
    },
    prevented: false,
    preventDefault() {
      this.prevented = true;
    },
  };
}

let packageOrder = 0;

function exportHarness({ revision, exportedRevision = null, at = null, blob = null, packageId = null }) {
  packageOrder += 1;
  const doc = new FakeDocument();
  const el = new FakeElement('div', doc);
  const state = defaultEasyState();
  state.packageId = packageId ?? `pkg_ex08_${packageOrder}`;
  state.exported = { revision: exportedRevision, at };
  const pkg = { id: state.packageId, title: 'Crumb & Co', revision, durationSeconds: 30 };
  const primary = [];
  let renders = 0;
  const ctx = {
    state,
    store: {
      get: () => state,
      patch: (patch) => {
        Object.assign(state, patch);
      },
    },
    api: {
      qa: async () => ({ passed: true, notes: 0 }),
    },
    host: {
      getPackage: () => pkg,
      renderMp4: async () => {
        renders += 1;
        return { blob, revision: pkg.revision };
      },
      openEditor() {},
      playerElement: () => null,
    },
    shell: {
      setPrimary: (options) => primary.push(options),
      setStatus() {},
      alert() {},
      setBanner() {},
    },
    go() {},
    rerender() {},
    dialogs: {},
  };
  return {
    doc,
    el,
    state,
    pkg,
    ctx,
    primary,
    renders: () => renders,
    fire: (attribute) => {
      const event = clickOn(attribute);
      el.fire('click', event);
      return event;
    },
  };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function withBlobUrls(run) {
  const originalCreate = URL.createObjectURL;
  const originalRevoke = URL.revokeObjectURL;
  let made = 0;
  URL.createObjectURL = () => {
    made += 1;
    return `blob:https://example.test/ex08-${made}`;
  };
  URL.revokeObjectURL = () => {};
  return Promise.resolve()
    .then(run)
    .finally(() => {
      URL.createObjectURL = originalCreate;
      URL.revokeObjectURL = originalRevoke;
    });
}

test('a current export without a blob offers Export again instead of a dead Download', async () => {
  await withBlobUrls(async () => {
    const blob = new Blob(['mp4'], { type: 'video/mp4' });
    const harness = exportHarness({ revision: 5, exportedRevision: 5, at: '2026-10-24T00:00:00.000Z', blob });
    const stop = step.bind(harness.el, harness.ctx);
    await flush();

    assert.equal(harness.renders(), 0, 'mounting must not silently start another render');
    assert.match(harness.el.innerHTML, /data-easy-export-done/);
    assert.match(harness.el.innerHTML, /data-easy-export-again/);
    assert.doesNotMatch(harness.el.innerHTML, /data-easy-export-download/);
    assert.doesNotMatch(harness.el.innerHTML, /easy-is-disabled/);
    assert.equal(harness.primary.at(-1)?.label, COPY.export.again);

    const click = harness.fire('[data-easy-export-again]');
    assert.equal(click.prevented, true);
    assert.equal(harness.renders(), 1, 'Export again must start a render');
    assert.match(harness.el.innerHTML, /data-easy-export-working/);
    assert.equal(harness.primary.at(-1)?.label, COPY.export.working);

    await flush();
    assert.match(harness.el.innerHTML, /data-easy-export-done/);
    assert.match(harness.el.innerHTML, /data-easy-export-download/);
    assert.match(harness.el.innerHTML, /download="crumb-co\.mp4"[^>]*href="blob:https:\/\/example\.test\/ex08-1"/);
    assert.equal(harness.primary.at(-1)?.label, COPY.export.download);
    stop();
  });
});

test('the primary action also re-exports when the current export has no blob', async () => {
  await withBlobUrls(async () => {
    const blob = new Blob(['mp4'], { type: 'video/mp4' });
    const harness = exportHarness({ revision: 6, exportedRevision: 6, at: '2026-10-24T00:00:00.000Z', blob });
    const stop = step.bind(harness.el, harness.ctx);
    await flush();

    assert.equal(harness.renders(), 0);
    step.onPrimary(harness.ctx);
    assert.equal(harness.renders(), 1);
    assert.match(harness.el.innerHTML, /data-easy-export-working/);

    await flush();
    assert.match(harness.el.innerHTML, /data-easy-export-download/);
    stop();
  });
});

test('a cached blob lands on done plus Download and survives an editor round trip', async () => {
  await withBlobUrls(async () => {
    const blob = new Blob(['mp4'], { type: 'video/mp4' });
    const harness = exportHarness({ revision: 7, blob });
    const stopFirst = step.bind(harness.el, harness.ctx);
    await flush();

    assert.equal(harness.renders(), 1);
    assert.match(harness.el.innerHTML, /data-easy-export-done/);
    assert.match(harness.el.innerHTML, /data-easy-export-download/);
    assert.doesNotMatch(harness.el.innerHTML, /data-easy-export-again/);
    assert.equal(harness.doc.heading.textContent, COPY.export.doneHeading);
    assert.equal(harness.primary.at(-1)?.label, COPY.export.download);
    stopFirst();

    const stopReturn = step.bind(harness.el, harness.ctx);
    await flush();

    assert.equal(harness.renders(), 1, 'returning from the editor must not start another render');
    assert.match(harness.el.innerHTML, /data-easy-export-done/);
    assert.match(harness.el.innerHTML, /data-easy-export-download/);
    assert.match(harness.el.innerHTML, /href="blob:https:\/\/example\.test\/ex08-2"/);
    assert.doesNotMatch(harness.el.innerHTML, /data-easy-export-again/);
    assert.equal(harness.primary.at(-1)?.label, COPY.export.download);
    stopReturn();
  });
});

test('a cached blob for a different package does not masquerade as the current export', async () => {
  await withBlobUrls(async () => {
    const blob = new Blob(['mp4'], { type: 'video/mp4' });
    const first = exportHarness({ revision: 8, packageId: 'pkg_ex08_first', blob });
    const stopFirst = step.bind(first.el, first.ctx);
    await flush();
    assert.equal(first.renders(), 1);
    stopFirst();

    const second = exportHarness({ revision: 8, exportedRevision: 8, packageId: 'pkg_ex08_second' });
    const stopSecond = step.bind(second.el, second.ctx);
    await flush();

    assert.equal(second.renders(), 0);
    assert.match(second.el.innerHTML, /data-easy-export-again/);
    assert.doesNotMatch(second.el.innerHTML, /data-easy-export-download/);
    assert.equal(second.primary.at(-1)?.label, COPY.export.again);
    stopSecond();
  });
});
