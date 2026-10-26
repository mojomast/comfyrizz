// UX08: the Easy Ask drawer is provider-aware and scoped to the live
// conversation/project. These tests use a fake DOM, a fake chat and a fake
// provider; no browser, network, paid call or Google Colab access is involved.
// @ts-nocheck
import test from 'node:test';
import assert from 'node:assert/strict';

import { COPY } from './copy.ts';
import {
  askScopeKey,
  connectedProvider,
  createAskDrawer,
  renderAskDrawer,
} from './ask-drawer.ts';
import { mountEasyAgentSettings } from './agent-settings.ts';
import { mountProjectName } from './project-name.ts';

const VOID_TAGS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
const ATTRIBUTE = /([a-zA-Z_:][-\w:.]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;

const decodeEntities = value => String(value)
  .replace(/&lt;/g, '<')
  .replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"')
  .replace(/&#39;/g, "'")
  .replace(/&amp;/g, '&');

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

class FakeEvent {
  constructor(type, target) {
    this.type = type;
    this.target = target;
    this.currentTarget = target;
    this.bubbles = true;
    this.defaultPrevented = false;
    this.propagationStopped = false;
  }
  preventDefault() { this.defaultPrevented = true; }
  stopPropagation() { this.propagationStopped = true; }
  stopImmediatePropagation() { this.propagationStopped = true; }
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
  }

  get className() { return this._classes.join(' '); }
  set className(value) { this._classes = String(value ?? '').split(/\s+/).filter(Boolean); }
  get parentElement() { return this.parentNode; }
  get firstElementChild() { return this.children[0] ?? null; }
  get isConnected() {
    let node = this;
    while (node.parentNode) node = node.parentNode;
    return node === this.ownerDocument.body;
  }

  setAttribute(name, value) {
    const key = String(name).toLowerCase();
    this.attributes.set(key, String(value));
    if (key === 'class') this.className = value;
    if (key === 'id') this.ownerDocument.byId.set(String(value), this);
    if (key === 'disabled') this.disabled = true;
    if (key === 'hidden') this.hidden = true;
  }

  getAttribute(name) {
    const key = String(name).toLowerCase();
    return this.attributes.has(key) ? this.attributes.get(key) : null;
  }

  appendChild(child) {
    child.parentNode = this;
    this.children.push(child);
    return child;
  }

  append(...nodes) {
    for (const node of nodes) this.appendChild(node);
  }

  removeChild(child) {
    const index = this.children.indexOf(child);
    if (index >= 0) this.children.splice(index, 1);
    child.parentNode = null;
    return child;
  }

  remove() {
    this.parentNode?.removeChild(this);
  }

  replaceWith(next) {
    const parent = this.parentNode;
    if (!parent) return;
    const index = parent.children.indexOf(this);
    if (index >= 0) parent.children.splice(index, 1, next);
    next.parentNode = parent;
    this.parentNode = null;
  }

  contains(node) {
    let current = node;
    while (current) {
      if (current === this) return true;
      current = current.parentNode;
    }
    return false;
  }

  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(listener);
  }

  removeEventListener(type, listener) {
    this.listeners.get(type)?.delete(listener);
  }

  dispatchEvent(event) {
    const payload = event ?? new FakeEvent('event', this);
    payload.target ??= this;
    let node = this;
    while (node) {
      payload.currentTarget = node;
      for (const listener of [...(node.listeners.get(payload.type) ?? [])]) listener.call(node, payload);
      if (payload.propagationStopped || payload.bubbles === false) break;
      node = node.parentNode;
    }
    return !payload.defaultPrevented;
  }

  matches(selector) { return matchSimple(this, selector); }

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

  querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
  focus() { this.ownerDocument.activeElement = this; }
  blur() {}
  select() {}

  get innerHTML() { return this._html; }

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
    this.byId = new Map();
  }

  createElement(tagName) { return new FakeElement(tagName, this); }
  getElementById(id) { return this.byId.get(String(id)) ?? null; }
}

function installDom() {
  const previousDocument = globalThis.document;
  const previousElement = globalThis.HTMLElement;
  const doc = new FakeDocument();
  globalThis.document = doc;
  globalThis.HTMLElement = FakeElement;
  return {
    doc,
    restore() {
      if (previousDocument === undefined) delete globalThis.document;
      else globalThis.document = previousDocument;
      if (previousElement === undefined) delete globalThis.HTMLElement;
      else globalThis.HTMLElement = previousElement;
    },
  };
}

function click(element) {
  element.dispatchEvent(new FakeEvent('click', element));
}

function makeState(overrides = {}) {
  return {
    chatId: 'chat_a',
    packageId: 'pkg_a',
    productionId: 'prod_a',
    ...overrides,
  };
}

function makeHost(state, calls) {
  return {
    async aiSelection() {
      return state.provider === 'none'
        ? { provider: 'none', model: '' }
        : { provider: state.provider, model: 'fake-model' };
    },
    async apiFetch() {
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    },
    adoptBuiltPackage() { calls.adopt += 1; },
    openAgentSettings() { calls.hostSettings += 1; },
  };
}

function fakeChatFactory(chats) {
  return (host, options) => {
    host.innerHTML = '<textarea data-project-chat-input></textarea>';
    const input = host.querySelector('[data-project-chat-input]');
    const chat = {
      options,
      prefills: [],
      destroyed: false,
      prefill(text) {
        this.prefills.push(text);
        input.value = text;
        input.focus();
      },
      destroy() {
        this.destroyed = true;
      },
    };
    chats.push(chat);
    return chat;
  };
}

test('the disconnected Ask view is a visible setup, not a hidden inspector click', () => {
  const html = renderAskDrawer({ hasProvider: false });
  assert.match(html, /data-easy-ask-connect/);
  assert.match(html, /data-easy-ask-drawer/);
  assert.doesNotMatch(html, /data-easy-ask-chat/);
  assert.ok(html.includes(COPY.ask.noProvider));
});

test('provider detection treats none and blank providers as disconnected', () => {
  assert.equal(connectedProvider({ provider: 'none', model: '' }), null);
  assert.equal(connectedProvider({ provider: '  ', model: '' }), null);
  assert.deepEqual(connectedProvider({ provider: ' opencode-go ', model: ' gpt ' }), {
    provider: 'opencode-go',
    model: 'gpt',
  });
});

test('Ask opens the current conversation and project, preserving prefill and focus', async () => {
  const dom = installDom();
  try {
    const root = dom.doc.createElement('div');
    dom.doc.body.append(root);
    const opener = dom.doc.createElement('button');
    root.append(opener);
    opener.focus();
    const state = makeState({ provider: 'opencode-go' });
    const calls = { hostSettings: 0, adopt: 0 };
    const chats = [];
    const drawer = createAskDrawer({
      root,
      state: () => state,
      host: makeHost(state, calls),
      createChat: fakeChatFactory(chats),
      log: () => {},
    });

    await drawer.openAsk('Shot 3: make it shorter');

    assert.equal(chats.length, 1);
    assert.equal(chats[0].options.initialConversationId, 'chat_a');
    assert.equal(chats[0].options.expectedPackageId, 'pkg_a');
    assert.deepEqual(chats[0].prefills, ['Shot 3: make it shorter']);
    assert.equal(dom.doc.activeElement, root.querySelector('[data-project-chat-input]'));
    assert.ok(root.querySelector('[data-easy-ask-chat]'));

    drawer.close();
    assert.equal(chats[0].destroyed, true);
    assert.equal(dom.doc.activeElement, opener);
    assert.equal(root.querySelector('[data-easy-ask-drawer]'), null);
  } finally {
    dom.restore();
  }
});

test('disconnected Ask opens the visible AI settings instead of a hidden element', async () => {
  const dom = installDom();
  try {
    const root = dom.doc.createElement('div');
    dom.doc.body.append(root);
    const state = makeState({ provider: 'none' });
    const calls = { hostSettings: 0, adopt: 0, visibleSettings: 0 };
    const drawer = createAskDrawer({
      root,
      state: () => state,
      host: makeHost(state, calls),
      createChat: fakeChatFactory([]),
      openSettings: () => {
        calls.visibleSettings += 1;
        return new Promise(() => {});
      },
      log: () => {},
    });

    await drawer.openAsk();
    const connect = root.querySelector('[data-easy-ask-connect]');
    assert.ok(connect, 'disconnected Ask renders a Connect action');
    assert.equal(dom.doc.activeElement, connect);

    click(connect);
    assert.equal(calls.visibleSettings, 1);
    assert.equal(calls.hostSettings, 0, 'the hidden editor trigger is not used');
  } finally {
    dom.restore();
  }
});

test('switching project destroys the open conversation so old context cannot be sent', async () => {
  const dom = installDom();
  try {
    const root = dom.doc.createElement('div');
    dom.doc.body.append(root);
    const state = makeState({ provider: 'opencode-go' });
    const calls = { hostSettings: 0, adopt: 0 };
    const chats = [];
    let scopeListener = null;
    const drawer = createAskDrawer({
      root,
      state: () => state,
      host: makeHost(state, calls),
      createChat: fakeChatFactory(chats),
      subscribe: (listener) => {
        scopeListener = listener;
        return () => { scopeListener = null; };
      },
      log: () => {},
    });

    await drawer.openAsk();
    assert.equal(chats.length, 1);
    assert.equal(askScopeKey(state), JSON.stringify(['chat_a', 'pkg_a', 'prod_a']));

    state.chatId = 'chat_b';
    state.packageId = 'pkg_b';
    state.productionId = null;
    scopeListener();

    assert.equal(chats[0].destroyed, true, 'the project-A chat is torn down');
    assert.equal(root.querySelector('[data-easy-ask-drawer]'), null);

    chats[0].options.applyProject({ package: { id: 'pkg_a' } });
    assert.equal(calls.adopt, 0, 'a late project-A reply cannot replace project B');

    await drawer.openAsk();
    assert.equal(chats.length, 2);
    assert.equal(chats[1].options.initialConversationId, 'chat_b');
    assert.equal(chats[1].options.expectedPackageId, 'pkg_b');
    assert.notEqual(chats[1], chats[0]);
  } finally {
    dom.restore();
  }
});

test('a project change during provider lookup cannot paint or open the old scope', async () => {
  const dom = installDom();
  try {
    const root = dom.doc.createElement('div');
    dom.doc.body.append(root);
    const state = makeState({ provider: 'opencode-go' });
    const calls = { hostSettings: 0, adopt: 0 };
    const chats = [];
    let release;
    const pending = new Promise((resolve) => { release = resolve; });
    const host = {
      aiSelection: async () => {
        await pending;
        return { provider: 'opencode-go', model: 'fake-model' };
      },
      apiFetch: async () => new Response('{}'),
      adoptBuiltPackage() {},
      openAgentSettings() {},
    };
    const drawer = createAskDrawer({
      root,
      state: () => state,
      host,
      createChat: fakeChatFactory(chats),
      log: () => {},
    });

    const opening = drawer.openAsk();
    state.chatId = 'chat_b';
    state.packageId = 'pkg_b';
    state.productionId = null;
    release();
    await opening;

    assert.equal(chats.length, 0, 'the stale lookup never creates a chat');
    assert.equal(root.querySelector('[data-easy-ask-drawer]'), null);
    assert.equal(calls.hostSettings, 0);
  } finally {
    dom.restore();
  }
});


test('visible AI settings expose the server-backed selection used by Ask', async () => {
  const calls = [];
  const controller = mountEasyAgentSettings({
    apiFetch: async (input) => {
      calls.push(String(input));
      return new Response(JSON.stringify({
        profiles: [{
          id: 'opencode-go', label: 'OpenCode Go', preset: 'opencode-go', baseUrl: 'https://example.test/v1',
          modelsUrl: '', modelsUrlOverride: '', model: 'planner-model', configured: true,
          hasApiKey: true, keySource: 'saved', builtin: false,
        }],
        active: { provider: 'opencode-go', model: 'planner-model' },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    },
  });

  assert.deepEqual(await controller.selection(), { provider: 'opencode-go', model: 'planner-model' });
  assert.deepEqual(calls, ['/api/agent/settings']);
  controller.destroy();
});

test('visible AI settings refuse an unconfigured selection instead of pretending to be connected', async () => {
  const controller = mountEasyAgentSettings({
    apiFetch: async () => new Response(JSON.stringify({
      profiles: [{
        id: 'custom', label: 'My provider', preset: 'custom', baseUrl: '', modelsUrl: '',
        modelsUrlOverride: '', model: '', configured: false, hasApiKey: false, keySource: 'none', builtin: false,
      }],
      active: { provider: 'custom', model: '' },
    }), { status: 200, headers: { 'content-type': 'application/json' } }),
  });

  await assert.rejects(controller.selection(), /AI settings/);
  controller.destroy();
});


test('a renamed video saves the package title and reports the settled name', async () => {
  const dom = installDom();
  try {
    const host = dom.doc.createElement('div');
    dom.doc.body.append(host);
    const pkg = { id: 'pkg_a', title: 'Old title', revision: 3 };
    const calls = [];
    const names = [];
    const controller = mountProjectName(host, {
      host: {
        apiFetch: async (input, init) => {
          calls.push({ url: String(input), body: JSON.parse(init.body) });
          return new Response(JSON.stringify({ package: { ...pkg, title: 'New title' }, revision: 4 }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        },
        getPackage: () => pkg,
      },
      onRename: (name) => names.push(name),
    });

    click(host.querySelector('[data-easy-project-name]'));
    const input = host.querySelector('[data-easy-project-name-input]');
    input.value = 'New title';
    const enter = new FakeEvent('keydown', input);
    enter.key = 'Enter';
    input.dispatchEvent(enter);
    await new Promise((resolve) => setTimeout(resolve, 10));

    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, '/api/package/pkg_a');
    assert.equal(calls[0].body.baseRevision, 3);
    assert.equal(calls[0].body.package.title, 'New title');
    assert.equal(pkg.title, 'New title');
    assert.equal(pkg.revision, 4);
    assert.deepEqual(names, ['New title']);
    assert.equal(host.querySelector('[data-easy-project-name]')?.textContent, 'New title');
    controller.destroy();
  } finally {
    dom.restore();
  }
});
