// @ts-nocheck
import test from 'node:test';
import assert from 'node:assert/strict';

import { createShellToastController, SHELL_TOAST_REGION_ID } from './toast.ts';

class FakeEvent {
  constructor(type, options = {}) {
    this.type = type;
    this.bubbles = options.bubbles ?? true;
    this.target = options.target ?? null;
    this.currentTarget = null;
    this.relatedTarget = options.relatedTarget ?? null;
    this.defaultPrevented = false;
  }
  preventDefault() {
    this.defaultPrevented = true;
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
    this.textContent = '';
    this.className = '';
  }
  get id() {
    return this.getAttribute('id') ?? '';
  }
  set id(value) {
    this.setAttribute('id', String(value));
  }
  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }
  getAttribute(name) {
    return this.attributes.has(name) ? this.attributes.get(name) : null;
  }
  removeAttribute(name) {
    this.attributes.delete(name);
  }
  append(...nodes) {
    for (const node of nodes) this.appendChild(node);
  }
  appendChild(node) {
    node.parentNode = this;
    this.children.push(node);
    return node;
  }
  remove() {
    if (!this.parentNode) return;
    const siblings = this.parentNode.children;
    const index = siblings.indexOf(this);
    if (index >= 0) siblings.splice(index, 1);
    this.parentNode = null;
  }
  addEventListener(type, listener) {
    const set = this.listeners.get(type) ?? new Set();
    set.add(listener);
    this.listeners.set(type, set);
  }
  removeEventListener(type, listener) {
    this.listeners.get(type)?.delete(listener);
  }
  dispatchEvent(event) {
    if (event.target === null) event.target = this;
    event.currentTarget = this;
    for (const listener of [...(this.listeners.get(event.type) ?? [])]) {
      listener.call(this, event);
    }
    if (event.bubbles && this.parentNode) this.parentNode.dispatchEvent(event);
    return !event.defaultPrevented;
  }
  click() {
    this.dispatchEvent(new FakeEvent('click'));
  }
  contains(node) {
    if (!node) return false;
    if (node === this) return true;
    return this.children.some(child => child.contains(node));
  }
}

class FakeDocument {
  constructor() {
    this.body = new FakeElement('body', this);
    this.elements = new Map();
  }
  createElement(tagName) {
    return new FakeElement(tagName, this);
  }
  getElementById(id) {
    return this.elements.get(id) ?? null;
  }
  register(element) {
    if (element.id) this.elements.set(element.id, element);
  }
}

class FakeClock {
  constructor() {
    this.time = 0;
    this.nextId = 1;
    this.timers = new Map();
  }
  now() {
    return this.time;
  }
  setTimeout(handler, ms) {
    const id = this.nextId++;
    this.timers.set(id, { at: this.time + Math.max(0, ms), handler });
    return id;
  }
  clearTimeout(id) {
    this.timers.delete(id);
  }
  advance(ms) {
    const end = this.time + ms;
    for (;;) {
      let next = null;
      for (const [id, timer] of this.timers) {
        if (timer.at <= end && (next === null || timer.at < next.timer.at)) {
          next = { id, timer };
        }
      }
      if (next === null) break;
      this.timers.delete(next.id);
      this.time = next.timer.at;
      next.timer.handler();
    }
    this.time = end;
  }
}

function makeController() {
  const document = new FakeDocument();
  const clock = new FakeClock();
  const controller = createShellToastController({ document, timer: clock, defaultDurationMs: 6000 });
  document.register(controller.region);
  return { controller, clock, document };
}

function find(element, attribute) {
  if (element.getAttribute(attribute) !== null) return element;
  for (const child of element.children) {
    const found = find(child, attribute);
    if (found) return found;
  }
  return null;
}

test('a focused toast action survives its former timeout and resumes afterwards', () => {
  const { controller, clock } = makeController();
  let retried = 0;
  const toast = controller.show({
    tone: 'danger',
    text: 'Export failed because the encoder stopped responding with a very long error.',
    action: { label: 'Retry export', onSelect: () => { retried += 1; } },
    durationMs: 6000,
  });

  clock.advance(1000);
  const action = find(toast.element, 'data-shell-toast-action');
  assert.ok(action, 'the toast exposes a real action button');
  action.dispatchEvent(new FakeEvent('focusin'));

  clock.advance(30000);
  assert.equal(toast.element.parentNode, controller.region, 'focus keeps the actionable toast alive past six seconds');
  assert.equal(action.getAttribute('aria-label') ?? action.textContent, 'Retry export');

  action.dispatchEvent(new FakeEvent('focusout', { relatedTarget: null }));
  clock.advance(4999);
  assert.equal(toast.element.parentNode, controller.region);
  clock.advance(1);
  assert.equal(toast.element.parentNode, null, 'the remaining lifetime ends after focus leaves');
  assert.equal(retried, 0);
});

test('pointer hover pauses a timed toast and leaving resumes the remaining time', () => {
  const { controller, clock } = makeController();
  const toast = controller.show({ text: 'Rendering preview', durationMs: 1000 });
  const message = find(toast.element, 'data-shell-toast-message');
  assert.equal(message.textContent, 'Rendering preview');

  clock.advance(500);
  toast.element.dispatchEvent(new FakeEvent('pointerenter', { bubbles: false }));
  clock.advance(5000);
  assert.equal(toast.element.parentNode, controller.region);

  toast.element.dispatchEvent(new FakeEvent('pointerleave', { bubbles: false }));
  clock.advance(499);
  assert.equal(toast.element.parentNode, controller.region);
  clock.advance(1);
  assert.equal(toast.element.parentNode, null);
});

test('actionable toasts persist until dismissed and run the action once', () => {
  const { controller, clock } = makeController();
  let retried = 0;
  const toast = controller.show({
    tone: 'warn',
    text: 'The last scene was reused.',
    action: { label: 'Try again', onSelect: () => { retried += 1; } },
  });

  clock.advance(60000);
  assert.equal(toast.element.parentNode, controller.region, 'an action toast does not expire on its own');
  const action = find(toast.element, 'data-shell-toast-action');
  action.click();
  assert.equal(retried, 1);
  assert.equal(toast.element.parentNode, null);
  action.click();
  assert.equal(retried, 1);
});

test('role and live-region semantics stay concise and truthful', () => {
  const { controller, clock } = makeController();
  assert.equal(controller.region.getAttribute('role'), 'region');
  assert.equal(controller.region.getAttribute('aria-live'), 'polite');
  assert.equal(controller.region.id, SHELL_TOAST_REGION_ID);

  const danger = controller.show({ tone: 'danger', text: 'Export failed.' });
  assert.equal(danger.element.getAttribute('role'), 'alert');
  assert.equal(danger.element.getAttribute('data-tone'), 'danger');
  const dismiss = find(danger.element, 'data-shell-toast-dismiss');
  assert.equal(dismiss.textContent, 'Dismiss');
  dismiss.click();
  assert.equal(danger.element.parentNode, null);

  const info = controller.show({ text: 'Saved.' });
  assert.equal(info.element.getAttribute('role'), 'status');
  clock.advance(6000);
  assert.equal(info.element.parentNode, null);
});

test('destroy clears timers and removes the region it created', () => {
  const { controller, clock } = makeController();
  controller.show({ text: 'Temporary', durationMs: 1000 });
  controller.destroy();
  assert.equal(controller.region.parentNode, null);
  controller.destroy();
  clock.advance(10000);
});
