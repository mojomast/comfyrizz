// @ts-nocheck
// EX01: the lip-sync check notice stays in plain Easy words, never names the
// pipeline tool, and can be dismissed for the rest of the session.
import test from 'node:test';
import assert from 'node:assert/strict';

import { COPY } from './copy.ts';
import * as notice from './syncnet-notice.ts';

function strings(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(strings);
  if (value && typeof value === 'object') return Object.values(value).flatMap(strings);
  return [];
}

const WARNING = notice.syncnetSkipWarning({
  syncnet: { configured: false, code: 'SYNCNET_UNAVAILABLE' },
});

class FakeDocument {
  constructor() {
    this.listeners = { click: [] };
    this.removed = [];
    this.styles = [];
    this.documentElement = {
      attributes: new Map(),
      setAttribute(name, value) {
        this.attributes.set(name, value);
      },
    };
    this.head = {
      append: (element) => {
        if (element.tagName === 'style') this.styles.push(element);
      },
    };
  }
  addEventListener(type, listener) {
    (this.listeners[type] ??= []).push(listener);
  }
  getElementById() {
    return null;
  }
  createElement(tagName) {
    const element = { tagName, dataset: {}, textContent: '', id: '' };
    element.setAttribute = (name, value) => {
      element[name] = value;
    };
    return element;
  }
  querySelectorAll(selector) {
    return [{ selector, remove: () => this.removed.push(selector) }];
  }
}

test('every Easy string is free of the pipeline tool name', () => {
  for (const text of strings(COPY)) {
    assert.equal(/syncnet/i.test(text), false, `Easy copy names the tool: ${text}`);
  }
});

test('the banner explains the missing lip-sync check in plain words', () => {
  assert.match(COPY.syncnet.skipped, /lip-sync will not be checked/i);
  assert.match(COPY.syncnet.skipped, /talking shot/i);
  assert.match(COPY.syncnet.skipped, /before you export/i);
  assert.equal(/syncnet/i.test(COPY.syncnet.skipped), false);

  const html = notice.renderSyncnetBanner(WARNING);
  assert.match(html, /data-easy-syncnet-warning/);
  assert.match(html, /easy-banner-warn/);
  assert.match(html, /data-easy-syncnet-dismiss/);
  assert.match(html, new RegExp(COPY.syncnet.dismiss));
});

test('dismissing the notice lasts for the session', async () => {
  assert.equal(typeof notice.createSyncnetNoticeSession, 'function');
  const session = notice.createSyncnetNoticeSession();
  assert.equal(notice.isSyncnetNoticeDismissed(session), false);
  assert.match(notice.renderSyncnetBanner(WARNING, session), /data-easy-syncnet-warning/);

  notice.dismissSyncnetNotice(session);
  assert.equal(notice.isSyncnetNoticeDismissed(session), true);
  assert.equal(notice.renderSyncnetBanner(WARNING, session), '');

  let asked = false;
  const quiet = await notice.loadSyncnetBanner({
    host: { getPackage: () => ({ presenter: { enabled: true } }) },
    api: {
      pipelineDiagnostics: async () => {
        asked = true;
        return { syncnet: { configured: false } };
      },
    },
    notice: session,
  });
  assert.equal(quiet, '');
  assert.equal(asked, false);
});

test('a later step still clears the banner after dismissal', async () => {
  const session = notice.createSyncnetNoticeSession();
  notice.dismissSyncnetNotice(session);
  const notPresenter = await notice.loadSyncnetBanner({
    host: { getPackage: () => ({ presenter: { enabled: false } }) },
    api: { pipelineDiagnostics: async () => ({ syncnet: { configured: false } }) },
    notice: session,
  });
  assert.equal(notPresenter, null);
});

test('the dismiss hook removes the visible banner and suppresses redraws', async () => {
  const doc = new FakeDocument();
  const previous = globalThis.document;
  globalThis.document = doc;
  try {
    const session = notice.createSyncnetNoticeSession();
    const html = await notice.loadSyncnetBanner({
      host: { getPackage: () => ({ presenter: { enabled: true } }) },
      api: { pipelineDiagnostics: async () => ({ syncnet: { configured: false } }) },
      notice: session,
    });
    assert.match(html ?? '', /data-easy-syncnet-dismiss/);
    assert.equal(doc.listeners.click.length > 0, true);

    let prevented = false;
    const event = {
      target: {
        closest: (selector) => (selector === '[data-easy-syncnet-dismiss]' ? {} : null),
      },
      preventDefault: () => {
        prevented = true;
      },
    };
    for (const listener of doc.listeners.click) listener(event);

    assert.equal(prevented, true);
    assert.equal(notice.isSyncnetNoticeDismissed(session), true);
    assert.equal(doc.documentElement.attributes.get('data-easy-syncnet-dismissed'), '');
    assert.equal(doc.removed.some((selector) => selector.includes('[data-easy-syncnet-warning]')), true);
    assert.equal(doc.styles.length, 1);
  } finally {
    globalThis.document = previous;
  }
});
