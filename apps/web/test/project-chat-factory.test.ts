// @ts-nocheck
import test from 'node:test';
import assert from 'node:assert/strict';
import * as projectChat from '../src/project-chat.ts';

const CHAT_ID = 'chat_factory_0123456789abcdef';
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
    const source = event && typeof event === 'object' ? event : {};
    const payload = {
      type: source.type ?? 'event',
      bubbles: source.bubbles ?? true,
      target: this,
      currentTarget: this,
      defaultPrevented: false,
      preventDefault() { this.defaultPrevented = true; },
      stopPropagation() { this.propagationStopped = true; },
    };
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
  const previousStorage = globalThis.localStorage;
  const stored = new Map();
  const doc = new FakeDocument();
  globalThis.document = doc;
  globalThis.localStorage = {
    getItem: key => stored.get(String(key)) ?? null,
    setItem: (key, value) => { stored.set(String(key), String(value)); },
    removeItem: key => { stored.delete(String(key)); },
  };
  return {
    doc,
    restore() {
      if (previousDocument === undefined) delete globalThis.document;
      else globalThis.document = previousDocument;
      if (previousStorage === undefined) delete globalThis.localStorage;
      else globalThis.localStorage = previousStorage;
    },
  };
}

function conversation(overrides = {}) {
  return {
    id: CHAT_ID,
    revision: 1,
    messages: [],
    plan: null,
    phase: 'chatting',
    projectId: null,
    projectRevision: null,
    ...overrides,
  };
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function factoryOptions(overrides = {}) {
  return {
    apiFetch: async () => jsonResponse({ conversation: conversation(), reply: '', built: false }),
    restoreSaved: false,
    applyProject: () => {},
    provider: async () => ({ provider: 'fake', model: 'fake-model' }),
    log: () => {},
    ...overrides,
  };
}

function create(host, overrides = {}) {
  return projectChat.createProjectChat(host, factoryOptions(overrides));
}

function isWithin(host, element) {
  let node = element;
  while (node) {
    if (node === host) return true;
    node = node.parentNode;
  }
  return false;
}

async function waitFor(predicate, label, timeoutMs = 1000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.ok(predicate(), label);
}

test('createProjectChat renders its labelled composer, Send button and live log only inside the host', async () => {
  const dom = installDom();
  try {
    assert.equal(typeof projectChat.createProjectChat, 'function');
    const outside = dom.doc.createElement('section');
    outside.innerHTML = '<p>Advanced chat</p>';
    dom.doc.body.appendChild(outside);
    const host = dom.doc.createElement('div');
    dom.doc.body.appendChild(host);
    const bodyChildren = dom.doc.body.children.length;

    const chat = create(host);
    await chat.ready;

    assert.equal(chat.element, host);
    const log = host.querySelector('[role="log"]');
    assert.ok(log, 'the host has a message log');
    assert.equal(log.getAttribute('aria-live'), 'polite');
    const form = host.querySelector('form');
    assert.ok(form, 'the host has a composer form');
    const composer = form.querySelector('textarea');
    assert.ok(composer, 'the composer is a textarea');
    assert.ok(composer.getAttribute('id'), 'the composer has an id for its label');
    assert.notEqual(composer.getAttribute('id'), 'prompt');
    assert.ok(form.querySelectorAll('label').some(label =>
      label.getAttribute('for') === composer.getAttribute('id') && label.textContent.trim()));
    assert.ok(form.querySelectorAll('button').some(button =>
      button.getAttribute('type') === 'submit' && button.textContent.trim() === 'Send'));
    assert.equal(dom.doc.body.children.length, bodyChildren);
    assert.equal(outside.innerHTML, '<p>Advanced chat</p>');
    assert.ok(dom.doc.body.querySelectorAll('textarea').every(element => isWithin(host, element)));
    assert.ok(dom.doc.body.querySelectorAll('form').every(element => isWithin(host, element)));
    assert.equal(dom.doc.getElementById('prompt'), null);
  } finally {
    dom.restore();
  }
});

test('prefill writes and focuses only this instance composer without sending', async () => {
  const dom = installDom();
  try {
    const globalPrompt = dom.doc.createElement('textarea');
    globalPrompt.setAttribute('id', 'prompt');
    globalPrompt.value = 'Advanced draft';
    dom.doc.body.appendChild(globalPrompt);
    const host = dom.doc.createElement('div');
    dom.doc.body.appendChild(host);
    const calls = [];
    const chat = create(host, {
      apiFetch: async (url, init = {}) => {
        calls.push({ url: String(url), method: init.method ?? 'GET' });
        return jsonResponse({ conversation: conversation(), reply: '', built: false });
      },
    });
    await chat.ready;

    chat.prefill('Shot 2: make this calmer');

    const composer = host.querySelector('textarea');
    assert.equal(composer.value, 'Shot 2: make this calmer');
    assert.equal(globalPrompt.value, 'Advanced draft');
    assert.equal(dom.doc.activeElement, composer);
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(calls.length, 0, 'prefill never sends a chat turn');
  } finally {
    dom.restore();
  }
});

test('the host composer sends one chat turn and appends the assistant reply to the host log', async () => {
  const dom = installDom();
  try {
    const host = dom.doc.createElement('div');
    dom.doc.body.appendChild(host);
    const calls = [];
    const chat = create(host, {
      apiFetch: async (url, init = {}) => {
        calls.push({ url: String(url), method: init.method ?? 'GET', body: init.body });
        const replyConversation = conversation({
          revision: 2,
          messages: [
            { role: 'user', content: 'Make the ending warmer.' },
            { role: 'assistant', content: 'I made the ending warmer.' },
          ],
        });
        return jsonResponse({ conversation: replyConversation, reply: 'I made the ending warmer.', built: false });
      },
    });
    await chat.ready;
    const form = host.querySelector('form');
    const composer = form.querySelector('textarea');
    composer.value = 'Make the ending warmer.';

    form.dispatchEvent({ type: 'submit', bubbles: true });

    const log = host.querySelector('[role="log"]');
    await waitFor(() => log.children.some(message => message.textContent === 'I made the ending warmer.'),
      'the assistant reply was appended to the host log');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, '/api/agent/chat');
    assert.equal(calls[0].method, 'POST');
    const body = JSON.parse(calls[0].body);
    assert.equal(body.message, 'Make the ending warmer.');
    assert.equal(body.mode, 'plan');
    assert.equal(body.provider, 'fake');
    assert.equal(log.children.at(-1).textContent, 'I made the ending warmer.');
  } finally {
    dom.restore();
  }
});

test('reference and cast proposals render the existing Accept and Reject controls inside the host', async () => {
  const dom = installDom();
  try {
    const host = dom.doc.createElement('div');
    dom.doc.body.appendChild(host);
    const proposed = conversation({
      referenceAssignments: [{
        id: 'asg_style_1',
        refId: 'ref_style',
        sceneId: 'scene_1',
        slot: 'style_reference',
        status: 'proposed',
      }],
      castProposals: [{
        id: 'cast_prop_1',
        status: 'proposed',
        action: 'cast',
        characterId: 'char_mara',
        scenes: ['scene_1'],
      }],
    });
    const chat = create(host, {
      initialConversationId: CHAT_ID,
      apiFetch: async () => jsonResponse({ conversation: proposed, reply: '', built: false }),
    });
    await chat.ready;

    assert.ok(host.querySelector('[data-reference-proposal="asg_style_1"]'));
    assert.equal(host.querySelector('[data-confirm-assignment="asg_style_1"]').textContent.trim(), 'Accept');
    assert.equal(host.querySelector('[data-change-assignment="asg_style_1"]').textContent.trim(), 'Reject');
    assert.ok(host.querySelector('[data-cast-proposal="cast_prop_1"]'));
    assert.equal(host.querySelector('[data-confirm-cast="cast_prop_1"]').textContent.trim(), 'Accept');
    assert.equal(host.querySelector('[data-change-cast="cast_prop_1"]').textContent.trim(), 'Reject');
  } finally {
    dom.restore();
  }
});

test('clip corrections, audio and signed plans render actionable controls with the activity drawer', async () => {
  const dom = installDom();
  try {
    const host = dom.doc.createElement('div');
    dom.doc.body.appendChild(host);
    const proposed = conversation({
      clipProposals: [
        { id: 'cp_fall', kind: 'correction', clipId: 's2', status: 'proposed', change: { note: 'Hit the ground harder.' } },
        { id: 'cp_audio', kind: 'audio', clipId: 'soundtrack', status: 'proposed', change: { note: 'Add percussion and impact foley.' } },
        { id: 'cp_plan', kind: 'correction', clipId: 's3', status: 'plan_ready', productionId: 'prod_1', planId: 'plan_1', planHash: 'a'.repeat(64) },
      ],
    });
    const reviewed = [];
    const chat = create(host, {
      initialConversationId: CHAT_ID,
      onReviewPlan: id => reviewed.push(id),
      apiFetch: async () => jsonResponse({ conversation: proposed, reply: '', built: false }),
    });
    await chat.ready;

    assert.ok(host.querySelector('[data-agent-console-toggle]'));
    assert.equal(host.querySelector('[data-confirm-clip="cp_fall"]').textContent.trim(), 'Prepare generation');
    assert.equal(host.querySelector('[data-confirm-clip="cp_audio"]').textContent.trim(), 'Apply change');
    assert.equal(host.querySelector('[data-review-plan="prod_1"]').textContent.trim(), 'Review & authorize plan');
    assert.ok(host.querySelector('[data-clip-proposal="cp_audio"]'));
    host.querySelector('[data-review-plan="prod_1"]').dispatchEvent({ type: 'click', bubbles: true });
    assert.deepEqual(reviewed, ['prod_1']);
  } finally {
    dom.restore();
  }
});

test('destroy removes the submit listener and empties the host', async () => {
  const dom = installDom();
  try {
    const host = dom.doc.createElement('div');
    dom.doc.body.appendChild(host);
    const calls = [];
    const chat = create(host, {
      apiFetch: async (url, init = {}) => {
        calls.push({ url: String(url), method: init.method ?? 'GET' });
        return jsonResponse({ conversation: conversation(), reply: '', built: false });
      },
    });
    await chat.ready;
    const form = host.querySelector('form');
    form.querySelector('textarea').value = 'This must not send.';

    chat.destroy();
    assert.equal(host.children.length, 0);
    assert.equal(host.innerHTML, '');
    form.dispatchEvent({ type: 'submit', bubbles: true });
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(calls.length, 0);
  } finally {
    dom.restore();
  }
});

test('mountProjectChat still resolves the global prompt for suggested prompts', async () => {
  const dom = installDom();
  try {
    const globalPrompt = dom.doc.createElement('textarea');
    globalPrompt.setAttribute('id', 'prompt');
    dom.doc.body.appendChild(globalPrompt);
    const root = dom.doc.createElement('div');
    dom.doc.body.appendChild(root);
    const chat = projectChat.mountProjectChat({
      apiFetch: async () => jsonResponse({ conversation: conversation(), reply: '', built: false }),
      root,
      restoreSaved: false,
      append: () => {},
      replace: () => {},
      setBusy: () => {},
      applyProject: () => {},
      provider: async () => ({ provider: 'fake', model: 'fake-model' }),
      log: () => {},
    });
    await chat.ready;
    const suggested = root.querySelector('[data-prompt]');
    const text = suggested.getAttribute('data-prompt');

    suggested.dispatchEvent({ type: 'click', bubbles: true });

    assert.equal(globalPrompt.value, text);
    assert.equal(dom.doc.activeElement, globalPrompt);
  } finally {
    dom.restore();
  }
});

test('adoptPackageId is sent only while unbound and the returned chat is handed off before package adoption', async () => {
  const dom = installDom();
  try {
    const host = dom.doc.createElement('div');
    dom.doc.body.appendChild(host);
    const bodies = [];
    const order = [];
    let turn = 0;
    const chat = create(host, {
      adoptPackageId: 'pkg_existing',
      expectedPackageId: 'pkg_existing',
      onConversationChange: (conversation) => order.push(`chat:${conversation.id}`),
      applyProject: (project) => order.push(`package:${project.package.id}`),
      apiFetch: async (_url, init = {}) => {
        turn += 1;
        bodies.push(JSON.parse(init.body));
        const built = turn === 1;
        return jsonResponse({
          conversation: conversation({
            revision: turn,
            projectId: 'pkg_existing',
            projectRevision: built ? 2 : 3,
            phase: built ? 'built' : 'chatting',
          }),
          reply: built ? 'Changed the existing package.' : 'No further changes.',
          built,
          ...(built ? { project: { package: { id: 'pkg_existing', title: 'Existing', revision: 2 }, revision: 2 } } : {}),
        });
      },
    });
    await chat.ready;

    await chat.send('Change the opening.', 'plan');
    await chat.send('Keep everything else unchanged.', 'plan');

    assert.equal(bodies[0].adoptPackageId, 'pkg_existing');
    assert.equal('adoptPackageId' in bodies[1], false, 'a bound conversation never re-adopts');
    assert.deepEqual(order.slice(0, 2), [`chat:${CHAT_ID}`, 'package:pkg_existing']);
  } finally {
    dom.restore();
  }
});

test('a response from another package is rejected before chat or package handoff', async () => {
  const dom = installDom();
  try {
    const host = dom.doc.createElement('div');
    dom.doc.body.appendChild(host);
    const handedOff = [];
    const chat = create(host, {
      expectedPackageId: 'pkg_expected',
      onConversationChange: (conversation) => handedOff.push(conversation.id),
      applyProject: (project) => handedOff.push(project.package.id),
      apiFetch: async () => jsonResponse({
        conversation: conversation({ projectId: 'pkg_other', phase: 'built' }),
        reply: 'Wrong project.',
        built: true,
        project: { package: { id: 'pkg_other', title: 'Other', revision: 2 }, revision: 2 },
      }),
    });
    await chat.ready;

    await chat.send('Change something.', 'plan');

    assert.deepEqual(handedOff, []);
    assert.match(host.querySelector('[data-project-chat-panel]').innerHTML, /different project/);
  } finally {
    dom.restore();
  }
});
