// @ts-nocheck
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { toast } from '../src/ui/toast.ts';

function makeElement(tag) {
  const element = {
    tagName: String(tag).toUpperCase(),
    children: [],
    attributes: {},
    dataset: {},
    className: '',
    textContent: '',
    type: '',
    hidden: false,
    parent: null,
    append(...kids) {
      for (const kid of kids) {
        kid.parent = this;
        this.children.push(kid);
      }
    },
    remove() {
      if (!this.parent) return;
      this.parent.children = this.parent.children.filter(child => child !== this);
      this.parent = null;
    },
    setAttribute(name, value) { this.attributes[name] = String(value); },
    getAttribute(name) { return this.attributes[name] ?? null; },
    addEventListener() {},
  };
  return element;
}

function installDocument() {
  const previous = globalThis.document;
  const body = makeElement('body');
  const head = makeElement('head');
  const doc = {
    body,
    head,
    getElementById(id) {
      const visit = (node) => {
        if (node.attributes.id === id) return node;
        for (const child of node.children) {
          const found = visit(child);
          if (found) return found;
        }
        return null;
      };
      return visit(body);
    },
    createElement: makeElement,
  };
  globalThis.document = doc;
  return () => {
    if (previous === undefined) delete globalThis.document;
    else globalThis.document = previous;
  };
}

test('toasts render in a status region, with danger toasts in an alert', () => {
  const restore = installDocument();
  try {
    toast({ tone: 'info', text: 'Export finished.' });
    const region = document.getElementById('toast-region');
    assert.equal(region.getAttribute('role'), 'status');
    const info = region.children.find(child => child.getAttribute('role') === 'status');
    assert.ok(info);
    assert.match(info.textContent, /Export finished/);

    toast({ tone: 'danger', text: 'Run refused.' });
    const alert = region.children.find(child => child.getAttribute('role') === 'alert');
    assert.ok(alert);
    assert.match(alert.textContent, /Run refused/);
  } finally {
    restore();
  }
});

test('danger toasts do not auto-dismiss', () => {
  const restore = installDocument();
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    toast({ tone: 'danger', text: 'Export failed.' });
    toast({ tone: 'ok', text: 'Export finished.' });
    const region = document.getElementById('toast-region');
    assert.equal(region.children.length, 2);
    mock.timers.tick(6000);
    const roles = region.children.map(child => child.getAttribute('role'));
    assert.deepEqual(roles, ['alert']);
    assert.match(region.children[0].textContent, /Export failed/);
  } finally {
    mock.timers.reset();
    restore();
  }
});
