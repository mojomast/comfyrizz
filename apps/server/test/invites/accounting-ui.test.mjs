import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { createGenerationGallery } from '../../src/invites/generation-gallery.mjs';

// Exercise the shipped scripts through their actual fetch/login/render paths.
// This small DOM records text nodes and deliberately forbids HTML insertion.
class Node {
  constructor(tag = 'div') { this.tag = tag; this.children = []; this.events = {}; this.value = ''; this.classList = { toggle() {} }; }
  set textContent(text) { this.children = [String(text)]; }
  get textContent() { return this.children.map(child => typeof child === 'string' ? child : child.textContent).join(' '); }
  set innerHTML(_) { throw new Error('Unsafe HTML insertion'); }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
  setAttribute() {}
  removeAttribute() {}
  addEventListener(event, listener) { this.events[event] = listener; }
  querySelectorAll(tag) { return this.children.flatMap(child => typeof child === 'string' ? [] : [...(child.tag === tag ? [child] : []), ...child.querySelectorAll(tag)]); }
  querySelector(tag) { return this.querySelectorAll(tag)[0]; }
  pause() {}
  load() {}
}

function galleryFor(rows) {
  const ledger = { get: () => ({ status: 'active' }), listGenerations: () => rows };
  return createGenerationGallery({ ledger }).list('invite_self');
}

async function render(surface, rows, { rawGallery = false } = {}) {
  const nodes = new Map();
  const get = id => { if (!nodes.has(id)) nodes.set(id, new Node()); return nodes.get(id); };
  const calls = [];
  const document = { getElementById: get, createElement: tag => new Node(tag), querySelectorAll: () => [] };
  get('login-form').append(new Node('button')); get('token').value = 'owner-test-token';
  const fetch = async path => {
    calls.push(path);
    const data = path === '/api/invites' ? { invites: [{ id: 'invite_self', status: 'active', generations: rows }] }
      : path === '/api/invites/admin-status' ? { spendEnabled: true }
      : path === '/api/invites/session' ? { budgetUnits: 1, easyPath: '/', spendEnabled: true }
      : path.startsWith('/api/demo/generations?') ? rawGallery ? { items: rows, total: rows.length, nextOffset: null } : galleryFor(rows)
      : assert.fail(`Unexpected API request ${path}`);
    return { ok: true, status: 200, json: async () => data };
  };
  const source = readFileSync(new URL(`../../src/invites/${surface === 'admin' ? 'admin-dashboard/dashboard' : 'gallery/gallery'}.js`, import.meta.url), 'utf8');
  runInNewContext(source, { document, fetch, URLSearchParams, location: { hash: '', pathname: '/' },
    sessionStorage: { getItem: () => 'guest-test-token' }, history: {}, navigator: {} });
  if (surface === 'admin') await get('login-form').events.submit({ preventDefault() {}, currentTarget: get('login-form') });
  // Flush the gallery's initial async load (no real network or timer).
  await new Promise(resolve => setImmediate(resolve));
  const target = get(surface === 'admin' ? 'invites' : 'films');
  assert.equal(target.children.length, 1, get(surface === 'admin' ? 'login-error' : 'notice').textContent);
  assert.equal(calls.length, 2);
  return target.textContent;
}

const row = (accounting, reservedEstimateCu = 2, spentEstimateCu = 0) => ({
  id: 'generation_1', inviteId: 'invite_self', runId: 'private_run', packageId: 'private_package',
  title: 'Shared film', prompt: 'Intentionally shared prompt', status: 'ready', showcase: true, createdAt: 1,
  spentEstimateCu, details: { accounting, reservedEstimateCu },
});

for (const surface of ['admin', 'gallery']) {
  test(`${surface}: unresolved CU is held, not charged or free`, async () => {
    const text = await render(surface, [row({ status: 'unresolved', actualSpendCu: null, costSource: 'unattributed_usage', shutdownVerified: true })]);
    assert.match(text, /Usage indeterminate; CU reserved · 2 CU held/);
    assert.doesNotMatch(text, /Verified actual usage|CPU render|0 CU estimated/);
  });
  test(`${surface}: verified actual CU and unused release derive from accounting, not legacy spend`, async () => {
    const text = await render(surface, [row({ status: 'settled', actualSpendCu: 0.3, costSource: 'verified_session_usage', shutdownVerified: true }, 2, 99)]);
    assert.match(text, /Verified actual usage: 0.3 CU · 0 CU held · 1.7 CU unused released/);
    assert.doesNotMatch(text, /99 CU/);
  });
  test(`${surface}: historical charges are estimates even if legacy actual fields contain zero`, async () => {
    const text = await render(surface, [row({ status: 'legacy_estimate', actualSpendCu: 0, costSource: 'legacy_reserved_upper_estimate' }, 2, 1.2)]);
    assert.match(text, /Legacy estimate: 1.2 CU · actual usage unverified/);
    assert.doesNotMatch(text, /Verified actual|CPU render|CU held|unused released/);
  });
  test(`${surface}: exact CPU accounting and verified non-allocation are distinct zero-cost outcomes`, async () => {
    const cpu = await render(surface, [row({ status: 'not_required', actualSpendCu: 0, costSource: 'cpu_no_colab_spend' }, 0)]);
    assert.match(cpu, /CPU render · 0 CU \(no Colab allocation\)/);
    const rejected = await render(surface, [row({ status: 'settled', actualSpendCu: 0, costSource: 'verified_no_allocation', shutdownVerified: true })]);
    assert.match(rejected, /Verified actual usage: 0 CU · 0 CU held · 2 CU unused released/);
    assert.doesNotMatch(rejected, /CPU render/);
  });
  test(`${surface}: missing or invalid accounting never turns a legacy zero into verified free work`, async () => {
    for (const accounting of [undefined, { status: 'not_required', actualSpendCu: 0 },
      { status: 'not_required', actualSpendCu: null, costSource: 'cpu_no_colab_spend' },
      { status: 'settled', actualSpendCu: 0, costSource: 'account_balance_delta', shutdownVerified: true },
      { status: 'settled', actualSpendCu: 0, costSource: 'verified_session_usage', shutdownVerified: false },
      { status: 'settled', actualSpendCu: null, costSource: 'verified_session_usage', shutdownVerified: true }]) {
      const text = await render(surface, [row(accounting)]);
      assert.match(text, /Usage indeterminate/);
      assert.doesNotMatch(text, /Verified actual usage|CPU render|unused released/);
    }
  });
  test(`${surface}: accounting metadata is never dumped into the page`, async () => {
    const text = await render(surface, [row({ status: 'unresolved', actualSpendCu: null,
      reason: '<img src=x onerror=private_reason>', session: 'private_session', receiptId: 'private_receipt',
      runId: 'private_run', account: 'private_account', token: 'private_token' })]);
    assert.doesNotMatch(text, /private_|<img/);
  });
}

test('gallery projection exposes only own-invite bounded billing fields', () => {
  const own = row({ status: 'unresolved', actualSpendCu: 0, costSource: 'unattributed_usage', shutdownVerified: true,
    reason: 'secret_reason', runId: 'secret_run', session: 'secret_session', receipt: { token: 'secret_token' } });
  const foreign = { ...own, id: 'generation_other', inviteId: 'invite_other', details: { ...own.details, reservedEstimateCu: 987 } };
  const items = galleryFor([own, foreign]).items;
  assert.equal(items[0].fromThisInvite, false);
  assert.equal(Object.hasOwn(items[0], 'accounting'), false);
  assert.deepEqual(items[1].accounting, { status: 'unresolved', costSource: 'unattributed_usage', shutdownVerified: true,
    actualSpendCu: null, reservedEstimateCu: 2, legacyEstimateCu: null });
  assert.doesNotMatch(JSON.stringify(items), /secret_|private_|987/);
});

test('gallery UI ignores even accidentally supplied foreign-invite billing fields', async () => {
  const text = await render('gallery', [{ ...row(), fromThisInvite: false,
    accounting: { status: 'unresolved', reservedEstimateCu: 987 } }], { rawGallery: true });
  assert.doesNotMatch(text, /987|CU held|Usage indeterminate|private_/);
});
