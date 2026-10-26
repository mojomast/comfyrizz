// UX12: exact-target, audible and accessible comparison.
// Node's test runner has no DOM library, so the controller and render contracts
// are exercised directly; the one mount test uses a small deterministic fake.
// @ts-nocheck
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  COMPARE_END_BEHAVIOR,
  CompareController,
  renderCompare,
  takeTimeAtSeconds,
} from './compare.ts';

const PACKAGE_ID = 'pkg_demo';
const SHOT_A = 's1';
const CLIP_A = 's1:a_plate1';
const SHOT_B = 's2';
const CLIP_B = 's2:a_plate2';
const TAKE_A1 = 'tk_111111111111';
const TAKE_A2 = 'tk_222222222222';
const TAKE_B1 = 'tk_333333333333';
const TAKE_B2 = 'tk_444444444444';

function take(n, durationInSeconds = 2, overrides = {}) {
  return {
    takeId: `tk_${String(n).repeat(12)}`,
    assetId: 'a_plate1',
    n,
    file: `takes/a_plate1/take-${n}.mp4`,
    sha256: String(n).repeat(64),
    bytes: 1024 * n,
    media: {
      fps: 24,
      frames: Math.round(durationInSeconds * 24),
      durationInSeconds,
    },
    gen: { generator: 'comfyui', prompt: `plate take ${n}`, seed: 7 + n },
    createdAt: `2026-10-20T12:0${n}:00.000Z`,
    verdict: 'unreviewed',
    ...overrides,
  };
}

function fakeApi(options = {}) {
  const calls = { select: [] };
  let release = null;
  const api = {
    async select(packageId, clipId, takeId) {
      calls.select.push({ packageId, clipId, takeId });
      if (options.deferred) await new Promise(resolve => { release = resolve; });
      const result = { kind: 'selected', packageId, revision: 5, clip: {}, takeId };
      if (options.omitTakeId) delete result.takeId;
      return result;
    },
  };
  return {
    api,
    calls,
    release() {
      if (release) release();
      release = null;
    },
  };
}

function shotPair() {
  return [
    { shotId: SHOT_A, clipId: CLIP_A, takes: [take(1), take(2)], selected: null },
    { shotId: SHOT_B, clipId: CLIP_B, takes: [take(3), take(4)], selected: null },
  ];
}

function options(overrides = {}) {
  return {
    api: fakeApi().api,
    packageId: PACKAGE_ID,
    clipId: CLIP_A,
    shotId: SHOT_A,
    takes: [take(1), take(2)],
    selected: null,
    shots: shotPair(),
    ...overrides,
  };
}

const TARGET_FIELDS = ['clipId', 'packageId', 'shotId', 'takeId'];

test('the compare target is immutable and names the exact shot, clip and take', () => {
  const controller = new CompareController(options());
  const target = controller.state.target;

  assert.ok(target);
  assert.equal(target.packageId, PACKAGE_ID);
  assert.equal(target.shotId, SHOT_A);
  assert.equal(target.clipId, CLIP_A);
  assert.equal(target.takeId, TAKE_A1);
  assert.equal(Object.isFrozen(target), true);
  assert.deepEqual(Object.keys(target).sort(), TARGET_FIELDS);

  controller.focusTake(1);
  assert.equal(controller.state.target.takeId, TAKE_A2);
  assert.equal(controller.state.target.shotId, SHOT_A);

  controller.nextShot();
  assert.equal(controller.state.target.shotId, SHOT_B);
  assert.equal(controller.state.target.clipId, CLIP_B);
  assert.equal(controller.state.target.takeId, TAKE_B1);
});

test('Keep is disabled until the focused take has a complete exact target', () => {
  const empty = new CompareController(options({ takes: [] }));
  assert.match(renderCompare(empty.state), /data-compare-keep[^>]*disabled/);
  assert.equal(empty.canKeep(), false);

  const single = new CompareController(options({ takes: [take(1)] }));
  assert.match(renderCompare(single.state), /data-compare-keep[^>]*disabled/);
  assert.equal(single.canKeep(), false);

  const pair = new CompareController(options());
  assert.doesNotMatch(renderCompare(pair.state), /data-compare-keep[^>]*disabled/);
  assert.equal(pair.canKeep(), true);
});

test('Keep submits the take targeted when it started, not the shot after navigation', async () => {
  const fake = fakeApi({ deferred: true });
  const controller = new CompareController(options({ api: fake.api }));

  const pending = controller.keepFocused();
  assert.equal(controller.state.busy, true);
  controller.nextShot();
  fake.release();

  assert.equal(await pending, false);
  assert.deepEqual(fake.calls.select, [{
    packageId: PACKAGE_ID,
    clipId: CLIP_A,
    takeId: TAKE_A1,
  }]);
  assert.equal(controller.state.clipId, CLIP_B);
  assert.equal(controller.state.selected, null);
  assert.match(controller.state.keepError, /selection changed/i);
});

test('rapid cross-shot navigation then Keep submits the current shot take exactly once', async () => {
  const fake = fakeApi();
  const controller = new CompareController(options({ api: fake.api }));

  controller.nextShot();
  controller.previousShot();
  controller.nextShot();
  assert.equal(controller.state.shotId, SHOT_B);

  assert.equal(await controller.keepFocused(), true);
  assert.deepEqual(fake.calls.select, [{
    packageId: PACKAGE_ID,
    clipId: CLIP_B,
    takeId: TAKE_B1,
  }]);
  assert.equal(controller.state.selected, TAKE_B1);
});

test('the shared position is in seconds and frames so 3s and 5s clips agree at 1s', () => {
  const clips = [take(1, 3), take(2, 5)];
  assert.equal(COMPARE_END_BEHAVIOR, 'clamp-each-take');

  const controller = new CompareController(options({
    takes: clips,
    shots: undefined,
  }));
  assert.equal(controller.state.durationSeconds, 5);
  assert.equal(controller.state.endBehavior, COMPARE_END_BEHAVIOR);

  assert.equal(controller.setPositionSeconds(1), 1);
  assert.equal(controller.state.positionSeconds, 1);
  assert.equal(controller.state.positionFrame, 24);
  assert.equal(controller.takeTime(TAKE_A1).seconds, 1);
  assert.equal(controller.takeTime(TAKE_A2).seconds, 1);
  assert.equal(controller.takeTime(TAKE_A1).frame, 24);
  assert.equal(controller.takeTime(TAKE_A2).frame, 24);

  const atFour = takeTimeAtSeconds(clips[0], 4);
  assert.equal(atFour.seconds, 3);
  assert.equal(atFour.atEnd, true);
  assert.equal(takeTimeAtSeconds(clips[1], 4).seconds, 4);
  assert.equal(takeTimeAtSeconds(clips[1], 4).atEnd, false);

  const html = renderCompare(controller.state);
  assert.match(html, /data-compare-seconds="1"/);
  assert.match(html, /data-compare-frame="24"/);
  assert.match(html, /data-compare-end="clamp-each-take"/);
});

test('exactly one take is monitored and audible at a time', () => {
  const controller = new CompareController(options());
  assert.equal(controller.state.monitoredTakeId, TAKE_A1);

  const first = renderCompare(controller.state);
  assert.match(first, /data-compare-monitored="tk_111111111111"/);
  assert.match(first, /data-compare-media="tk_111111111111"[^>]*data-monitored="true"/);
  assert.match(first, /data-compare-media="tk_222222222222"[^>]*data-monitored="false"[^>]*muted/);

  controller.focusTake(1);
  const second = renderCompare(controller.state);
  assert.equal(controller.state.monitoredTakeId, TAKE_A2);
  assert.match(second, /data-compare-media="tk_222222222222"[^>]*data-monitored="true"/);
  assert.doesNotMatch(second, /data-compare-media="tk_222222222222"[^>]*muted/);
  assert.match(second, /data-compare-media="tk_111111111111"[^>]*muted/);
});

test('favorites persist across mounts and are honest when storage is unavailable', () => {
  const memory = new Map();
  const storage = {
    getItem: key => memory.get(key) ?? null,
    setItem: (key, value) => { memory.set(key, value); },
  };

  const first = new CompareController(options({ storage }));
  assert.equal(first.pinFocused(), true);
  assert.equal(first.state.favoritePersistent, true);
  assert.equal(first.state.pinned.has(TAKE_A1), true);
  first.destroy();

  const second = new CompareController(options({ storage }));
  assert.equal(second.state.pinned.has(TAKE_A1), true);
  assert.equal(second.state.favoritePersistent, true);

  const noStorage = new CompareController(options());
  noStorage.pinFocused();
  assert.equal(noStorage.state.favoritePersistent, false);
  assert.match(noStorage.state.liveMessage, /this session/i);
});

test('compare navigation clears the previous shot state before the new takes load', () => {
  const controller = new CompareController(options());
  controller.keepFocused();
  controller.focusTake(1);
  controller.scrubTo(0.75);
  controller.togglePlayback();

  controller.nextShot();
  assert.equal(controller.state.shotId, SHOT_B);
  assert.equal(controller.state.focusIndex, 0);
  assert.equal(controller.state.position, 0);
  assert.equal(controller.state.positionSeconds, 0);
  assert.equal(controller.state.playing, false);
  assert.equal(controller.state.keepError, null);
  assert.deepEqual(controller.state.takes.map(item => item.takeId), [TAKE_B1, TAKE_B2]);
  assert.equal(controller.state.monitoredTakeId, TAKE_B1);
  assert.equal(controller.state.target.takeId, TAKE_B1);
});

class FakeNode {
  constructor(tagName = 'div') {
    this.tagName = String(tagName).toUpperCase();
    this.children = [];
    this.attributes = new Map();
    this.listeners = new Map();
    this.dataset = {};
    this.style = {};
    this.className = '';
    this.textContent = '';
    this.parentNode = null;
    this.disabled = false;
    this.hidden = false;
    this.muted = false;
    this.paused = true;
    this.currentTime = 0;
    this.duration = 2;
    this._innerHTML = '';
  }

  get classList() {
    const self = this;
    return {
      contains: name => self.className.split(/\s+/).includes(name),
      add: name => {
        const names = self.className.split(/\s+/).filter(Boolean);
        if (!names.includes(name)) names.push(name);
        self.className = names.join(' ');
      },
    };
  }

  set innerHTML(value) {
    this._innerHTML = String(value);
    this.children = [];
    this.writes = (this.writes ?? 0) + 1;
    if (this._innerHTML.includes('data-compare-view')) {
      const view = new FakeNode('section');
      view.setAttribute('data-compare-view', '');
      const shot = /data-compare-shot="([^"]*)"/.exec(this._innerHTML);
      if (shot) view.setAttribute('data-compare-shot', shot[1]);
      this.appendChild(view);
      const takeIds = [...this._innerHTML.matchAll(/data-compare-take="([^"]+)"/g)].map(match => match[1]);
      const mediaIds = [...this._innerHTML.matchAll(/data-compare-media="([^"]+)"/g)].map(match => match[1]);
      this.takeNodes = takeIds.map(id => {
        const node = new FakeNode('li');
        node.setAttribute('data-compare-take', id);
        return node;
      });
      this.mediaNodes = mediaIds.map(id => {
        const node = new FakeNode(this._innerHTML.includes(`data-compare-media="${id}" data-media-kind="image"`) ? 'img' : 'video');
        node.setAttribute('data-compare-media', id);
        node.play = () => { node.paused = false; return Promise.resolve(); };
        node.pause = () => { node.paused = true; };
        return node;
      });
    }
  }

  get innerHTML() {
    return this._innerHTML;
  }

  setAttribute(name, value) {
    this.attributes.set(String(name).toLowerCase(), String(value));
  }

  getAttribute(name) {
    const key = String(name).toLowerCase();
    return this.attributes.has(key) ? this.attributes.get(key) : null;
  }

  hasAttribute(name) {
    return this.attributes.has(String(name).toLowerCase());
  }

  removeAttribute(name) {
    this.attributes.delete(String(name).toLowerCase());
  }

  appendChild(child) {
    child.parentNode = this;
    this.children.push(child);
    return child;
  }

  contains(node) {
    let current = node;
    while (current) {
      if (current === this) return true;
      current = current.parentNode;
    }
    return false;
  }

  closest(selector) {
    const match = /^\[([^\]=]+)\]$/.exec(selector);
    if (!match) return null;
    let node = this;
    while (node) {
      if (node.hasAttribute(match[1])) return node;
      node = node.parentNode;
    }
    return null;
  }

  querySelector(selector) {
    const attr = /^\[([^\]=]+)\]$/.exec(selector);
    if (!attr) return null;
    if (this.hasAttribute(attr[1])) return this;
    for (const child of this.children) {
      const found = child.querySelector(selector);
      if (found) return found;
    }
    return null;
  }

  querySelectorAll(selector) {
    if (selector === '[data-compare-take]') return this.takeNodes ?? [];
    if (selector === '[data-compare-media]') return this.mediaNodes ?? [];
    if (selector === 'audio, video') {
      return (this.mediaNodes ?? []).filter(node => node.tagName === 'VIDEO' || node.tagName === 'AUDIO');
    }
    return [];
  }

  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(listener);
  }

  removeEventListener(type, listener) {
    this.listeners.get(type)?.delete(listener);
  }

  focus() {}

  getBoundingClientRect() {
    return { left: 0, top: 0, width: 320, height: 180 };
  }
}

test('mount keeps the same media elements when focus or playback changes', () => {
  const host = new FakeNode('div');
  const options = {
    api: fakeApi().api,
    packageId: PACKAGE_ID,
    clipId: CLIP_A,
    shotId: SHOT_A,
    takes: [take(1), take(2)],
    selected: null,
    shots: undefined,
  };

  const handle = (async () => {
    const { mountCompare } = await import('./compare.ts');
    return mountCompare(host, options);
  });

  let mounted;
  return handle().then(handleValue => {
    mounted = handleValue;
    const writes = host.writes;
    const mediaBefore = host.mediaNodes.slice();
    assert.equal(mediaBefore.length, 2);

    mounted.controller.focusTake(1);
    assert.equal(host.writes, writes);
    assert.deepEqual(host.mediaNodes, mediaBefore);

    mounted.controller.togglePlayback();
    assert.equal(host.writes, writes);
    assert.deepEqual(host.mediaNodes, mediaBefore);

    mounted.destroy();
  });
});
