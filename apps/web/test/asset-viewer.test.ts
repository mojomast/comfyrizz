// @ts-nocheck
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as viewerModule from '../src/viewer/asset-viewer.ts';
import { mountAssetViewer } from '../src/viewer/asset-viewer.ts';

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
    this.id = '';
    this.value = '';
    this.hidden = false;
    this.disabled = false;
    this.open = false;
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
    return child;
  }

  append(...nodes) {
    for (const node of nodes) this.appendChild(node);
  }

  replaceChildren(...nodes) {
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

  set innerHTML(value) {
    this._innerHTML = String(value);
    this.children = [];
    if (this._innerHTML.includes('data-compare-view')) {
      const view = new FakeElement('section', this.ownerDocument);
      view.setAttribute('data-compare-view', '');
      this.appendChild(view);
    }
  }

  get innerHTML() {
    return this._innerHTML;
  }

  querySelector(selector) {
    if (selector === '[data-compare-view]') return findAttr(this, 'data-compare-view') ?? null;
    return null;
  }

  querySelectorAll() {
    return [];
  }

  getBoundingClientRect() {
    return { left: 0, top: 0, width: 1000, height: 500, right: 1000, bottom: 500 };
  }

  focus() {
    this.focused = true;
    this.ownerDocument.activeElement = this;
  }

  showModal() {
    this.open = true;
    this.modal = true;
  }

  close() {
    this.open = false;
    this.dispatchEvent({ type: 'close' });
  }

  play() {
    return Promise.resolve();
  }

  pause() {}
}

class FakeDocument {
  constructor({ reducedMotion = false } = {}) {
    this.activeElement = null;
    this.reducedMotion = reducedMotion;
    this.defaultView = {
      matchMedia: query => ({ matches: this.reducedMotion, media: query }),
    };
  }

  createElement(tagName) {
    return new FakeElement(tagName, this);
  }
}

function fakeDocument(options = {}) {
  return new FakeDocument(options);
}

function host(document) {
  return new FakeElement('div', document);
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

function findAttr(root, name) {
  const key = name.toLowerCase();
  return [root, ...descendants(root)].find(node => node.hasAttribute(key));
}

function findAllAttr(root, name) {
  const key = name.toLowerCase();
  return [root, ...descendants(root)].filter(node => node.hasAttribute(key));
}

function viewerHooks(element) {
  return Array.from(element.attributes.keys()).filter(name => (
    name === 'data-viewer' || name.startsWith('data-viewer-')
  ));
}

function click(element) {
  element.dispatchEvent({ type: 'click' });
}

function keydown(element, key, shiftKey = false) {
  element.dispatchEvent({ type: 'keydown', key, shiftKey });
}

function imageItem(overrides = {}) {
  return { id: 'a_img', kind: 'image', title: 'Still', src: '/api/media/img-ticket', width: 1920, height: 1080, ...overrides };
}

function videoItem(overrides = {}) {
  return { id: 'a_vid', kind: 'video', title: 'Take', src: '/api/media/video-ticket', duration: 10, fps: 10, width: 1920, height: 1080, ...overrides };
}

function audioItem(overrides = {}) {
  return { id: 'a_aud', kind: 'audio', title: 'Voice', src: '/api/media/audio-ticket', duration: 20, ...overrides };
}

function take(n) {
  return {
    takeId: `tk_${String(n).repeat(12)}`,
    assetId: 'a_vid',
    n,
    file: `takes/a_vid/take-${n}.mp4`,
    sha256: String(n).repeat(64),
    bytes: 1024 * n,
    media: { fps: 24, frames: 48, durationInSeconds: 2 },
    gen: { generator: 'comfyui', prompt: `take ${n}`, seed: n },
    createdAt: '2026-10-23T12:00:00.000Z',
    verdict: 'unreviewed',
  };
}

function fakeApi(calls = []) {
  return {
    async select(packageId, clipId, takeId) {
      calls.push({ packageId, clipId, takeId });
      return { kind: 'selected', packageId, revision: 2, clip: {}, takeId };
    },
  };
}

function compareOptions(overrides = {}) {
  return {
    packageId: 'pkg_1',
    shotId: 's1',
    clipId: 's1:a_vid',
    api: fakeApi(),
    takes: [take(1), take(2)],
    selected: take(2).takeId,
    shots: [{ shotId: 's1', clipId: 's1:a_vid' }, { shotId: 's2', clipId: 's2:a_vid' }],
    ...overrides,
  };
}

function mount(options) {
  const document = options.document ?? fakeDocument();
  const target = options.host ?? host(document);
  const opener = options.opener ?? new FakeElement('button', document);
  const closed = [];
  const handle = mountAssetViewer({
    ...options,
    document,
    host: target,
    opener,
    onClose: options.onClose ?? (() => closed.push(true)),
  });
  return { document, host: target, opener, handle, closed };
}

test('one export and one data hook per element', () => {
  assert.deepEqual(Object.keys(viewerModule), ['mountAssetViewer']);

  const { host, handle } = mount({ items: [imageItem()], index: 0 });
  for (const node of [host, ...descendants(host)]) {
    assert.ok(viewerHooks(node).length <= 1, `element ${node.tagName} carries ${viewerHooks(node).join(', ')}`);
  }
  handle.destroy();
});

test('opens a native dialog, labels it by the title, focuses the media and announces the position', () => {
  const { handle, document, host, opener } = mount({ items: [imageItem(), videoItem()], index: 0 });
  const dialog = handle.element;
  const title = findAttr(host, 'data-viewer-title');
  const live = findAttr(host, 'data-viewer-live');
  const media = findAttr(host, 'data-viewer-media');

  assert.equal(dialog.tagName, 'DIALOG');
  assert.equal(dialog.open, true);
  assert.equal(dialog.modal, true);
  assert.equal(dialog.getAttribute('aria-labelledby'), title.id);
  assert.equal(title.id.length > 0, true);
  assert.equal(document.activeElement, media);
  assert.equal(live.textContent, 'Asset 1 of 2');
  assert.equal(live.getAttribute('aria-live'), 'polite');
  assert.equal(handle.state.index, 0);
  assert.equal(handle.state.item.id, 'a_img');
  assert.ok(opener);
  handle.destroy();
});

test('Escape closes the dialog and returns focus to the opener once', () => {
  const closed = [];
  const { handle, host, opener } = mount({
    items: [imageItem()],
    index: 0,
    onClose: () => closed.push(true),
  });
  const dialog = handle.element;
  keydown(dialog, 'Escape');

  assert.equal(dialog.open, false);
  assert.equal(opener.focused, true);
  assert.deepEqual(closed, [true]);
  assert.equal(handle.state.open, false);
  assert.ok(host);
});

test('the cancel event closes and returns focus to the opener', () => {
  const { handle, opener } = mount({ items: [imageItem()], index: 0 });
  handle.element.dispatchEvent({ type: 'cancel' });
  assert.equal(handle.element.open, false);
  assert.equal(opener.focused, true);
});

test('previous and next update the live region and are disabled at the ends', () => {
  const { handle, host } = mount({ items: [imageItem(), videoItem(), audioItem()], index: 0 });
  const prev = findAttr(host, 'data-viewer-prev');
  const next = findAttr(host, 'data-viewer-next');
  const live = findAttr(host, 'data-viewer-live');

  assert.equal(prev.disabled, true);
  assert.equal(next.disabled, false);
  click(next);
  assert.equal(live.textContent, 'Asset 2 of 3');
  assert.equal(handle.state.index, 1);
  assert.equal(prev.disabled, false);
  click(next);
  assert.equal(live.textContent, 'Asset 3 of 3');
  assert.equal(next.disabled, true);
  click(prev);
  assert.equal(live.textContent, 'Asset 2 of 3');
  handle.destroy();
});

test('region mode changes only from the R key or the Region button, never from a stray pointer down', () => {
  const { handle, host } = mount({ items: [imageItem()], index: 0 });
  const media = findAttr(host, 'data-viewer-media');
  const regionButton = findAttr(host, 'data-viewer-region');

  media.dispatchEvent({ type: 'pointerdown', clientX: 400, clientY: 250 });
  assert.equal(handle.state.regionMode, false);

  keydown(handle.element, 'r');
  assert.equal(handle.state.regionMode, true);
  assert.equal(regionButton.getAttribute('aria-pressed'), 'true');

  media.dispatchEvent({ type: 'pointerdown', clientX: 400, clientY: 250 });
  assert.equal(handle.state.regionMode, true);

  keydown(handle.element, 'r');
  assert.equal(handle.state.regionMode, false);

  click(regionButton);
  assert.equal(handle.state.regionMode, true);
  assert.equal(findAttr(host, 'data-viewer-region-desc').textContent.length > 0, true);
  handle.destroy();
});

test('the hover preview uses the filmstrip tile nearest the hovered time', () => {
  const filmstrip = {
    status: 'ready',
    key: 'b'.repeat(64),
    ticketUrl: '/api/media/0123456789abcdef0123456789abcdef',
    width: 300,
    height: 50,
    tiles: [
      { t: 0, x: 0, y: 0, w: 100, h: 50 },
      { t: 5, x: 100, y: 0, w: 100, h: 50 },
      { t: 9, x: 200, y: 0, w: 100, h: 50 },
    ],
  };
  const { handle, host, document } = mount({
    document: fakeDocument(),
    items: [videoItem()],
    index: 0,
    media: { a_vid: { filmstrip } },
  });
  assert.ok(document);
  const media = findAttr(host, 'data-viewer-media');
  const hover = findAttr(host, 'data-viewer-hover');

  media.dispatchEvent({ type: 'pointermove', clientX: 520, clientY: 100 });
  assert.equal(hover.hidden, false);
  assert.match(hover.style.backgroundImage, /0123456789abcdef0123456789abcdef/);
  assert.equal(hover.style.backgroundPosition, '-100px 0px');

  media.dispatchEvent({ type: 'pointermove', clientX: 910, clientY: 100 });
  assert.equal(hover.style.backgroundPosition, '-200px 0px');

  media.dispatchEvent({ type: 'pointerleave' });
  assert.equal(hover.hidden, true);
  handle.destroy();
});

test('frame step walks by 1/fps and keeps the scrub in step', () => {
  const { handle, host } = mount({ items: [videoItem()], index: 0 });
  const scrub = findAttr(host, 'data-viewer-scrub');

  keydown(handle.element, '.');
  assert.ok(Math.abs(handle.state.time - 0.1) < 1e-9);
  assert.equal(scrub.value, '0.1');

  keydown(handle.element, '.');
  assert.ok(Math.abs(handle.state.time - 0.2) < 1e-9);

  keydown(handle.element, ',');
  assert.ok(Math.abs(handle.state.time - 0.1) < 1e-9);
  handle.destroy();
});

test('frame step falls back to 1/30 when the item has no fps', () => {
  const { handle, host } = mount({ items: [videoItem({ fps: undefined })], index: 0 });
  keydown(handle.element, '.');
  assert.ok(Math.abs(handle.state.time - 1 / 30) < 1e-9);
  assert.ok(findAttr(host, 'data-viewer-scrub'));
  handle.destroy();
});

test('image zoom stays between 1x and 4x with buttons and label', () => {
  const { handle, host } = mount({ items: [imageItem()], index: 0 });
  const zoomIn = findAttr(host, 'data-viewer-zoom-in');
  const zoomOut = findAttr(host, 'data-viewer-zoom-out');
  const label = findAttr(host, 'data-viewer-zoom-label');

  assert.equal(label.textContent, '1x');
  assert.equal(zoomOut.disabled, true);
  for (let i = 0; i < 20; i += 1) click(zoomIn);
  assert.equal(label.textContent, '4x');
  assert.equal(zoomIn.disabled, true);

  for (let i = 0; i < 20; i += 1) click(zoomOut);
  assert.equal(label.textContent, '1x');
  assert.equal(zoomOut.disabled, true);

  keydown(handle.element, '+');
  assert.equal(label.textContent, '1.5x');
  keydown(handle.element, '-');
  assert.equal(label.textContent, '1x');
  handle.destroy();
});

test('compare is disabled with a visible reason when package, shot or clip is missing', () => {
  const { handle, host } = mount({
    items: [videoItem()],
    index: 0,
    compare: compareOptions({ shotId: '' }),
  });
  const compare = findAttr(host, 'data-viewer-compare');
  const reason = findAttr(host, 'data-viewer-compare-error');
  const compareHost = findAttr(host, 'data-viewer-compare-host');

  assert.equal(compare.disabled, true);
  assert.equal(compare.getAttribute('aria-disabled'), 'true');
  assert.ok(reason.textContent.length > 0);
  assert.notEqual(reason.textContent, '');
  assert.match(reason.textContent, /shot/i);
  assert.equal(reason.hidden, false);
  assert.equal(compareHost.hidden, true);
  click(compare);
  assert.equal(compareHost.hidden, true);
  handle.destroy();
});

test('compare opens through the real mountCompare with the exact shot id', () => {
  const { handle, host } = mount({
    items: [videoItem()],
    index: 0,
    compare: compareOptions(),
  });
  const compare = findAttr(host, 'data-viewer-compare');
  const compareHost = findAttr(host, 'data-viewer-compare-host');

  assert.equal(compare.disabled, false);
  click(compare);
  assert.equal(handle.state.compare, true);
  assert.equal(compareHost.hidden, false);
  assert.match(compareHost.innerHTML, /data-compare-view/);
  assert.match(compareHost.innerHTML, /data-compare-shot="s1"/);

  const source = readFileSync(new URL('../src/viewer/asset-viewer.ts', import.meta.url), 'utf8');
  assert.match(source, /shotId:\s*compare\.shotId/);
  assert.match(source, /clipId:\s*compare\.clipId/);
  assert.doesNotMatch(source, /shotId:\s*compare\.shotId\s*\?\?/);
  assert.doesNotMatch(source, /clipId:\s*compare\.clipId\s*\?\?/);
  assert.doesNotMatch(source, /mountCompare[\s\S]{0,80}import\(/);
  handle.destroy();
});

test('a compare mount error is shown in the dialog instead of closing it', () => {
  const { handle, host } = mount({
    items: [videoItem()],
    index: 0,
    compare: compareOptions({ api: {} }),
  });
  click(findAttr(host, 'data-viewer-compare'));
  const reason = findAttr(host, 'data-viewer-compare-error');

  assert.equal(reason.hidden, false);
  assert.match(reason.textContent, /compare/i);
  assert.equal(handle.element.open, true);
  assert.equal(handle.state.compare, false);
  handle.destroy();
});

test('E returns the model annotation with the exact target ids', () => {
  const calls = [];
  const { handle, host } = mount({
    items: [imageItem()],
    index: 0,
    compare: compareOptions(),
    onIterate: payload => calls.push(payload),
  });
  keydown(handle.element, 'r');
  keydown(handle.element, 'ArrowRight');
  keydown(handle.element, 'e');

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], {
    target: {
      packageId: 'pkg_1',
      shotId: 's1',
      clipId: 's1:a_vid',
      assetId: 'a_img',
    },
    annotation: handle.state.annotation,
  });
  assert.ok(findAttr(host, 'data-viewer-iterate'));
  handle.destroy();
});

test('media data comes only from options.media and item.src', () => {
  const { handle, host } = mount({
    items: [
      videoItem({ posterUrl: '/api/media/wrong-poster' }),
      imageItem(),
    ],
    index: 0,
    media: {
      a_vid: {
        posterUrl: '/api/media/poster-ticket',
        filmstrip: { status: 'ready', key: 'c'.repeat(64), ticketUrl: '/api/media/strip', width: 160, height: 90, tiles: [] },
      },
    },
  });
  const video = descendants(findAttr(host, 'data-viewer-media')).find(node => node.tagName === 'VIDEO');
  assert.equal(video.poster, '/api/media/poster-ticket');
  assert.equal(video.src, '/api/media/video-ticket');

  click(findAttr(host, 'data-viewer-next'));
  const image = descendants(findAttr(host, 'data-viewer-media')).find(node => node.tagName === 'IMG');
  assert.equal(image.src, '/api/media/img-ticket');
  handle.destroy();
});

test('audio renders a waveform from peaks and a play control', () => {
  const { handle, host } = mount({
    items: [audioItem()],
    index: 0,
    media: { a_aud: { peaks: [0.1, 0.5, 1, 0.25] } },
  });
  const bars = descendants(findAttr(host, 'data-viewer-media')).filter(node => node.className.includes('viewer-wave-bar'));
  assert.equal(bars.length, 4);
  assert.ok(findAttr(host, 'data-viewer-play'));
  handle.destroy();
});

test('reduced motion comes from options or the injected document and sets a data attribute', () => {
  const reduced = mount({ document: fakeDocument({ reducedMotion: true }), items: [imageItem()], index: 0 });
  assert.equal(reduced.handle.element.getAttribute('data-reduced-motion'), 'true');
  reduced.handle.destroy();

  const forcedOff = mount({
    document: fakeDocument({ reducedMotion: true }),
    items: [imageItem()],
    index: 0,
    reducedMotion: false,
  });
  assert.equal(forcedOff.handle.element.getAttribute('data-reduced-motion'), 'false');
  forcedOff.handle.destroy();

  const forcedOn = mount({ document: fakeDocument({ reducedMotion: false }), items: [imageItem()], index: 0, reducedMotion: true });
  assert.equal(forcedOn.handle.element.getAttribute('data-reduced-motion'), 'true');
  forcedOn.handle.destroy();
});

test('the stylesheet disables transitions under the reduced motion data attribute', () => {
  const css = readFileSync(new URL('../src/viewer/viewer.css', import.meta.url), 'utf8');
  assert.match(css, /\[data-reduced-motion="true"\]/);
  assert.match(css, /transition:\s*none/);
});
