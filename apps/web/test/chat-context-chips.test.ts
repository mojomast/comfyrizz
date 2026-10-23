// IP36: turn context chips for a chat message.
//
// A turn can carry explicit, removable chips for the clip in review, the
// candidate take, the playhead time, the active work tab and the conversation /
// package revisions. Nothing here may infer a clip from a global
// "last selected" value: the only source is the context object passed in.
//
// The web package typecheck has no @types/node; node:test imports are runtime
// only, like the other web tests that use node:test.
// @ts-nocheck
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildTurnContextChips,
  formatTurnContextTime,
  mountProjectChat,
  removeTurnContextChip,
  renderTurnContextChips,
} from '../src/project-chat.ts';

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
  if (value.startsWith('.')) return element.className.split(/\s+/).includes(value.slice(1));
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
  }

  get className() {
    return this._classes.join(' ');
  }

  set className(value) {
    this._classes = String(value ?? '').split(/\s+/).filter(Boolean);
  }

  get parentElement() {
    return this.parentNode;
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
    this.children.push(child);
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
    this.body = new FakeElement('body', this);
    this.documentElement = this.body;
    this.activeElement = this.body;
  }

  createElement(tagName) {
    return new FakeElement(tagName, this);
  }

  getElementById() {
    return null;
  }
}

function context() {
  return {
    clipId: 'ep2_video_a01',
    sceneId: 's_hero',
    candidate: { takeId: 'tk_candidate_01', takeN: 3 },
    time: { frame: 210, fps: 30 },
    tab: 'review',
    revisions: { conversation: 4, package: 12 },
  };
}

test('builds one chip per explicit context kind with stable ids', () => {
  const chips = buildTurnContextChips(context());

  assert.deepEqual(chips.map(chip => chip.kind), ['clip', 'candidate', 'time', 'tab', 'revisions']);
  assert.deepEqual(chips.map(chip => chip.id), [
    'clip:ep2_video_a01',
    'candidate:tk_candidate_01',
    'time:210:30',
    'tab:review',
    'revisions:4:12',
  ]);

  const byKind = Object.fromEntries(chips.map(chip => [chip.kind, chip]));
  assert.equal(byKind.clip.label, 'Clip');
  assert.equal(byKind.clip.value, 's_hero · ep2_video_a01');
  assert.equal(byKind.candidate.label, 'Candidate');
  assert.equal(byKind.candidate.value, 'Take 3');
  assert.equal(byKind.time.label, 'Time');
  assert.equal(byKind.time.value, '00:07');
  assert.equal(byKind.tab.label, 'Tab');
  assert.equal(byKind.tab.value, 'Review');
  assert.equal(byKind.revisions.label, 'Revisions');
  assert.equal(byKind.revisions.value, 'chat r4 · project r12');
});

test('an empty context has no chips and never falls back to a global selection', () => {
  assert.deepEqual(buildTurnContextChips({}), []);
  assert.deepEqual(buildTurnContextChips(null), []);
  assert.deepEqual(buildTurnContextChips({ clipId: '   ', tab: '  ' }), []);

  // Building a context must not leave module-level state behind that a later
  // turn could pick up as an implicit "last selected" clip.
  buildTurnContextChips(context());
  assert.deepEqual(buildTurnContextChips({}), []);
});

test('time accepts seconds or frame/fps and refuses malformed values', () => {
  assert.equal(formatTurnContextTime({ frame: 210, fps: 30 }), '00:07');
  assert.equal(formatTurnContextTime({ frame: 0, fps: 24 }), '00:00');
  assert.equal(formatTurnContextTime({ seconds: 3723.9 }), '1:02:03');
  assert.equal(formatTurnContextTime(7.9), '00:07');
  assert.equal(formatTurnContextTime({ frame: 10 }), null);
  assert.equal(formatTurnContextTime({ frame: -1, fps: 30 }), null);
  assert.equal(formatTurnContextTime({ seconds: Number.NaN }), null);
  assert.equal(formatTurnContextTime({ seconds: -2 }), null);

  const chips = buildTurnContextChips({ time: { seconds: 12.5 } });
  assert.deepEqual(chips.map(chip => chip.value), ['00:12']);
});

test('revisions may arrive singly or with legacy field names', () => {
  const conversation = buildTurnContextChips({ revisions: { conversation: 3 } });
  assert.equal(conversation[0]?.value, 'chat r3');

  const project = buildTurnContextChips({ revisions: { conversationRevision: 2, packageRevision: 9 } });
  assert.equal(project[0]?.value, 'chat r2 · project r9');

  assert.deepEqual(buildTurnContextChips({ revisions: {} }), []);
});

test('removing a chip returns a new list and never mutates the original', () => {
  const original = buildTurnContextChips(context());
  const next = removeTurnContextChip(original, 'clip:ep2_video_a01');

  assert.notEqual(next, original);
  assert.equal(original.length, 5);
  assert.equal(next.length, 4);
  assert.deepEqual(next.map(chip => chip.kind), ['candidate', 'time', 'tab', 'revisions']);

  const byKind = removeTurnContextChip(next, 'tab');
  assert.deepEqual(byKind.map(chip => chip.kind), ['candidate', 'time', 'revisions']);
  assert.equal(original.length, 5);
});

test('renders removable chips with escaped data hooks', () => {
  const html = renderTurnContextChips(buildTurnContextChips(context()));

  assert.match(html, /data-turn-context/);
  assert.match(html, /role="group"/);
  assert.match(html, /aria-label="Turn context"/);
  assert.match(html, /data-context-chip="clip"/);
  assert.match(html, /data-remove-context-chip="clip:ep2_video_a01"/);
  assert.match(html, /aria-label="Remove Clip context"/);
  assert.match(html, /×/);
  assert.equal((html.match(/data-remove-context-chip=/g) ?? []).length, 5);

  const unsafe = renderTurnContextChips([{
    id: 'clip:"><script>',
    kind: 'clip',
    label: 'Clip',
    value: '<script>alert(1)</script>',
  }]);
  assert.doesNotMatch(unsafe, /<script>/);
  assert.match(unsafe, /&lt;script&gt;/);
  assert.match(unsafe, /data-remove-context-chip="clip:&quot;&gt;&lt;script&gt;"/);

  assert.equal(renderTurnContextChips([]), '');
});

test('mount renders removable chips and sends only the chips left in the turn', async () => {
  const previousDocument = globalThis.document;
  const previousStorage = globalThis.localStorage;
  const previousFetch = globalThis.fetch;
  const stored = new Map();
  const doc = new FakeDocument();
  const root = doc.createElement('div');
  doc.body.appendChild(root);
  globalThis.document = doc;
  globalThis.localStorage = {
    getItem: key => stored.get(String(key)) ?? null,
    setItem: (key, value) => { stored.set(String(key), String(value)); },
    removeItem: key => { stored.delete(String(key)); },
  };

  const posted = [];
  const conversation = {
    id: 'chat_0123456789abcdef',
    revision: 1,
    messages: [{ role: 'user', content: 'hi' }],
    plan: null,
    phase: 'chatting',
    projectId: null,
    projectRevision: null,
  };
  const apiFetch = async (url, init = {}) => {
    posted.push({ url: String(url), body: init.body ? JSON.parse(String(init.body)) : null });
    return new Response(JSON.stringify({ conversation, reply: 'ok', built: false }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  try {
    const chat = mountProjectChat({
      apiFetch,
      root,
      restoreSaved: false,
      append: () => {},
      replace: () => {},
      setBusy: () => {},
      applyProject: () => {},
      provider: async () => ({ provider: 'fake', model: 'fake-model' }),
      log: () => {},
      getTurnContext: () => context(),
    });

    await chat.ready;
    assert.match(root.innerHTML, /data-turn-context/);
    assert.match(root.innerHTML, /data-context-chip="clip"/);

    const remove = root.querySelector('[data-remove-context-chip="clip:ep2_video_a01"]');
    assert.ok(remove, 'the clip chip has a remove control');
    remove.dispatchEvent({ type: 'click', bubbles: true });

    assert.doesNotMatch(root.innerHTML, /data-context-chip="clip"/);
    assert.match(root.innerHTML, /data-context-chip="candidate"/);
    assert.deepEqual(chat.turnContextChips.map(chip => chip.kind), ['candidate', 'time', 'tab', 'revisions']);

    await chat.send('Keep the wide shot.', 'plan');

    const request = posted.find(entry => entry.url === '/api/agent/chat');
    assert.ok(request, 'the chat turn was posted');
    assert.deepEqual(request.body.turnContext.map(chip => chip.kind), ['candidate', 'time', 'tab', 'revisions']);
    assert.equal(request.body.turnContext[0].value, 'Take 3');
  } finally {
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
    if (previousStorage === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = previousStorage;
    if (previousFetch === undefined) delete globalThis.fetch;
    else globalThis.fetch = previousFetch;
  }
});
