// The web package typecheck has no @types/node; node:test imports are only
// for this file's runtime, so type checking is skipped here.
// @ts-nocheck
import test from 'node:test';
import assert from 'node:assert/strict';
import { renderThumb } from '../src/thumbs/thumb.ts';

// Minimal DOM harness for renderThumb. The renderer only creates elements,
// attributes, text and one click listener, so this stays deliberately small.
class FakeElement {
  constructor(tagName, ownerDocument, namespaceURI = null) {
    this.tagName = String(tagName).toUpperCase();
    this.ownerDocument = ownerDocument;
    this.namespaceURI = namespaceURI;
    this.parentNode = null;
    this.children = [];
    this.attributes = new Map();
    this.listeners = new Map();
    this.className = '';
    this.textContent = '';
    this.disabled = false;
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
    const key = String(name).toLowerCase();
    this.attributes.set(key, String(value));
    if (key === 'class') this.className = String(value);
    if (key === 'disabled') this.disabled = true;
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
    for (const node of nodes) this.appendChild(node);
  }

  replaceChildren(...nodes) {
    this.children = [];
    this.append(...nodes);
  }

  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(listener);
  }

  dispatchEvent(event = {}) {
    const payload = { target: this, ...event };
    for (const listener of this.listeners.get(payload.type) ?? []) listener.call(this, payload);
    return true;
  }
}

const fakeDocument = {
  createElement(tagName) {
    return new FakeElement(tagName, this);
  },
  createElementNS(namespaceURI, tagName) {
    return new FakeElement(tagName, this, namespaceURI);
  },
};

function host() {
  return new FakeElement('div', fakeDocument);
}

function descendants(root) {
  const found = [];
  const visit = node => {
    for (const child of node.children ?? []) {
      found.push(child);
      visit(child);
    }
  };
  visit(root);
  return found;
}

function byClass(root, name) {
  return descendants(root).filter(node => node.classList.contains(name));
}

function textOf(node) {
  return `${node.textContent ?? ''}${(node.children ?? []).map(textOf).join('')}`;
}

const READY = {
  status: 'ready',
  key: 'a'.repeat(64),
  ticketUrl: '/api/media/0123456789abcdef0123456789abcdef',
  width: 320,
  height: 180,
};

const OPTIONS = { alt: 'Take 1 poster', width: 160, height: 90 };

test('ready renders a lazy async image with explicit dimensions and the media ticket', () => {
  const target = host();
  renderThumb(target, READY, OPTIONS);

  assert.equal(target.getAttribute('data-thumb-state'), 'ready');
  const images = descendants(target).filter(node => node.tagName === 'IMG');
  assert.equal(images.length, 1);
  const image = images[0];
  assert.equal(image.getAttribute('src'), READY.ticketUrl);
  assert.equal(image.getAttribute('alt'), 'Take 1 poster');
  assert.equal(image.getAttribute('loading'), 'lazy');
  assert.equal(image.getAttribute('decoding'), 'async');
  assert.equal(image.getAttribute('width'), '160');
  assert.equal(image.getAttribute('height'), '90');
});

test('ready audio peaks render a labelled waveform instead of an image URL', () => {
  const target = host();
  renderThumb(target, { ...READY, peaks: [0, 0.25, 0.9, 0.4, 0] }, OPTIONS);

  assert.equal(target.getAttribute('data-thumb-state'), 'ready');
  const waveforms = byClass(target, 'thumb-waveform');
  assert.equal(waveforms.length, 1);
  const waveform = waveforms[0];
  assert.equal(waveform.getAttribute('role'), 'img');
  assert.equal(waveform.getAttribute('aria-label'), 'Take 1 poster');
  const lines = descendants(waveform).filter(node => node.tagName === 'POLYLINE');
  assert.equal(lines.length, 1);
  assert.match(lines[0].getAttribute('points'), /^0,50 /);
  assert.equal(descendants(target).filter(node => node.tagName === 'IMG').length, 0);
});

test('pending shows a glyph and Rendering… with no retry action', () => {
  const target = host();
  renderThumb(target, { status: 'pending' }, OPTIONS);

  assert.equal(target.getAttribute('data-thumb-state'), 'pending');
  assert.match(textOf(target), /Rendering…/);
  assert.equal(byClass(target, 'thumb-glyph').length, 1);
  assert.equal(descendants(target).filter(node => node.tagName === 'BUTTON').length, 0);
});

test('failed shows the label, reason copy and a Retry button that calls onRetry once', () => {
  const target = host();
  let retries = 0;
  renderThumb(
    target,
    { status: 'failed', reason: 'ffmpeg-unavailable' },
    { ...OPTIONS, onRetry: () => { retries += 1; } },
  );

  assert.equal(target.getAttribute('data-thumb-state'), 'failed');
  const text = textOf(target);
  assert.match(text, /Thumbnail unavailable/);
  assert.match(text, /ffmpeg is unavailable/i);
  assert.doesNotMatch(text, /ffmpeg-unavailable/);

  const buttons = descendants(target).filter(node => node.tagName === 'BUTTON');
  assert.equal(buttons.length, 1);
  assert.equal(buttons[0].getAttribute('type'), 'button');
  assert.equal(buttons[0].getAttribute('aria-label'), 'Retry thumbnail');
  assert.equal(buttons[0].disabled, false);
  assert.equal(textOf(buttons[0]), 'Retry');

  buttons[0].dispatchEvent({ type: 'click' });
  assert.equal(retries, 1);
  buttons[0].dispatchEvent({ type: 'click' });
  assert.equal(retries, 2);
});

test('failed keeps a readable reason and disables Retry when no handler is supplied', () => {
  const target = host();
  renderThumb(target, { status: 'failed', reason: 'network_error' }, OPTIONS);

  assert.match(textOf(target), /Thumbnail unavailable/);
  assert.match(textOf(target), /network error/);
  const buttons = descendants(target).filter(node => node.tagName === 'BUTTON');
  assert.equal(buttons.length, 1);
  assert.equal(buttons[0].disabled, true);
  assert.doesNotThrow(() => buttons[0].dispatchEvent({ type: 'click' }));
});

test('none renders the kind glyph and label plus the server reason', () => {
  const target = host();
  renderThumb(
    target,
    { status: 'none', reason: 'no source asset' },
    { ...OPTIONS, kind: 'waveform' },
  );

  assert.equal(target.getAttribute('data-thumb-state'), 'none');
  assert.equal(byClass(target, 'thumb-glyph').length, 1);
  assert.match(textOf(target), /No waveform/);
  assert.match(textOf(target), /no source asset/);
  assert.equal(descendants(target).filter(node => node.tagName === 'IMG').length, 0);
});

test('none without a kind falls back to the generic thumbnail label', () => {
  const target = host();
  renderThumb(target, { status: 'none', reason: 'none' }, OPTIONS);

  assert.equal(target.getAttribute('data-thumb-state'), 'none');
  assert.match(textOf(target), /No thumbnail/);
  assert.doesNotMatch(textOf(target), /\bnone\b/);
});

test('re-rendering replaces the previous state and content', () => {
  const target = host();
  renderThumb(target, { status: 'pending' }, OPTIONS);
  assert.equal(target.children.length, 1);

  renderThumb(target, READY, OPTIONS);
  assert.equal(target.getAttribute('data-thumb-state'), 'ready');
  assert.equal(target.children.length, 1);
  assert.equal(descendants(target).filter(node => node.tagName === 'IMG').length, 1);
  assert.doesNotMatch(textOf(target), /Rendering…/);
});
