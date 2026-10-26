// SE11: leaving Super Easy without losing the video.
//
// The URL builders and the fresh state are pure. The mount is checked against
// a tiny fake root, so no browser, network, player or server package is
// touched. node:test imports are runtime-only.
// @ts-nocheck
import test from 'node:test';
import assert from 'node:assert/strict';

import { defaultEasyState } from '../store.ts';
import {
  escapeToEditor,
  escapeToHome,
  escapeToStudio,
  isSuperEasyDone,
  makeAnotherState,
  renderSuperEasyDoneActions,
} from './escape.ts';
import { renderSuperEasyHome } from './home.ts';
import { mountSuperEasy } from './mount.ts';

function state(patch = {}) {
  return { ...defaultEasyState(), ...patch };
}

function fakeRoot() {
  const listeners = new Map();
  const prompt = {
    value: '',
    focused: false,
    focus() {
      this.focused = true;
    },
  };
  const root = {
    innerHTML: '',
    dataset: {},
    addEventListener(type, handler) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(handler);
    },
    removeEventListener(type, handler) {
      listeners.get(type)?.delete(handler);
    },
    querySelector(selector) {
      return selector === '#super-easy-prompt' ? prompt : null;
    },
    fire(type, event) {
      for (const handler of listeners.get(type) ?? []) handler(event);
    },
  };
  return { root, prompt };
}

function clickTarget(selector) {
  return {
    closest(candidate) {
      return candidate === selector ? { selector } : null;
    },
  };
}

function noop() {}

function doneSnapshot() {
  return { finalVideo: { status: 'done', url: 'https://example.test/final.mp4' } };
}

test('opening a package in Studio without run state keeps its id and falls back to Idea', () => {
  assert.equal(
    escapeToStudio('?package=pkg_123&view=editor&step=plan', 'pkg_123'),
    '?package=pkg_123&step=idea',
  );
  assert.equal(escapeToStudio('', 'pkg_123'), '?package=pkg_123&step=idea');
  assert.equal(
    escapeToStudio('?package=pkg_from_url&step=plan', null),
    '?package=pkg_from_url&step=idea',
    'the package already in the address is not dropped',
  );
  assert.equal(escapeToStudio('', null), '?step=idea');
});

test('opening the package in the editor keeps its id and asks for Editor', () => {
  assert.equal(
    escapeToEditor('?package=pkg_123&step=review', 'pkg_123'),
    '?package=pkg_123&view=editor',
  );
  assert.equal(escapeToEditor('', 'pkg_123'), '?package=pkg_123&view=editor');
  assert.equal(escapeToEditor('', null), '?view=editor');
});

test('Make another returns to a bare Super Easy address', () => {
  assert.equal(
    escapeToHome('?package=pkg_123&view=editor&step=export&chat=chat_1'),
    '',
  );
  assert.equal(escapeToHome('?package=pkg_123&from=shared'), '?from=shared');
});

test('Make another clears local state and leaves the server package alone', () => {
  const previous = state({
    packageId: 'pkg_123',
    chatId: 'chat_1',
    productionId: 'prod_0123456789abcdef01234567',
    idea: { ...defaultEasyState().idea, text: 'A friendly robot' },
    plan: { ...defaultEasyState().plan, status: 'ready' },
    generate: { status: 'done' },
  });

  const next = makeAnotherState();

  assert.deepEqual(next, defaultEasyState());
  assert.equal(next.packageId, null);
  assert.equal(next.chatId, null);
  assert.equal(next.productionId, null);
  assert.equal(next.generate.status, 'idle');
  assert.equal(next.plan.status, 'none');
  assert.equal(next.idea.text, '');
  assert.equal(previous.packageId, 'pkg_123', 'the old state is not mutated');
});

test('the home more-control link carries the package id', () => {
  const html = renderSuperEasyHome({ packageId: 'pkg_123' });
  const link = html.match(/<a\b[^>]*data-super-easy-more-control[^>]*>/u);
  assert.ok(link, 'the more-control link is present');
  assert.match(link[0], /href="\?package=pkg_123&amp;step=idea"/u);
  assert.equal((html.match(/data-super-easy-more-control/g) ?? []).length, 1);

  const plain = renderSuperEasyHome();
  assert.match(plain, /href="\?step=idea"/u);
});

test('the done actions put Download first and keep the editor escape secondary', () => {
  const html = renderSuperEasyDoneActions({
    finalUrl: 'https://example.test/final.mp4',
    packageId: 'pkg_123',
    search: '?package=pkg_123',
  });

  assert.match(html, /data-super-easy-done-actions/u);

  const download = html.match(/<a\b[^>]*data-super-easy-download[^>]*>([\s\S]*?)<\/a>/u);
  assert.ok(download, 'Download uses the existing final URL');
  assert.match(download[0], /href="https:\/\/example\.test\/final\.mp4"/u);
  assert.match(download[0], /class="[^"]*\bbtn-primary\b[^"]*"/u);
  assert.match(download[0], /\bdownload\b/u);
  assert.equal(download[1], 'Download');

  const studio = html.match(/<a\b[^>]*data-super-easy-open-studio[^>]*>([\s\S]*?)<\/a>/u);
  assert.ok(studio, 'Open in Studio is present');
  assert.match(studio[0], /href="\?package=pkg_123&amp;step=idea"/u);
  assert.equal(studio[1], 'Open in Studio');

  assert.match(html, /<button[^>]*data-super-easy-make-another[^>]*>Make another<\/button>/u);
  const editor = html.match(/<button\b[^>]*data-super-easy-open-editor[^>]*>([\s\S]*?)<\/button>/u);
  assert.ok(editor, 'Open in editor remains available');
  assert.match(editor[0], /class="[^"]*\bbtn-secondary\b[^"]*"/u);
  assert.equal(editor[1], 'Open in editor');

  assert.equal((html.match(/data-super-easy-download/g) ?? []).length, 1);
  assert.equal((html.match(/data-super-easy-open-studio/g) ?? []).length, 1);
  assert.equal((html.match(/data-super-easy-make-another/g) ?? []).length, 1);
  assert.equal((html.match(/data-super-easy-open-editor/g) ?? []).length, 1);
});

test('a done view without a usable final URL never shows a dead Download', () => {
  const html = renderSuperEasyDoneActions({ packageId: 'pkg_123' });
  assert.doesNotMatch(html, /data-super-easy-download/u);
  assert.match(html, /data-super-easy-open-studio/u);
  assert.match(html, /data-super-easy-make-another/u);
  assert.match(html, /data-super-easy-open-editor/u);
});

test('the done snapshot is recognised from the final video', () => {
  assert.equal(isSuperEasyDone(doneSnapshot()), true);
  assert.equal(isSuperEasyDone({ render: { status: 'running', fraction: 0.4 } }), false);
  assert.equal(isSuperEasyDone(null), false);
});

test('I want more control keeps the package in the address before the studio opens', () => {
  const { root } = fakeRoot();
  const navigated = [];
  const handed = [];
  const handle = mountSuperEasy({
    root,
    state: () => state({ packageId: 'pkg_123' }),
    navigate: (url) => {
      navigated.push(url);
    },
    onMoreControl: (packageId) => {
      handed.push(packageId);
    },
  });

  let prevented = false;
  root.fire('click', {
    target: clickTarget('[data-super-easy-more-control]'),
    preventDefault() {
      prevented = true;
    },
  });

  assert.equal(prevented, true);
  assert.equal(navigated.length, 1);
  assert.match(navigated[0], /[?&]package=pkg_123(?:&|$)/u);
  assert.deepEqual(handed, ['pkg_123']);
  handle.destroy();
});

test('Open in editor hands the package to Advanced', () => {
  const { root } = fakeRoot();
  const opened = [];
  const handle = mountSuperEasy({
    root,
    state: () => state({
      packageId: 'pkg_123',
      productionId: 'prod_0123456789abcdef01234567',
      generate: { status: 'done' },
    }),
    snapshot: () => doneSnapshot(),
    onMoreControl: noop,
    onOpenEditor: (packageId) => {
      opened.push(packageId);
    },
  });

  assert.match(root.innerHTML, /data-super-easy-open-editor/u);
  let prevented = false;
  root.fire('click', {
    target: clickTarget('[data-super-easy-open-editor]'),
    preventDefault() {
      prevented = true;
    },
  });

  assert.equal(prevented, true);
  assert.deepEqual(opened, ['pkg_123']);
  handle.destroy();
});

test('Open in Studio keeps the package before the studio opens', () => {
  const { root } = fakeRoot();
  const navigated = [];
  const handed = [];
  const handle = mountSuperEasy({
    root,
    state: () => state({
      packageId: 'pkg_123',
      productionId: 'prod_0123456789abcdef01234567',
      generate: { status: 'done' },
    }),
    snapshot: () => doneSnapshot(),
    navigate: (url) => {
      navigated.push(url);
    },
    onMoreControl: (packageId) => {
      handed.push(packageId);
    },
  });

  assert.match(root.innerHTML, /data-super-easy-open-studio/u);
  let prevented = false;
  root.fire('click', {
    target: clickTarget('[data-super-easy-open-studio]'),
    preventDefault() {
      prevented = true;
    },
  });

  assert.equal(prevented, true);
  assert.equal(navigated.length, 1);
  assert.match(navigated[0], /[?&]package=pkg_123(?:&|$)/u);
  assert.deepEqual(handed, ['pkg_123']);
  handle.destroy();
});

test('Make another clears to the Super Easy home without deleting anything', () => {
  const { root } = fakeRoot();
  let current = state({
    packageId: 'pkg_123',
    productionId: 'prod_0123456789abcdef01234567',
    generate: { status: 'done' },
  });
  const navigated = [];
  const fresh = [];
  const handle = mountSuperEasy({
    root,
    state: () => current,
    snapshot: () => doneSnapshot(),
    navigate: (url) => {
      navigated.push(url);
    },
    onMoreControl: noop,
    onMakeAnother: (next) => {
      fresh.push(next);
    },
  });

  assert.match(root.innerHTML, /data-super-easy-make-another/u);
  root.fire('click', {
    target: clickTarget('[data-super-easy-make-another]'),
    preventDefault() {},
  });

  assert.equal(fresh.length, 1);
  assert.equal(fresh[0].packageId, null);
  assert.equal(fresh[0].productionId, null);
  assert.deepEqual(navigated, ['']);
  assert.equal(root.dataset.superEasyView, 'home');
  assert.match(root.innerHTML, /data-super-easy-home/u);
  assert.doesNotMatch(root.innerHTML, /data-super-easy-progress/u);
  assert.match(root.innerHTML, /data-super-easy-form/u);
  handle.destroy();
});

test('a run that is not done does not offer Make another', () => {
  const { root } = fakeRoot();
  const handle = mountSuperEasy({
    root,
    state: () => state({
      packageId: 'pkg_123',
      productionId: 'prod_0123456789abcdef01234567',
      generate: { status: 'running' },
    }),
    snapshot: () => ({ render: { status: 'running', fraction: 0.4 } }),
    onMoreControl: noop,
  });

  assert.doesNotMatch(root.innerHTML, /data-super-easy-make-another/u);
  handle.destroy();
});

test('escape code never mentions Google Colab without its first word', () => {
  const done = renderSuperEasyDoneActions();
  for (const match of done.matchAll(/Colab/g)) {
    assert.ok(done.slice(0, match.index).endsWith('Google '));
  }
});

test('escaping with a mid-plan package opens Plan instead of Idea', () => {
  const current = state({
    packageId: 'pkg_123',
    productionId: 'prod_0123456789abcdef01234567',
    idea: { ...defaultEasyState().idea, text: 'A friendly robot learns to skate' },
    plan: { ...defaultEasyState().plan, status: 'writing' },
  });

  assert.equal(
    escapeToStudio('?package=pkg_123&step=idea', 'pkg_123', current),
    '?package=pkg_123&step=plan',
  );

  const resumed = state({
    packageId: 'pkg_123',
    productionId: 'prod_0123456789abcdef01234567',
    plan: { ...defaultEasyState().plan, status: 'writing' },
  });
  assert.equal(
    escapeToStudio('?step=idea', 'pkg_123', resumed),
    '?package=pkg_123&step=plan',
    'a short or empty local prompt does not send a packaged video back to Idea',
  );
});

test('escaping after a finished generation opens Review', () => {
  const current = state({
    packageId: 'pkg_123',
    productionId: 'prod_0123456789abcdef01234567',
    plan: { ...defaultEasyState().plan, status: 'ready' },
    generate: { status: 'done' },
  });

  assert.equal(
    escapeToStudio('?package=pkg_123&step=idea', 'pkg_123', current),
    '?package=pkg_123&step=review',
  );
});

test('escaping after an export opens Export', () => {
  const current = state({
    packageId: 'pkg_123',
    productionId: 'prod_0123456789abcdef01234567',
    plan: { ...defaultEasyState().plan, status: 'ready' },
    generate: { status: 'done' },
    exported: { revision: 4, at: '2026-10-26T15:00:00.000Z' },
  });

  assert.equal(
    escapeToStudio('?package=pkg_123&step=idea', 'pkg_123', current),
    '?package=pkg_123&step=export',
  );
});

test('escaping after a reload with an exported revision still opens Export', () => {
  const current = state({
    packageId: 'pkg_123',
    productionId: 'prod_0123456789abcdef01234567',
    plan: { ...defaultEasyState().plan, status: 'ready' },
    exported: { revision: 4, at: '2026-10-26T15:00:00.000Z' },
  });

  assert.equal(
    escapeToStudio('?package=pkg_123', 'pkg_123', current),
    '?package=pkg_123&step=export',
  );
});

test('escaping while generation runs opens Generate', () => {
  const current = state({
    packageId: 'pkg_123',
    productionId: 'prod_0123456789abcdef01234567',
    plan: { ...defaultEasyState().plan, status: 'ready' },
    generate: { status: 'running' },
  });

  assert.equal(
    escapeToStudio('?package=pkg_123&step=export', 'pkg_123', current),
    '?package=pkg_123&step=generate',
  );
});

test('escaping without a package stays on Idea even with a full idea', () => {
  const current = state({
    idea: { ...defaultEasyState().idea, text: 'A friendly robot learns to skate' },
    questions: [{ id: 'q1', field: 'tone', prompt: 'Tone?', options: ['warm'], decide: 'warm' }],
    questionsAsked: true,
  });

  assert.equal(escapeToStudio('?step=plan', null, current), '?step=idea');
});

test('caller-supplied facts drive the same derived escape', () => {
  const current = state({
    packageId: 'pkg_123',
    productionId: 'prod_0123456789abcdef01234567',
    plan: { ...defaultEasyState().plan, status: 'ready' },
    generate: { status: 'done' },
  });

  assert.equal(
    escapeToStudio('?package=pkg_123', 'pkg_123', current, {
      hasPackage: true,
      planApproved: true,
      actionsActive: false,
      allShotsKept: false,
      exportCurrent: false,
    }),
    '?package=pkg_123&step=review',
  );
});

test('the done Studio escape follows the finished package to Review', () => {
  const current = state({
    packageId: 'pkg_123',
    productionId: 'prod_0123456789abcdef01234567',
    plan: { ...defaultEasyState().plan, status: 'ready' },
    generate: { status: 'done' },
  });
  const html = renderSuperEasyDoneActions({
    finalUrl: 'https://example.test/final.mp4',
    packageId: 'pkg_123',
    search: '?package=pkg_123',
    state: current,
  });
  const studio = html.match(/<a\b[^>]*data-super-easy-open-studio[^>]*>/u);
  assert.ok(studio, 'Open in Studio is present');
  assert.match(studio[0], /href="\?package=pkg_123&amp;step=review"/u);
});
