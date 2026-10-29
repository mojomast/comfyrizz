// @ts-nocheck
import test from 'node:test';
import assert from 'node:assert/strict';
import { mountCorrectionShutdown } from '../src/easy/correction-shutdown.ts';

test('shutdown warning offers a read-only check and disappears only after confirmation', async () => {
  class Element {
    children = []; hidden = false; textContent = ''; listeners = {}; disabled = false;
    setAttribute() {} append(...items) { this.children.push(...items); }
    replaceChildren() { this.children = []; }
    addEventListener(name, callback) { this.listeners[name] = callback; }
    remove() { this.removed = true; }
  }
  const view = { addEventListener() {}, removeEventListener() {}, setInterval() { return 1; }, clearInterval() {} };
  const doc = { defaultView: view, createElement() { return new Element(); } };
  let panel;
  const root = { ownerDocument: doc, parentNode: { insertBefore(value) { panel = value; } }, nextSibling: null };
  let confirmed = false;
  const calls = [];
  const fetch = async (path, options) => {
    calls.push({ path, method: options?.method });
    if (options?.method === 'POST') { confirmed = true; return { ok: true, json: async () => ({ confirmed: true }) }; }
    return { ok: true, json: async () => confirmed ? { blocked: false } : { blocked: true, blockers: [
      { runId: 'run_123456789abc', session: 'comfyrizz-pkg', canCheck: true, reason: 'shutdown_unconfirmed' },
    ] } };
  };
  const destroy = mountCorrectionShutdown(root, fetch);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(panel.hidden, false);
  assert.match(panel.children[1].children[0].textContent, /Inspect Google Colab sessions/);
  const button = panel.children[1].children[1];
  await button.listeners.click();
  assert.equal(panel.hidden, true);
  assert.deepEqual(calls.map(call => call.method ?? 'GET'), ['GET', 'POST', 'GET']);
  destroy();
  assert.equal(panel.removed, true);
});
