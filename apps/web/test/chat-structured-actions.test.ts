// IP39: chat proposal buttons are structured commands, not composer prefills.
//
// Accept and Reject on a reference or cast proposal resolve to the same
// `decision.resolve` command the UI and chat adapters use (architecture D5).
// The command always names the displayed proposal's id; the host supplies the
// production id and base revision. No composer text is written and no LLM turn
// is sent. These tests use a fake DOM and a command spy only.
// @ts-nocheck
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PROPOSAL_DECISION_COMMAND_KIND,
  buildProposalDecisionCommand,
  mountProjectChat,
  proposalCommandPath,
  proposalDecisionOption,
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
    this.byId = new Map();
  }

  createElement(tagName) {
    return new FakeElement(tagName, this);
  }

  getElementById(id) {
    return this.byId.get(String(id)) ?? null;
  }
}

function conversation() {
  return {
    id: 'chat_ip39_0123456789abcdef',
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
  };
}

function installDom() {
  const previousDocument = globalThis.document;
  const previousStorage = globalThis.localStorage;
  const stored = new Map([['comfyrizz.project-chat', 'chat_ip39_0123456789abcdef']]);
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
      return new Response(JSON.stringify({ conversation: conversation(), reply: 'ok', built: false }), {
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

test('builds one decision.resolve command whose payload names the proposal', () => {
  assert.equal(PROPOSAL_DECISION_COMMAND_KIND, 'decision.resolve');
  assert.equal(proposalDecisionOption('accept'), 'approve');
  assert.equal(proposalDecisionOption('reject'), 'reject');
  assert.equal(proposalCommandPath('prod_a/b'), '/api/productions/prod_a%2Fb/commands');

  const command = buildProposalDecisionCommand({
    productionId: 'prod_0123456789abcdef01234567',
    revision: 7,
    proposalId: 'asg_style_1',
    action: 'reject',
    proposalHash: 'a'.repeat(64),
    commandId: 'cmd_fixed_1',
  });

  assert.equal(command.kind, 'decision.resolve');
  assert.equal(command.productionId, 'prod_0123456789abcdef01234567');
  assert.equal(command.commandId, 'cmd_fixed_1');
  assert.equal(command.idempotencyKey, 'cmd_fixed_1');
  assert.deepEqual(command.expected, { productionRevision: 7 });
  assert.equal(command.payload.decisionId, 'asg_style_1');
  assert.equal(command.payload.proposalId, 'asg_style_1');
  assert.equal(command.payload.optionId, 'reject');
  assert.equal(command.payload.proposalHash, 'a'.repeat(64));

  const accepted = buildProposalDecisionCommand({
    productionId: 'prod_0123456789abcdef01234567',
    revision: 7,
    proposalId: 'cast_prop_1',
    action: 'accept',
    commandId: 'cmd_fixed_2',
  });
  assert.equal(accepted.payload.optionId, 'approve');
  assert.equal('proposalHash' in accepted.payload, false);
});

test('a command is refused for a malformed id, action or revision', () => {
  const base = {
    productionId: 'prod_0123456789abcdef01234567',
    revision: 4,
    proposalId: 'asg_style_1',
    action: 'reject',
    commandId: 'cmd_fixed_1',
  };
  assert.throws(() => buildProposalDecisionCommand({ ...base, proposalId: '  ' }), /proposal/i);
  assert.throws(() => buildProposalDecisionCommand({ ...base, productionId: '' }), /production/i);
  assert.throws(() => buildProposalDecisionCommand({ ...base, action: 'maybe' }), /action/i);
  assert.throws(() => buildProposalDecisionCommand({ ...base, revision: -1 }), /revision/i);
  assert.throws(() => buildProposalDecisionCommand({ ...base, revision: 1.5 }), /revision/i);
});

test('reject sends the production command with the proposal id and no prefill', async () => {
  const dom = installDom();
  try {
    const sent = [];
    let changed = 0;
    const { chat, root, calls } = mount({
      onChangeAssignment: () => { changed += 1; },
      proposalCommands: {
        productionId: 'prod_0123456789abcdef01234567',
        baseRevision: () => 9,
        commandId: (action, proposalId) => `cmd_${action}_${proposalId}`,
        sendCommand: async command => { sent.push(command); return { revision: 10 }; },
      },
    });

    await chat.ready;
    assert.match(root.innerHTML, /data-reference-proposal="asg_style_1"/);
    assert.ok(root.querySelector('[data-change-assignment="asg_style_1"]'), 'the Reject button is rendered');

    const ok = await chat.rejectProposal('reference', 'asg_style_1');
    assert.equal(ok, true);
    assert.equal(sent.length, 1);
    const [command] = sent;
    assert.equal(command.kind, 'decision.resolve');
    assert.equal(command.commandId, 'cmd_reject_asg_style_1');
    assert.equal(command.idempotencyKey, 'cmd_reject_asg_style_1');
    assert.deepEqual(command.expected, { productionRevision: 9 });
    assert.equal(command.payload.decisionId, 'asg_style_1');
    assert.equal(command.payload.proposalId, 'asg_style_1');
    assert.equal(command.payload.optionId, 'reject');

    assert.equal(changed, 0, 'Reject never pre-fills or asks the host to change the proposal');
    assert.equal(calls.filter(entry => entry.method === 'POST' && entry.url === '/api/agent/chat').length, 0,
      'Reject never dispatches an LLM chat turn');
    assert.doesNotMatch(root.innerHTML, /data-reference-proposal="asg_style_1"/);
    assert.match(root.innerHTML, /data-cast-proposal="cast_prop_1"/);
    assert.equal(chat.conversation.referenceAssignments[0].status, 'rejected');
  } finally {
    dom.restore();
  }
});

test('the rendered Reject control dispatches through the same path', async () => {
  const dom = installDom();
  try {
    const sent = [];
    const { chat, root } = mount({
      proposalCommands: {
        productionId: () => 'prod_0123456789abcdef01234567',
        baseRevision: 3,
        sendCommand: command => { sent.push(command); },
      },
    });
    await chat.ready;

    root.querySelector('[data-change-cast="cast_prop_1"]').dispatchEvent({ type: 'click', bubbles: true });
    await waitFor(() => sent.length === 1, 'the Reject click sent a command');
    assert.equal(sent[0].payload.decisionId, 'cast_prop_1');
    assert.equal(sent[0].payload.optionId, 'reject');
    await waitFor(() => !/data-cast-proposal="cast_prop_1"/.test(root.innerHTML), 'the rejected proposal is gone');
  } finally {
    dom.restore();
  }
});

test('accept sends approve for a cast proposal', async () => {
  const dom = installDom();
  try {
    const sent = [];
    const { chat, root } = mount({
      proposalCommands: {
        productionId: 'prod_0123456789abcdef01234567',
        baseRevision: 2,
        sendCommand: async command => { sent.push(command); },
      },
    });
    await chat.ready;

    const ok = await chat.acceptProposal('cast', 'cast_prop_1');
    assert.equal(ok, true);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].payload.optionId, 'approve');
    assert.equal(sent[0].payload.decisionId, 'cast_prop_1');
    assert.doesNotMatch(root.innerHTML, /data-cast-proposal="cast_prop_1"/);
    assert.match(root.innerHTML, /data-reference-proposal="asg_style_1"/);
  } finally {
    dom.restore();
  }
});

test('without an injected sender the binding posts the command to the production path', async () => {
  const dom = installDom();
  try {
    const requests = [];
    const { chat, root } = mount({
      proposalCommands: {
        productionId: 'prod_0123456789abcdef01234567',
        baseRevision: () => 6,
        apiFetch: async (url, init = {}) => {
          requests.push({ url: String(url), method: init.method, body: init.body });
          return new Response(JSON.stringify({ revision: 7 }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        },
      },
    });
    await chat.ready;

    root.querySelector('[data-change-assignment="asg_style_1"]').dispatchEvent({ type: 'click', bubbles: true });
    await waitFor(() => requests.length === 1, 'the production command was posted');
    assert.equal(requests[0].url, '/api/productions/prod_0123456789abcdef01234567/commands');
    assert.equal(requests[0].method, 'POST');
    const body = JSON.parse(requests[0].body);
    assert.equal(body.kind, 'decision.resolve');
    assert.equal(body.payload.decisionId, 'asg_style_1');
    assert.equal(body.payload.optionId, 'reject');
    assert.deepEqual(body.expected, { productionRevision: 6 });
  } finally {
    dom.restore();
  }
});

test('an unbound chat never turns Reject back into a composer prefill', async () => {
  const dom = installDom();
  try {
    let changed = 0;
    const { chat, root, calls } = mount({
      onChangeAssignment: () => { changed += 1; },
      onChangeCastProposal: () => { changed += 1; },
      onChangeCast: () => { changed += 1; },
    });
    await chat.ready;

    const ok = await chat.rejectProposal('reference', 'asg_style_1');
    assert.equal(ok, false);
    assert.equal(changed, 0, 'no host prefill or change hook is called');
    assert.match(root.innerHTML, /needs a production command binding/);
    assert.equal(calls.filter(entry => entry.method === 'POST').length, 0);
    assert.match(root.innerHTML, /data-reference-proposal="asg_style_1"/);
  } finally {
    dom.restore();
  }
});

test('a failed command keeps the proposal and reports one error', async () => {
  const dom = installDom();
  try {
    const { chat, root } = mount({
      proposalCommands: {
        productionId: 'prod_0123456789abcdef01234567',
        baseRevision: 1,
        sendCommand: async () => { throw new Error('revision conflict'); },
      },
    });
    await chat.ready;

    const ok = await chat.rejectProposal('reference', 'asg_style_1');
    assert.equal(ok, false);
    assert.match(root.innerHTML, /revision conflict/);
    assert.match(root.innerHTML, /data-reference-proposal="asg_style_1"/);
    assert.equal(chat.conversation.referenceAssignments[0].status, 'proposed');
  } finally {
    dom.restore();
  }
});
