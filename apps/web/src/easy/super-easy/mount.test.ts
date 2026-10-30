// SE07: first paint and in-place navigation for Super Easy.
//
// The mount is tested against a tiny fake root: no browser, no network and no
// player. The Easy delegation is checked from its source because that module
// imports CSS, which node:test cannot load. node:test imports are runtime-only.
// @ts-nocheck
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { defaultEasyState } from '../store.ts';
import { SUPER_EASY_EXAMPLE_PROMPT, mountSuperEasy, superEasyScreen } from './mount.ts';
import { ideaPrompt } from '../idea-prompt.ts';

const EASY_MOUNT = fileURLToPath(new URL('../mount.ts', import.meta.url));
const SUPER_EASY_MOUNT = fileURLToPath(new URL('./mount.ts', import.meta.url));

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
    listeners,
    addEventListener(type, handler) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(handler);
    },
    removeEventListener(type, handler) {
      listeners.get(type)?.delete(handler);
    },
    querySelector(selector) {
      if (selector === '#super-easy-prompt') return prompt;
      if (selector === '[data-super-easy-home]') return root.innerHTML.includes('data-super-easy-home') ? {} : null;
      return null;
    },
    fire(type, event) {
      for (const handler of listeners.get(type) ?? []) handler(event);
    },
  };
  return { root, prompt };
}

function karaokeRoot(initial = {}) {
  const base = fakeRoot();
  const attributes = new Map();
  const style = { value: initial.lyricsStyle ?? 'off' };
  const lrc = {
    value: initial.lyricsLrc ?? '',
    focused: false,
    focus() { this.focused = true; },
    setAttribute(name, value) { attributes.set(name, String(value)); },
    removeAttribute(name) { attributes.delete(name); },
    getAttribute(name) { return attributes.has(name) ? attributes.get(name) : null; },
  };
  const error = { hidden: true, textContent: '' };
  const group = { hidden: false };
  const query = base.root.querySelector;
  base.root.querySelector = selector => ({
    '[data-super-easy-lyrics-style]': style,
    '[data-super-easy-lyrics-lrc]': lrc,
    '[data-super-easy-lyrics-error]': error,
    '[data-super-easy-lyrics]': group,
  })[selector] ?? query(selector);
  return { ...base, style, lrc, error, group };
}

function clickTarget(selector) {
  return {
    closest(candidate) {
      return candidate === selector ? { selector } : null;
    },
  };
}

function submitTarget() {
  return clickTarget('[data-super-easy-form]');
}

test('Music Video layout selection updates the shared planner aspect', () => {
  const { root } = fakeRoot();
  let current = state({ videoType: 'music-video' });
  const handle = mountSuperEasy({ root, state: () => current, onMoreControl() {}, onAspectChange(aspect) { current = { ...current, idea: { ...current.idea, aspect } }; } });
  assert.match(root.innerHTML, /data-super-easy-music-aspect/);
  root.fire('change', { target: { ...clickTarget('[data-super-easy-music-aspect]'), value: '9:16' } });
  assert.equal(current.idea.aspect, '9:16');
  assert.match(ideaPrompt(current), /Aspect: 9:16\./);
  handle.render({ forceHome: true });
  assert.match(root.innerHTML, /value="9:16" selected/);
  handle.destroy();
});

test('DeepSeek non-thinking selection reaches Generate', () => {
  const { root, prompt } = fakeRoot();
  let generated;
  const handle = mountSuperEasy({ root, state: () => state(), onMoreControl() {}, onGenerate(input) { generated = input; } });
  prompt.value = 'A sufficiently long video brief';
  const target = { ...clickTarget('[data-super-easy-deepseek-no-thinking]'), checked: true };
  root.fire('change', { target });
  root.fire('submit', { target: submitTarget(), preventDefault() {} });
  assert.equal(generated.deepSeekNoThinking, true);
  handle.destroy();
});

test('a fresh video opens the Super Easy home and an existing run opens progress', () => {
  assert.equal(superEasyScreen(state()), 'home');
  assert.equal(superEasyScreen(state({ generate: { status: 'running' } })), 'progress');
  assert.equal(superEasyScreen(state({ productionId: 'prod_0123456789abcdef01234567' })), 'progress');
});

test('first paint is the Super Easy home, never the Easy studio or its player slot', () => {
  const { root } = fakeRoot();
  const handle = mountSuperEasy({
    root,
    state: () => state(),
    onMoreControl: () => {},
  });

  assert.equal(root.dataset.superEasyView, 'home');
  assert.match(root.innerHTML, /data-super-easy-home/u);
  assert.match(root.innerHTML, /data-super-easy-form/u);
  assert.doesNotMatch(root.innerHTML, /data-super-easy-progress/u);
  assert.doesNotMatch(root.innerHTML, /data-easy-shell/u);
  assert.doesNotMatch(root.innerHTML, /data-easy-player/u);

  handle.destroy();
});

test('background home updates preserve the active prompt and only setup forces a repaint', () => {
  const { root, prompt } = fakeRoot();
  let setup = { compute: 'cpu', spendCap: 10, confirmed: false };
  const handle = mountSuperEasy({
    root,
    state: () => state(),
    onMoreControl: () => {},
    setup: () => setup,
  });
  const initial = root.innerHTML;
  prompt.value = 'A skater learns to fall safely';
  root.fire('input', {
    target: {
      value: prompt.value,
      closest: selector => (selector === '#super-easy-prompt' ? prompt : null),
    },
  });

  handle.render();
  assert.equal(root.innerHTML, initial, 'a background update must not replace the focused textarea');

  setup = { compute: 'colab', spendCap: 12, confirmed: true };
  handle.render({ forceHome: true });
  assert.notEqual(root.innerHTML, initial, 'an explicit setup change can repaint');
  assert.match(root.innerHTML, /A skater learns to fall safely/u, 'the typed prompt survives the setup repaint');
  handle.destroy();
});

test('I want more control hands off to the studio instead of navigating the page', () => {
  const { root } = fakeRoot();
  let handedOff = 0;
  const handle = mountSuperEasy({
    root,
    state: () => state(),
    onMoreControl: () => {
      handedOff += 1;
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
  assert.equal(handedOff, 1);
  handle.destroy();
});

test('Try an example fills the one prompt and keeps the happy path local', () => {
  const { root, prompt } = fakeRoot();
  let handedOff = 0;
  const handle = mountSuperEasy({
    root,
    state: () => state(),
    onMoreControl: () => {
      handedOff += 1;
    },
  });

  root.fire('click', {
    target: clickTarget('[data-super-easy-example]'),
    preventDefault() {},
  });

  assert.equal(prompt.value, SUPER_EASY_EXAMPLE_PROMPT);
  assert.equal(prompt.focused, true);
  assert.equal(handedOff, 0);
  handle.destroy();
});

test('Generate sends the trimmed prompt to This computer and never to Google Colab', () => {
  const { root, prompt } = fakeRoot();
  const calls = [];
  const handle = mountSuperEasy({
    root,
    state: () => state(),
    onMoreControl: () => {},
    onGenerate: (input) => {
      calls.push(input);
    },
  });

  prompt.value = '  A friendly robot who learns to bake bread  ';
  let prevented = false;
  root.fire('submit', {
    target: submitTarget(),
    preventDefault() {
      prevented = true;
    },
  });

  assert.equal(prevented, true);
  assert.deepEqual(calls, [{ prompt: 'A friendly robot who learns to bake bread', compute: 'cpu', lengthS: 30, motionModel: 'auto' }]);
  handle.destroy();
});

test('video-type cards change guidance without clobbering the prompt or starting Generate', () => {
  const { root, prompt } = fakeRoot();
  const hint = { textContent: '' };
  const query = root.querySelector;
  root.querySelector = selector => selector === '[data-super-easy-prompt-hint]' ? hint : query(selector);
  const selected = [];
  const generated = [];
  const handle = mountSuperEasy({
    root,
    state: () => state(),
    onMoreControl: () => {},
    onVideoTypeChange: type => selected.push(type),
    onGenerate: input => generated.push(input),
  });
  prompt.value = 'Keep every word I typed';
  root.fire('change', {
    target: {
      value: 'motion-explainer',
      checked: true,
      closest: selector => selector === '[data-super-easy-video-type]' ? {} : null,
    },
  });
  assert.equal(prompt.value, 'Keep every word I typed');
  assert.match(prompt.placeholder, /heat pump/u);
  assert.match(hint.textContent, /process or mechanism/u);
  assert.deepEqual(selected, ['motion-explainer']);
  assert.deepEqual(generated, []);
  assert.match(root.innerHTML, /data-super-easy-home/u, 'selection does not repaint or navigate');
  handle.destroy();
});

test('file input and Add URL are the only mount actions that start attachment work', async () => {
  const { root } = fakeRoot();
  const url = { value: 'https://example.com/brief' };
  const query = root.querySelector;
  root.querySelector = selector => selector === '[data-super-easy-context-url]' ? url : query(selector);
  const calls = [];
  const attachments = {
    snapshot: () => ({ attachments: [], pending: [], message: '', messageError: false, attachmentSignature: null, attachmentRevision: 0 }),
    attachFiles: async files => { calls.push({ kind: 'files', files }); return true; },
    addUrl: async value => { calls.push({ kind: 'url', value }); return true; },
  };
  const generated = [];
  const handle = mountSuperEasy({ root, state: () => state(), onMoreControl: () => {}, attachments, onGenerate: input => generated.push(input) });
  assert.deepEqual(calls, [], 'painting the controls never attaches or fetches');

  const file = { name: 'brief.md', type: 'text/markdown', size: 20 };
  root.fire('change', {
    target: {
      files: [file],
      closest: selector => selector === '[data-super-easy-context-files]' ? {} : null,
    },
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls, [{ kind: 'files', files: [file] }]);

  root.fire('click', { target: clickTarget('[data-super-easy-context-add-url]'), preventDefault() {} });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls[1], { kind: 'url', value: 'https://example.com/brief' });
  assert.equal(url.value, '', 'only a successful explicit Add URL clears the input');
  assert.deepEqual(generated, []);
  handle.destroy();
});

test('Generate forwards selected type and attachment identity only when present', () => {
  const { root, prompt } = fakeRoot();
  const calls = [];
  const current = state({
    videoType: 'product-walkthrough',
    chatId: 'chat_context123',
    attachmentSignature: 'ctx_12345678_1',
    attachmentRevision: 4,
  });
  const handle = mountSuperEasy({
    root,
    state: () => current,
    onMoreControl: () => {},
    onGenerate: input => calls.push(input),
  });
  prompt.value = 'Walk through our travel camera and its flip screen';
  root.fire('submit', { target: submitTarget(), preventDefault() {} });
  assert.deepEqual(calls, [{
    prompt: prompt.value,
    compute: 'cpu',
    lengthS: 30,
    motionModel: 'auto',
    videoType: 'product-walkthrough',
    conversationId: 'chat_context123',
    attachmentSignature: 'ctx_12345678_1',
    attachmentRevision: 4,
  }]);
  handle.destroy();
});

test('duration changes persist to the shared idea and ride along with Generate', () => {
  const { root, prompt } = fakeRoot();
  const length = { value: '30' };
  const baseQuery = root.querySelector;
  root.querySelector = selector => selector === '[data-super-easy-length]:checked' ? length : baseQuery(selector);
  const changes = [];
  const calls = [];
  const handle = mountSuperEasy({
    root,
    state: () => state(),
    onMoreControl: () => {},
    onLengthChange: lengthS => changes.push(lengthS),
    onGenerate: input => calls.push(input),
  });

  length.value = '60';
  root.fire('change', {
    target: {
      value: length.value,
      closest: selector => selector === '[data-super-easy-length]' ? length : null,
    },
  });
  prompt.value = 'A friendly robot who learns to bake bread';
  root.fire('submit', { target: submitTarget(), preventDefault() {} });

  assert.deepEqual(changes, [60]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].lengthS, 60);
  handle.destroy();
});

test('custom duration is keyboard-editable, validated, persisted and sent to Generate', () => {
  const { root, prompt } = fakeRoot();
  const custom = { value: '', focus() { this.focused = true; }, setAttribute() {}, removeAttribute() {}, ...clickTarget('[data-super-easy-custom-length]') };
  const error = { hidden: true };
  const preset = { value: '30', checked: true };
  const query = root.querySelector;
  root.querySelector = selector => selector === '[data-super-easy-custom-length]' ? custom
    : selector === '[data-super-easy-length-error]' ? error
    : selector === '[data-super-easy-length]:checked' ? (preset.checked ? preset : null) : query(selector);
  const current = state();
  const generated = [];
  const handle = mountSuperEasy({ root, state: () => current, onMoreControl() {},
    onLengthChange(value) { current.idea.lengthS = value; }, onGenerate(input) { generated.push(input); } });
  prompt.value = 'A clear title reveal for the project';
  for (const value of ['', '0', '121', '120.5', '12.5']) {
    custom.value = value;
    root.fire('input', { target: custom });
    root.fire('submit', { target: submitTarget(), preventDefault() {} });
    assert.equal(error.hidden, false);
    assert.equal(generated.length, 0);
  }
  for (const value of ['12', '40', '91', '120']) {
    custom.value = value;
    root.fire('input', { target: custom });
    root.fire('submit', { target: submitTarget(), preventDefault() {} });
    assert.equal(error.hidden, true);
    assert.equal(current.idea.lengthS, Number(value));
    assert.equal(generated.at(-1).lengthS, Number(value));
  }
  handle.destroy();
});

test('Music Video trim edits persist locally, validate, and generate only on explicit submit', () => {
  const { root, prompt } = fakeRoot();
  const start = { value: '2.5', focus() {}, setAttribute() {}, removeAttribute() {} };
  const end = { value: '27', focus() {}, setAttribute() {}, removeAttribute() {} };
  const error = { hidden: true };
  const group = { hidden: false };
  const baseQuery = root.querySelector;
  root.querySelector = selector => ({
    '[data-super-easy-song-start]': start,
    '[data-super-easy-song-end]': end,
    '[data-super-easy-song-trim-error]': error,
    '[data-super-easy-song-trim]': group,
  })[selector] ?? baseQuery(selector);
  const trims = [];
  const generated = [];
  const attachmentCalls = [];
  const attachments = {
    snapshot: () => ({ attachments: [], pending: [], message: '', messageError: false, attachmentSignature: null, attachmentRevision: 0 }),
    attachFiles: async () => { attachmentCalls.push('upload'); return true; },
    addUrl: async () => { attachmentCalls.push('fetch'); return true; },
    reload: async () => { attachmentCalls.push('reload'); return true; },
  };
  const current = state({ videoType: 'music-video', songTrim: null });
  const handle = mountSuperEasy({
    root,
    state: () => current,
    onMoreControl: () => {},
    attachments,
    onSongTrimChange: trim => trims.push(trim),
    onGenerate: input => generated.push(input),
  });
  root.fire('input', {
    target: { value: start.value, closest: selector => selector === '[data-super-easy-song-start]' ? start : null },
  });
  assert.deepEqual(trims, [{ startSeconds: 2.5, endSeconds: 27 }]);
  assert.deepEqual(generated, []);
  assert.deepEqual(attachmentCalls, [], 'trim editing never uploads, fetches or reloads attachments');
  assert.equal(error.hidden, true);

  prompt.value = 'Create a bold video for our supplied song';
  root.fire('submit', { target: submitTarget(), preventDefault() {} });
  assert.deepEqual(generated, [{
    prompt: prompt.value,
    compute: 'cpu',
    lengthS: 30,
    motionModel: 'auto',
    videoType: 'music-video',
    songTrim: { startSeconds: 2.5, endSeconds: 27 },
  }]);

  end.value = '2';
  root.fire('input', {
    target: { value: end.value, closest: selector => selector === '[data-super-easy-song-end]' ? end : null },
  });
  assert.equal(error.hidden, false);
  root.fire('submit', { target: submitTarget(), preventDefault() {} });
  assert.equal(generated.length, 1, 'an invalid trim cannot start generation');
  assert.equal(trims.length, 1, 'invalid partial input does not overwrite the last valid persisted trim');
  handle.destroy();
});

test('Music Video Generate forwards exact valid standard and enhanced LRC without canonical cues', () => {
  const cases = [
    { lyricsStyle: 'caption', lyricsLrc: '[00:01.00]First exact line\r\n[00:03.50]Second exact line\n' },
    { lyricsStyle: 'reel', lyricsLrc: '[00:01.00]<00:01.00>Enhanced <00:01.50>word timing' },
  ];
  for (const item of cases) {
    const { root, prompt, style, lrc } = karaokeRoot(item);
    const generated = [];
    const drafts = [];
    const current = state({ videoType: 'music-video', ...item });
    const handle = mountSuperEasy({
      root,
      state: () => current,
      onMoreControl: () => {},
      onLyricsLrcChange: raw => drafts.push(raw),
      onGenerate: input => generated.push(input),
    });
    assert.equal(style.value, item.lyricsStyle);
    prompt.value = 'Create a bold video for our supplied song';
    lrc.value = item.lyricsLrc;
    root.fire('input', {
      target: { value: lrc.value, closest: selector => selector === '[data-super-easy-lyrics-lrc]' ? lrc : null },
    });
    root.fire('submit', { target: submitTarget(), preventDefault() {} });
    assert.equal(generated.length, 1);
    assert.equal(generated[0].lyricsStyle, item.lyricsStyle);
    assert.equal(generated[0].lyricsLrc, item.lyricsLrc);
    assert.deepEqual(drafts, [item.lyricsLrc]);
    assert.equal(Object.hasOwn(generated[0], 'lyrics'), false);
    assert.equal(Object.hasOwn(generated[0], 'cues'), false);
    handle.destroy();
  }
});

test('malformed and plain LRC show bounded line errors and block Generate even with Off, before setup or attachments', () => {
  for (const raw of ['[00:no]Malformed timestamp', 'Plain lyrics never acquire automatic timings', Array.from({ length: 9 }, (_, i) => `Plain line ${i + 1}`).join('\n')]) {
    const { root, prompt, lrc, error } = karaokeRoot({ lyricsStyle: 'off', lyricsLrc: raw });
    const generated = [];
    const attachmentCalls = [];
    let setupCalls = 0;
    const attachments = {
      snapshot: () => ({ attachments: [], pending: [], message: '', messageError: false, attachmentSignature: null, attachmentRevision: 0 }),
      attachFiles: async () => { attachmentCalls.push('upload'); return true; },
      addUrl: async () => { attachmentCalls.push('fetch'); return true; },
    };
    const current = state({ videoType: 'music-video', lyricsStyle: 'off', lyricsLrc: raw });
    const handle = mountSuperEasy({
      root,
      state: () => current,
      onMoreControl: () => {},
      attachments,
      setup: () => ({ compute: 'colab', spendCap: 10, confirmed: false }),
      onSetup: () => { setupCalls += 1; },
      onGenerate: input => generated.push(input),
    });
    prompt.value = 'Create a bold video for our supplied song';
    root.fire('submit', { target: submitTarget(), preventDefault() {} });
    assert.deepEqual(generated, []);
    assert.deepEqual(attachmentCalls, []);
    assert.equal(setupCalls, 0, 'validation precedes the setup dialog and every provider path');
    assert.equal(error.hidden, false);
    assert.match(error.textContent, /Line 1:/u);
    assert.ok(error.textContent.split('\n').length <= 7, 'at most six parser issues plus a bounded overflow note');
    assert.equal(lrc.focused, true);
    assert.equal(lrc.getAttribute('aria-invalid'), 'true');
    handle.destroy();
  }
});

test('empty Off is valid and lyric controls never leak into another preset or clobber prompt and attachments', () => {
  const { root, prompt, style, lrc } = karaokeRoot({ lyricsStyle: 'off', lyricsLrc: '' });
  const generated = [];
  const styles = [];
  const attachmentCalls = [];
  const attachments = {
    snapshot: () => ({ attachments: [], pending: [], message: '', messageError: false, attachmentSignature: null, attachmentRevision: 0 }),
    attachFiles: async () => { attachmentCalls.push('upload'); return true; },
    addUrl: async () => { attachmentCalls.push('fetch'); return true; },
  };
  const current = state({ videoType: 'music-video' });
  const handle = mountSuperEasy({
    root,
    state: () => current,
    onMoreControl: () => {},
    attachments,
    onLyricsStyleChange: value => styles.push(value),
    onGenerate: input => generated.push(input),
  });
  prompt.value = 'Keep every word and the current attachment focus';
  lrc.value = '';
  const before = root.innerHTML;
  style.value = 'caption';
  root.fire('change', {
    target: { value: 'caption', closest: selector => selector === '[data-super-easy-lyrics-style]' ? style : null },
  });
  assert.equal(root.innerHTML, before, 'style changes never repaint the prompt or attachment rows');
  assert.equal(prompt.value, 'Keep every word and the current attachment focus');
  assert.deepEqual(styles, ['caption']);
  assert.deepEqual(attachmentCalls, []);

  style.value = 'off';
  root.fire('change', {
    target: { value: 'off', closest: selector => selector === '[data-super-easy-lyrics-style]' ? style : null },
  });
  root.fire('submit', { target: submitTarget(), preventDefault() {} });
  assert.equal(generated.length, 1);
  assert.equal(Object.hasOwn(generated[0], 'lyricsStyle'), false);
  assert.equal(Object.hasOwn(generated[0], 'lyricsLrc'), false);
  assert.deepEqual(attachmentCalls, []);
  handle.destroy();
});

test('parking and remounting restores the lyric style and exact raw draft from shared state', () => {
  let current = state({ videoType: 'music-video' });
  const first = karaokeRoot();
  const initial = mountSuperEasy({
    root: first.root,
    state: () => current,
    onMoreControl: () => {},
    onLyricsStyleChange: lyricsStyle => { current = { ...current, lyricsStyle }; },
    onLyricsLrcChange: lyricsLrc => { current = { ...current, lyricsLrc }; },
  });
  first.style.value = 'caption';
  first.root.fire('change', {
    target: { value: 'caption', closest: selector => selector === '[data-super-easy-lyrics-style]' ? first.style : null },
  });
  const raw = '\n[00:01.00]<00:01.00>Parked <00:01.50>draft\r\n[00:03.00]Exact text\n';
  first.lrc.value = raw;
  first.root.fire('input', {
    target: { value: raw, closest: selector => selector === '[data-super-easy-lyrics-lrc]' ? first.lrc : null },
  });
  initial.destroy();

  const resumed = karaokeRoot({ lyricsStyle: current.lyricsStyle, lyricsLrc: current.lyricsLrc });
  const second = mountSuperEasy({ root: resumed.root, state: () => current, onMoreControl: () => {} });
  assert.equal(resumed.style.value, 'caption');
  assert.equal(resumed.lrc.value, raw);
  second.destroy();
});

test('Make Another resets both lyric controls and the persisted reset state', () => {
  const raw = '[00:01.00]Old project lyric';
  const { root, lrc } = karaokeRoot({ lyricsStyle: 'reel', lyricsLrc: raw });
  const resets = [];
  const current = state({ videoType: 'music-video', lyricsStyle: 'reel', lyricsLrc: raw });
  const handle = mountSuperEasy({
    root,
    state: () => current,
    onMoreControl: () => {},
    onMakeAnother: next => resets.push(next),
  });
  root.fire('click', { target: clickTarget('[data-super-easy-make-another]'), preventDefault() {} });
  assert.equal(resets.length, 1);
  assert.equal(resets[0].lyricsStyle, 'off');
  assert.equal(resets[0].lyricsLrc, '');
  assert.equal(lrc.value, '');
  assert.doesNotMatch(root.innerHTML, /Old project lyric/u);
  assert.match(root.innerHTML, /<option value="off" selected>Off<\/option>/u);
  handle.destroy();
});

test('confirmed setup forwards Google Colab once; unconfirmed setup opens setup instead', () => {
  const { root, prompt } = fakeRoot();
  const calls = [];
  let opened = 0;
  let setup = { compute: 'colab', spendCap: 7.5, confirmed: false };
  const handle = mountSuperEasy({
    root, state: () => state(), onMoreControl: () => {},
    setup: () => setup, onSetup: () => { opened += 1; }, onGenerate: input => calls.push(input),
  });
  prompt.value = 'A tiny lighthouse crew races the coming storm';
  root.fire('submit', { target: submitTarget(), preventDefault() {} });
  assert.equal(opened, 1);
  assert.deepEqual(calls, []);
  setup = { ...setup, confirmed: true };
  root.fire('submit', { target: submitTarget(), preventDefault() {} });
  assert.deepEqual(calls, [{ prompt: prompt.value, compute: 'colab', lengthS: 30, motionModel: 'auto', setupConfirmed: true }]);
  handle.destroy();
});

test('the motion-model selector offers Auto, H3 and LTX and saves changes', () => {
  const { root } = fakeRoot();
  let selected = null;
  const handle = mountSuperEasy({
    root, state: () => state(), onMoreControl: () => {},
    setup: () => ({ compute: 'cpu', motionModel: 'auto', spendCap: 10, confirmed: false }),
    onMotionModelChange: model => { selected = model; },
  });
  assert.match(root.innerHTML, /Auto — H3 acting \+ LTX camera/u);
  assert.match(root.innerHTML, /MiniMax H3 — characters \+ native sound/u);
  assert.match(root.innerHTML, /LTX-2.5 — cinematic motion plates/u);
  assert.match(root.innerHTML, /Klein only — stills \+ code motion/u);
  root.fire('change', { target: { value: 'ltx', closest: selector => (selector === '[data-super-easy-motion-model]' ? {} : null) } });
  assert.equal(selected, 'ltx');
  handle.destroy();
});

test('Record this run rides along with Generate and remembers the checkbox', () => {
  const { root, prompt } = fakeRoot();
  const toggle = { checked: true };
  const baseQuery = root.querySelector;
  root.querySelector = (selector) => (selector === '[data-procedure-capture-toggle]' ? toggle : baseQuery(selector));
  const calls = [];
  const toggles = [];
  const handle = mountSuperEasy({
    root,
    state: () => state(),
    onMoreControl: () => {},
    captureArmed: () => true,
    onCaptureToggle: (armed) => toggles.push(armed),
    onGenerate: (input) => {
      calls.push(input);
    },
  });

  assert.match(root.innerHTML, /data-procedure-capture-toggle[^>]* checked>/u);
  toggle.checked = false;
  root.fire('change', { target: { checked: false, closest: (selector) => (selector === '[data-procedure-capture-toggle]' ? toggle : null) } });
  assert.deepEqual(toggles, [false]);

  toggle.checked = true;
  prompt.value = 'A friendly robot who learns to bake bread';
  root.fire('submit', { target: submitTarget(), preventDefault() {} });
  assert.deepEqual(calls, [{ prompt: 'A friendly robot who learns to bake bread', compute: 'cpu', lengthS: 30, motionModel: 'auto', capture: true }]);
  handle.destroy();
});

test('a too-short prompt stays on the home screen', () => {
  const { root, prompt } = fakeRoot();
  const calls = [];
  const handle = mountSuperEasy({
    root,
    state: () => state(),
    onMoreControl: () => {},
    onGenerate: (input) => {
      calls.push(input);
    },
  });

  prompt.value = 'robot';
  root.fire('submit', {
    target: submitTarget(),
    preventDefault() {},
  });

  assert.deepEqual(calls, []);
  assert.equal(prompt.focused, true);
  handle.destroy();
});

test('a run opens the progress view with gauges and no player adoption', () => {
  const { root } = fakeRoot();
  const snapshot = {
    plan: { status: 'done' },
    characters: { done: 1, total: 2 },
    shots: [{ status: 'approved' }, { status: 'review' }],
    voice: { status: 'starting' },
    render: { status: 'running', fraction: 0.4 },
  };
  const handle = mountSuperEasy({
    root,
    state: () => state({ productionId: 'prod_0123456789abcdef01234567', generate: { status: 'running' } }),
    snapshot: () => snapshot,
    onMoreControl: () => {},
  });

  assert.equal(root.dataset.superEasyView, 'progress');
  assert.match(root.innerHTML, /data-super-easy-progress/u);
  assert.match(root.innerHTML, /data-super-easy-overall-gauge/u);
  assert.match(root.innerHTML, /data-super-easy-stage-gauge/u);
  assert.doesNotMatch(root.innerHTML, /data-super-easy-home/u);
  assert.doesNotMatch(root.innerHTML, /data-easy-player/u);

  handle.destroy();
});

test('the store moves the same mount from home to progress without remounting', () => {
  const { root } = fakeRoot();
  let current = state();
  let notify = () => {};
  const handle = mountSuperEasy({
    root,
    state: () => current,
    subscribe: (listener) => {
      notify = listener;
      return () => {
        notify = () => {};
      };
    },
    snapshot: () => ({ plan: { status: 'done' } }),
    onMoreControl: () => {},
  });

  assert.match(root.innerHTML, /data-super-easy-home/u);

  current = state({ productionId: 'prod_0123456789abcdef01234567', generate: { status: 'running' } });
  notify();

  assert.equal(root.dataset.superEasyView, 'progress');
  assert.match(root.innerHTML, /data-super-easy-progress/u);
  handle.destroy();
});

test('destroy unbinds the handoff, the form and the store subscription', () => {
  const { root } = fakeRoot();
  let handedOff = 0;
  let unsubscribed = 0;
  let notify = () => {};
  const handle = mountSuperEasy({
    root,
    state: () => state(),
    subscribe: (listener) => {
      notify = listener;
      return () => {
        unsubscribed += 1;
      };
    },
    onMoreControl: () => {
      handedOff += 1;
    },
  });

  handle.destroy();
  notify();
  root.fire('click', {
    target: clickTarget('[data-super-easy-more-control]'),
    preventDefault() {},
  });

  assert.equal(handedOff, 0);
  assert.equal(unsubscribed, 1);
  assert.equal(root.innerHTML, '');
  assert.equal(root.dataset.superEasyView, undefined);
});

function stableProgressRoot() {
  const writes = { innerHTML: 0, chrome: 0, gallery: 0, actions: 0, live: 0, gauges: 0 };
  const listeners = new Map();
  let html = '';
  let rendered = false;
  let liveText = '';
  const region = (kind) => {
    let value = '';
    return {
      get innerHTML() {
        return value;
      },
      set innerHTML(next) {
        value = next;
        writes[kind] += 1;
      },
    };
  };
  const gauges = ['plan', 'characters', 'shots', 'voice', 'render'].map((id) => {
    let value = '';
    return {
      get innerHTML() {
        return value;
      },
      set innerHTML(next) {
        value = next;
        writes.gauges += 1;
      },
      getAttribute(name) {
        return name === 'data-stage-id' ? id : null;
      },
    };
  });
  const live = {
    get textContent() {
      return liveText;
    },
    set textContent(value) {
      liveText = value;
      writes.live += 1;
    },
    setAttribute() {},
  };
  const nodes = new Map([
    ['[data-super-easy-chrome]', region('chrome')],
    ['[data-super-easy-gallery]', region('gallery')],
    ['[data-super-easy-actions]', region('actions')],
    ['[data-super-easy-live]', live],
    ['[data-super-easy-overall-value]', { textContent: '' }],
    ['[data-super-easy-overall-gauge]', region('gauges')],
  ]);
  const root = {
    dataset: {},
    get innerHTML() {
      return html;
    },
    set innerHTML(value) {
      html = value;
      writes.innerHTML += 1;
      rendered = true;
    },
    querySelector(selector) {
      if (!rendered) return null;
      return nodes.get(selector) ?? null;
    },
    querySelectorAll(selector) {
      return selector === '[data-super-easy-stage-gauge]' ? gauges : [];
    },
    addEventListener(type, handler) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(handler);
    },
    removeEventListener(type, handler) {
      listeners.get(type)?.delete(handler);
    },
  };
  return { root, writes };
}

test('frequent progress repaints leave the playing sample, live region and escapes in place', () => {
  const { root, writes } = stableProgressRoot();
  const snapshot = {
    plan: { status: 'done' },
    characters: { status: 'done' },
    shots: [{ status: 'approved' }],
    voice: { status: 'done', url: '/media/voice.mp3' },
    render: { status: 'running', fraction: 0.2 },
  };
  const handle = mountSuperEasy({
    root,
    state: () => state({ productionId: 'prod_0123456789abcdef01234567', generate: { status: 'running' } }),
    snapshot: () => snapshot,
    onMoreControl: () => {},
  });

  assert.equal(writes.innerHTML, 1, 'the first paint mounts the whole screen');
  assert.equal(writes.gallery, 0);

  for (const fraction of [0.4, 0.6, 0.8]) {
    snapshot.render.fraction = fraction;
    handle.render();
  }

  assert.equal(writes.innerHTML, 1, 'no full replacement for fraction-only events');
  assert.equal(writes.chrome, 0, 'stage markup stays in place');
  assert.equal(writes.gallery, 0, 'a playing sample is not replaced');
  assert.equal(writes.actions, 0, 'a focused escape is not replaced');
  assert.equal(writes.live, 0, 'the live region keeps the same sentence');
  assert.ok(writes.gauges > 0, 'the measured gauges still move');
  handle.destroy();
});

test('the preview and failure handoffs are clickable escapes', () => {
  const { root } = fakeRoot();
  const reviews = [];
  const retries = [];
  const handle = mountSuperEasy({
    root,
    state: () => state({ packageId: 'pkg_1', productionId: 'prod_0123456789abcdef01234567', generate: { status: 'running' } }),
    snapshot: () => ({ plan: { status: 'done' }, render: { status: 'running', fraction: 0.2 } }),
    previewReady: () => true,
    failure: () => null,
    onReview: (packageId) => reviews.push(packageId),
    onRetry: () => retries.push(true),
    onMoreControl: () => {},
  });

  assert.match(root.innerHTML, /data-super-easy-review/u);
  root.fire('click', {
    target: clickTarget('[data-super-easy-review]'),
    preventDefault() {},
  });
  assert.deepEqual(reviews, ['pkg_1']);
  assert.deepEqual(retries, []);
  handle.destroy();

  const failed = fakeRoot();
  const retryHandle = mountSuperEasy({
    root: failed.root,
    state: () => state({ productionId: 'prod_0123456789abcdef01234567', generate: { status: 'running' } }),
    snapshot: () => null,
    failure: () => ({ message: 'The plan could not be written.', retryable: true }),
    onRetry: () => retries.push(true),
    onMoreControl: () => {},
  });

  assert.match(failed.root.innerHTML, /data-super-easy-error/u);
  failed.root.fire('click', {
    target: clickTarget('[data-super-easy-retry]'),
    preventDefault() {},
  });
  assert.deepEqual(retries, [true]);
  retryHandle.destroy();
});

test('Easy delegates first paint to Super Easy and releases the player first', () => {
  const easy = readFileSync(EASY_MOUNT, 'utf8');
  const superEasy = readFileSync(SUPER_EASY_MOUNT, 'utf8');

  assert.match(easy, /import \{[^}]*mountSuperEasy[^}]*\} from '\.\/super-easy\/mount\.ts'/u);
  assert.ok((easy.match(/route\.view === 'superEasy'/gu) ?? []).length >= 2, 'both boot and route changes check Super Easy');
  assert.match(easy, /boot\.view === 'superEasy'/u);
  assert.match(easy, /setPreferStudio\(true\)/u);
  assert.match(easy, /onMoreControl:/u);

  const start = easy.indexOf('function showSuperEasy');
  const end = easy.indexOf('\n  function ', start + 1);
  assert.ok(start >= 0 && end > start);
  const body = easy.slice(start, end);
  const release = body.indexOf('releasePlayer()');
  const mount = body.indexOf('mountSuperEasy(');
  assert.ok(release >= 0, 'the borrowed player is returned before Super Easy paints');
  assert.ok(mount > release, 'Super Easy mounts only after the player is released');

  const openStart = easy.indexOf('function openStudioFromSuperEasy');
  const openEnd = easy.indexOf('\n  function ', openStart + 1);
  assert.ok(openStart >= 0 && openEnd > openStart);
  const open = easy.slice(openStart, openEnd);
  const destroy = open.indexOf('destroySuperEasy()');
  const studio = open.indexOf('ensureShell()');
  assert.ok(destroy >= 0 && studio > destroy, 'more control closes Super Easy before the studio mounts');

  assert.doesNotMatch(superEasy, /preview-slot|adoptPlayer|releasePlayer/u);
  assert.doesNotMatch(superEasy, /data-easy-player|playerElement/u);
  assert.doesNotMatch(superEasy, /Google Colab/u);
});

function richRoot() {
  const { root, prompt } = fakeRoot();
  const attributes = new Map();
  Object.assign(prompt, {
    setAttribute(name, value) { attributes.set(name, String(value)); },
    removeAttribute(name) { attributes.delete(name); },
    getAttribute(name) { return attributes.has(name) ? attributes.get(name) : null; },
  });
  const error = { hidden: true };
  const plain = root.querySelector;
  root.querySelector = (selector) => (selector === '[data-super-easy-prompt-error]' ? error : plain(selector));
  return { root, prompt, error };
}

test('an idea chip fills its own prompt and clears a shown error', () => {
  const { root, prompt, error } = richRoot();
  const handle = mountSuperEasy({ root, state: () => state(), onMoreControl: () => {} });
  error.hidden = false;
  root.fire('click', {
    target: {
      closest(candidate) {
        return candidate === '[data-super-easy-idea]'
          ? { getAttribute: (name) => (name === 'data-super-easy-idea' ? 'coffee' : null) }
          : null;
      },
    },
    preventDefault() {},
  });
  assert.equal(prompt.value, 'How a coffee bean becomes your morning cup');
  assert.equal(prompt.focused, true);
  assert.equal(error.hidden, true);
  handle.destroy();
});

test('a too-short Generate shows the inline message, and typing hides it again', () => {
  const { root, prompt, error } = richRoot();
  const calls = [];
  const handle = mountSuperEasy({ root, state: () => state(), onMoreControl: () => {}, onGenerate: (input) => calls.push(input) });
  prompt.value = 'robot';
  root.fire('submit', { target: submitTarget(), preventDefault() {} });
  assert.deepEqual(calls, []);
  assert.equal(error.hidden, false);
  assert.equal(prompt.getAttribute('aria-invalid'), 'true');
  assert.match(prompt.getAttribute('aria-describedby'), /super-easy-prompt-error/u);

  root.fire('input', { target: clickTarget('#super-easy-prompt') });
  assert.equal(error.hidden, true);
  assert.equal(prompt.getAttribute('aria-invalid'), null);
  handle.destroy();
});

test('Download MP4 hands the package to export, falling back to Review', () => {
  const exported = [];
  const reviewed = [];
  const withExport = fakeRoot();
  const first = mountSuperEasy({
    root: withExport.root,
    state: () => state({ packageId: 'pkg_1', generate: { status: 'running' } }),
    onMoreControl: () => {},
    onReview: (id) => reviewed.push(id),
    onExport: (id) => exported.push(id),
  });
  withExport.root.fire('click', { target: clickTarget('[data-super-easy-export]'), preventDefault() {} });
  assert.deepEqual(exported, ['pkg_1']);
  assert.deepEqual(reviewed, []);
  first.destroy();

  const reviewOnly = fakeRoot();
  const second = mountSuperEasy({
    root: reviewOnly.root,
    state: () => state({ packageId: 'pkg_2', generate: { status: 'running' } }),
    onMoreControl: () => {},
    onReview: (id) => reviewed.push(id),
  });
  reviewOnly.root.fire('click', { target: clickTarget('[data-super-easy-export]'), preventDefault() {} });
  assert.deepEqual(reviewed, ['pkg_2']);
  second.destroy();
});

test('the caller can supply the gauges for a snapshot the journal cannot fill', () => {
  const { root } = fakeRoot();
  const seen = [];
  const handle = mountSuperEasy({
    root,
    state: () => state({ generate: { status: 'running' } }),
    snapshot: () => ({ marker: 1 }),
    stages(snapshot) {
      seen.push(snapshot);
      return {
        overall: 0.5,
        finalReady: false,
        complete: false,
        stages: ['plan', 'characters', 'shots', 'voice', 'render'].map((id) => ({
          id,
          label: id,
          status: id === 'plan' ? 'done' : 'waiting',
          statusText: id === 'plan' ? 'Done' : 'Waiting',
          fraction: id === 'plan' ? 1 : 0,
          error: null,
        })),
      };
    },
    onMoreControl: () => {},
  });
  assert.deepEqual(seen[0], { marker: 1 });
  assert.match(root.innerHTML, /data-super-easy-stage="plan" data-stage-status="done"/u);
  assert.match(root.innerHTML, /data-super-easy-overall-value>50%</u);
  handle.destroy();
});

test('the Easy mount sends Download MP4 to the Studio Export step and merges local gauges', () => {
  const source = readFileSync(EASY_MOUNT, 'utf8');
  assert.match(source, /onExport: \(packageId\) => openStudioFromSuperEasy\('export', packageId\)/u);
  assert.match(source, /stages: \(snapshot\) => superEasyStages\(snapshot\)/u);
  assert.match(source, /mergeLocalStages\(readStages\(snapshot\), localStageReadings\(/u);
  assert.match(source, /currentStep !== step\) showStep\(step\)/u, 'Export is shown once, so it renders once');
});

function attachmentFocusHarness(snapshot, videoType = 'product-walkthrough') {
  const document = {
    activeElement: null,
    createElement() {
      return new FakeAttachmentList(document);
    },
  };
  class Control {
    constructor(row, kind, id, value = '') {
      this.row = row;
      this.kind = kind;
      this.id = id;
      this.value = value;
      this.checked = false;
      this.selectionStart = value.length;
      this.selectionEnd = value.length;
    }
    selector() {
      return `[data-super-easy-context-${this.kind}]`;
    }
    matches(selector) {
      return selector === this.selector();
    }
    closest(selector) {
      return this.matches(selector) ? this : null;
    }
    getAttribute(name) {
      return name === `data-super-easy-context-${this.kind}` ? this.id : null;
    }
    focus() {
      document.activeElement = this;
    }
    setSelectionRange(start, end) {
      this.selectionStart = start;
      this.selectionEnd = end;
    }
  }
  class Row {
    constructor(ownerDocument, html) {
      this.ownerDocument = ownerDocument;
      this.source = /data-context-source="([^"]+)"/u.exec(html)?.[1] ?? null;
      this.id = /data-context-id="([^"]+)"/u.exec(html)?.[1] ?? null;
      this.parent = null;
      this.controls = [];
      const noteId = /data-super-easy-context-note="([^"]+)"/u.exec(html)?.[1];
      if (noteId) {
        this.note = new Control(this, 'note', noteId, /value="([^"]*)"/u.exec(html)?.[1] ?? '');
        this.controls.push(this.note);
      }
      const usageId = /data-super-easy-context-usage="([^"]+)"/u.exec(html)?.[1];
      if (usageId) {
        this.usage = new Control(this, 'usage', usageId);
        this.usage.checked = new RegExp(`data-super-easy-context-usage="${usageId}"[^>]* checked`, 'u').test(html);
        this.controls.push(this.usage);
      }
      const removeId = /data-super-easy-context-remove="([^"]+)"/u.exec(html)?.[1];
      if (removeId) {
        this.removeControl = new Control(this, 'remove', removeId);
        this.controls.push(this.removeControl);
      }
    }
    getAttribute(name) {
      return name === 'data-context-source' ? this.source : name === 'data-context-id' ? this.id : null;
    }
    querySelectorAll(selector) {
      return this.controls.filter(control => control.matches(selector));
    }
    querySelector(selector) {
      return this.controls.find(control => control.matches(selector)) ?? null;
    }
    contains(control) {
      return this.controls.includes(control);
    }
    remove() {
      this.parent?.removeChild(this);
    }
  }
  class FakeAttachmentList {
    constructor(ownerDocument) {
      this.ownerDocument = ownerDocument;
      this.children = [];
      this.writes = 0;
    }
    get firstElementChild() {
      return this.children[0] ?? null;
    }
    set innerHTML(html) {
      this.writes += 1;
      this.children = String(html).split(/(?=<li )/u).filter(part => part.startsWith('<li ')).map(part => {
        const row = new Row(this.ownerDocument, part);
        row.parent = this;
        return row;
      });
    }
    querySelectorAll(selector) {
      return selector === 'li[data-context-source][data-context-id]' ? this.children.filter(row => row.id) : [];
    }
    querySelector() {
      return null;
    }
    replaceChild(next, previous) {
      const index = this.children.indexOf(previous);
      this.children[index] = next;
      next.parent = this;
      previous.parent = null;
    }
    insertBefore(row, at) {
      row.parent?.removeChild(row);
      const index = at ? this.children.indexOf(at) : this.children.length;
      this.children.splice(index < 0 ? this.children.length : index, 0, row);
      row.parent = this;
    }
    removeChild(row) {
      const index = this.children.indexOf(row);
      if (index >= 0) this.children.splice(index, 1);
      row.parent = null;
    }
  }
  const list = new FakeAttachmentList(document);
  const pending = { innerHTML: '' };
  const status = { textContent: '', classList: { toggle() {} } };
  const { root } = fakeRoot();
  root.ownerDocument = document;
  const query = root.querySelector;
  root.querySelector = selector => ({
    '[data-super-easy-context-list]': list,
    '[data-super-easy-context-pending]': pending,
    '[data-super-easy-context-status]': status,
  })[selector] ?? query(selector);
  const attachments = {
    snapshot: () => snapshot,
    setNote: async () => true,
    setUsage: async () => true,
  };
  const handle = mountSuperEasy({
    root,
    state: () => state({ videoType }),
    attachments,
    onMoreControl: () => {},
  });
  return {
    document, list, root, handle, attachments,
    setSnapshot(next) { snapshot = next; },
  };
}

function attachmentSnapshot(items, signature = 'ctx_one') {
  return {
    attachments: items,
    attachmentSignature: signature,
    attachmentRevision: 1,
    pending: [],
    message: '',
    messageError: false,
  };
}

const focusMedia = () => ({
  id: 'ref_1', source: 'media', kind: 'image', label: 'Product', note: 'saved', usage: 'reference', rightsAsserted: true,
});

test('another upload and pending status preserve a dirty note value, node and focus', () => {
  let snapshot = attachmentSnapshot([focusMedia()]);
  const h = attachmentFocusHarness(snapshot);
  const row = h.list.children[0];
  const note = row.note;
  note.focus();
  note.value = 'unsaved planning detail';
  h.root.fire('input', { target: note });
  const listWrites = h.list.writes;

  snapshot = {
    ...attachmentSnapshot([
      focusMedia(),
      { id: 'ctx_2', source: 'context', kind: 'text', label: 'Brief', usage: 'reference', rightsAsserted: false },
    ], 'ctx_two'),
    pending: [{ key: 'p1', name: 'later.txt', status: 'uploading' }],
    message: 'Uploading later.txt…',
  };
  h.setSnapshot(snapshot);
  h.handle.syncAttachments();
  assert.equal(h.list.children[0], row, 'the unchanged keyed note row is reused');
  assert.equal(h.list.children[0].note, note);
  assert.equal(note.value, 'unsaved planning detail');
  assert.equal(h.document.activeElement, note);
  assert.equal(h.list.writes, listWrites, 'an item reconciliation does not replace the whole list');

  snapshot = { ...snapshot, message: 'Still uploading…' };
  h.setSnapshot(snapshot);
  h.handle.syncAttachments();
  assert.equal(h.list.children[0], row);
  assert.equal(note.value, 'unsaved planning detail');
  assert.equal(h.document.activeElement, note);
  assert.equal(h.list.writes, listWrites, 'status-only work never repaints attachment items');
  h.handle.destroy();
});

test('editorial usage reconciliation restores logical checkbox focus', () => {
  let snapshot = attachmentSnapshot([focusMedia()]);
  const h = attachmentFocusHarness(snapshot);
  const previous = h.list.children[0];
  previous.usage.focus();
  previous.usage.checked = true;

  snapshot = attachmentSnapshot([{ ...focusMedia(), usage: 'editorial', editorialScope: 'product-walkthrough', revision: 2 }], 'ctx_editorial');
  h.setSnapshot(snapshot);
  h.handle.syncAttachments();
  const current = h.list.children[0];
  assert.notEqual(current, previous, 'the changed keyed row is refreshed');
  assert.equal(current.usage.checked, true);
  assert.equal(h.document.activeElement, current.usage, 'focus follows the same logical editorial toggle');
  h.handle.destroy();
});

test('Custom image opt-in reconciles scoped usage and preserves checkbox focus', () => {
  const h = attachmentFocusHarness(attachmentSnapshot([focusMedia()]), null);
  const previous = h.list.children[0];
  previous.usage.focus();
  previous.usage.checked = true;
  h.setSnapshot(attachmentSnapshot([{ ...focusMedia(), usage: 'editorial', editorialScope: 'custom', revision: 2 }], 'ctx_custom'));
  h.handle.syncAttachments();
  const current = h.list.children[0];
  assert.notEqual(current, previous);
  assert.equal(current.usage.checked, true);
  assert.equal(h.document.activeElement, current.usage);
  h.handle.destroy();
});

test('unscoped or differently scoped editorial image is not checked in Custom', () => {
  for (const scope of [undefined, 'product-walkthrough', 'music-video']) {
    const h = attachmentFocusHarness(attachmentSnapshot([{ ...focusMedia(), usage: 'editorial', editorialScope: scope }]), null);
    assert.equal(h.list.children[0].usage.checked, false);
    h.handle.destroy();
  }
});
