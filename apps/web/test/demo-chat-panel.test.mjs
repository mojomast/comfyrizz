import assert from 'node:assert/strict';
import test from 'node:test';
import { mountChat, renderChat, renderMarkdown } from '../src/demo/chat-panel.mjs';

const decodeEntities = value => value
  .replace(/&lt;/g, '<')
  .replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"')
  .replace(/&#39;/g, "'")
  .replace(/&amp;/g, '&');

const classListOf = element => String(element.className ?? '').split(/\s+/).filter(Boolean);

const matches = (element, selector) => {
  if (selector.startsWith('.')) return classListOf(element).includes(selector.slice(1));
  if (selector.startsWith('#')) return element.getAttribute('id') === selector.slice(1);
  const attribute = /^\[([\w-]+)(?:="([^"]*)")?\]$/.exec(selector);
  if (attribute) {
    const value = element.getAttribute(attribute[1]);
    return attribute[2] === undefined ? value !== null : value === attribute[2];
  }
  return element.tagName.toLowerCase() === selector.toLowerCase();
};

class FakeElement {
  constructor(tagName, ownerDocument) {
    this.tagName = tagName.toUpperCase();
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
    this.focused = false;
  }

  get className() {
    return this._classes.join(' ');
  }

  set className(value) {
    this._classes = String(value ?? '').split(/\s+/).filter(Boolean);
  }

  get classList() {
    return {
      contains: name => this._classes.includes(name),
      add: name => {
        if (!this._classes.includes(name)) this._classes.push(name);
      },
      remove: name => {
        this._classes = this._classes.filter(value => value !== name);
      },
    };
  }

  setAttribute(name, value) {
    const key = String(name).toLowerCase();
    const text = String(value);
    this.attributes.set(key, text);
    if (key === 'class') this.className = text;
    if (key === 'disabled') this.disabled = true;
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

  dispatchEvent(event) {
    const payload = event ?? {};
    payload.target ??= this;
    payload.bubbles ??= true;
    payload.defaultPrevented = false;
    payload.preventDefault ??= () => {
      payload.defaultPrevented = true;
    };

    let node = this;
    while (node) {
      payload.currentTarget = node;
      for (const listener of node.listeners.get(payload.type) ?? []) {
        listener.call(node, payload);
      }
      if (!payload.bubbles) break;
      node = node.parentNode;
    }

    return !payload.defaultPrevented;
  }

  matches(selector) {
    return matches(this, selector);
  }

  closest(selector) {
    let node = this;
    while (node) {
      if (matches(node, selector)) return node;
      node = node.parentNode;
    }
    return null;
  }

  querySelectorAll(selector) {
    const found = [];
    const walk = node => {
      for (const child of node.children) {
        if (matches(child, selector)) found.push(child);
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
    this.focused = true;
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

const VOID_TAGS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
const ATTRIBUTE = /([a-zA-Z_:][-\w:.]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;

const parseAttributes = (element, source) => {
  ATTRIBUTE.lastIndex = 0;
  let match;
  while ((match = ATTRIBUTE.exec(source ?? '')) !== null) {
    const value = match[2] ?? match[3] ?? match[4] ?? '';
    element.setAttribute(match[1], decodeEntities(value));
  }
};

const parseHtml = (root, html, ownerDocument) => {
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
      if (!VOID_TAGS.has(token[1].toLowerCase()) && !value.endsWith('/>')) {
        stack.push(element);
      }
      continue;
    }

    stack[stack.length - 1].textContent += decodeEntities(value);
  }
};

class FakeDocument {
  createElement(tagName) {
    return new FakeElement(tagName, this);
  }
}

const createRoot = () => new FakeDocument().createElement('div');

test('message text and attributes are escaped against XSS', () => {
  const payload = '<script>alert("x")</script><img src=x onerror="alert(1)">';
  const html = renderChat([{ role: 'user', text: payload }], {
    modelLabel: 'gpt<&" onmouseover="alert(1)',
  });

  assert.ok(!html.includes('<script>'));
  assert.ok(!html.includes('<img'));
  assert.match(html, /&lt;script&gt;alert\(&quot;x&quot;\)&lt;\/script&gt;/);
  assert.match(html, /&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;/);
  assert.ok(!/onmouseover="alert/.test(html));
  assert.match(html, /gpt&lt;&amp;&quot; onmouseover=&quot;alert\(1\) - any OpenAI-compatible model works/);
});

test('markdown subset renders paragraphs, bold, code and dash lists after escaping', () => {
  const html = renderChat([{
    role: 'assistant',
    text: 'Hello **world** and `npm test`.\n\n- first\n- **second**\n\nAnother <b>paragraph</b>.',
  }], { modelLabel: 'gpt-4o-mini' });

  assert.match(html, /<p>Hello <strong>world<\/strong> and <code>npm test<\/code>\.<\/p>/);
  assert.match(html, /<ul><li>first<\/li><li><strong>second<\/strong><\/li><\/ul>/);
  assert.match(html, /<p>Another &lt;b&gt;paragraph&lt;\/b&gt;\.<\/p>/);
  assert.ok(!html.includes('<b>'));
  assert.equal(renderMarkdown('`**literal**`'), '<p><code>**literal**</code></p>');
  assert.equal(renderMarkdown('**<b>safe</b>**'), '<p><strong>&lt;b&gt;safe&lt;/b&gt;</strong></p>');
});

test('model badge is exact and role classes are applied', () => {
  const html = renderChat([
    { role: 'user', text: 'hi' },
    { role: 'assistant', text: 'hello' },
  ], { modelLabel: 'gpt-4o-mini' });

  assert.ok(html.includes('<span class="chat-model-badge">gpt-4o-mini - any OpenAI-compatible model works</span>'));
  assert.match(html, /<li class="chat-message chat-message--user" data-role="user">/);
  assert.match(html, /<li class="chat-message chat-message--assistant" data-role="assistant">/);
  assert.match(renderChat([]), /model - any OpenAI-compatible model works/);
});

test('pending renders the indicator and disables the composer', () => {
  const html = renderChat([{ role: 'user', text: 'hi' }], { modelLabel: 'm', pending: true });

  assert.match(html, /<div class="chat-pending" role="status" aria-live="polite">/);
  assert.match(html, /Thinking/);
  assert.match(html, /<textarea[^>]*disabled>/);
  assert.match(html, /<button class="chat-send" type="submit" disabled>Send<\/button>/);

  const idle = renderChat([], { modelLabel: 'm', pending: false });
  assert.ok(!idle.includes('chat-pending'));
  assert.ok(!/<textarea[^>]*disabled>/.test(idle));
});

test('mountChat sends trimmed text on Enter and ignores empty input', () => {
  const root = createRoot();
  const sent = [];
  mountChat(root, { onSend: text => sent.push(text) });

  const input = root.querySelector('.chat-input');
  assert.ok(input);
  assert.ok(root.querySelector('.chat-send'));

  input.value = '  a launch video  ';
  input.dispatchEvent({ type: 'keydown', key: 'Enter', shiftKey: false, bubbles: true });
  assert.deepEqual(sent, ['a launch video']);
  assert.equal(input.value, '');

  input.value = '   ';
  input.dispatchEvent({ type: 'keydown', key: 'Enter', shiftKey: false, bubbles: true });
  assert.deepEqual(sent, ['a launch video']);
});

test('Shift+Enter leaves a newline instead of sending and the button sends', () => {
  const root = createRoot();
  const sent = [];
  mountChat(root, { onSend: text => sent.push(text) });

  const input = root.querySelector('.chat-input');
  input.value = 'line one';
  const shiftEnter = { type: 'keydown', key: 'Enter', shiftKey: true, bubbles: true };
  input.dispatchEvent(shiftEnter);
  assert.deepEqual(sent, []);
  assert.equal(shiftEnter.defaultPrevented, false);

  root.querySelector('.chat-send').dispatchEvent({ type: 'click', bubbles: true });
  assert.deepEqual(sent, ['line one']);
});

test('mountChat disables the composer while a send is pending', async () => {
  const root = createRoot();
  let resolveSend;
  const pendingSend = new Promise(resolve => {
    resolveSend = resolve;
  });
  const panel = mountChat(root, { onSend: () => pendingSend });

  const input = root.querySelector('.chat-input');
  input.value = 'slow request';
  input.dispatchEvent({ type: 'keydown', key: 'Enter', shiftKey: false, bubbles: true });

  assert.equal(panel.pending, true);
  assert.equal(root.querySelector('.chat-input').disabled, true);
  assert.equal(root.querySelector('.chat-send').disabled, true);
  assert.match(root.innerHTML, /chat-pending/);

  root.querySelector('.chat-input').value = 'blocked';
  root.querySelector('.chat-input').dispatchEvent({
    type: 'keydown',
    key: 'Enter',
    shiftKey: false,
    bubbles: true,
  });

  resolveSend();
  await pendingSend;
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(panel.pending, false);
  assert.equal(root.querySelector('.chat-input').disabled, false);
  assert.ok(!root.innerHTML.includes('chat-pending'));
});

test('setPending blocks sending and update re-renders messages', () => {
  const root = createRoot();
  const sent = [];
  const panel = mountChat(root, { onSend: text => sent.push(text) });

  panel.setPending(true);
  const input = root.querySelector('.chat-input');
  assert.equal(input.disabled, true);
  input.value = 'nope';
  input.dispatchEvent({ type: 'keydown', key: 'Enter', shiftKey: false, bubbles: true });
  assert.deepEqual(sent, []);

  panel.setPending(false);
  panel.update({ messages: [{ role: 'assistant', text: '**ready**' }], modelLabel: 'm2' });

  assert.match(root.innerHTML, /<strong>ready<\/strong>/);
  assert.ok(root.innerHTML.includes('m2 - any OpenAI-compatible model works'));
  assert.match(root.innerHTML, /chat-message--assistant/);
});
