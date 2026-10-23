// IP39W: an unbound (live) chat can still reject a proposal.
//
// Without a production `proposalCommands` binding, Reject sends one
// decision-only `/api/agent/chat` request (fresh turnId + baseRevision), then
// pre-fills the composer with an editable message. It never sends that message
// and never calls the model. A bound production keeps IP39's `decision.resolve`.
// @ts-nocheck
import test from 'node:test';
import assert from 'node:assert/strict';
import { PROPOSAL_DECISION_COMMAND_KIND, mountProjectChat } from '../src/project-chat.ts';

const CONVERSATION_ID = 'chat_ip39w_0123456789abcdef';

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

  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(listener);
  }

  removeEventListener(type, listener) {
    this.listeners.get(type)?.delete(listener);
  }

  dispatchEvent(event = {}) {
    // Real Event objects have read-only fields, so copy the parts listeners use.
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
      for (const listener of node.listeners.get(payload.type) ?? []) listener.call(node, payload);
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

function conversation(overrides = {}) {
  return {
    id: CONVERSATION_ID,
    revision: 5,
    messages: [{ role: 'user', content: 'Use this style everywhere.' }],
    plan: null,
    phase: 'chatting',
    projectId: null,
    projectRevision: null,
    referenceAssignments: [{
      id: 'asg_style_1',
      refId: 'ref_style',
      sceneId: 'scene_1',
      slot: 'style_reference',
      status: 'proposed',
      reason: 'Matches the brief',
    }],
    castProposals: [{
      id: 'cast_prop_1',
      status: 'proposed',
      action: 'cast',
      characterId: 'char_mara',
      scenes: ['scene_1'],
      role: 'narrator',
    }],
    ...overrides,
  };
}

function rejectedConversation(requestBody) {
  const next = conversation();
  const referenceIds = new Set(requestBody?.rejectAssignments ?? []);
  const castIds = new Set(requestBody?.rejectCastProposals ?? []);
  next.revision = (requestBody?.baseRevision ?? next.revision) + 1;
  next.referenceAssignments = next.referenceAssignments.map(assignment => referenceIds.has(assignment.id)
    ? { ...assignment, status: 'rejected', rejectedAt: '2026-10-23T00:00:00.000Z', turnId: requestBody.turnId }
    : assignment);
  next.castProposals = next.castProposals.map(proposal => castIds.has(proposal.id)
    ? { ...proposal, status: 'rejected', rejectedAt: '2026-10-23T00:00:00.000Z', turnId: requestBody.turnId }
    : proposal);
  return next;
}

function installDom() {
  const previousDocument = globalThis.document;
  const previousStorage = globalThis.localStorage;
  const stored = new Map([['comfyrizz.project-chat', CONVERSATION_ID]]);
  const doc = new FakeDocument();
  const composer = doc.createElement('textarea');
  composer.setAttribute('id', 'prompt');
  doc.body.appendChild(composer);
  const inputEvents = [];
  composer.addEventListener('input', () => inputEvents.push(composer.value));
  globalThis.document = doc;
  globalThis.localStorage = {
    getItem: key => stored.get(String(key)) ?? null,
    setItem: (key, value) => { stored.set(String(key), String(value)); },
    removeItem: key => { stored.delete(String(key)); },
  };
  return {
    doc,
    composer,
    inputEvents,
    restore() {
      if (previousDocument === undefined) delete globalThis.document;
      else globalThis.document = previousDocument;
      if (previousStorage === undefined) delete globalThis.localStorage;
      else globalThis.localStorage = previousStorage;
    },
  };
}

function mount(options = {}) {
  const doc = globalThis.document;
  const root = doc.createElement('div');
  doc.body.appendChild(root);
  const calls = [];
  const chat = mountProjectChat({
    apiFetch: async (url, init = {}) => {
      calls.push({ url: String(url), method: init.method ?? 'GET', body: init.body });
      if (String(url).startsWith('/api/agent/chat/')) {
        return new Response(JSON.stringify({ conversation: conversation(), reply: '', built: false }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      const body = init.body ? JSON.parse(init.body) : {};
      const next = (body.rejectAssignments?.length || body.rejectCastProposals?.length)
        ? rejectedConversation(body)
        : conversation();
      return new Response(JSON.stringify({ conversation: next, reply: '', built: false }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    },
    root,
    append: () => {},
    replace: () => {},
    setBusy: () => {},
    applyProject: () => {},
    provider: async () => ({ provider: 'fake', model: 'fake-model' }),
    log: () => {},
    ...options,
  });
  return { chat, root, calls };
}

async function waitFor(predicate, label, timeoutMs = 1000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.ok(predicate(), label);
}

test('an unbound Reject posts one decision-only reference request and prefills the composer', async () => {
  const dom = installDom();
  try {
    const { chat, root, calls } = mount();
    await chat.ready;
    assert.match(root.innerHTML, /data-reference-proposal="asg_style_1"/);

    const ok = await chat.decideProposal('reference', 'asg_style_1', 'reject');
    assert.equal(ok, true);

    const posts = calls.filter(entry => entry.method === 'POST');
    assert.equal(posts.length, 1, 'Reject issues exactly one request');
    assert.equal(posts[0].url, '/api/agent/chat');
    const body = JSON.parse(posts[0].body);
    assert.deepEqual(body.rejectAssignments, ['asg_style_1']);
    assert.equal('rejectCastProposals' in body, false);
    assert.equal(body.baseRevision, 5);
    assert.match(body.turnId, /^[A-Za-z0-9_-]{8,100}$/);
    assert.equal('message' in body, false, 'the decision-only request sends no model message');
    assert.equal('provider' in body, false, 'the decision-only request asks for no provider');

    assert.equal(dom.composer.value, 'Not this one: ref_style. ', 'the composer holds an editable rejection message');
    assert.deepEqual(dom.inputEvents, ['Not this one: ref_style. '], 'the composer change is announced');
    assert.doesNotMatch(root.innerHTML, /data-reference-proposal="asg_style_1"/);

    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(calls.filter(entry => entry.method === 'POST').length, 1,
      'the prefilled message is never sent automatically');
  } finally {
    dom.restore();
  }
});

test('an unbound Reject posts one decision-only cast request and prefills the character label', async () => {
  const dom = installDom();
  try {
    const { chat, root, calls } = mount({
      characterLabel: characterId => characterId === 'char_mara' ? 'Mara' : undefined,
    });
    await chat.ready;

    const ok = await chat.decideProposal('cast', 'cast_prop_1', 'reject');
    assert.equal(ok, true);

    const posts = calls.filter(entry => entry.method === 'POST');
    assert.equal(posts.length, 1);
    const body = JSON.parse(posts[0].body);
    assert.deepEqual(body.rejectCastProposals, ['cast_prop_1']);
    assert.equal('rejectAssignments' in body, false);
    assert.equal(body.baseRevision, 5);
    assert.match(body.turnId, /^[A-Za-z0-9_-]{8,100}$/);
    assert.equal('message' in body, false);

    assert.equal(dom.composer.value, 'Not this one: Mara. ');
    assert.doesNotMatch(root.innerHTML, /data-cast-proposal="cast_prop_1"/);
    assert.match(root.innerHTML, /data-reference-proposal="asg_style_1"/);
  } finally {
    dom.restore();
  }
});

test('a bound production keeps IP39 decision.resolve and never writes the composer', async () => {
  const dom = installDom();
  try {
    const sent = [];
    const { chat, root, calls } = mount({
      proposalCommands: {
        productionId: 'prod_0123456789abcdef01234567',
        baseRevision: () => 9,
        commandId: (action, proposalId) => `cmd_${action}_${proposalId}`,
        sendCommand: async command => { sent.push(command); },
      },
    });
    await chat.ready;

    const ok = await chat.decideProposal('reference', 'asg_style_1', 'reject');
    assert.equal(ok, true);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].kind, PROPOSAL_DECISION_COMMAND_KIND);
    assert.equal(sent[0].commandId, 'cmd_reject_asg_style_1');
    assert.deepEqual(sent[0].expected, { productionRevision: 9 });
    assert.equal(sent[0].payload.decisionId, 'asg_style_1');
    assert.equal(sent[0].payload.optionId, 'reject');
    assert.equal(dom.composer.value, '', 'the IP39 command path never prefills the composer');
    assert.equal(calls.filter(entry => entry.method === 'POST' && entry.url === '/api/agent/chat').length, 0,
      'the bound path never dispatches a chat turn');
    assert.doesNotMatch(root.innerHTML, /data-reference-proposal="asg_style_1"/);
  } finally {
    dom.restore();
  }
});

test('the rendered unbound Reject control dispatches through the decision-only path', async () => {
  const dom = installDom();
  try {
    const { chat, root, calls } = mount();
    await chat.ready;

    root.querySelector('[data-change-assignment="asg_style_1"]').dispatchEvent({ type: 'click', bubbles: true });
    await waitFor(() => calls.some(entry => entry.method === 'POST'), 'the Reject click sent the decision');
    const posts = calls.filter(entry => entry.method === 'POST');
    assert.equal(posts.length, 1);
    assert.deepEqual(JSON.parse(posts[0].body).rejectAssignments, ['asg_style_1']);
    assert.equal(dom.composer.value, 'Not this one: ref_style. ');
  } finally {
    dom.restore();
  }
});
