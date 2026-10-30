// @ts-nocheck — node:test is intentionally outside the browser type environment.
import test from 'node:test';
import assert from 'node:assert/strict';
import { isProjectsRoute, loadProjectsGallery, mountProjectsGallery, projectOpenHref, renderProjectsGallery } from './projects-gallery.ts';
import { mountProjectNavigation, projectNavigationTarget, renderProjectNavigation } from '../project-gallery-navigation.ts';

test('the boot hook claims only view=projects so routing can skip the sample document', () => {
  assert.equal(isProjectsRoute('?view=projects'), true);
  assert.equal(isProjectsRoute('?view=projects&demo=1'), true);
  assert.equal(isProjectsRoute('?package=pkg_a&view=editor'), false);
  assert.equal(isProjectsRoute(''), false);
});

test('owner collection clears old project identity; hosted navigation stays scoped to its gallery', () => {
  const owner = projectNavigationTarget({ search: '?package=old&chat=old-chat&production=old-prod&step=review&edit=1&theme=dark' });
  const params = new URLSearchParams(owner.href);
  assert.equal(owner.label, 'Projects');
  assert.equal(params.get('view'), 'projects');
  assert.equal(params.get('theme'), 'dark');
  for (const key of ['package', 'chat', 'production', 'step', 'edit']) assert.equal(params.has(key), false);
  assert.deepEqual(projectNavigationTarget({ search: '?demo=1&package=private', baseURI: 'https://example.test/hosted-demo/' }), {
    label: 'Gallery', href: '/hosted-demo/gallery/',
  });
  assert.match(renderProjectNavigation({ search: '?demo=1' }), /data-guest-gallery/);
});

test('editor topbar integration mounts one stable control and updates it in place', () => {
  const children = [];
  const host = {
    ownerDocument: { createElement: () => {
      const node = { dataset: {}, remove() { const index = children.indexOf(node); if (index >= 0) children.splice(index, 1); } };
      return node;
    } },
    querySelector: () => children[0] ?? null,
    append: node => children.push(node),
  };
  const dispose = mountProjectNavigation(host, { search: '?package=pkg_a&view=editor' });
  assert.equal(children.length, 1);
  assert.equal(children[0].textContent, 'Projects');
  assert.equal(new URLSearchParams(children[0].href).get('view'), 'projects');
  assert.equal(new URLSearchParams(children[0].href).has('package'), false);
  mountProjectNavigation(host, { search: '?demo=1' });
  assert.equal(children.length, 1, 'a second mount must not duplicate the entry');
  assert.equal(children[0].textContent, 'Gallery');
  assert.equal(children[0].href, '/gallery/');
  dispose();
  assert.equal(children.length, 0);
});

test('saved drafts and unfinished packages appear without any completed-film requirement', async () => {
  const calls = [];
  const projects = await loadProjectsGallery({ request: async path => {
    calls.push(path);
    return { ok: true, json: async () => [{ id: 'pkg_draft', title: 'My draft <cut>', durationS: 45, aspect: '16:9', updatedAt: '2026-10-30T10:00:00Z' }] };
  } });
  assert.deepEqual(calls, ['/api/packages']);
  const html = renderProjectsGallery({ status: 'ready', projects });
  assert.match(html, /My draft &lt;cut&gt;/);
  for (const mode of ['super-easy', 'easy', 'editor', 'chat']) {
    const params = new URLSearchParams(projectOpenHref(projects[0].id, mode));
    assert.equal(params.get('package'), 'pkg_draft');
    assert.equal(params.has('chat'), false, 'the previous project conversation must never follow a new selection');
    assert.match(html, new RegExp(`data-project-mode="${mode}"`));
  }
  assert.match(html, /Chat with agent/);
});

test('empty lists are authoritative and malformed/error responses stay errors', async () => {
  const previous = globalThis.localStorage;
  globalThis.localStorage = { getItem: () => JSON.stringify([{ packageId: 'stale', title: 'Stale sample' }]) };
  try {
    assert.deepEqual(await loadProjectsGallery({ request: async () => ({ ok: true, json: async () => [] }) }), []);
    await assert.rejects(loadProjectsGallery({ request: async () => ({ ok: false, status: 401 }) }), /owner session/);
    await assert.rejects(loadProjectsGallery({ request: async () => ({ ok: true, json: async () => ({}) }) }), /invalid project list/);
    const html = renderProjectsGallery({ status: 'ready', projects: [] });
    assert.match(html, /No saved projects yet/);
    assert.doesNotMatch(html, /Stale sample|Pip|Try the example/);
  } finally {
    if (previous === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = previous;
  }
});

function rootFixture(search = '') {
  const listeners = new Map();
  return {
    innerHTML: '',
    ownerDocument: { title: '', baseURI: 'https://example.test/hosted-demo/', defaultView: { location: { search } } },
    addEventListener: (type, listener) => listeners.set(type, listener),
    removeEventListener: type => listeners.delete(type),
    click: event => listeners.get('click')?.(event),
  };
}

test('guest collection requests never reach the owner API, including accidental mount', async () => {
  let requests = 0;
  const request = async () => { requests++; throw new Error('owner request'); };
  await assert.rejects(loadProjectsGallery({ request, search: '?demo=1' }), /Open Gallery/);
  const root = rootFixture('?demo=1');
  const dispose = mountProjectsGallery(root, { request });
  assert.equal(requests, 0);
  assert.match(root.innerHTML, /href="\/hosted-demo\/gallery\/"/);
  assert.equal(root.ownerDocument.title, 'Gallery · Comfyrizz');
  dispose();
});

test('collection displays loading and failure, retries, and cannot repaint after disposal', async () => {
  const root = rootFixture();
  let resolve;
  let calls = 0;
  const dispose = mountProjectsGallery(root, { request: () => {
    calls++;
    return new Promise(done => { resolve = done; });
  } });
  assert.match(root.innerHTML, /Loading your saved projects/);
  assert.equal(root.ownerDocument.title, 'Projects · Comfyrizz');
  resolve({ ok: false, status: 503 });
  await new Promise(done => setImmediate(done));
  assert.match(root.innerHTML, /Projects unavailable/);
  root.click({ target: { closest: selector => selector === '[data-projects-retry]' ? {} : null } });
  assert.equal(calls, 2);
  assert.match(root.innerHTML, /Loading your saved projects/);
  dispose();
  resolve({ ok: true, json: async () => [{ id: 'late', title: 'Late response' }] });
  await new Promise(done => setImmediate(done));
  assert.equal(root.innerHTML, '');
});

test('SPA project opening carries the selected ID and mode, while modified clicks stay native', async () => {
  const root = rootFixture();
  const selections = [];
  let prevented = 0;
  const dispose = mountProjectsGallery(root, { request: async () => ({ ok: true, json: async () => [] }), onOpen: selection => selections.push(selection) });
  const event = {
    button: 0,
    target: { closest: selector => selector === '[data-project-open]' ? { dataset: { projectOpen: 'pkg_selected', projectMode: 'chat' } } : null },
    preventDefault: () => prevented++,
  };
  root.click(event);
  root.click({ ...event, ctrlKey: true });
  assert.deepEqual(selections, [{ packageId: 'pkg_selected', mode: 'chat' }]);
  assert.equal(prevented, 1);
  dispose();
});
