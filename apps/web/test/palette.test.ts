// @ts-nocheck
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  filterPaletteCommands,
  isTypingTarget,
  mountPalette,
  renderPalette,
  shortcutSuppressed,
} from '../src/ui/palette.ts';
import {
  clearCommands,
  getCommands,
  registerCommand,
  resetCommands,
} from '../src/editor/commands.ts';

function fakeElement(tag = 'div', editable = false) {
  const element: any = {
    tagName: tag.toUpperCase(),
    isContentEditable: editable,
    attributes: {},
    dataset: {},
    classList: { toggle() {}, add() {}, remove() {} },
    setAttribute(name, value) { this.attributes[name] = String(value); },
    getAttribute(name) { return this.attributes[name] ?? null; },
    closest(selector) {
      if (selector === '[contenteditable="true"]' && editable) return this;
      return null;
    },
  };
  return element;
}

test('command palette defaults include every new command with its shortcut hint where defined', () => {
  resetCommands();
  const commands = getCommands();
  assert.ok(commands.length >= 10);
  const titles = commands.map(command => command.title ?? command.label ?? command.name);
  assert.ok(titles.includes('Toggle Easy / Advanced view'));
  assert.ok(titles.includes('Density: Compact'));
  assert.ok(titles.includes('Density: Comfortable'));
  assert.ok(titles.includes('Toggle left panel'));
  assert.ok(titles.includes('Toggle right panel'));
  assert.ok(titles.includes('Toggle timeline'));
  assert.ok(titles.includes('Review drawer'));
  assert.ok(titles.includes('Reset layout'));
  assert.ok(titles.includes('Inspector tab 1: Scene'));

  const html = renderPalette(commands);
  assert.match(html, /role="combobox"/);
  assert.match(html, /role="listbox"/);
  assert.match(html, /role="option"/);
  assert.match(html, /Ctrl\/Cmd\+Shift\+A/);
});

test('filtering keeps matching commands and drops non-matching ones', () => {
  resetCommands();
  const commands = getCommands();
  const filtered = filterPaletteCommands(commands, 'density');
  assert.ok(filtered.length >= 2);
  assert.ok(filtered.every(command => /density/i.test(`${command.id} ${command.title ?? ''} ${(command.keywords ?? []).join(' ')}`)));
  assert.equal(filterPaletteCommands(commands, 'zzzz-no-match').length, 0);
});

test('single-key shortcuts are inert while focus is in an input', () => {
  const input = fakeElement('input');
  const textarea = fakeElement('textarea');
  const editable = fakeElement('div', true);
  const button = fakeElement('button');

  assert.equal(isTypingTarget(input), true);
  assert.equal(isTypingTarget(textarea), true);
  assert.equal(isTypingTarget(editable), true);
  assert.equal(isTypingTarget(button), false);

  const event = { key: 'R', target: input, ctrlKey: false, metaKey: false, altKey: false };
  assert.equal(shortcutSuppressed(event as any), true);

  const ctrlEvent = { key: 'k', target: input, ctrlKey: true, metaKey: false, altKey: false };
  assert.equal(shortcutSuppressed(ctrlEvent as any), false);
});

test('commands can be registered and cleared without affecting the default reset', () => {
  clearCommands();
  assert.equal(getCommands().length, 0);

  registerCommand({ id: 'test.command', title: 'Test command', shortcut: 'T' });
  assert.equal(getCommands().length, 1);
  assert.equal(getCommands()[0].id, 'test.command');

  resetCommands();
  assert.ok(getCommands().length > 1);
  assert.ok(!getCommands().some(command => command.id === 'test.command'));
});

test('mounting creates an APG combobox and opens on Ctrl+K', () => {
  const previousDocument = globalThis.document;
  const previousWindow = globalThis.window;
  const listeners: any[] = [];
  const body: any = { appendChild(el) { this.children.push(el); }, children: [] };
  const head: any = { appendChild() {} };
  const doc: any = {
    body,
    head,
    documentElement: { dataset: {}, setAttribute() {} },
    createElement(tag) {
      const el: any = {
        tagName: tag.toUpperCase(),
        hidden: false,
        children: [],
        attributes: {},
        dataset: {},
        style: {},
        classList: { toggle() {}, add() {}, remove() {} },
        append(...nodes) { this.children.push(...nodes); },
        appendChild(node) { this.children.push(node); return node; },
        querySelector() { return null; },
        querySelectorAll() { return []; },
        remove() {},
        focus() {},
        setAttribute(name, value) { this.attributes[name] = String(value); },
        getAttribute(name) { return this.attributes[name] ?? null; },
        addEventListener() {},
        removeEventListener() {},
      };
      return el;
    },
    getElementById() { return null; },
    addEventListener(type, fn) { listeners.push({ type, fn }); },
    removeEventListener() {},
    activeElement: null,
  };
  const win: any = {
    addEventListener(type, fn) { listeners.push({ type, fn }); },
    removeEventListener() {},
    dispatchEvent() { return true; },
    requestAnimationFrame(cb) { cb(); },
  };
  globalThis.document = doc;
  globalThis.window = win;

  try {
    resetCommands();
    const handle = mountPalette({ document: doc, window: win, host: body });
    assert.ok(handle);
    assert.equal(typeof handle.open, 'function');
    const ctrlK = listeners.find(item => item.type === 'keydown');
    assert.ok(ctrlK);
    const event = {
      key: 'k',
      ctrlKey: true,
      metaKey: false,
      altKey: false,
      shiftKey: false,
      target: fakeElement('div'),
      preventDefault() {},
      stopPropagation() {},
    };
    ctrlK.fn(event);
    assert.equal(handle.isOpen(), true);
    handle.destroy();
  } finally {
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  }
});
