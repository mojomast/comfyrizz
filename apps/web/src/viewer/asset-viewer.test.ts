// UX12: exact-target, audible and accessible review in the asset viewer.
// Node's test runner has no DOM, so the viewer is mounted on a deterministic
// fake document. No network, no Files API and no media bytes are touched.
// @ts-nocheck
import test from 'node:test';
import assert from 'node:assert/strict';
import { mountAssetViewer } from './asset-viewer.ts';
import { displayedToMediaRegion } from './model.ts';

class FakeElement {
  constructor(tagName, ownerDocument) {
    this.tagName = String(tagName).toUpperCase();
    this.ownerDocument = ownerDocument;
    this.parentNode = null;
    this.children = [];
    this.attributes = new Map();
    this.listeners = new Map();
    this.dataset = {};
    this.style = {};
    this.className = '';
    this.textContent = '';
    this.value = '';
    this.hidden = false;
    this.disabled = false;
    this.open = false;
    this.paused = true;
    this.ended = false;
    this.currentTime = 0;
    this.duration = NaN;
    this.muted = false;
    this.focused = false;
    this._innerHTML = '';
  }

  get classList() {
    const element = this;
    return {
      contains: name => element.className.split(/\s+/).includes(name),
      add: name => {
        const names = element.className.split(/\s+/).filter(Boolean);
        if (!names.includes(name)) names.push(name);
        element.className = names.join(' ');
      },
    };
  }

  set src(value) {
    this.setAttribute('src', value);
  }

  get src() {
    return this.getAttribute('src') ?? '';
  }

  set poster(value) {
    this.setAttribute('poster', value);
  }

  get poster() {
    return this.getAttribute('poster') ?? '';
  }

  set innerHTML(value) {
    this._innerHTML = String(value);
    this.children = [];
  }

  get innerHTML() {
    return this._innerHTML;
  }

  setAttribute(name, value) {
    this.attributes.set(String(name).toLowerCase(), String(value));
  }

  getAttribute(name) {
    const key = String(name).toLowerCase();
    return this.attributes.has(key) ? this.attributes.get(key) : null;
  }

  hasAttribute(name) {
    return this.attributes.has(String(name).toLowerCase());
  }

  removeAttribute(name) {
    this.attributes.delete(String(name).toLowerCase());
  }

  appendChild(child) {
    child.parentNode = this;
    child.ownerDocument = this.ownerDocument;
    this.children.push(child);
    this.ownerDocument?.created?.push(child);
    return child;
  }

  append(...nodes) {
    for (const node of nodes) this.appendChild(node);
  }

  replaceChildren(...nodes) {
    for (const child of this.children) child.parentNode = null;
    this.children = [];
    this.append(...nodes);
  }

  removeChild(child) {
    const index = this.children.indexOf(child);
    if (index >= 0) this.children.splice(index, 1);
    child.parentNode = null;
    return child;
  }

  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(listener);
  }

  removeEventListener(type, listener) {
    this.listeners.get(type)?.delete(listener);
  }

  dispatchEvent(event = {}) {
    const payload = {
      ...event,
      type: event.type,
      target: this,
      currentTarget: this,
      defaultPrevented: false,
      preventDefault() { this.defaultPrevented = true; },
      stopPropagation() { this.propagationStopped = true; },
    };
    let node = this;
    while (node) {
      const listeners = node.listeners.get(payload.type);
      if (listeners) {
        for (const listener of Array.from(listeners)) listener.call(node, payload);
      }
      if (payload.propagationStopped) break;
      node = node.parentNode;
    }
    return !payload.defaultPrevented;
  }

  getBoundingClientRect() {
    return { left: 0, top: 0, width: 1000, height: 500, right: 1000, bottom: 500 };
  }

  focus() {
    this.focused = true;
    if (this.ownerDocument) this.ownerDocument.activeElement = this;
  }

  showModal() {
    this.open = true;
  }

  close() {
    this.open = false;
    this.dispatchEvent({ type: 'close' });
  }

  play() {
    this.paused = false;
    return Promise.resolve();
  }

  pause() {
    this.paused = true;
  }
}

class FakeDocument {
  constructor() {
    this.activeElement = null;
    this.created = [];
    this.defaultView = {
      matchMedia: query => ({ matches: false, media: query }),
    };
  }

  createElement(tagName) {
    return new FakeElement(tagName, this);
  }
}

function fakeDocument() {
  return new FakeDocument();
}

function mount(options) {
  const document = options.document ?? fakeDocument();
  const host = options.host ?? new FakeElement('div', document);
  const opener = options.opener ?? new FakeElement('button', document);
  const handle = mountAssetViewer({
    ...options,
    document,
    host,
    opener,
  });
  return { document, host, opener, handle };
}

function descendants(root) {
  const found = [];
  const visit = node => {
    for (const child of node.children ?? []) {
      found.push(child);
      visit(child);
    }
  };
  visit(root);
  return found;
}

function findAllAttr(root, name) {
  const key = name.toLowerCase();
  return [root, ...descendants(root)].filter(node => node.hasAttribute(key));
}

function findAttr(root, name) {
  return findAllAttr(root, name)[0] ?? null;
}

function click(element) {
  element.dispatchEvent({ type: 'click' });
}

function keydown(element, key, init = {}) {
  element.dispatchEvent({ type: 'keydown', key, shiftKey: false, ...init });
}

function tick() {
  return new Promise(resolve => setTimeout(resolve, 0));
}

function item(id, kind, overrides = {}) {
  return {
    id,
    kind,
    title: id,
    ...(kind === 'video' || kind === 'audio' ? { duration: 10, fps: 10 } : {}),
    ...overrides,
  };
}

function compareOptions(overrides = {}) {
  return {
    packageId: 'pkg_1',
    shotId: 's1',
    clipId: 's1:a_vid',
    api: { async select() { return { kind: 'selected', takeId: 'tk_1' }; } },
    takes: [],
    ...overrides,
  };
}

test('iterate carries the exact target of the item that is on screen', () => {
  const calls = [];
  const items = [
    item('a1', 'video', {
      src: '/api/media/a1',
      target: { shotId: 's1', clipId: 's1:a1', takeId: 'tk_hist_1', assetId: 'a1' },
    }),
    item('a2', 'video', {
      src: '/api/media/a2',
      target: { shotId: 's2', clipId: 's2:a2', takeId: 'tk_hist_2', assetId: 'a2' },
    }),
  ];
  const { handle } = mount({
    items,
    index: 0,
    compare: compareOptions(),
    onIterate: payload => calls.push(payload),
  });

  handle.next();
  keydown(handle.element, 'e');
  assert.deepEqual(calls[0].target, {
    packageId: 'pkg_1',
    shotId: 's2',
    clipId: 's2:a2',
    takeId: 'tk_hist_2',
    assetId: 'a2',
  });

  handle.prev();
  keydown(handle.element, 'e');
  assert.deepEqual(calls[1].target, {
    packageId: 'pkg_1',
    shotId: 's1',
    clipId: 's1:a1',
    takeId: 'tk_hist_1',
    assetId: 'a1',
  });
  handle.destroy();
});

test('an on-demand source shows loading and is discarded when navigation moves on', async () => {
  const pending = new Map();
  const resolveSource = (current, signal) => new Promise((resolve, reject) => {
    pending.set(current.id, { resolve, reject, signal });
  });
  const { handle, host } = mount({
    items: [item('a1', 'video'), item('a2', 'video')],
    index: 0,
    resolveSource,
  });

  const loading = findAttr(host, 'data-viewer-loading');
  assert.ok(loading);
  assert.equal(loading.hidden, false);
  assert.match(loading.textContent, /loading/i);

  handle.next();
  assert.equal(pending.get('a1').signal.aborted, true);
  assert.equal(findAttr(host, 'data-viewer-loading').hidden, false);

  pending.get('a2').resolve({ src: '/api/media/a2' });
  await tick();
  const video = descendants(findAttr(host, 'data-viewer-media')).find(node => node.tagName === 'VIDEO');
  assert.equal(video.src, '/api/media/a2');
  assert.equal(findAttr(host, 'data-viewer-loading').hidden, true);

  pending.get('a1').resolve({ src: '/api/media/a1' });
  await tick();
  assert.equal(video.src, '/api/media/a2');
  assert.equal(handle.state.item.id, 'a2');
  assert.equal(findAllAttr(host, 'src').some(node => node.src === '/api/media/a1'), false);
  handle.destroy();
});

test('an on-demand source failure is visible and can be retried', async () => {
  let attempt = 0;
  const { handle, host } = mount({
    items: [item('a1', 'video')],
    index: 0,
    resolveSource: async () => {
      attempt += 1;
      if (attempt === 1) throw new Error('Files media unavailable');
      return { src: '/api/media/a1' };
    },
  });

  await tick();
  const error = findAttr(host, 'data-viewer-error');
  assert.equal(error.hidden, false);
  assert.match(error.textContent, /unavailable/i);

  const retry = findAttr(host, 'data-viewer-retry');
  assert.ok(retry);
  click(retry);
  await tick();
  const video = descendants(findAttr(host, 'data-viewer-media')).find(node => node.tagName === 'VIDEO');
  assert.equal(video.src, '/api/media/a1');
  assert.equal(findAttr(host, 'data-viewer-error').hidden, true);
  handle.destroy();
});

test('a source that already resolves on the item skips loading', () => {
  const { handle, host } = mount({
    items: [item('a1', 'video', { src: '/api/media/a1' })],
    index: 0,
    resolveSource: async () => {
      throw new Error('must not be called');
    },
  });
  const loading = findAttr(host, 'data-viewer-loading');
  assert.ok(loading);
  assert.equal(loading.hidden, true);
  assert.equal(findAttr(host, 'data-viewer-error').hidden, true);
  handle.destroy();
});

test('audio and video play, pause, end and error stay in sync with the viewer', () => {
  const { handle, host } = mount({ items: [item('a1', 'video', { src: '/api/media/a1' })], index: 0 });
  const video = descendants(findAttr(host, 'data-viewer-media')).find(node => node.tagName === 'VIDEO');
  const play = findAttr(host, 'data-viewer-play');

  video.dispatchEvent({ type: 'play' });
  assert.equal(handle.state.playing, true);
  assert.equal(play.textContent, 'Pause');
  assert.equal(play.getAttribute('aria-pressed'), 'true');

  video.dispatchEvent({ type: 'pause' });
  assert.equal(handle.state.playing, false);
  assert.equal(play.textContent, 'Play');

  video.currentTime = 10;
  video.dispatchEvent({ type: 'ended' });
  assert.equal(handle.state.playing, false);
  assert.equal(handle.state.time, 10);

  video.dispatchEvent({ type: 'error' });
  assert.equal(findAttr(host, 'data-viewer-error').hidden, false);
  handle.destroy();
});

test('button Space and Enter and modifier chords stay with the focused control', () => {
  const { handle, host } = mount({ items: [item('a1', 'video', { src: '/api/media/a1' })], index: 0 });
  const play = findAttr(host, 'data-viewer-play');
  const close = findAttr(host, 'data-viewer-close');

  keydown(play, ' ');
  assert.equal(handle.state.playing, false);

  keydown(close, 'Enter');
  assert.equal(handle.state.open, true);

  keydown(handle.element, 'ArrowRight', { ctrlKey: true });
  assert.equal(handle.state.index, 0);
  keydown(handle.element, 'ArrowRight', { metaKey: true });
  assert.equal(handle.state.index, 0);
  keydown(handle.element, 'ArrowRight', { altKey: true });
  assert.equal(handle.state.index, 0);
  handle.destroy();
});

test('fifty open-close cycles leave no nodes, audio or listeners behind', () => {
  const created = [];
  for (let index = 0; index < 50; index += 1) {
    const document = fakeDocument();
    created.push(document);
    const { handle, host } = mount({
      document,
      items: [item('a1', 'audio', { src: '/api/media/a1' })],
      index: 0,
    });
    const audio = descendants(findAttr(host, 'data-viewer-media')).find(node => node.tagName === 'AUDIO');
    assert.ok(audio);
    handle.destroy();
    assert.equal(host.children.length, 0);
    assert.equal(audio.paused, true);
    assert.equal(audio.hasAttribute('src'), false);
  }

  const liveMedia = created
    .flatMap(document => document.created)
    .filter(node => node.tagName === 'AUDIO' || node.tagName === 'VIDEO')
    .filter(node => node.hasAttribute('src'));
  assert.deepEqual(liveMedia, []);
});

test('media-relative pointer annotation uses the media box, not the letterbox', () => {
  const { handle, host } = mount({
    items: [item('a1', 'image', { src: '/api/media/a1', width: 1920, height: 1080 })],
    index: 0,
  });
  keydown(handle.element, 'r');
  const media = findAttr(host, 'data-viewer-media');
  media.dispatchEvent({ type: 'pointerdown', clientX: 500, clientY: 250 });
  media.dispatchEvent({ type: 'pointerup' });

  const region = handle.state.annotation.region;
  assert.ok(region);
  assert.ok(Math.abs(region.x - 0.5) < 1e-9);
  assert.ok(Math.abs(region.y - 0.5) < 1e-9);
  handle.destroy();
});

test('zoom and letterbox map the same image feature to the same source point', () => {
  const display = { x: 0, y: 0, width: 1000, height: 500 };
  const media = { width: 1920, height: 1080 };
  const atZoomOne = displayedToMediaRegion({ x: 0.7222, y: 0.5, w: 0, h: 0 }, display, media, 1);
  const atZoomTwo = displayedToMediaRegion({ x: 0.9444, y: 0.5, w: 0, h: 0 }, display, media, 2);
  assert.ok(Math.abs(atZoomOne.x - 0.75) < 0.002);
  assert.ok(Math.abs(atZoomTwo.x - 0.75) < 0.002);
  assert.ok(Math.abs(atZoomOne.y - 0.5) < 1e-9);
  assert.ok(Math.abs(atZoomTwo.y - 0.5) < 1e-9);
});
