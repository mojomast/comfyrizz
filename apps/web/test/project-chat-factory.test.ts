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
    assert.equal(host.querySelector('[data-review-plan="prod_1"]').textContent.trim(), 'Review & edit full plan');
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

test('Advanced chat reads a Super Easy package at send time and rejects a substituted reply', async () => {
  const dom = installDom();
  try {
    const host = dom.doc.createElement('div');
    dom.doc.body.appendChild(host);
    let current = null;
    const bodies = [];
    const applied = [];
    const chat = create(host, {
      getEditContext: () => current,
      applyProject: project => applied.push(project.package.id),
      apiFetch: async (_url, init = {}) => {
        bodies.push(JSON.parse(init.body));
        return jsonResponse({ conversation: conversation({ projectId: 'pkg_replacement', phase: 'built' }), reply: 'Replaced.', built: true,
          project: { package: { id: 'pkg_replacement', revision: 1 }, revision: 1 } });
      },
    });
    await chat.ready;
    current = { packageId: 'pkg_7c235c863aa8707a', revision: 6 };
    await chat.send('Correct the existing olive video.', 'plan');
    assert.equal(bodies[0].expectedPackageId, current.packageId);
    assert.equal(bodies[0].expectedPackageRevision, 6);
    assert.deepEqual(applied, []);
    assert.match(host.querySelector('[data-project-chat-panel]').innerHTML, /different project/);
    assert.equal(chat.conversation, null);
  } finally { dom.restore(); }
});

test('an explicit new-video action leaves edit mode, while opening another package restores it', async () => {
  const dom = installDom();
  try {
    const host = dom.doc.createElement('div');
    dom.doc.body.appendChild(host);
    let current = { packageId: 'pkg_existing', revision: 6 };
    const bodies = [];
    const chat = create(host, {
      getEditContext: () => current,
      apiFetch: async (_url, init = {}) => {
        const body = JSON.parse(init.body); bodies.push(body);
        return jsonResponse({ conversation: conversation({ id: body.conversationId, projectId: body.expectedPackageId ?? null }), reply: 'Draft only.', built: false });
      },
    });
    await chat.ready;
    host.querySelector('#project-new').dispatchEvent({ type: 'click', bubbles: true });
    await chat.send('Make a new film.', 'plan');
    assert.equal(bodies[0].expectedPackageId, undefined);
    current = { packageId: 'pkg_other_opened', revision: 2 };
    await chat.send('Edit the newly opened film.', 'plan');
    assert.equal(bodies[1].expectedPackageId, current.packageId);
    assert.equal(bodies[1].expectedPackageRevision, 2);
  } finally { dom.restore(); }
});

test('a cold saved package displays its exact edit diff and applies through the revision-bound Build action', async () => {
  const dom = installDom();
  try {
    const host = dom.doc.createElement('div'); dom.doc.body.appendChild(host);
    const bodies = [], applied = [];
    const diff = [{ path: 'voice.enabled', before: true, after: false }, { path: 'scenes.s1.copy.kicker', before: '<unwanted>', after: null }];
    const staged = conversation({ plan: null, phase: 'draft', projectId: 'pkg_existing', projectRevision: 41,
      packageEdit: { request: { packageId: 'pkg_existing', expectedRevision: 41 }, diff } });
    const chat = create(host, {
      getEditContext: () => ({ packageId: 'pkg_existing', revision: 41 }),
      applyProject: project => applied.push(project.package.id),
      apiFetch: async (_url, init = {}) => {
        const body = JSON.parse(init.body); bodies.push(body);
        return jsonResponse(body.action === 'build'
          ? { conversation: conversation({ ...staged, phase: 'built', revision: 2, projectRevision: 42, packageEdit: null, lastPackageEdit: { diff, appliedRevision: 42 } }), built: true, reply: 'Applied reviewed edits.', project: { package: { id: 'pkg_existing', revision: 42 }, revision: 42 } }
          : { conversation: staged, built: false, reply: 'Review the staged package edits.' });
      },
    });
    await chat.ready;
    await chat.send('Stage the requested cleanup.', 'plan');
    const review = host.querySelector('[data-package-edit-review]');
    assert.ok(review); assert.match(host.querySelector('[data-project-chat-panel]').innerHTML, /voice.enabled/);
    assert.match(host.querySelector('[data-project-chat-panel]').innerHTML, /&lt;unwanted&gt;/);
    assert.deepEqual(applied, []);
    host.querySelector('#project-package-edit-build').dispatchEvent({ type: 'click', bubbles: true });
    await waitFor(() => applied.length === 1, 'the reviewed edit was applied');
    assert.equal(bodies[1].action, 'build');
    assert.equal(bodies[1].expectedPackageId, 'pkg_existing');
    assert.equal(bodies[1].expectedPackageRevision, 41);
    assert.equal(bodies[1].baseRevision, staged.revision);
    assert.equal(host.querySelector('#project-package-edit-build'), null);
    assert.match(host.querySelector('[data-project-chat-panel]').innerHTML, /Applied package edits · revision 42/);
  } finally { dom.restore(); }
});

test('package restoration ignores the global chat and preserves each project conversation across modes', async () => {
  const dom = installDom();
  try {
    localStorage.setItem('comfyrizz.project-chat', 'chat_unrelated');
    localStorage.setItem('comfyrizz.project-chat:pkg_selected', 'chat_selected');
    const calls = [], applied = [];
    const options = {
      restoreSaved: true,
      getEditContext: () => ({ packageId: 'pkg_selected', revision: 12 }),
      applyProject: project => applied.push(project.revision),
      apiFetch: async (url, init = {}) => {
        calls.push([url, init.method ?? 'GET']);
        return jsonResponse({ conversation: conversation({ id: 'chat_selected', projectId: 'pkg_selected', projectRevision: 10 }),
          project: { package: { id: 'pkg_selected' }, revision: 12 }, built: false });
      },
    };
    const first = create(dom.doc.createElement('div'), options);
    await first.ready;
    first.destroy();
    const next = create(dom.doc.createElement('div'), options);
    await next.ready;
    assert.equal(next.conversationId, 'chat_selected');
    assert.deepEqual(calls, Array(2).fill(['/api/agent/chat/chat_selected', 'GET']));
    assert.deepEqual(applied, [12, 12]);
    next.destroy();
  } finally { dom.restore(); }
});

test('rebinding drops a late restore and sends with the selected conversation and current CAS', async () => {
  const dom = installDom();
  try {
    let release;
    const delayed = new Promise(resolve => { release = resolve; });
    const applied = [], snapshots = [], bodies = [];
    const chat = create(dom.doc.createElement('div'), {
      initialConversationId: 'chat_old', expectedPackageId: 'pkg_old',
      applyProject: project => applied.push(project.package.id),
      onConversationChange: value => snapshots.push(value.id),
      apiFetch: async (url, init = {}) => {
        if (url.endsWith('/chat_old')) return delayed;
        if (init.method === 'POST') bodies.push(JSON.parse(init.body));
        return jsonResponse({ conversation: conversation({ id: 'chat_selected', revision: 7, projectId: 'pkg_selected', projectRevision: 22 }), built: false });
      },
    });
    const oldReady = chat.ready;
    await chat.setProjectContext({ packageId: 'pkg_selected', revision: 22, conversationId: 'chat_selected' });
    release(jsonResponse({ conversation: conversation({ id: 'chat_old', projectId: 'pkg_old' }),
      project: { package: { id: 'pkg_old' }, revision: 99 } }));
    await oldReady;
    await chat.send('Edit the selected project.', 'plan');
    assert.equal(chat.conversationId, 'chat_selected');
    assert.deepEqual(applied, []);
    assert.deepEqual(snapshots, ['chat_selected', 'chat_selected']);
    assert.equal(bodies.length, 1);
    assert.equal(bodies[0].conversationId, 'chat_selected');
    assert.equal(bodies[0].baseRevision, 7);
    assert.equal(bodies[0].expectedPackageId, 'pkg_selected');
    assert.equal(bodies[0].expectedPackageRevision, 22);
    chat.destroy();
  } finally { dom.restore(); }
});

test('same-project revision updates preserve the conversation without creating or loading another', async () => {
  const dom = installDom();
  try {
    const calls = [];
    const chat = create(dom.doc.createElement('div'), {
      apiFetch: async (url, init = {}) => {
        calls.push({ url, body: init.body && JSON.parse(init.body) });
        return jsonResponse({ conversation: conversation({ id: 'chat_selected', projectId: 'pkg_selected', revision: 3 }), built: false });
      },
    });
    await chat.setProjectContext({ packageId: 'pkg_selected', revision: 22, conversationId: 'chat_selected' });
    await chat.setProjectContext({ packageId: 'pkg_selected', revision: 23 });
    await chat.send('Use my latest edits.', 'plan');
    assert.equal(calls.length, 2);
    assert.equal(calls[1].body.conversationId, 'chat_selected');
    assert.equal(calls[1].body.expectedPackageRevision, 23);
    chat.destroy();
  } finally { dom.restore(); }
});

test('a restored stale package never overwrites the newer authoritative selected revision', async () => {
  const dom = installDom();
  try {
    const applied = [];
    const chat = create(dom.doc.createElement('div'), {
      initialConversationId: CHAT_ID,
      getEditContext: () => ({ packageId: 'pkg_selected', revision: 42 }),
      applyProject: project => applied.push(project),
      apiFetch: async () => jsonResponse({ conversation: conversation({ projectId: 'pkg_selected', projectRevision: 40 }),
        project: { package: { id: 'pkg_selected' }, revision: 40 } }),
    });
    await chat.ready;
    assert.equal(chat.conversationId, CHAT_ID);
    assert.deepEqual(applied, []);
    chat.destroy();
  } finally { dom.restore(); }
});

test('destroy during restore or a turn prevents late project, conversation, and storage handoff', async () => {
  const dom = installDom();
  try {
    for (const restoring of [true, false]) {
      let release;
      const delayed = new Promise(resolve => { release = resolve; });
      const effects = [];
      const host = dom.doc.createElement('div');
      const chat = create(host, {
        ...(restoring ? { initialConversationId: CHAT_ID } : {}),
        getEditContext: () => ({ packageId: 'pkg_selected', revision: 1 }),
        apiFetch: async () => delayed,
        applyProject: () => effects.push('project'),
        onConversationChange: () => effects.push('conversation'),
        onReferencesChanged: () => effects.push('references'),
      });
      const completion = restoring ? chat.ready : chat.send('Edit.', 'plan');
      if (!restoring) await waitFor(() => chat.conversationId !== null, 'turn started');
      chat.destroy();
      const storedBefore = localStorage.getItem('comfyrizz.project-chat:pkg_selected');
      release(jsonResponse({ conversation: conversation({ projectId: 'pkg_selected' }), built: true,
        project: { package: { id: 'pkg_selected' }, revision: 2 } }));
      await completion;
      assert.deepEqual(effects, []);
      assert.equal(host.innerHTML, '');
      assert.equal(localStorage.getItem('comfyrizz.project-chat:pkg_selected'), storedBefore);
      await chat.send('Disposed controllers cannot send.', 'plan');
    }
  } finally { dom.restore(); }
});

test('project or revision changes during provider selection prevent the old turn from being sent', async () => {
  const dom = installDom();
  try {
    for (const next of [{ packageId: 'pkg_other', revision: 2 }, { packageId: 'pkg_selected', revision: 3 }]) {
      let current = { packageId: 'pkg_selected', revision: 2 }, release, selecting = false;
      const calls = [];
      const chat = create(dom.doc.createElement('div'), {
        getEditContext: () => current,
        provider: () => { selecting = true; return new Promise(resolve => { release = resolve; }); },
        apiFetch: async url => { calls.push(url); return jsonResponse({}); },
      });
      const sending = chat.send('Apply this edit.', 'plan');
      await waitFor(() => selecting, 'provider selection started');
      current = next;
      release({ provider: 'fake', model: 'fake' });
      await sending;
      assert.deepEqual(calls, []);
      chat.destroy();
    }
  } finally { dom.restore(); }
});

test('an external edit while a turn is running makes its late result ineligible to replace the project', async () => {
  const dom = installDom();
  try {
    let current = { packageId: 'pkg_selected', revision: 2 }, release, started = false;
    const effects = [];
    const chat = create(dom.doc.createElement('div'), {
      getEditContext: () => current,
      apiFetch: () => { started = true; return new Promise(resolve => { release = resolve; }); },
      applyProject: () => effects.push('project'),
      onConversationChange: () => effects.push('conversation'),
    });
    const sending = chat.send('Apply this edit.', 'plan');
    await waitFor(() => started, 'turn started');
    current = { ...current, revision: 4 };
    release(jsonResponse({ conversation: conversation({ projectId: 'pkg_selected', projectRevision: 3 }), built: true,
      project: { package: { id: 'pkg_selected' }, revision: 3 } }));
    await sending;
    assert.deepEqual(effects, []);
    chat.destroy();
  } finally { dom.restore(); }
});

test('guest chat never calls owner restore, provider, proposal, progress, or turn APIs', async () => {
  const dom = installDom();
  try {
    const calls = [];
    const host = dom.doc.createElement('div');
    const chat = create(host, {
      initialConversationId: CHAT_ID,
      canUseOwnerApi: () => false,
      apiFetch: async () => { calls.push('fetch'); return jsonResponse({}); },
      provider: async () => { calls.push('provider'); return { provider: 'fake', model: 'fake' }; },
      getAgentProgress: async () => { calls.push('progress'); return {}; },
    });
    await chat.ready;
    await chat.send('Edit this.', 'plan');
    await chat.decideProposal('reference', 'proposal_1', 'accept');
    await chat.confirmClipProposals(['proposal_2']);
    await chat.authorizeClipProposals(['proposal_2']);
    assert.throws(() => chat.ensureConversationId(), /owner/);
    assert.equal(host.querySelector('textarea').disabled, true);
    await chat.setProjectContext({ packageId: 'pkg_selected', revision: 1, conversationId: 'chat_selected', owner: false });
    assert.deepEqual(calls, []);
    chat.destroy();
  } finally { dom.restore(); }
});

test('failed restoration blocks new turns until reload succeeds instead of silently forking the conversation', async () => {
  const dom = installDom();
  try {
    const calls = [], host = dom.doc.createElement('div');
    let available = false;
    const chat = create(host, {
      initialConversationId: CHAT_ID,
      apiFetch: async (url, init = {}) => {
        calls.push(init.method ?? 'GET');
        return available ? jsonResponse({ conversation: conversation({ revision: 4 }), built: false })
          : jsonResponse({ error: 'Temporary outage' }, 503);
      },
    });
    await chat.ready;
    await chat.send('Do not fork the failed restore.', 'plan');
    assert.deepEqual(calls, ['GET']);
    assert.equal(chat.conversationId, CHAT_ID);
    available = true;
    host.querySelector('#project-reload').dispatchEvent({ type: 'click', bubbles: true });
    await waitFor(() => chat.conversation?.revision === 4, 'restored original conversation');
    await chat.send('Now continue.', 'plan');
    assert.deepEqual(calls, ['GET', 'GET', 'POST']);
    chat.destroy();
  } finally { dom.restore(); }
});

test('explicit new video clears static package adoption while retaining the old project chat for reopening', async () => {
  const dom = installDom();
  try {
    localStorage.setItem('comfyrizz.project-chat:pkg_old', 'chat_old');
    const bodies = [], host = dom.doc.createElement('div');
    const chat = create(host, {
      expectedPackageId: 'pkg_old', adoptPackageId: 'pkg_old',
      apiFetch: async (_url, init = {}) => {
        const body = JSON.parse(init.body); bodies.push(body);
        return jsonResponse({ conversation: conversation({ id: body.conversationId, projectId: 'pkg_new' }), built: true,
          project: { package: { id: 'pkg_new' }, revision: 1 } });
      },
    });
    await chat.ready;
    host.querySelector('#project-new').dispatchEvent({ type: 'click', bubbles: true });
    await chat.send('Make a new film.', 'plan');
    assert.equal(bodies[0].adoptPackageId, undefined);
    assert.equal(bodies[0].expectedPackageId, undefined);
    assert.equal(chat.conversation.projectId, 'pkg_new');
    assert.equal(localStorage.getItem('comfyrizz.project-chat:pkg_old'), 'chat_old');
    chat.destroy();
  } finally { dom.restore(); }
});

test('the host can advance the bound package revision while a stale package selection is ignored', async () => {
  const dom = installDom();
  try {
    let live = { packageId: 'pkg_selected', revision: 22 };
    const sent = [];
    const chat = create(dom.doc.createElement('div'), {
      getEditContext: () => live,
      apiFetch: async (_url, init = {}) => {
        if (init.method === 'POST') {
          sent.push(JSON.parse(init.body));
          return jsonResponse({ conversation: conversation({ projectId: 'pkg_selected', revision: 4 }), built: false });
        }
        return jsonResponse({ conversation: conversation({ id: 'chat_selected', projectId: 'pkg_selected' }), built: false });
      },
    });
    await chat.setProjectContext({ packageId: 'pkg_selected', revision: 22, conversationId: 'chat_selected' });
    live = { packageId: 'pkg_selected', revision: 25 };
    await chat.send('Use revision 25.', 'plan');
    assert.equal(sent[0].expectedPackageRevision, 25);
    live = { packageId: 'pkg_stale_other', revision: 99 };
    await chat.send('Stay on the selected package.', 'plan');
    assert.equal(sent[1].expectedPackageId, 'pkg_selected');
    assert.equal(sent[1].expectedPackageRevision, 25);
    chat.destroy();
  } finally { dom.restore(); }
});

test('gallery switching A to B to A reopens A chat and never creates a replacement conversation', async () => {
  const dom = installDom();
  try {
    const calls = [];
    let nextChat = 0;
    const chat = create(dom.doc.createElement('div'), {
      restoreSaved: false,
      apiFetch: async (url, init = {}) => {
        calls.push([url, init.method ?? 'GET']);
        if (init.method === 'POST') {
          nextChat += 1;
          const body = JSON.parse(init.body);
          return jsonResponse({ conversation: conversation({ id: body.conversationId, projectId: `pkg_${nextChat === 1 ? 'a' : 'b'}` }), built: false });
        }
        return jsonResponse({ conversation: conversation({ id: decodeURIComponent(String(url).split('/').at(-1)), projectId: 'pkg_a', messages: [{ role: 'user', content: 'A history' }] }), built: false });
      },
    });
    await chat.ready;
    await chat.setProjectContext({ packageId: 'pkg_a', revision: 1 });
    await chat.send('Start A.', 'plan');
    const chatA = chat.conversationId;
    await chat.setProjectContext({ packageId: 'pkg_b', revision: 1 });
    await chat.send('Start B.', 'plan');
    const chatB = chat.conversationId;
    assert.notEqual(chatA, chatB);
    calls.length = 0;
    await chat.setProjectContext({ packageId: 'pkg_a', revision: 4 });
    assert.equal(chat.conversationId, chatA);
    assert.deepEqual(calls, [[`/api/agent/chat/${chatA}`, 'GET']]);
    assert.equal(chat.conversation.messages[0].content, 'A history');
    chat.destroy();
  } finally { dom.restore(); }
});

test('reload refreshes only the current conversation and makes an earlier load ineligible', async () => {
  const dom = installDom();
  try {
    const releases = [], snapshots = [];
    const chat = create(dom.doc.createElement('div'), {
      initialConversationId: CHAT_ID,
      apiFetch: () => new Promise(resolve => releases.push(resolve)),
      onConversationChange: value => snapshots.push(value.revision),
    });
    await waitFor(() => releases.length === 1, 'initial load started');
    const initial = chat.ready;
    const refreshed = chat.reload();
    await waitFor(() => releases.length === 2, 'refresh started');
    assert.equal(chat.conversationId, CHAT_ID);
    releases[1](jsonResponse({ conversation: conversation({ id: CHAT_ID, revision: 8 }), built: false }));
    await refreshed;
    releases[0](jsonResponse({ conversation: conversation({ id: CHAT_ID, revision: 2 }), built: false }));
    await initial;
    assert.equal(chat.conversation.revision, 8);
    assert.deepEqual(snapshots, [8]);
    chat.destroy();
  } finally { dom.restore(); }
});
