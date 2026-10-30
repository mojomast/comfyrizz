// @ts-nocheck
// UR32: the Export step's pure render functions.

import test from 'node:test';
import assert from 'node:assert/strict';

import { COPY } from '../src/easy/copy.ts';
import { defaultEasyState } from '../src/easy/store.ts';
import {
  exportFileName,
  isExportCurrent,
  renderExportDone,
  renderExportError,
  renderExportStale,
  renderExportWorking,
  step,
} from '../src/easy/steps/export.ts';

test('the working state has a progressbar', () => {
  const html = renderExportWorking(40);
  assert.match(html, /role="progressbar"/);
  assert.match(html, /aria-valuenow="40"/);
  assert.match(html, new RegExp(COPY.export.working));
});

test('the done state has the heading, video, download link and QA text', () => {
  const html = renderExportDone({
    name: 'Crumb & Co',
    blobUrl: 'blob:https://example.test/123',
    durationS: 30,
    aspect: '16:9',
    sizeBytes: 3_000_000,
    qa: { passed: true, notes: 0 },
    narration: true,
    captionsUrl: '/api/export/x/captions.vtt',
  });
  assert.match(html, new RegExp(COPY.export.doneHeading));
  assert.match(html, /<video\b[^>]*controls/);
  assert.match(html, /<track\b[^>]*kind="captions"/);
  assert.match(html, /src="\/api\/export\/x\/captions\.vtt"/);
  assert.match(html, /Crumb &amp; Co · <span data-easy-export-duration>0:30<\/span> · 16:9 · 3\.0 MB/);
  assert.match(html, /<a\b[^>]*download="crumb-co\.mp4"[^>]*href="blob:https:\/\/example\.test\/123"/);
  assert.match(html, new RegExp(COPY.export.download));
  assert.match(html, new RegExp(COPY.export.qaPass));
  assert.match(html, /data-easy-export-change[^>]*>Change anything<\/button>/);
  assert.match(html, /data-easy-export-editor[^>]*>Open in editor<\/button>/);
  assert.match(html, /Describe any change\. Paid regeneration still asks first\./);
});

test('export does not present requested or package duration as finished duration', () => {
  const html = renderExportDone({ pkg: { durationSeconds: 30 }, state: defaultEasyState() });
  assert.match(html, /data-easy-export-duration>Duration unavailable/);
  assert.doesNotMatch(html, /0:30/);
});

test('the failure state has role=alert with the reason and both actions', () => {
  const html = renderExportError('the server said no');
  assert.match(html, /role="alert"/);
  assert.match(html, /the server said no/);
  assert.match(html, new RegExp(COPY.export.retry));
  assert.match(html, new RegExp(COPY.shell.openEditor));
});

test('the stale text shows when the file is older than the latest changes', () => {
  const html = renderExportDone({
    name: 'Crumb & Co',
    blobUrl: 'blob:https://example.test/123',
    stale: true,
  });
  assert.match(html, new RegExp(COPY.export.stale));
  assert.match(html, new RegExp(COPY.export.again));

  const staleOnly = renderExportStale();
  assert.match(staleOnly, new RegExp(COPY.export.stale));
  assert.match(staleOnly, new RegExp(COPY.export.again));
});

test('the download file name is slugified', () => {
  assert.equal(exportFileName('Crumb & Co'), 'crumb-co.mp4');
  assert.equal(exportFileName('  Crumb & Co  '), 'crumb-co.mp4');
  assert.equal(exportFileName(''), 'video.mp4');
});

test('an export is current only when the stored revision matches the package', () => {
  assert.equal(isExportCurrent({ revision: 3 }, 3), true);
  assert.equal(isExportCurrent({ revision: 3 }, 2), false);
  assert.equal(isExportCurrent({ revision: 4 }, 3), false);
  assert.equal(isExportCurrent({ revision: 3 }, null), false);
  assert.equal(isExportCurrent(null, 3), false);
});

class FakeElement {
  constructor(tagName, ownerDocument) {
    this.tagName = tagName;
    this.ownerDocument = ownerDocument;
    this.innerHTML = '';
    this.textContent = '';
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

  focus() {
    this.ownerDocument.activeElement = this;
  }
}

class FakeDocument {
  constructor() {
    this.activeElement = null;
    this.heading = new FakeElement('h2', this);
  }

  querySelector(selector) {
    return selector === '[data-easy-heading]' ? this.heading : null;
  }

  createElement(tagName) {
    return new FakeElement(tagName, this);
  }
}

function exportHarness({ revision, exportedRevision = null, at = null, blob = null }) {
  const doc = new FakeDocument();
  const el = new FakeElement('div', doc);
  const state = defaultEasyState();
  state.packageId = 'pkg_1';
  state.exported = { revision: exportedRevision, at };
  const pkg = { id: 'pkg_1', title: 'Crumb & Co', revision, durationSeconds: 30 };
  const primary = [];
  let renders = 0;
  let qaCalls = 0;
  const ctx = {
    state,
    store: {
      get: () => state,
      patch: (patch) => {
        Object.assign(state, patch);
      },
    },
    api: {
      qa: async () => {
        qaCalls += 1;
        return { passed: true, notes: 0 };
      },
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
  return { doc, el, state, pkg, ctx, primary, renders: () => renders, qaCalls: () => qaCalls };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

test('an export already done for the package mounts done without calling renderMp4 again', async () => {
  const harness = exportHarness({ revision: 5, exportedRevision: 5, at: '2026-10-24T00:00:00.000Z' });
  const stop = step.bind(harness.el, harness.ctx);
  await flush();

  assert.equal(harness.renders(), 0);
  assert.equal(harness.qaCalls(), 0);
  assert.match(harness.el.innerHTML, /data-easy-export-done/);
  assert.match(harness.el.innerHTML, new RegExp(COPY.export.doneHeading));
  assert.equal(harness.doc.heading.textContent, COPY.export.doneHeading);
  assert.equal(harness.doc.activeElement, harness.doc.heading);
  assert.equal(harness.primary.at(-1)?.label, COPY.export.again);
  stop();
});

test('switching to the editor and back restores the done screen without a second render', async () => {
  const blob = new Blob(['mp4'], { type: 'video/mp4' });
  const harness = exportHarness({ revision: 7, blob });
  const stopFirst = step.bind(harness.el, harness.ctx);
  await flush();

  assert.equal(harness.renders(), 1);
  assert.equal(harness.state.exported.revision, 7);
  assert.match(harness.el.innerHTML, /data-easy-export-done/);
  stopFirst();

  const stopReturn = step.bind(harness.el, harness.ctx);
  await flush();

  assert.equal(harness.renders(), 1, 'returning from the editor must not start another render');
  assert.match(harness.el.innerHTML, /data-easy-export-done/);
  assert.match(harness.el.innerHTML, /<a\b[^>]*download="crumb-co\.mp4"[^>]*href="blob:/);
  assert.equal(harness.doc.heading.textContent, COPY.export.doneHeading);
  assert.equal(harness.primary.at(-1)?.label, COPY.export.download);
  stopReturn();
});

test('a package revision newer than the stored export still renders', async () => {
  const harness = exportHarness({ revision: 8, exportedRevision: 7, at: '2026-10-24T00:00:00.000Z' });
  const stop = step.bind(harness.el, harness.ctx);
  await flush();

  assert.equal(harness.renders(), 1);
  assert.equal(harness.state.exported.revision, 8);
  assert.match(harness.el.innerHTML, /data-easy-export-done/);
  stop();
});
