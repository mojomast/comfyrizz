// AV18: the review drawer loads real poster thumbnails for video takes and
// gives every row an "Open in viewer" action. The web package typecheck has no
// @types/node; node:test imports are runtime only.
// @ts-nocheck
import test from 'node:test';
import assert from 'node:assert/strict';
import { mountReviewDrawer } from '../src/takes/review-drawer.ts';

const PACKAGE_ID = 'pkg_launchdemo0001';
const POSTER_TICKET = '/api/media/poster_ticket_123';

function clip(n, overrides = {}) {
  const id = `ep2_video_a${String(n).padStart(2, '0')}`;
  return {
    clipId: id,
    sceneId: `s${n}`,
    assetId: `a_${n}`,
    slot: 'presenter',
    kind: 'presenter',
    from: (n - 1) * 90,
    durationInFrames: 90,
    state: 'review',
    selected: `tk_${String(n).repeat(12)}`,
    selectedN: 1,
    takeCount: 2,
    newTakes: 0,
    lastJob: null,
    queued: false,
    ...overrides,
  };
}

function videoTake(takeId, posterKey = 'poster_ref_a1') {
  return {
    takeId,
    assetId: 'a_1',
    n: 1,
    file: 'takes/a_1/clip.mp4',
    sha256: 'a'.repeat(64),
    bytes: 1024,
    media: { posterKey },
    gen: {},
    createdAt: '2026-10-23T00:00:00.000Z',
    verdict: 'unreviewed',
  };
}

function fakeTakesApi(takesByClip = {}) {
  const calls = [];
  return {
    calls,
    async getTakes(packageId, clipId) {
      calls.push({ packageId, clipId });
      const entry = takesByClip[clipId] ?? { selected: null, takes: [] };
      return {
        packageId,
        revision: 1,
        clip: { clipId },
        assetId: entry.takes?.[0]?.assetId ?? 'a_1',
        selected: entry.selected ?? null,
        takes: entry.takes ?? [],
        history: [],
        lastJob: null,
        queued: null,
      };
    },
    async takeUrl() {
      throw new Error('video takes must not mint an image ticket');
    },
  };
}

function fakeThumbsClient(result = {
  status: 'ready',
  key: 'b'.repeat(64),
  ticketUrl: POSTER_TICKET,
  width: 160,
  height: 90,
}) {
  const loads = [];
  return {
    loads,
    async load(request) {
      loads.push(request);
      return result;
    },
    retry() {},
  };
}

// Minimal DOM harness for mountReviewDrawer, matching the drawer test.
const decodeEntities = value => String(value)
  .replace(/&lt;/g, '<')
  .replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"')
  .replace(/&#39;/g, "'")
  .replace(/&amp;/g, '&');

const VOID_TAGS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
const ATTRIBUTE = /([a-zA-Z_:][-\w:.]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;

function matchSimple(element, selector) {
  const value = String(selector ?? '').trim();
  if (!value) return false;
  if (value.startsWith('#')) return element.getAttribute('id') === value.slice(1);
  if (value.startsWith('.')) return String(element.className ?? '').split(/\s+/).includes(value.slice(1));
  const attribute = /^\[([\w-]+)(?:=(?:"([^"]*)"|'([^']*)'|([^\]]+)))?\]$/.exec(value);
  if (attribute) {
    const found = element.getAttribute(attribute[1]);
    if (found === null) return false;
    const wanted = attribute[2] ?? attribute[3] ?? attribute[4];
    return wanted === undefined ? true : found === wanted;
  }
  return element.tagName.toLowerCase() === value.toLowerCase();
}

function parseAttributes(element, source) {
  ATTRIBUTE.lastIndex = 0;
  let match;
  while ((match = ATTRIBUTE.exec(source ?? '')) !== null) {
    element.setAttribute(match[1], decodeEntities(match[2] ?? match[3] ?? match[4] ?? ''));
  }
}

function parseHtml(root, html, ownerDocument) {
  const stack = [root];
  const tokenizer = /<!--[\s\S]*?-->|<\/?([a-zA-Z][\w:-]*)((?:\s+[^\s"'>/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*)\s*\/?>|[^<]+/g;
  let token;
  while ((token = tokenizer.exec(html)) !== null) {
    const value = token[0];
    if (value.startsWith('<!--')) continue;
    if (value.startsWith('</')) {
      const tag = token[1].toLowerCase();
      for (let index = stack.length - 1; index > 0; index -= 1) {
        if (stack[index].tagName.toLowerCase() === tag) {
          stack.length = index;
          break;
        }
      }
      continue;
    }
    if (value.startsWith('<')) {
      const element = ownerDocument.createElement(token[1]);
      parseAttributes(element, token[2]);
      stack[stack.length - 1].appendChild(element);
      if (!VOID_TAGS.has(token[1].toLowerCase()) && !value.endsWith('/>')) stack.push(element);
      continue;
    }
    stack[stack.length - 1].textContent += decodeEntities(value);
  }
}

class FakeElement {
  constructor(tagName, ownerDocument) {
    this.tagName = String(tagName).toUpperCase();
    this.ownerDocument = ownerDocument;
    this.parentNode = null;
    this.children = [];
    this.attributes = new Map();
    this.listeners = new Map();
    this._classes = [];
    this._html = '';
    this.textContent = '';
    this.value = '';
    this.disabled = false;
    this.hidden = false;
    this.scrollTop = 0;
    this.clientHeight = 0;
    this.isContentEditable = false;
  }

  get className() {
    return this._classes.join(' ');
  }

  set className(value) {
    this._classes = String(value ?? '').split(/\s+/).filter(Boolean);
  }

  get classList() {
    const element = this;
    return {
      contains: name => element._classes.includes(name),
      add: name => { if (!element._classes.includes(name)) element._classes.push(name); },
      remove: name => { element._classes = element._classes.filter(entry => entry !== name); },
    };
  }

  get parentElement() {
    return this.parentNode;
  }

  get dataset() {
    const element = this;
    const keyOf = name => `data-${String(name).replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`)}`;
    return new Proxy({}, {
      get(_target, name) { return element.attributes.get(keyOf(name)); },
      set(_target, name, value) { element.attributes.set(keyOf(name), String(value)); return true; },
      deleteProperty(_target, name) { element.attributes.delete(keyOf(name)); return true; },
      has(_target, name) { return element.attributes.has(keyOf(name)); },
    });
  }

  setAttribute(name, value) {
    const key = String(name).toLowerCase();
    this.attributes.set(key, String(value));
    if (key === 'class') this.className = value;
    if (key === 'disabled') this.disabled = true;
    if (key === 'hidden') this.hidden = true;
  }

  getAttribute(name) {
    const key = String(name).toLowerCase();
    return this.attributes.has(key) ? this.attributes.get(key) : null;
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
    for (const node of nodes) {
      if (typeof node === 'string') {
        const text = this.ownerDocument.createElement('#text');
        text.textContent = node;
        this.appendChild(text);
      } else {
        this.appendChild(node);
      }
    }
  }

  remove() {
    if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(child => child !== this);
    this.parentNode = null;
  }

  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(listener);
  }

  removeEventListener(type, listener) {
    this.listeners.get(type)?.delete(listener);
  }

  dispatchEvent(event = {}) {
    const payload = event;
    if (payload.target === undefined) payload.target = this;
    payload.defaultPrevented ??= false;
    payload.preventDefault ??= () => { payload.defaultPrevented = true; };
    payload.stopPropagation ??= () => { payload.propagationStopped = true; };
    let node = this;
    while (node) {
      payload.currentTarget = node;
      for (const listener of node.listeners.get(payload.type) ?? []) listener.call(node, payload);
      if (payload.propagationStopped || payload.bubbles === false) break;
      node = node.parentNode;
    }
    return !payload.defaultPrevented;
  }

  matches(selector) {
    return matchSimple(this, selector);
  }

  closest(selector) {
    let node = this;
    while (node) {
      if (node.matches?.(selector)) return node;
      node = node.parentNode;
    }
    return null;
  }

  querySelectorAll(selector) {
    const found = [];
    const walk = node => {
      for (const child of node.children) {
        if (child.matches?.(selector)) found.push(child);
        walk(child);
      }
    };
    walk(this);
    return found;
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] ?? null;
  }

  focus() {
    this.ownerDocument.activeElement = this;
  }

  get innerHTML() {
    return this._html;
  }

  set innerHTML(html) {
    this._html = String(html);
    this.children = [];
    this.textContent = '';
    parseHtml(this, this._html, this.ownerDocument);
  }
}

class FakeDocument {
  constructor() {
    this.listeners = new Map();
    this.documentElement = new FakeElement('html', this);
    this.body = new FakeElement('body', this);
    this.activeElement = this.body;
  }

  createElement(tagName) {
    return new FakeElement(tagName, this);
  }

  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(listener);
  }

  removeEventListener(type, listener) {
    this.listeners.get(type)?.delete(listener);
  }

  dispatchEvent(event = {}) {
    const payload = event;
    if (payload.target === undefined) payload.target = this;
    payload.defaultPrevented ??= false;
    payload.preventDefault ??= () => { payload.defaultPrevented = true; };
    for (const listener of this.listeners.get(payload.type) ?? []) listener.call(this, payload);
    return !payload.defaultPrevented;
  }
}

function installFakeDom() {
  const previousDocument = globalThis.document;
  const previousElement = globalThis.Element;
  const previousHTMLElement = globalThis.HTMLElement;
  const doc = new FakeDocument();
  globalThis.document = doc;
  globalThis.Element = FakeElement;
  globalThis.HTMLElement = FakeElement;
  return {
    doc,
    restore() {
      if (previousDocument === undefined) delete globalThis.document;
      else globalThis.document = previousDocument;
      if (previousElement === undefined) delete globalThis.Element;
      else globalThis.Element = previousElement;
      if (previousHTMLElement === undefined) delete globalThis.HTMLElement;
      else globalThis.HTMLElement = previousHTMLElement;
    },
  };
}

async function flushThumbs() {
  await new Promise(resolve => setTimeout(resolve, 0));
  await new Promise(resolve => setTimeout(resolve, 0));
}

test('a video take row loads its poster through the thumbs client', async () => {
  const item = clip(1);
  const takes = fakeTakesApi({
    [item.clipId]: {
      selected: item.selected,
      takes: [videoTake(item.selected, 'poster_ref_a1')],
    },
  });
  const thumbs = fakeThumbsClient();
  const { doc, restore } = installFakeDom();
  try {
    const host = doc.createElement('div');
    const handle = mountReviewDrawer({
      host,
      clips: [item],
      takesApi: takes,
      thumbsClient: thumbs,
      packageId: PACKAGE_ID,
    });
    handle.open();
    await flushThumbs();

    assert.deepEqual(thumbs.loads, [
      { packageId: PACKAGE_ID, ref: 'poster_ref_a1', kind: 'poster' },
    ]);
    const thumb = handle.element.querySelector('.review-thumb');
    const img = thumb.querySelector('img');
    assert.ok(img, 'the row shows a real poster frame');
    assert.equal(img.getAttribute('src'), POSTER_TICKET);
    assert.equal(img.getAttribute('alt'), '');
    assert.equal(img.getAttribute('loading'), 'lazy');
    assert.equal(img.getAttribute('decoding'), 'async');
    assert.equal(img.getAttribute('data-review-thumb-poster'), 'true');
    assert.equal(thumb.getAttribute('data-has-thumb'), 'true');

    handle.destroy();
  } finally {
    restore();
  }
});

test('every row has a keyboard-reachable Open in viewer button with the real ids', async () => {
  const first = clip(1);
  const second = clip(2);
  const opened = [];
  const { doc, restore } = installFakeDom();
  try {
    const host = doc.createElement('div');
    const handle = mountReviewDrawer({
      host,
      clips: [first, second],
      takesApi: fakeTakesApi(),
      thumbsClient: fakeThumbsClient(),
      onOpenViewer: target => { opened.push(target); },
    });
    handle.open();

    const buttons = handle.element.querySelectorAll('[data-review-open-viewer]');
    assert.equal(buttons.length, 2);
    for (const button of buttons) {
      assert.equal(button.tagName, 'BUTTON');
      assert.equal(button.getAttribute('type'), 'button');
      assert.notEqual(button.getAttribute('tabindex'), '-1');
      assert.equal(button.disabled, false);
      assert.match(button.textContent, /Open in viewer/);
    }

    const allowed = buttons[0].dispatchEvent({ type: 'keydown', key: 'Enter', bubbles: true });
    assert.equal(allowed, true, 'Enter is left to the native button activation');
    buttons[0].dispatchEvent({ type: 'click', bubbles: true });
    assert.deepEqual(opened, [{ clipId: first.clipId, takeId: first.selected }]);

    buttons[1].dispatchEvent({ type: 'click', bubbles: true });
    assert.deepEqual(opened[1], { clipId: second.clipId, takeId: second.selected });

    handle.destroy();
  } finally {
    restore();
  }
});

test('a row without a take keeps the viewer action disabled and inert', async () => {
  const item = clip(1, { selected: null, selectedN: null, takeCount: 0 });
  const opened = [];
  const { doc, restore } = installFakeDom();
  try {
    const host = doc.createElement('div');
    const handle = mountReviewDrawer({
      host,
      clips: [item],
      takesApi: fakeTakesApi(),
      thumbsClient: fakeThumbsClient(),
      onOpenViewer: target => { opened.push(target); },
    });
    handle.open();
    await flushThumbs();

    const button = handle.element.querySelector('[data-review-open-viewer]');
    assert.equal(button.disabled, true);
    button.dispatchEvent({ type: 'click', bubbles: true });
    assert.deepEqual(opened, []);

    handle.destroy();
  } finally {
    restore();
  }
});

test('the poster take is the viewer target when no take was selected', async () => {
  const item = clip(1, { selected: null, selectedN: null, takeCount: 1 });
  const takeId = 'tk_newest123456';
  const takes = fakeTakesApi({
    [item.clipId]: { selected: null, takes: [videoTake(takeId)] },
  });
  const opened = [];
  const { doc, restore } = installFakeDom();
  try {
    const host = doc.createElement('div');
    const handle = mountReviewDrawer({
      host,
      clips: [item],
      takesApi: takes,
      thumbsClient: fakeThumbsClient(),
      packageId: PACKAGE_ID,
      onOpenViewer: target => { opened.push(target); },
    });
    handle.open();
    await flushThumbs();

    const button = handle.element.querySelector('[data-review-open-viewer]');
    assert.equal(button.disabled, false);
    assert.equal(button.getAttribute('data-review-take'), takeId);
    button.dispatchEvent({ type: 'click', bubbles: true });
    assert.deepEqual(opened, [{ clipId: item.clipId, takeId }]);

    handle.destroy();
  } finally {
    restore();
  }
});
