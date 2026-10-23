// VX11 wiring: the voice card's controls go through the existing character API
// and production command route. Fakes only: no network, no Google Colab call.
// @ts-nocheck
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mountCharacterEditor } from '../src/characters/editor.ts';

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
    const parent = stack[stack.length - 1];
    parent.textContent += decodeEntities(value);
    if (parent.tagName === 'TEXTAREA') parent.value = parent.textContent;
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
    this.type = '';
    this.checked = false;
    this.disabled = false;
    this.hidden = false;
    this.files = null;
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
    if (key === 'type') this.type = String(value).toLowerCase();
    if (key === 'value') this.value = String(value);
    if (key === 'checked') this.checked = true;
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
  constructor(mode = 'easy') {
    this.listeners = new Map();
    this.documentElement = new FakeElement('html', this);
    this.documentElement.setAttribute('data-mode', mode);
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
}

function installFakeDom(mode = 'easy') {
  const previous = {
    document: globalThis.document,
    Element: globalThis.Element,
    HTMLElement: globalThis.HTMLElement,
    HTMLInputElement: globalThis.HTMLInputElement,
    HTMLSelectElement: globalThis.HTMLSelectElement,
    HTMLTextAreaElement: globalThis.HTMLTextAreaElement,
  };
  const doc = new FakeDocument(mode);
  globalThis.document = doc;
  globalThis.Element = FakeElement;
  globalThis.HTMLElement = FakeElement;
  globalThis.HTMLInputElement = FakeElement;
  globalThis.HTMLSelectElement = FakeElement;
  globalThis.HTMLTextAreaElement = FakeElement;
  return {
    doc,
    restore() {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete globalThis[key];
        else globalThis[key] = value;
      }
    },
  };
}

function character(voice = {}) {
  return {
    schema: 'comfyrizz.character/v1',
    id: 'chr_0123456789abcdef',
    revision: 2,
    name: 'Pip',
    handle: 'pip',
    role: 'mascot',
    kind: 'fictional',
    summary: 'Round, cheerful coffee-bean mascot',
    visual: {
      identityPrompt: 'small round coffee bean',
      negative: 'no human face',
      style: 'flat 3D',
      palette: [],
      wardrobe: [],
      expressions: [],
      images: [],
      sheet: { status: 'none' },
      seed: null,
      identity: { method: 'klein_ref' },
    },
    voice: {
      engine: 'kokoro',
      voice: 'am_michael',
      speed: 0.98,
      sampleLines: ['Morning! Fresh is best.'],
      ...voice,
    },
    bible: {
      personality: 'upbeat',
      mannerisms: [],
      catchphrases: [],
      speakingStyle: 'short sentences',
      do: [],
      dont: [],
      notes: '',
    },
    tags: [],
    createdAt: '2026-10-20T00:00:00.000Z',
    updatedAt: '2026-10-20T00:00:00.000Z',
  };
}

function fakeApi(initial) {
  let current = structuredClone(initial);
  const calls = [];
  const api = {
    update: async (id, patch) => {
      calls.push({ method: 'update', id, body: structuredClone(patch) });
      current = {
        ...current,
        ...structuredClone(patch),
        revision: current.revision + 1,
        visual: { ...current.visual, ...structuredClone(patch.visual ?? {}) },
        voice: { ...current.voice, ...structuredClone(patch.voice ?? {}) },
        bible: { ...current.bible, ...structuredClone(patch.bible ?? {}) },
      };
      return structuredClone(current);
    },
  };
  return { api, calls, get current() { return current; } };
}

function flush() {
  return new Promise(resolve => setTimeout(resolve, 0));
}

function fire(element, type, extra = {}) {
  element.dispatchEvent({ type, target: element, bubbles: true, ...extra });
}

test('the Easy toggle saves voice.h3Mode through the character API and re-renders Describe', async () => {
  const fake = fakeApi(character({ h3Mode: 'clip' }));
  const { doc, restore } = installFakeDom('easy');
  try {
    const root = doc.createElement('div');
    mountCharacterEditor(root, { api: fake.api, character: fake.current });

    const toggle = root.querySelector('[data-voice-mode-toggle]');
    assert.ok(toggle, 'the card renders the Easy toggle');
    toggle.checked = true;
    fire(toggle, 'change');
    await flush();

    const updates = fake.calls.filter(call => call.method === 'update');
    assert.equal(updates.length, 1);
    assert.deepEqual(updates[0].body, { voice: { h3Mode: 'prompt' } });
    assert.match(root.innerHTML, /data-voice-mode-prompt/);
    assert.match(root.innerHTML, /data-voice-mode-description/);
  } finally {
    restore();
  }
});

test('Suggest fills the Describe box without saving until the user saves', async () => {
  const fake = fakeApi(character({ h3Mode: 'prompt', voiceDescription: '' }));
  const suggestions = [];
  const { doc, restore } = installFakeDom('easy');
  try {
    const root = doc.createElement('div');
    mountCharacterEditor(root, {
      api: fake.api,
      character: fake.current,
      suggestVoiceDescription: async input => {
        suggestions.push(structuredClone(input));
        return { ok: true, status: 'proposed', applied: false, voiceDescription: 'Warm, low and unhurried.' };
      },
    });

    fire(root.querySelector('[data-action="voice-mode-suggest"]'), 'click');
    await flush();

    assert.equal(suggestions.length, 1);
    assert.equal(root.querySelector('[data-voice-mode-description]').value, 'Warm, low and unhurried.');
    assert.equal(fake.calls.length, 0, 'a suggestion is a draft, not a save');
    assert.equal(root.querySelector('[data-action="voice-mode-audition"]').disabled, false);
  } finally {
    restore();
  }
});

test('Audition saves the current description, sends one prompt audition, and shows busy then the result', async () => {
  const fake = fakeApi(character({ h3Mode: 'prompt', voiceDescription: 'Old description.' }));
  const requests = [];
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  fake.api.requestAudition = async request => {
    requests.push(structuredClone(request));
    await gate;
    return {
      ok: false,
      status: 409,
      code: 'AUDITION_PROMPT_PLANNED',
      message: 'Prompt voice audition planned.',
      voicePath: 'prompt',
    };
  };
  const { doc, restore } = installFakeDom('easy');
  try {
    const root = doc.createElement('div');
    mountCharacterEditor(root, { api: fake.api, character: fake.current });

    const description = root.querySelector('[data-voice-mode-description]');
    description.value = 'Warm, low and unhurried.';
    fire(description, 'input');
    assert.equal(root.querySelector('[data-action="voice-mode-audition"]').disabled, false);

    fire(root.querySelector('[data-action="voice-mode-audition"]'), 'click');
    await flush();

    const busy = root.querySelector('[data-action="voice-mode-audition"]');
    assert.equal(busy.disabled, true, 'the button is disabled while the audition runs');
    assert.match(root.innerHTML, /Auditioning/);
    assert.equal(requests.length, 1, 'exactly one audition request');

    release();
    await flush();
    await flush();

    const updates = fake.calls.filter(call => call.method === 'update');
    assert.equal(updates.length, 1);
    assert.deepEqual(updates[0].body, {
      voice: { h3Mode: 'prompt', voiceDescription: 'Warm, low and unhurried.' },
    });
    assert.equal(requests[0].characterId, 'chr_0123456789abcdef');
    assert.equal(requests[0].description, 'Warm, low and unhurried.');
    assert.match(root.innerHTML, /AUDITION_PROMPT_PLANNED/);
  } finally {
    restore();
  }
});

test('the seed pin and production override save through their existing APIs', async () => {
  const fake = fakeApi(character({ h3Mode: 'prompt', voiceDescription: 'Calm and precise.' }));
  const commands = [];
  const { doc, restore } = installFakeDom('advanced');
  try {
    const root = doc.createElement('div');
    mountCharacterEditor(root, {
      api: fake.api,
      character: fake.current,
      production: { id: 'prod_0123456789abcdef01234567', revision: 4, h3VoiceMode: null },
      sendCommand: async envelope => {
        commands.push(structuredClone(envelope));
        return { revision: 5 };
      },
    });

    const seed = root.querySelector('[data-voice-mode-seed]');
    seed.value = '42';
    fire(seed, 'change');
    await flush();
    assert.deepEqual(fake.calls.at(-1).body, { voice: { seed: 42 } });

    const override = root.querySelector('[data-voice-production-override]');
    override.value = 'prompt';
    fire(override, 'change');
    await flush();
    assert.equal(commands.length, 1);
    assert.equal(commands[0].kind, 'voice_mode.set');
    assert.equal(commands[0].productionId, 'prod_0123456789abcdef01234567');
    assert.deepEqual(commands[0].payload, { h3VoiceMode: 'prompt' });
  } finally {
    restore();
  }
});

test('Advanced is marked data-adv so Easy mode hides it and the local CSS lays it out as a compact grid', () => {
  const fake = fakeApi(character({ h3Mode: 'prompt', voiceDescription: 'Calm and precise.' }));
  const { doc, restore } = installFakeDom('easy');
  try {
    const root = doc.createElement('div');
    mountCharacterEditor(root, { api: fake.api, character: fake.current });

    const advancedTag = /<div[^>]*data-voice-mode-advanced[^>]*>/.exec(root.innerHTML)?.[0] ?? '';
    assert.ok(advancedTag, 'the Advanced block is rendered for the editor');
    assert.match(advancedTag, /\bdata-adv\b/);

    const components = readFileSync(new URL('../src/ui/components.css', import.meta.url), 'utf8');
    assert.match(components, /html\[data-mode=["']easy["']\]\s*\[data-adv\]\s*\{[\s\S]*?display:\s*none/);

    const css = readFileSync(new URL('../src/characters/characters.css', import.meta.url), 'utf8');
    assert.match(css, /\.chr-voice-mode-advanced\s*\{[\s\S]*?display:\s*grid/);
    assert.match(css, /\.chr-voice-mode-advanced\s*\{[\s\S]*?gap:\s*var\(--space-2\)/);
  } finally {
    restore();
  }
});
