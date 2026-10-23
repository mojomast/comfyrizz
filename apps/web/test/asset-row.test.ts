// @ts-nocheck
// AV07: asset row module and one poster key in the takes API.
import test from 'node:test';
import assert from 'node:assert/strict';
import { assetRowHtml, hydrateAssetThumbs } from '../src/assets/asset-row.ts';
import { takePosterMediaUrl } from '../src/takes/api.ts';

function fakeDocument() {
  return new FakeDocument();
}

class FakeElement {
  constructor(tagName, ownerDocument) {
    this.tagName = String(tagName).toUpperCase();
    this.ownerDocument = ownerDocument;
    this.parentNode = null;
    this.children = [];
    this.attributes = new Map();
    this.dataset = {};
    this.className = '';
    this.textContent = '';
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
    const key = String(name);
    this.attributes.set(key, String(value));
    if (key === 'class') this.className = String(value);
  }

  getAttribute(name) {
    return this.attributes.has(String(name)) ? this.attributes.get(String(name)) : null;
  }

  hasAttribute(name) {
    return this.attributes.has(String(name));
  }

  removeAttribute(name) {
    this.attributes.delete(String(name));
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

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] ?? null;
  }

  querySelectorAll(selector) {
    const found = [];
    const matches = element => {
      const value = String(selector);
      if (value.startsWith('[') && value.endsWith(']')) {
        return element.hasAttribute(value.slice(1, -1));
      }
      if (value.startsWith('.')) {
        return element.className.split(/\s+/).includes(value.slice(1));
      }
      const tagAndClass = /^([a-z]+)\.(.+)$/.exec(value);
      if (tagAndClass) {
        return element.tagName === tagAndClass[1].toUpperCase()
          && element.className.split(/\s+/).includes(tagAndClass[2]);
      }
      return element.tagName === value.toUpperCase();
    };
    const walk = node => {
      for (const child of node.children) {
        if (matches(child)) found.push(child);
        walk(child);
      }
    };
    walk(this);
    return found;
  }
}

class FakeDocument {
  createElement(tagName) {
    return new FakeElement(tagName, this);
  }

  createElementNS(_namespace, tagName) {
    return new FakeElement(tagName, this);
  }
}

function makeHost(document, ids) {
  const host = new FakeElement('div', document);
  const thumbs = new Map();
  for (const id of ids) {
    const row = new FakeElement('div', document);
    row.dataset.assetId = id;
    row.setAttribute('data-asset-id', id);
    const thumb = new FakeElement('button', document);
    thumb.setAttribute('type', 'button');
    thumb.setAttribute('class', 'thumb');
    row.appendChild(thumb);
    host.appendChild(row);
    thumbs.set(id, thumb);
  }
  return { host, thumbs };
}

function fakeObserverFactory() {
  const state = {
    observed: [],
    unobserved: [],
    disconnected: false,
    callback: null,
  };
  const factory = callback => {
    state.callback = callback;
    return {
      observe(element) {
        state.observed.push(element);
      },
      unobserve(element) {
        state.unobserved.push(element);
      },
      disconnect() {
        state.disconnected = true;
      },
    };
  };
  return { factory, state };
}

function flush() {
  return new Promise(resolve => setTimeout(resolve, 0));
}

function readyResult() {
  return {
    status: 'ready',
    key: 'k_poster',
    ticketUrl: '/api/media/poster_ticket',
    width: 160,
    height: 90,
  };
}

const HERO = {
  kind: 'image',
  origin: 'generated',
  status: 'ready',
  file: 'assets/a_hero.png',
  license: { id: 'CC0-1.0' },
  gen: { generator: 'flux3-klein', workflow: 'hero-flow' },
  media: { frames: 24 },
};

const PLATE = {
  kind: 'image',
  origin: 'upload',
  status: 'pending',
};

const NARRATION = {
  kind: 'audio',
  origin: 'generated',
  status: 'ready',
  license: { id: 'CC0-1.0' },
  gen: { generator: 'kokoro' },
};

const CTX = {
  pkg: {
    assets: {
      a_hero: { status: 'ready' },
      a_plate: { status: 'pending' },
      a_narr: { status: 'ready' },
    },
  },
};

test('assetRowHtml reproduces the current main.ts renderAssets row text', () => {
  const expectedHero = '<div class="asset job-row rail-row" data-asset-id="a_hero"><button type="button" class="thumb" data-asset-open aria-haspopup="dialog" aria-label="Open a_hero (image, ready)">▣</button><div class="asset-copy job-content"><div class="job-head"><b class="job-name">a_hero</b><span class="badge badge-ok chip" data-tone="ok">CC0-1.0</span><time class="job-time hint tabular-nums mono">24f</time></div><span class="job-progress hint">image · flux3-klein · hero-flow</span></div><span class="asset-end"><button type="button" data-asset-action="workflow" data-asset-id="a_hero" data-workflow-format="api" title="Download the API-format workflow that was submitted. ComfyUI drag-and-drop needs UI format, which is not generated.">Open in ComfyUI</button><button type="button" data-asset-action="workflow" data-asset-id="a_hero" data-workflow-format="readme" title="How to open this API-format workflow in ComfyUI">How to open</button></span></div>';

  const expectedPlate = '<div class="asset job-row rail-row pending" data-asset-id="a_plate"><button type="button" class="thumb" data-asset-open aria-haspopup="dialog" aria-label="Open a_plate (image, pending)">◌</button><div class="asset-copy job-content"><div class="job-head"><b class="job-name">a_plate</b><span class="badge badge-warn chip warn" data-tone="warn">pending gpu</span></div><span class="job-progress hint">image · upload</span></div></div>';

  const expectedNarration = '<div class="asset job-row rail-row" data-asset-id="a_narr"><button type="button" class="thumb" data-asset-open aria-haspopup="dialog" aria-label="Open a_narr (audio, ready)">♪</button><div class="asset-copy job-content"><div class="job-head"><b class="job-name">a_narr</b><span class="badge badge-ok chip" data-tone="ok">CC0-1.0</span></div><span class="job-progress hint">audio · kokoro</span></div></div>';

  assert.equal(assetRowHtml('a_hero', HERO, CTX), expectedHero);
  assert.equal(assetRowHtml('a_plate', PLATE, CTX), expectedPlate);
  assert.equal(assetRowHtml('a_narr', NARRATION, CTX), expectedNarration);
});

test('the thumb is a dialog opener button with a kind and status label', () => {
  const html = assetRowHtml('a_hero', HERO, CTX);
  assert.match(
    html,
    /<button type="button" class="thumb" data-asset-open aria-haspopup="dialog" aria-label="Open a_hero \(image, ready\)">▣<\/button>/,
  );
});

test('hydrateAssetThumbs requires a non-empty packageId', () => {
  const document = fakeDocument();
  const { host } = makeHost(document, ['a_one']);
  const client = { load: async () => readyResult(), retry() {} };
  const { factory } = fakeObserverFactory();

  assert.throws(
    () => hydrateAssetThumbs(host, client, { packageId: '', observerFactory: factory }),
    TypeError,
  );
  assert.throws(
    () => hydrateAssetThumbs(host, client, { packageId: '   ', observerFactory: factory }),
    TypeError,
  );
});

test('a null observer factory loads nothing', async () => {
  const document = fakeDocument();
  const { host } = makeHost(document, ['a_one']);
  const loads = [];
  const client = {
    async load(request) {
      loads.push(request);
      return readyResult();
    },
    retry() {},
  };

  const handle = hydrateAssetThumbs(host, client, { packageId: 'pkg_1', observerFactory: null });
  await flush();

  assert.deepEqual(loads, []);
  handle.disconnect();
});

test('only intersecting rows load, each once, with the real thumbs request shape', async () => {
  const document = fakeDocument();
  const { host, thumbs } = makeHost(document, ['a_one', 'a_two', 'a_three']);
  const loads = [];
  const client = {
    async load(request) {
      loads.push(request);
      return readyResult();
    },
    retry() {},
  };
  const { factory, state } = fakeObserverFactory();

  const handle = hydrateAssetThumbs(host, client, { packageId: 'pkg_1', observerFactory: factory });

  assert.deepEqual(state.observed, [thumbs.get('a_one'), thumbs.get('a_two'), thumbs.get('a_three')]);

  const second = thumbs.get('a_two');
  state.callback([
    { target: thumbs.get('a_one'), isIntersecting: true },
    { target: second, isIntersecting: false },
    { target: thumbs.get('a_three'), isIntersecting: true },
  ]);
  await flush();

  assert.deepEqual(loads, [
    { packageId: 'pkg_1', ref: 'a_one', kind: 'poster' },
    { packageId: 'pkg_1', ref: 'a_three', kind: 'poster' },
  ]);
  assert.deepEqual(state.unobserved, [thumbs.get('a_one'), thumbs.get('a_three')]);
  assert.equal(thumbs.get('a_one').getAttribute('data-thumb-state'), 'ready');
  assert.equal(thumbs.get('a_three').getAttribute('data-thumb-state'), 'ready');
  assert.equal(second.getAttribute('data-thumb-state'), null);

  state.callback([{ target: thumbs.get('a_one'), isIntersecting: true }]);
  await flush();
  assert.equal(loads.length, 2);

  handle.disconnect();
});

test('a result that arrives after disconnect is not rendered', async () => {
  const document = fakeDocument();
  const { host, thumbs } = makeHost(document, ['a_one']);
  const thumb = thumbs.get('a_one');
  let resolveLoad;
  const client = {
    load() {
      return new Promise(resolve => {
        resolveLoad = resolve;
      });
    },
    retry() {},
  };
  const { factory, state } = fakeObserverFactory();

  const handle = hydrateAssetThumbs(host, client, { packageId: 'pkg_1', observerFactory: factory });
  state.callback([{ target: thumb, isIntersecting: true }]);
  handle.disconnect();
  assert.equal(state.disconnected, true);

  resolveLoad(readyResult());
  await flush();

  assert.equal(thumb.getAttribute('data-thumb-state'), null);
});

test('a rejected load renders the failed thumbnail state', async () => {
  const document = fakeDocument();
  const { host, thumbs } = makeHost(document, ['a_one']);
  const thumb = thumbs.get('a_one');
  const client = {
    async load() {
      throw new Error('boom');
    },
    retry() {},
  };
  const { factory, state } = fakeObserverFactory();

  hydrateAssetThumbs(host, client, { packageId: 'pkg_1', observerFactory: factory });
  state.callback([{ target: thumb, isIntersecting: true }]);
  await flush();
  await flush();

  assert.equal(thumb.getAttribute('data-thumb-state'), 'failed');
  assert.equal(thumb.getAttribute('data-thumb-reason'), 'boom');
});

function fakeTake(media) {
  return {
    takeId: 'tk_1',
    assetId: 'a_1',
    n: 1,
    sha256: 'a'.repeat(64),
    bytes: 1,
    media,
    gen: {},
    createdAt: '2026-10-23T00:00:00.000Z',
    verdict: 'unreviewed',
  };
}

test('takePosterMediaUrl reads the single media.posterKey', () => {
  assert.equal(
    takePosterMediaUrl(fakeTake({ posterKey: '/api/media/poster_ticket' })),
    '/api/media/poster_ticket',
  );
  assert.equal(
    takePosterMediaUrl(fakeTake({ posterKey: 'poster_ref_1' })),
    'poster_ref_1',
  );
  assert.equal(
    takePosterMediaUrl(fakeTake({ posterKey: '/api/media/poster_ticket', thumbnail: '/api/media/wrong' })),
    '/api/media/poster_ticket',
  );
  assert.equal(takePosterMediaUrl(fakeTake({ thumbnail: '/api/media/wrong' })), null);
  assert.equal(takePosterMediaUrl(fakeTake({})), null);
  assert.equal(takePosterMediaUrl(null), null);
});
