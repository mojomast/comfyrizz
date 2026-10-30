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
import { createExportArtifactRecord, exportArtifactStorageKey, saveExportArtifact } from '../export-artifacts.ts';
import { step, renderExportDone } from './export.ts';

test('a saved silent narration preview is not presented as a finished video', () => {
  const pkg = { voice: { enabled: true, engine: 'kokoro' }, scenes: [{ narration: 'A line' }], assets: {} };
  const html = renderExportDone({ pkg, blobUrl: 'blob:preview' });
  assert.match(html, /Preview/);
  assert.match(html, /Narration is planned but not yet available/);
  assert.doesNotMatch(html, /Your video is ready/);
});

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

function exportHarness({
  revision,
  exportedRevision = null,
  at = null,
  blob = null,
  packageId = null,
  exportResult = undefined,
  storage = undefined,
  resolveExportArtifact = undefined,
}) {
  packageOrder += 1;
  const doc = new FakeDocument();
  const el = new FakeElement('div', doc);
  const state = defaultEasyState();
  state.packageId = packageId ?? `pkg_ex08_${packageOrder}`;
  state.exported = { revision: exportedRevision, at };
  const pkg = { id: state.packageId, title: 'Crumb & Co', revision, durationSeconds: 30 };
  const primary = [];
  const apiCalls = [];
  let renders = 0;
  let resolutions = 0;
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
      export: async () => {
        apiCalls.push('export');
        throw new Error('the export endpoint must not be called to reopen a saved download');
      },
    },
    host: {
      getPackage: () => pkg,
      renderMp4: async () => {
        renders += 1;
        return exportResult ?? { blob, revision: pkg.revision };
      },
      resolveExportArtifact: resolveExportArtifact
        ? async (record) => {
          resolutions += 1;
          return resolveExportArtifact(record);
        }
        : undefined,
      exportArtifactStorage: storage,
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
    apiCalls,
    renders: () => renders,
    resolutions: () => resolutions,
    fire: (attribute) => {
      const event = clickOn(attribute);
      el.fire('click', event);
      return event;
    },
  };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

test('export duration follows current video metadata and ignores stale events', async () => {
  const harness = exportHarness({ revision: 5, blob: new Blob(['mp4']) });
  const stop = step.bind(harness.el, harness.ctx);
  await flush();
  assert.match(harness.el.innerHTML, /data-easy-export-duration>Duration unavailable/);
  assert.doesNotMatch(harness.el.innerHTML, /0:30/);
  const video = { duration: 4.245 };
  const label = { textContent: 'Duration unavailable' };
  harness.el.querySelector = selector => selector === 'video[data-easy-player]' ? video
    : selector === '[data-easy-export-duration]' ? label : null;
  harness.el.fire('loadedmetadata', { type: 'loadedmetadata', target: video });
  assert.equal(label.textContent, '0:04');
  harness.el.fire('loadedmetadata', { type: 'loadedmetadata', target: { duration: 30 } });
  assert.equal(label.textContent, '0:04');
  video.duration = Infinity;
  harness.el.fire('durationchange', { type: 'durationchange', target: video });
  assert.equal(label.textContent, 'Duration unavailable');
  video.duration = 4.245;
  harness.el.fire('error', { type: 'error', target: video });
  assert.equal(label.textContent, 'Duration unavailable');
  stop();
  harness.el.fire('loadedmetadata', { type: 'loadedmetadata', target: video });
  assert.equal(label.textContent, 'Duration unavailable');
});

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

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);

function fullExportResult({ packageId, revision, blob = null, preflight = true, exportId = 'x_ux16' }) {
  const result = {
    exportId,
    packageId,
    revision,
    files: [
      { name: 'video.mp4', bytes: 2048, path: '/exports/video.mp4' },
      { name: 'captions.vtt', bytes: 128, path: '/exports/captions.vtt' },
    ],
    intent: 'draft',
    archiveMode: 'private',
  };
  if (blob) result.blob = blob;
  if (preflight) {
    result.preflight = {
      ok: true,
      final: false,
      intent: 'draft',
      blockers: [],
      warnings: [],
      facts: {
        intent: 'draft',
        format: { width: 1080, height: 1920, aspect: '9:16', fps: 30 },
        archiveMode: 'private',
        snapshotFingerprint: HASH_A,
        timelineHash: HASH_B,
        captionRevision: HASH_A,
        speechSha256: HASH_B,
        sourceCompleteness: {
          complete: false,
          missing: ['audio/durations.json'],
          inputs: [{ path: 'audio/durations.json', sha256: null, bytes: null }],
        },
        rightsExclusions: [],
        reviews: [{ decisionId: 'dec_1', state: 'unknown' }],
      },
    };
    result.snapshot = {
      fingerprint: HASH_A,
      schema: 'comfyrizz.delivery-snapshot/v1',
      packageRevision: revision,
      editorRevision: 1,
    };
  }
  return result;
}

function fakeExportStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    map,
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => {
      map.set(key, value);
    },
    removeItem: (key) => {
      map.delete(key);
    },
  };
}

let freshModule = 0;
function importFreshExportStep() {
  freshModule += 1;
  return import(`./export.ts?fresh=${freshModule}-${Date.now()}`);
}

test('export then a fresh module loads the saved artifact and Download uses the resolver, not a render', async () => {
  await withBlobUrls(async () => {
    const storage = fakeExportStorage();
    const packageId = 'pkg_ux16_reload';
    const blob = new Blob(['mp4'], { type: 'video/mp4' });
    const first = exportHarness({
      revision: 3,
      packageId,
      storage,
      exportResult: fullExportResult({ packageId, revision: 3, blob }),
    });
    const stopFirst = step.bind(first.el, first.ctx);
    await flush();

    assert.equal(first.renders(), 1);
    assert.match(first.el.innerHTML, /data-easy-export-download/);
    assert.ok(storage.map.has(exportArtifactStorageKey(packageId)));
    stopFirst();

    const reloaded = exportHarness({
      revision: 3,
      exportedRevision: 3,
      at: '2026-10-26T00:00:00.000Z',
      packageId,
      storage,
      resolveExportArtifact: async () => ({
        href: 'https://media.example.test/video.mp4?sig=renewed',
      }),
    });
    const fresh = await importFreshExportStep();
    const stopReloaded = fresh.step.bind(reloaded.el, reloaded.ctx);
    await flush();

    assert.equal(reloaded.renders(), 0, 'a saved artifact must not start another render');
    assert.match(reloaded.el.innerHTML, /data-easy-export-download/);
    assert.match(reloaded.el.innerHTML, /data-easy-export-facts/);
    assert.match(reloaded.el.innerHTML, /9:16/);
    assert.match(reloaded.el.innerHTML, /audio\/durations\.json/);
    assert.equal(reloaded.apiCalls.length, 0);

    const click = reloaded.fire('[data-easy-export-download]');
    await flush();
    assert.equal(click.prevented, true);
    assert.equal(reloaded.resolutions(), 1);
    assert.equal(reloaded.renders(), 0);
    assert.equal(reloaded.apiCalls.length, 0);
    stopReloaded();
  });
});

test('without a resolver a saved artifact says reopening is not connected and offers Export again', async () => {
  await withBlobUrls(async () => {
    const storage = fakeExportStorage();
    const packageId = 'pkg_ux16_not_connected';
    const built = createExportArtifactRecord(fullExportResult({ packageId, revision: 2 }));
    assert.deepEqual(saveExportArtifact(built.record, storage), { saved: true });

    const harness = exportHarness({ revision: 2, packageId, storage });
    const fresh = await importFreshExportStep();
    const stop = fresh.step.bind(harness.el, harness.ctx);
    await flush();

    assert.equal(harness.renders(), 0);
    assert.match(harness.el.innerHTML, /data-easy-export-download/);
    const click = harness.fire('[data-easy-export-download]');
    await flush();
    assert.equal(click.prevented, true);
    assert.match(harness.el.innerHTML, /data-easy-export-artifact-state="not-connected"/);
    assert.match(harness.el.innerHTML, /not connected in this build yet/i);
    assert.match(harness.el.innerHTML, /data-easy-export-again/);
    assert.equal(harness.renders(), 0);

    harness.fire('[data-easy-export-again]');
    assert.equal(harness.renders(), 1, 'Export again must start a fresh render');
    stop();
  });
});

test('no export id shows a visible cannot-reopen notice and persists nothing', async () => {
  await withBlobUrls(async () => {
    const storage = fakeExportStorage();
    const packageId = 'pkg_ux16_no_id';
    const blob = new Blob(['mp4'], { type: 'video/mp4' });
    const harness = exportHarness({
      revision: 1,
      packageId,
      storage,
      exportResult: { blob, revision: 1 },
    });
    const stop = step.bind(harness.el, harness.ctx);
    await flush();

    assert.equal(harness.renders(), 1);
    assert.match(harness.el.innerHTML, /data-easy-export-download/);
    assert.match(harness.el.innerHTML, /data-easy-export-artifact-warning/);
    assert.match(harness.el.innerHTML, /cannot be reopened after reload/);
    assert.equal(storage.map.size, 0);
    assert.doesNotMatch(harness.el.innerHTML, new RegExp(packageId));
    stop();
  });
});

test('a storage failure is visible in the done view and does not hide the export', async () => {
  await withBlobUrls(async () => {
    const packageId = 'pkg_ux16_quota';
    const storage = fakeExportStorage();
    storage.setItem = () => {
      const error = new Error('quota');
      error.name = 'QuotaExceededError';
      throw error;
    };
    const blob = new Blob(['mp4'], { type: 'video/mp4' });
    const harness = exportHarness({
      revision: 1,
      packageId,
      storage,
      exportResult: fullExportResult({ packageId, revision: 1, blob }),
    });
    const stop = step.bind(harness.el, harness.ctx);
    await flush();

    assert.match(harness.el.innerHTML, /data-easy-export-done/);
    assert.match(harness.el.innerHTML, /data-easy-export-download/);
    assert.match(harness.el.innerHTML, /data-easy-export-artifact-warning/);
    assert.match(harness.el.innerHTML, /could not be saved/i);
    stop();
  });
});

test('a clean MP4 result without preflight shows delivery facts as not recorded', async () => {
  await withBlobUrls(async () => {
    const packageId = 'pkg_ux16_no_preflight';
    const storage = fakeExportStorage();
    const blob = new Blob(['mp4'], { type: 'video/mp4' });
    const harness = exportHarness({
      revision: 1,
      packageId,
      storage,
      exportResult: fullExportResult({ packageId, revision: 1, blob, preflight: false }),
    });
    const stop = step.bind(harness.el, harness.ctx);
    await flush();

    assert.match(harness.el.innerHTML, /data-easy-export-facts/);
    assert.match(harness.el.innerHTML, /Delivery facts not recorded for this file\./);
    assert.doesNotMatch(harness.el.innerHTML, /No creative reviews recorded/);
    stop();
  });
});

test('corrupt saved JSON is reported and ignored instead of looking like a fresh export', async () => {
  await withBlobUrls(async () => {
    const storage = fakeExportStorage();
    const packageId = 'pkg_ux16_corrupt';
    storage.setItem(exportArtifactStorageKey(packageId), '{not json');

    const harness = exportHarness({ revision: 5, exportedRevision: 5, packageId, storage });
    const fresh = await importFreshExportStep();
    const stop = fresh.step.bind(harness.el, harness.ctx);
    await flush();

    assert.equal(harness.renders(), 0);
    assert.match(harness.el.innerHTML, /data-easy-export-artifact-warning/);
    assert.match(harness.el.innerHTML, /unreadable/i);
    assert.match(harness.el.innerHTML, /data-easy-export-again/);
    stop();
  });
});

test('done actions open Ask and the editor in place without rerendering or exporting again', async () => {
  const harness = exportHarness({ revision: 4, exportedRevision: 4, at: '2026-10-26T00:00:00.000Z' });
  let asks = 0;
  let editors = 0;
  let rerenders = 0;
  harness.ctx.openAsk = () => { asks += 1; };
  harness.ctx.host.openEditor = () => { editors += 1; };
  harness.ctx.rerender = () => { rerenders += 1; };
  const stop = step.bind(harness.el, harness.ctx);
  await flush();

  const change = harness.fire('[data-easy-export-change]');
  const editor = harness.fire('[data-easy-export-editor]');

  assert.equal(change.prevented, true);
  assert.equal(editor.prevented, true);
  assert.equal(asks, 1);
  assert.equal(editors, 1);
  assert.equal(rerenders, 0);
  assert.equal(harness.renders(), 0);
  assert.match(harness.el.innerHTML, /data-easy-export-done/);
  stop();
});
