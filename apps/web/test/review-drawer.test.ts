// The web package typecheck has no @types/node; node:test imports are runtime
// only, like the other web tests that use node:test.
// @ts-nocheck
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  REVIEW_ROW_HEIGHT,
  REVIEW_ROW_HEIGHT_COMPACT,
  REVIEW_ROW_HEIGHT_COMFORTABLE,
  ReviewDrawerModel,
  ReviewThumbCache,
  clipNeedsReview,
  createReviewDrawerModel,
  currentReviewRowHeight,
  filterReviewClips,
  mountReviewDrawer,
  renderReviewCostCard,
  renderReviewDrawer,
  renderReviewRows,
  renderReviewWindow,
  reviewCounts,
  reviewGroupFor,
  reviewRowHeight,
  reviewRows,
  sharedAssetIndex,
  shortClipId,
  takeProgressLabel,
  windowRange,
} from '../src/takes/review-drawer.ts';
import { approvedPillLabel, renderRenderBar, summarizeGate } from '../src/takes/render-bar.ts';
import {
  activeReviewTake,
  createProductionReviewApi,
  createTakesApi,
  productionCommandPath,
  reviewCostCardEstimateLabel,
  takeLooksLikeImage,
  takePosterMediaUrl,
} from '../src/takes/api.ts';

function clip(n: number, overrides: Record<string, unknown> = {}) {
  const id = `ep2_video_a${String(n).padStart(2, '0')}`;
  return {
    clipId: id,
    sceneId: `s${Math.ceil(n / 4)}`,
    assetId: `a_${n}`,
    slot: n % 2 === 0 ? 'background' : 'presenter',
    kind: n % 2 === 0 ? 'plate' : 'presenter',
    from: (n - 1) * 90,
    durationInFrames: 90,
    state: 'review',
    selected: `tk_${String(n).repeat(12)}`,
    selectedN: 2,
    takeCount: 4,
    newTakes: 0,
    lastJob: null,
    queued: false,
    ...overrides,
  };
}

function clips(count: number, overrides: Record<string, unknown> = {}) {
  return Array.from({ length: count }, (_, index) => clip(index + 1, overrides));
}


// Minimal DOM harness for mountReviewDrawer. The drawer renders its shell from
// HTML, so this only needs the tags, attributes, events and focus state the
// mount path actually touches.
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

function pressKey(element, key, extra = {}) {
  return element.dispatchEvent({ type: 'keydown', key, bubbles: true, ...extra });
}

test('one top-bar pill summarises 48 clips and renders no per-clip chips', () => {
  const list = clips(48);
  const gate = summarizeGate(list);
  const html = renderRenderBar(gate);

  assert.equal(gate.approved, 0);
  assert.equal(gate.total, 48);
  assert.match(html, /0\/48 approved/);
  assert.equal((html.match(/data-render-approved/g) ?? []).length, 1);
  assert.equal((html.match(/data-render-blocker/g) ?? []).length, 0);
  assert.equal((html.match(/data-render-run/g) ?? []).length, 0);
  assert.equal((html.match(/data-render-open-override/g) ?? []).length, 0);
  assert.match(html, /aria-controls="review-drawer"/);
  assert.match(html, /aria-keyshortcuts="R"/);
  assert.equal(approvedPillLabel(gate), '0/48 approved');
});

test('the drawer keeps every render-bar hook inside the drawer', () => {
  const blocked = renderReviewDrawer(clips(48), { open: true });
  assert.match(blocked, /id="review-drawer"/);
  assert.match(blocked, /data-review-drawer/);
  assert.match(blocked, /data-render-blocker="ep2_video_a01"/);
  assert.match(blocked, /data-render-open-override/);
  assert.match(blocked, /data-render-override/);
  assert.doesNotMatch(blocked, /data-render-run/);

  const approved = clips(3, { state: 'approved' });
  const ready = renderReviewDrawer(approved, { filter: 'approved', open: true });
  assert.match(ready, /data-render-run/);
  assert.doesNotMatch(ready, /data-render-open-override/);
  assert.match(renderRenderBar(summarizeGate(approved)), /data-render-ready/);
});

test('filters, search and sort keep timeline order and status grouping', () => {
  const list = [
    clip(4, { state: 'failed' }),
    clip(1, { state: 'review' }),
    clip(3, { state: 'stale' }),
    clip(2, { state: 'approved' }),
    clip(5, { state: 'review', sceneId: 'intro' }),
  ];

  assert.deepEqual(reviewCounts(list), { needs: 2, stale: 1, approved: 1, failed: 1, total: 5 });
  assert.equal(reviewGroupFor('rejected'), 'failed');
  assert.equal(clipNeedsReview(list[1]), true);
  assert.equal(clipNeedsReview(list[2]), false);

  assert.deepEqual(
    filterReviewClips(list, { filter: 'needs' }).map(item => item.clipId),
    ['ep2_video_a01', 'ep2_video_a05'],
  );
  assert.deepEqual(
    filterReviewClips(list, { filter: 'needs', query: 'intro' }).map(item => item.clipId),
    ['ep2_video_a05'],
  );
  assert.deepEqual(
    filterReviewClips(list, { filter: 'needs', query: 'presenter' }).map(item => item.clipId),
    ['ep2_video_a01', 'ep2_video_a05'],
  );
  assert.deepEqual(
    filterReviewClips(list, { filter: 'needs', sort: 'status' }).map(item => item.clipId),
    ['ep2_video_a01', 'ep2_video_a05'],
  );
});

test('rows use a 64x36 thumbnail contract, a short id with the full title and take n/m', () => {
  const row = reviewRows([clip(7)])[0];
  assert.equal(row.fullId, 'ep2_video_a07');
  assert.equal(row.shortId, 'ep2_video_a07');
  assert.equal(row.scene, 's2');
  assert.equal(row.statusLabel, 'Needs review');
  assert.equal(row.takeLabel, 'take 2/4');
  assert.equal(shortClipId('scene:a_really_long_asset_identifier'), 'a_really_l…tifier');
  assert.equal(takeProgressLabel(clip(1, { takeCount: 0 })), 'no takes');

  const html = renderReviewRows([row], { activeId: row.clipId });
  assert.match(html, /class="review-thumb"/);
  assert.match(html, /title="ep2_video_a07"/);
  assert.match(html, /role="option"/);
  assert.match(html, /aria-selected="true"/);
  assert.match(html, /tabindex="0"/);
  assert.match(html, /data-render-blocker="ep2_video_a07"/);
  assert.match(html, /take 2\/4/);
});

test('row heights match the density CSS in compact and comfortable', () => {
  // CSS: calc(var(--row-height) + var(--space-2)) = 28 + 8 / 36 + 8.
  assert.equal(REVIEW_ROW_HEIGHT_COMPACT, 36);
  assert.equal(REVIEW_ROW_HEIGHT_COMFORTABLE, 44);
  assert.equal(REVIEW_ROW_HEIGHT, REVIEW_ROW_HEIGHT_COMFORTABLE);
  assert.equal(reviewRowHeight('compact'), REVIEW_ROW_HEIGHT_COMPACT);
  assert.equal(reviewRowHeight('comfortable'), REVIEW_ROW_HEIGHT_COMFORTABLE);

  const css = readFileSync(new URL('../src/takes/panel.css', import.meta.url), 'utf8');
  assert.match(css, /\.review-row\s*\{[\s\S]*?--review-row-height:\s*calc\(var\(--row-height\)\s*\+\s*var\(--space-2\)\)/);
  assert.match(css, /\.review-row\s*\{[\s\S]*?height:\s*var\(--review-row-height\)/);
  assert.match(css, /\.review-thumb\s*\{[\s\S]*?height:\s*var\(--row-height-comfortable\)/);
  assert.match(css, /\.review-status\s*\{[\s\S]*?min-height:\s*0/);
  assert.match(css, /\.review-status\s*\{[\s\S]*?align-self:\s*center/);

  const compact = createReviewDrawerModel({ clips: [clip(1)], density: 'compact' });
  const comfortable = createReviewDrawerModel({ clips: [clip(1)], density: 'comfortable' });
  assert.equal(compact.rowHeight, REVIEW_ROW_HEIGHT_COMPACT);
  assert.equal(comfortable.rowHeight, REVIEW_ROW_HEIGHT_COMFORTABLE);

  const { doc, restore } = installFakeDom();
  try {
    assert.equal(currentReviewRowHeight(), REVIEW_ROW_HEIGHT_COMFORTABLE);
    doc.documentElement.setAttribute('data-density', 'compact');
    assert.equal(currentReviewRowHeight(), REVIEW_ROW_HEIGHT_COMPACT);
    doc.documentElement.setAttribute('data-density', '');
    doc.documentElement.setAttribute('data-mode', 'advanced');
    assert.equal(currentReviewRowHeight(), REVIEW_ROW_HEIGHT_COMPACT);
  } finally {
    restore();
  }
});

test('windowed rows keep the CSS height and start flush at scrollTop 0', () => {
  for (const density of ['compact', 'comfortable']) {
    const height = reviewRowHeight(density);
    const view = windowRange(48, 0, 480, height, 4);
    assert.equal(view.total, 48);
    assert.equal(view.start, 0);
    assert.equal(view.top, 0);
    assert.equal(view.end, Math.min(48, Math.ceil(480 / height) + 4));
    assert.equal(view.bottom, (48 - view.end) * height);

    const rows = reviewRows(clips(view.end + 2));
    const html = renderReviewWindow(rows, view, rows[0].clipId);
    assert.ok(!html.startsWith('<div class="review-spacer"'), `${density}: no top spacer at scrollTop 0`);
    assert.match(html, /id="review-option-0"/);

    const scrolled = windowRange(48, height * 20, 480, height, 4);
    assert.equal(scrolled.start, 16);
    assert.equal(scrolled.top, 16 * height);
    assert.ok(scrolled.end < 48);
  }
});

test('take n/m sits on the row meta line and the badge is the only side item', () => {
  const { doc, restore } = installFakeDom();
  try {
    const host = doc.createElement('div');
    host.innerHTML = renderReviewRows(reviewRows([clip(7)]), { activeId: 'ep2_video_a07' });
    const row = host.querySelector('.review-row');
    const meta = host.querySelector('.review-row-meta');
    const take = host.querySelector('.review-take');
    const badge = host.querySelector('.review-status');
    assert.ok(row);
    assert.ok(meta);
    assert.ok(take);
    assert.ok(badge);
    assert.equal(take.parentNode, meta);
    assert.equal(meta.parentNode.parentNode, row);
    assert.equal(badge.parentNode, row);
    assert.equal(host.querySelector('.review-row-side'), null);
    assert.match(take.textContent, /take 2\/4/);
  } finally {
    restore();
  }
});

test('keyboard A approves and advances focus to the next clip needing review', async () => {
  const list = [clip(1), clip(2), clip(3)];
  const approved: string[] = [];
  const model = createReviewDrawerModel({
    clips: list,
    onApprove: async item => { approved.push(item.clipId); },
  });

  assert.equal(model.activeId, 'ep2_video_a01');
  assert.equal(await model.handleKey('a'), true);
  assert.deepEqual(approved, ['ep2_video_a01']);
  assert.equal(model.clips[0].state, 'approved');
  assert.equal(model.activeId, 'ep2_video_a02');
  assert.equal(model.liveMessage, 'Approved 1/3');
  assert.deepEqual(model.counts, { needs: 2, stale: 0, approved: 1, failed: 0, total: 3 });

  assert.equal(await model.handleKey('j'), true);
  assert.equal(model.activeId, 'ep2_video_a03');
  assert.equal(await model.handleKey('arrowup'), true);
  assert.equal(model.activeId, 'ep2_video_a02');
});

test('rows whose asset backs two scenes show a shared chip count', () => {
  const list = [
    clip(1, { clipId: 's_title:a_icon_check', sceneId: 's_title', assetId: 'a_icon_check', from: 0 }),
    clip(2, { clipId: 's_hero:a_diagram_flow', sceneId: 's_hero', assetId: 'a_diagram_flow', from: 90 }),
    clip(3, { clipId: 's_stat:a_icon_check', sceneId: 's_stat', assetId: 'a_icon_check', from: 180 }),
    clip(4, { clipId: 's_list:a_pattern_dots', sceneId: 's_list', assetId: 'a_pattern_dots', from: 270 }),
    clip(5, { clipId: 's_outro:a_anim_bars', sceneId: 's_outro', assetId: 'a_anim_bars', from: 360 }),
  ];

  const index = sharedAssetIndex(list);
  assert.equal(index.get('a_icon_check').clipCount, 2);
  assert.equal(index.get('a_icon_check').sceneCount, 2);
  assert.deepEqual(index.get('a_icon_check').clipIds, ['s_title:a_icon_check', 's_stat:a_icon_check']);
  assert.equal(index.get('a_diagram_flow').clipCount, 1);

  const rows = reviewRows(list);
  assert.deepEqual(
    rows.filter(row => row.sharedSceneCount === 2).map(row => row.clipId),
    ['s_title:a_icon_check', 's_stat:a_icon_check'],
  );

  const sharedHtml = renderReviewRows(rows.filter(row => row.sharedSceneCount === 2));
  assert.match(sharedHtml, /class="badge review-shared"/);
  assert.match(sharedHtml, /data-review-shared="2"/);
  assert.match(sharedHtml, /shared · 2 scenes/);
  assert.equal((sharedHtml.match(/shared · 2 scenes/g) ?? []).length, 2);

  const uniqueHtml = renderReviewRows(rows.filter(row => row.assetId === 'a_diagram_flow'));
  assert.doesNotMatch(uniqueHtml, /review-shared/);
  assert.doesNotMatch(uniqueHtml, /shared · /);
});

test('approving a shared asset keeps the drawer count, pill and gate in sync', async () => {
  const list = [
    clip(1, { clipId: 's_title:a_icon_check', sceneId: 's_title', assetId: 'a_icon_check', from: 0 }),
    clip(2, { clipId: 's_hero:a_diagram_flow', sceneId: 's_hero', assetId: 'a_diagram_flow', from: 90 }),
    clip(3, { clipId: 's_stat:a_icon_check', sceneId: 's_stat', assetId: 'a_icon_check', from: 180 }),
    clip(4, { clipId: 's_list:a_pattern_dots', sceneId: 's_list', assetId: 'a_pattern_dots', from: 270 }),
    clip(5, { clipId: 's_outro:a_anim_bars', sceneId: 's_outro', assetId: 'a_anim_bars', from: 360 }),
  ];
  const verdicts: string[] = [];
  const announced: string[] = [];
  const model = createReviewDrawerModel({
    clips: list,
    onApprove: item => { verdicts.push(item.assetId); },
    onAnnounce: message => { announced.push(message); },
  });

  assert.equal(model.activeId, 's_title:a_icon_check');
  assert.equal(await model.handleKey('a'), true);
  assert.deepEqual(verdicts, ['a_icon_check'], 'one verdict per asset, not one per clip');
  assert.equal(model.counts.approved, 2);
  assert.equal(model.counts.needs, 3);
  assert.equal(model.gate.approved, 2);
  assert.equal(model.gate.total, 5);
  assert.equal(model.liveMessage, 'Approved a_icon_check in 2 scenes (2/5)');
  assert.equal(announced.at(-1), 'Approved a_icon_check in 2 scenes (2/5)');

  // The drawer, the pill and the gate read the same counter.
  assert.equal(approvedPillLabel(model.gate), '2/5 approved');
  assert.equal(approvedPillLabel(summarizeGate(model.clips)), '2/5 approved');
  assert.match(renderRenderBar(summarizeGate(model.clips)), /2\/5 approved/);

  // Both shared clips moved to Approved; the active row advances to the next
  // clip that still needs review.
  assert.equal(model.rows.filter(row => row.group === 'approved').length, 0);
  assert.equal(model.rows.length, 3);
  assert.equal(model.activeId, 's_hero:a_diagram_flow');
  model.setFilter('approved');
  assert.deepEqual(model.rows.map(row => row.clipId), ['s_title:a_icon_check', 's_stat:a_icon_check']);
  assert.ok(model.rows.every(row => row.sharedSceneCount === 2));
});

test('the mounted drawer progress matches the pill after a shared approval', async () => {
  const { doc, restore } = installFakeDom();
  try {
    const list = [
      clip(1, { clipId: 's_title:a_icon_check', sceneId: 's_title', assetId: 'a_icon_check', from: 0 }),
      clip(2, { clipId: 's_hero:a_diagram_flow', sceneId: 's_hero', assetId: 'a_diagram_flow', from: 90 }),
      clip(3, { clipId: 's_stat:a_icon_check', sceneId: 's_stat', assetId: 'a_icon_check', from: 180 }),
      clip(4, { clipId: 's_list:a_pattern_dots', sceneId: 's_list', assetId: 'a_pattern_dots', from: 270 }),
      clip(5, { clipId: 's_outro:a_anim_bars', sceneId: 's_outro', assetId: 'a_anim_bars', from: 360 }),
    ];
    const host = doc.createElement('div');
    const handle = mountReviewDrawer({ host, clips: list });
    handle.open();

    const progress = () => handle.element.querySelector('[data-review-count]').textContent;
    assert.equal(progress(), '0/5 approved');
    assert.equal(handle.model.rows.length, 5);

    assert.equal(await handle.model.approve('s_title:a_icon_check'), true);
    assert.equal(progress(), '2/5 approved');
    assert.equal(approvedPillLabel(handle.model.gate), '2/5 approved');
    assert.equal(approvedPillLabel(summarizeGate(handle.model.clips)), '2/5 approved');
    assert.match(handle.element.querySelector('[data-review-live]').textContent, /Approved a_icon_check in 2 scenes \(2\/5\)/);
    assert.equal(handle.model.rows.length, 3);

    handle.destroy();
  } finally {
    restore();
  }
});

test('J/K and arrows move, D redoes, Enter opens Takes only in Advanced, and inputs suppress letters', async () => {
  const redone: string[] = [];
  const opened: string[] = [];
  const model = new ReviewDrawerModel({
    clips: [clip(1), clip(2)],
    onRedo: item => { redone.push(item.clipId); },
    onOpenTakes: clipId => { opened.push(clipId); },
    getMode: () => 'advanced',
  });

  assert.equal(await model.handleKey('j'), true);
  assert.equal(model.activeId, 'ep2_video_a02');
  assert.equal(await model.handleKey('k'), true);
  assert.equal(model.activeId, 'ep2_video_a01');
  assert.equal(await model.handleKey('arrowdown'), true);
  assert.equal(model.activeId, 'ep2_video_a02');

  assert.equal(await model.handleKey('d'), true);
  assert.deepEqual(redone, ['ep2_video_a02']);
  assert.equal(model.liveMessage, 'Redo queued for ep2_video_a02');
  assert.equal(model.clips[1].state, 'queued');

  assert.equal(await model.handleKey('enter'), true);
  assert.deepEqual(opened, ['ep2_video_a02']);

  const easy = new ReviewDrawerModel({ clips: [clip(1)], onOpenTakes: clipId => opened.push(clipId), getMode: () => 'easy' });
  assert.equal(await easy.handleKey('enter'), false);
  assert.equal(opened.length, 1);

  const before = model.activeId;
  assert.equal(await model.handleKey('a', { inEditable: true }), false);
  assert.equal(model.activeId, before);
  assert.equal(model.counts.approved, 0);
});

test('D announces the failure reason and never marks a failed redo queued', async () => {
  const reason = 'Redo failed: the CPU backend cannot generate clip takes: it has no media runner, so use Google Colab or your own ComfyUI';
  const model = createReviewDrawerModel({
    clips: [clip(1)],
    onRedo: () => ({ ok: false, reason }),
  });

  assert.equal(await model.handleKey('d'), false);
  assert.equal(model.liveMessage, reason);
  assert.equal(model.clips[0].state, 'review');
  assert.equal(model.clips[0].queued, false);
});

test('D shows the spend-approval reason in the drawer live region', async () => {
  const { doc, restore } = installFakeDom();
  try {
    const host = doc.createElement('div');
    const reason = 'Redo needs spend approval in the Takes inspector';
    const handle = mountReviewDrawer({
      host,
      clips: [clip(1)],
      onRedo: () => ({ ok: false, reason }),
    });
    handle.open();

    assert.equal(await handle.model.redo('ep2_video_a01'), false);
    assert.equal(handle.model.liveMessage, reason);
    assert.match(handle.element.querySelector('[data-review-live]').textContent, /Redo needs spend approval in the Takes inspector/);
    assert.equal(handle.model.clips[0].state, 'review');

    handle.destroy();
  } finally {
    restore();
  }
});

test('D surfaces a thrown server error message instead of the generic text', async () => {
  const model = createReviewDrawerModel({
    clips: [clip(1)],
    onRedo: () => { throw new Error('the CPU backend cannot generate clip takes: it has no media runner'); },
  });

  assert.equal(await model.handleKey('d'), false);
  assert.match(model.liveMessage, /^Redo failed: the CPU backend cannot generate clip takes: it has no media runner$/);
  assert.equal(model.clips[0].state, 'review');
});

test('Shift+A approves all visible after a confirm and leaves nothing needing review', async () => {
  const list = [clip(1), clip(2), clip(3, { state: 'approved' })];
  const approved: string[] = [];
  let confirmed = '';
  const model = createReviewDrawerModel({
    clips: list,
    confirm: message => { confirmed = message; return true; },
    onApprove: item => { approved.push(item.clipId); },
  });

  const count = await model.approveVisible();
  assert.equal(count, 2);
  assert.deepEqual(approved, ['ep2_video_a01', 'ep2_video_a02']);
  assert.match(confirmed, /Approve 2 visible clips\?/);
  assert.equal(model.liveMessage, 'Approved 3/3');
  assert.equal(model.counts.needs, 0);
  assert.equal(model.activeId, '');
});

test('Shift+A is a no-op when the confirm is declined', async () => {
  const approved: string[] = [];
  const model = createReviewDrawerModel({
    clips: [clip(1), clip(2)],
    confirm: () => false,
    onApprove: item => { approved.push(item.clipId); },
  });

  assert.equal(await model.approveVisible(), 0);
  assert.deepEqual(approved, []);
  assert.equal(model.liveMessage, 'Approve all cancelled');
  assert.equal(model.counts.needs, 2);
});


test('mounting keeps the caller onChange and notifies exactly once per change', async () => {
  const { doc, restore } = installFakeDom();
  try {
    const host = doc.createElement('div');
    const calls: string[] = [];
    const handle = mountReviewDrawer({
      host,
      clips: [clip(1), clip(2)],
      onChange: model => { calls.push(model.activeId); },
    });

    assert.doesNotThrow(() => handle.setClips([clip(1), clip(2), clip(3)]));
    assert.equal(calls.length, 1);
    assert.equal(handle.model.clips.length, 3);

    assert.doesNotThrow(() => handle.setClips([clip(4), clip(5)]));
    assert.equal(calls.length, 2);

    assert.doesNotThrow(() => handle.model.setFilter('approved'));
    assert.equal(calls.length, 3);
    assert.equal(handle.model.filter, 'approved');

    assert.equal(await handle.model.approve('ep2_video_a04'), true);
    assert.equal(calls.length, 4);
    assert.equal(handle.model.clips[0].state, 'approved');

    handle.destroy();
  } finally {
    restore();
  }
});

test('Esc still closes the drawer after the last visible clip is approved', async () => {
  const { doc, restore } = installFakeDom();
  try {
    const host = doc.createElement('div');
    const handle = mountReviewDrawer({ host, clips: [clip(1)] });
    handle.open();
    assert.equal(handle.isOpen(), true);

    const row = doc.activeElement;
    assert.equal(row.getAttribute('id'), 'review-option-0');
    pressKey(row, 'a');
    await new Promise(resolve => setTimeout(resolve, 0));

    assert.equal(handle.model.clips[0].state, 'approved');
    assert.equal(handle.model.activeId, '');
    const closeButton = handle.element.querySelector('[data-review-close]');
    assert.equal(doc.activeElement, closeButton);

    pressKey(doc.activeElement, 'Escape');
    assert.equal(handle.isOpen(), false);
    assert.equal(handle.element.hidden, true);

    handle.destroy();
  } finally {
    restore();
  }
});

function fakeTake(n, overrides = {}) {
  const takeId = overrides.takeId ?? `tk_${String(n).repeat(12)}`;
  return {
    takeId,
    assetId: 'a_icon_check',
    n,
    file: `takes/a_icon_check/${takeId}.png`,
    sha256: 'a'.repeat(64),
    bytes: 640,
    media: {},
    gen: {},
    createdAt: `2026-10-2${n % 10}T00:00:00.000Z`,
    verdict: 'unreviewed',
    ...overrides,
  };
}

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function stubReviewFetch(takesByClip = {}) {
  const calls = [];
  const fetchImpl = async (input, init = {}) => {
    const url = new URL(String(input), 'http://127.0.0.1');
    const method = String(init.method ?? 'GET').toUpperCase();
    calls.push({ path: url.pathname, method });

    const takesMatch = /^\/api\/package\/([^/]+)\/clips\/([^/]+)\/takes$/.exec(url.pathname);
    if (takesMatch) {
      const clipId = decodeURIComponent(takesMatch[2]);
      const entry = takesByClip[clipId] ?? { selected: null, takes: [] };
      const takes = entry.takes ?? [];
      const selected = entry.selected ?? null;
      return jsonResponse({
        packageId: decodeURIComponent(takesMatch[1]),
        revision: 1,
        clip: { clipId },
        assetId: takes[0]?.assetId ?? 'a_icon_check',
        selected,
        takes,
        history: [],
        lastJob: null,
        queued: null,
      });
    }

    const ticketMatch = /^\/api\/package\/([^/]+)\/clips\/([^/]+)\/takes\/([^/]+)\/ticket$/.exec(url.pathname);
    if (ticketMatch && method === 'POST') {
      const takeId = decodeURIComponent(ticketMatch[3]);
      return jsonResponse({
        kind: 'ticket',
        takeId,
        ticket: `ticket_${takeId}`,
        url: `/api/media/ticket_${takeId}`,
      });
    }

    return jsonResponse({ error: 'not found' }, 404);
  };
  return {
    calls,
    apiFetch: fetchImpl,
    getCalls() { return calls.filter(call => call.method === 'GET').length; },
    ticketCalls() { return calls.filter(call => call.path.endsWith('/ticket')); },
  };
}

async function flushThumbs() {
  await new Promise(resolve => setTimeout(resolve, 0));
  await new Promise(resolve => setTimeout(resolve, 0));
}

test('the thumbnail source is the selected take, then the newest active take', () => {
  const one = fakeTake(1);
  const two = fakeTake(2);
  const three = fakeTake(3);
  const purgedSelected = fakeTake(4, { purged: true });

  assert.equal(activeReviewTake([one, three, two], two.takeId).takeId, two.takeId);
  assert.equal(activeReviewTake([one, three, purgedSelected], purgedSelected.takeId).takeId, three.takeId);
  assert.equal(activeReviewTake([one, two, three], null).takeId, three.takeId);
  assert.equal(activeReviewTake([], one.takeId), null);

  assert.equal(takeLooksLikeImage(one), true);
  assert.equal(takeLooksLikeImage(fakeTake(5, { file: 'takes/a/clip.mp4' })), false);
  assert.equal(
    takePosterMediaUrl(fakeTake(5, { file: 'takes/a/clip.mp4', media: { poster: '/api/media/poster_frame1' } })),
    '/api/media/poster_frame1',
  );
});

test('thumbnails are cached per takeId and failures stay on the kind fallback', async () => {
  const shared = fakeTake(2, { takeId: 'tk_shared123456' });
  const selected = shared.takeId;
  const stub = stubReviewFetch({
    's_title:a_icon_check': {
      selected,
      takes: [fakeTake(1), shared],
    },
    's_stat:a_icon_check': {
      selected: shared.takeId,
      takes: [shared],
    },
    's_empty:a_none': { selected: null, takes: [] },
  });
  const api = createTakesApi({ apiFetch: stub.apiFetch });
  const cache = new ReviewThumbCache({ packageId: 'pkg_launchdemo0001', api });

  const first = await cache.load('s_title:a_icon_check', selected);
  assert.equal(first.source, 'image');
  assert.equal(first.takeId, selected);
  assert.equal(first.url, `/api/media/ticket_${selected}`);
  assert.equal(stub.ticketCalls().length, 1);

  const callsAfterFirst = stub.calls.length;
  const cachedAgain = await cache.load('s_title:a_icon_check', selected);
  assert.equal(cachedAgain.url, first.url);
  assert.equal(stub.calls.length, callsAfterFirst, 'a rendered row is not fetched twice');

  const sameTakeOtherClip = await cache.load('s_stat:a_icon_check', shared.takeId);
  assert.equal(sameTakeOtherClip.url, `/api/media/ticket_${shared.takeId}`);
  assert.equal(stub.ticketCalls().length, 1, 'a shared takeId reuses its media ticket');

  const empty = await cache.load('s_empty:a_none');
  assert.equal(empty.source, 'fallback');
  assert.equal(empty.url, null);

  const failing = new ReviewThumbCache({
    packageId: 'pkg_launchdemo0001',
    api: {
      async getTakes() { throw new Error('offline'); },
      async takeUrl() { throw new Error('offline'); },
    },
  });
  assert.deepEqual(await failing.load('s_title:a_icon_check'), { takeId: null, url: null, source: 'fallback' });
});

test('the drawer hydrates only the virtualized rows and keeps the 64x36 fallback', async () => {
  const list = clips(48);
  const takesByClip = {};
  for (const item of list) {
    takesByClip[item.clipId] = {
      selected: item.selected,
      takes: [fakeTake(2, { takeId: item.selected, media: { width: 640, height: 360 } })],
    };
  }
  const stub = stubReviewFetch(takesByClip);
  const api = createTakesApi({ apiFetch: stub.apiFetch });
  const { doc, restore } = installFakeDom();
  try {
    const host = doc.createElement('div');
    const handle = mountReviewDrawer({
      host,
      clips: list,
      takesApi: api,
      packageId: 'pkg_launchdemo0001',
    });
    assert.equal(stub.calls.length, 0, 'a hidden drawer does not request thumbnails');

    handle.open();
    const view = handle.model.window();
    assert.ok(view.end < list.length);
    assert.equal(stub.getCalls(), view.end, 'only the rendered window asks for takes');

    await flushThumbs();
    const thumbs = handle.element.querySelectorAll('.review-thumb');
    assert.equal(thumbs.length, view.end - view.start);
    for (const thumb of thumbs) {
      const img = thumb.querySelector('img');
      assert.ok(img, 'a row with a selected take shows its image');
      assert.equal(img.getAttribute('alt'), '');
      assert.equal(img.getAttribute('loading'), 'lazy');
      assert.equal(img.getAttribute('decoding'), 'async');
      assert.equal(thumb.getAttribute('data-has-thumb'), 'true');
    }

    const beforeScroll = stub.getCalls();
    handle.model.setScrollTop(REVIEW_ROW_HEIGHT * 30);
    const scrolled = handle.model.window();
    await flushThumbs();
    assert.equal(stub.getCalls(), beforeScroll + (scrolled.end - scrolled.start));
    assert.ok(stub.getCalls() < list.length, 'scrolling never loads all 48 clips at once');

    handle.destroy();
  } finally {
    restore();
  }
});

test('a clip without a take keeps the kind text instead of an image', async () => {
  const withTake = clip(1);
  const withoutTake = clip(2, { selected: null, selectedN: null, takeCount: 0 });
  const stub = stubReviewFetch({
    [withTake.clipId]: { selected: withTake.selected, takes: [fakeTake(2, { takeId: withTake.selected })] },
    [withoutTake.clipId]: { selected: null, takes: [] },
  });
  const { doc, restore } = installFakeDom();
  try {
    const host = doc.createElement('div');
    const handle = mountReviewDrawer({
      host,
      clips: [withTake, withoutTake],
      takesApi: createTakesApi({ apiFetch: stub.apiFetch }),
      packageId: 'pkg_launchdemo0001',
    });
    handle.open();
    await flushThumbs();

    const rows = handle.element.querySelectorAll('[data-review-clip]');
    assert.equal(rows.length, 2);
    assert.ok(rows[0].querySelector('.review-thumb').querySelector('img'));
    assert.equal(rows[1].querySelector('.review-thumb').querySelector('img'), null);
    const fallback = rows[1].querySelector('[data-review-thumb-fallback]');
    assert.equal(fallback.textContent, 'plate');
    assert.equal(rows[1].querySelector('.review-thumb').getAttribute('data-has-thumb'), null);

    handle.destroy();
  } finally {
    restore();
  }
});

// IP31: the review drawer is bound to a production. Redo is a plan proposal
// that shows a cost card before any spend; preview never writes a selection;
// selecting and rejecting are explicit production commands.

const PRODUCTION_ID = 'prod_0123456789abcdef01234567';
const PLAN_HASH = 'c'.repeat(64);

function costCard(overrides = {}) {
  return {
    productionId: PRODUCTION_ID,
    planHash: PLAN_HASH,
    planId: 'plan_1',
    proposalRevision: 7,
    revision: 7,
    clipId: 'ep2_video_a01',
    assetId: 'a_1',
    estimate: { gpuMinutes: 2, overheadMinutes: 1 },
    budget: { allowed: true, required: 3, remaining: 17 },
    backend: { id: 'google_colab', label: 'Google Colab' },
    jobs: 1,
    commandId: 'cmd_propose_1',
    ...overrides,
  };
}

function fakeProductionApi(overrides = {}) {
  const calls = [];
  const api = {
    calls,
    async proposeRedo(input) {
      calls.push({ method: 'proposeRedo', input });
      return costCard({ clipId: input.clipId, assetId: input.assetId });
    },
    async approvePlan(card) {
      calls.push({ method: 'approvePlan', card });
      return { ...card, approved: true, revision: card.revision + 1, commandId: 'cmd_approve_1' };
    },
    async selectTake(input) {
      calls.push({ method: 'selectTake', input });
      return { productionId: PRODUCTION_ID, revision: 9 };
    },
    async rejectTake(input) {
      calls.push({ method: 'rejectTake', input });
      return { productionId: PRODUCTION_ID, revision: 9 };
    },
    async approveTake(input) {
      calls.push({ method: 'approveTake', input });
      return { productionId: PRODUCTION_ID, revision: 9 };
    },
    ...overrides,
  };
  return api;
}

function commandResponse(events = []) {
  return jsonResponse({
    duplicate: false,
    committed: true,
    productionId: PRODUCTION_ID,
    revision: 8,
    lastSequence: 8,
    production: { id: PRODUCTION_ID, revision: 8, lastSequence: 8 },
    events,
  });
}

test('the production review client proposes a plan and never spends on the proposal', async () => {
  const calls = [];
  const api = createProductionReviewApi({
    productionId: PRODUCTION_ID,
    revision: 7,
    commandId: prefix => `${prefix}_fixed`,
    apiFetch: async (input, init = {}) => {
      calls.push({ url: String(input), init, body: JSON.parse(String(init.body ?? '{}')) });
      return commandResponse([{
        id: 'evt_8',
        productionId: PRODUCTION_ID,
        sequence: 8,
        type: 'plan.proposed',
        data: {
          planHash: PLAN_HASH,
          planId: 'plan_1',
          estimate: { gpuMinutes: 2, overheadMinutes: 1 },
          budget: { allowed: true, required: 3 },
          backend: { id: 'google_colab', label: 'Google Colab' },
          jobs: 1,
        },
      }]);
    },
  });

  const card = await api.proposeRedo({
    packageId: 'pkg_1',
    clipId: 'ep2_video_a01',
    assetId: 'a_1',
    change: { note: 'cleaner background' },
    backendId: 'colab',
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, productionCommandPath(PRODUCTION_ID));
  assert.equal(calls[0].body.kind, 'plan.propose');
  assert.equal(calls[0].body.commandId, 'plan_propose_fixed');
  assert.equal(calls[0].body.idempotencyKey, 'plan_propose_fixed');
  assert.equal(calls[0].body.expected.productionRevision, 7);
  assert.equal(calls[0].body.payload.clipId, 'ep2_video_a01');
  assert.equal(calls[0].body.payload.change.note, 'cleaner background');
  assert.equal(card.planHash, PLAN_HASH);
  assert.equal(card.revision, 8);
  assert.equal(card.proposalRevision, 8);
  assert.deepEqual(card.estimate, { gpuMinutes: 2, overheadMinutes: 1 });
  assert.deepEqual(card.backend, { id: 'google_colab', label: 'Google Colab' });
  assert.equal(reviewCostCardEstimateLabel(card), '2 GPU min + 1 min overhead');
  assert.notEqual(calls[0].body.kind, 'plan.approve');
});

test('the production review client sends explicit select and reject commands', async () => {
  const sent = [];
  const api = createProductionReviewApi({
    productionId: PRODUCTION_ID,
    revision: 11,
    commandId: prefix => `${prefix}_fixed`,
    apiFetch: async (_input, init = {}) => {
      sent.push(JSON.parse(String(init.body ?? '{}')));
      return commandResponse();
    },
  });

  await api.selectTake({ clipId: 's1:a_1', assetId: 'a_1', takeId: 'tk_1' });
  await api.rejectTake({ clipId: 's1:a_1', assetId: 'a_1', takeId: 'tk_1', note: 'logo hidden' });
  await api.approveTake({ clipId: 's1:a_1', assetId: 'a_1', takeId: 'tk_1' });

  assert.deepEqual(sent.map(body => body.kind), ['take.select', 'clip.reject', 'clip.approve']);
  assert.deepEqual(sent[0].payload, { clipId: 's1:a_1', assetId: 'a_1', takeId: 'tk_1' });
  assert.equal(sent[1].payload.note, 'logo hidden');
  assert.equal(sent[0].expected.productionRevision, 11);
});

test('Redo on a production shows a cost card and leaves the clip in review', async () => {
  const production = fakeProductionApi();
  const model = createReviewDrawerModel({ clips: [clip(1)], production });

  assert.equal(await model.redo('ep2_video_a01'), true);
  assert.deepEqual(production.calls.map(call => call.method), ['proposeRedo']);
  assert.equal(model.clips[0].state, 'review');
  assert.equal(model.clips[0].queued, false);
  assert.equal(model.costCard?.planHash, PLAN_HASH);
  assert.match(model.liveMessage, /Review the cost before spending/);

  const html = renderReviewCostCard(model.costCard);
  assert.match(html, /data-review-cost-card/);
  assert.match(html, /2 GPU min/);
  assert.match(html, /Google Colab/);
  assert.match(html, /data-review-cost-approve/);
  assert.match(html, /data-review-cost-cancel/);
});

test('approving the cost card is the first command that allows spend', async () => {
  const production = fakeProductionApi();
  const model = createReviewDrawerModel({ clips: [clip(1)], production });
  await model.redo('ep2_video_a01');

  assert.equal(await model.approveCost(), true);
  assert.deepEqual(production.calls.map(call => call.method), ['proposeRedo', 'approvePlan']);
  assert.equal(model.costCard, null);
  assert.equal(model.clips[0].state, 'queued');
  assert.equal(model.clips[0].queued, true);
  assert.match(model.liveMessage, /approved/i);
});

test('cancelling the cost card sends no spend command', async () => {
  const production = fakeProductionApi();
  const model = createReviewDrawerModel({ clips: [clip(1)], production });
  await model.redo('ep2_video_a01');

  model.cancelCost();
  assert.equal(model.costCard, null);
  assert.deepEqual(production.calls.map(call => call.method), ['proposeRedo']);
  assert.equal(model.clips[0].state, 'review');
  assert.match(model.liveMessage, /cancel/i);
});

test('preview never selects a take, while an explicit selection does', async () => {
  const production = fakeProductionApi();
  const previewed = [];
  const model = createReviewDrawerModel({
    clips: [clip(1)],
    production,
    onPreview: (item, takeId) => previewed.push({ clipId: item.clipId, takeId }),
  });
  const before = model.clips[0].selected;

  assert.equal(await model.previewTake('tk_aaaaaaaaaaaa', 'ep2_video_a01'), true);
  assert.deepEqual(previewed, [{ clipId: 'ep2_video_a01', takeId: 'tk_aaaaaaaaaaaa' }]);
  assert.equal(model.previewTakeId, 'tk_aaaaaaaaaaaa');
  assert.equal(model.clips[0].selected, before);
  assert.deepEqual(production.calls, [], 'preview sends no production command');

  assert.equal(await model.selectTake('tk_bbbbbbbbbbbb', 'ep2_video_a01'), true);
  assert.deepEqual(production.calls.map(call => call.method), ['selectTake']);
  assert.equal(production.calls[0].input.takeId, 'tk_bbbbbbbbbbbb');
  assert.equal(model.clips[0].selected, 'tk_bbbbbbbbbbbb');
});

test('reject is an explicit clip.reject command and updates the row', async () => {
  const production = fakeProductionApi();
  const model = createReviewDrawerModel({ clips: [clip(1)], production });

  assert.equal(await model.rejectTake('tk_aaaaaaaaaaaa', 'ep2_video_a01'), true);
  assert.deepEqual(production.calls.map(call => call.method), ['rejectTake']);
  assert.equal(production.calls[0].input.takeId, 'tk_aaaaaaaaaaaa');
  assert.equal(model.clips[0].state, 'rejected');
  assert.match(model.liveMessage, /rejected/i);
});

test('the mounted drawer shows the cost card before spend and only queues on approval', async () => {
  const production = fakeProductionApi();
  const { doc, restore } = installFakeDom();
  try {
    const host = doc.createElement('div');
    const handle = mountReviewDrawer({ host, clips: [clip(1)], production });
    handle.open();

    const card = handle.element.querySelector('[data-review-cost-card]');
    assert.ok(card);
    assert.equal(card.getAttribute('hidden'), '');

    await handle.model.redo('ep2_video_a01');
    assert.equal(card.getAttribute('hidden'), null);
    assert.match(card.innerHTML, /data-review-cost-approve/);
    assert.match(card.innerHTML, /2 GPU min/);
    assert.equal(handle.model.clips[0].state, 'review');

    card.querySelector('[data-review-cost-approve]').dispatchEvent({ type: 'click', bubbles: true });
    await flushThumbs();

    assert.deepEqual(production.calls.map(call => call.method), ['proposeRedo', 'approvePlan']);
    assert.equal(handle.model.costCard, null);
    assert.equal(handle.model.clips[0].state, 'queued');
    assert.equal(card.getAttribute('hidden'), '');

    handle.destroy();
  } finally {
    restore();
  }
});
