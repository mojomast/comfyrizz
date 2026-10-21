import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { mountStoryboard, renderStoryboard } from '../src/demo/storyboard.mjs';

const launchTimeline = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../../examples/launch-demo/timeline.json', import.meta.url)), 'utf8'),
);

const SCENE_IDS = launchTimeline.scenes.map(scene => scene.id);

const ATTR_SELECTOR = /^\[([a-zA-Z0-9_-]+)(?:=(?:"([^"]*)"|'([^']*)'))?\]$/;

function matches(element, selector) {
  const match = ATTR_SELECTOR.exec(selector);
  if (!match) return false;
  const value = element.getAttribute(match[1]);
  if (value === null) return false;
  const wanted = match[2] ?? match[3];
  return wanted === undefined ? true : value === wanted;
}

class FakeElement {
  constructor(attributes = {}) {
    this.attributes = { ...attributes };
    this.children = [];
    this.parent = null;
    this.listeners = new Map();
    this.focused = false;
  }

  append(child) {
    child.parent = this;
    this.children.push(child);
    return child;
  }

  setAttribute(name, value) {
    this.attributes[name] = String(value);
  }

  getAttribute(name) {
    return Object.prototype.hasOwnProperty.call(this.attributes, name) ? this.attributes[name] : null;
  }

  removeAttribute(name) {
    delete this.attributes[name];
  }

  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(listener);
  }

  removeEventListener(type, listener) {
    this.listeners.set(type, (this.listeners.get(type) ?? []).filter(entry => entry !== listener));
  }

  dispatch(type, event = {}) {
    for (const listener of this.listeners.get(type) ?? []) {
      listener({ preventDefault() {}, ...event, target: event.target ?? this });
    }
  }

  closest(selector) {
    let node = this;
    while (node) {
      if (matches(node, selector)) return node;
      node = node.parent;
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
}

function fakeStoryboard(ids) {
  const root = new FakeElement({ class: 'storyboard' });
  const chips = ids.map(id => {
    const item = root.append(new FakeElement({ class: 'storyboard-scene', 'data-scene-id': id }));
    const chip = item.append(new FakeElement({ class: 'storyboard-chip', 'data-action': 'select', 'data-scene-id': id }));
    item.append(new FakeElement({ class: 'storyboard-rerun', 'data-action': 'rerun', 'data-scene-id': id }));
    return chip;
  });
  return { root, chips };
}

test('renderStoryboard uses the real launch demo timeline and emits one chip per scene', () => {
  const html = renderStoryboard(launchTimeline);

  assert.match(html, /<section class="storyboard" aria-label="Storyboard">/);
  assert.match(html, /<ol class="storyboard-scenes" aria-label="Scenes">/);
  assert.equal((html.match(/data-action="select"/g) ?? []).length, launchTimeline.scenes.length);
  assert.equal((html.match(/data-action="rerun"/g) ?? []).length, launchTimeline.scenes.length);
  assert.equal((html.match(/class="storyboard-status storyboard-status-ready"/g) ?? []).length, launchTimeline.scenes.length);
  assert.equal((html.match(/>Re-run</g) ?? []).length, launchTimeline.scenes.length);
  assert.equal((html.match(/aria-current=/g) ?? []).length, 0);

  for (const id of SCENE_IDS) {
    assert.match(html, new RegExp(`data-scene-id="${id}"`));
  }
  assert.match(html, />Comfyrizz</);
  assert.match(html, />5\.0s</);
});

test('per-scene statuses override the timeline and render all four badges', () => {
  const html = renderStoryboard(launchTimeline, {
    selectedId: 's_hero',
    scenes: {
      s_title: 'ready',
      s_hero: { status: 'stale' },
      s_stat: { state: 'rerendering' },
      s_chart: 'failed',
    },
  });

  assert.equal((html.match(/storyboard-status-ready/g) ?? []).length, 3, 'unlisted scenes stay ready');
  assert.equal((html.match(/storyboard-status-stale/g) ?? []).length, 1);
  assert.equal((html.match(/storyboard-status-rerendering/g) ?? []).length, 1);
  assert.equal((html.match(/storyboard-status-failed/g) ?? []).length, 1);
  assert.match(html, /class="storyboard-status storyboard-status-stale" data-status="stale">stale</);
  assert.match(html, /class="storyboard-status storyboard-status-rerendering" data-status="rerendering">rerendering</);
  assert.match(html, /class="storyboard-status storyboard-status-failed" data-status="failed">failed</);

  assert.equal((html.match(/aria-current="true"/g) ?? []).length, 1);
  const selected = html.match(/<button[^>]*data-scene-id="s_hero"[^>]*>/)[0];
  assert.match(selected, /aria-current="true"/);
  assert.doesNotMatch(html.match(/<button[^>]*data-scene-id="s_title"[^>]*>/)[0], /aria-current/);
});

test('unknown statuses fall back to ready and invalid timelines render an empty state', () => {
  const html = renderStoryboard(launchTimeline, { scenes: { s_title: 'mystery' } });
  assert.match(html.match(/<li[^>]*data-scene-id="s_title"[^>]*>/)[0], /data-status="ready"/);

  assert.match(renderStoryboard(null), /class="storyboard-empty">No scenes yet\.</);
});

test('labels, ids and re-run labels are HTML-escaped', () => {
  const html = renderStoryboard({
    fps: 30,
    scenes: [{
      id: 's"><img src=x onerror=1>',
      layout: 'title',
      from: 0,
      durationInFrames: 30,
      copy: { headline: '<script>alert(1)</script>' },
    }],
  });

  assert.ok(!html.includes('<script>'));
  assert.ok(!html.includes('<img'));
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(html, /data-scene-id="s&quot;&gt;&lt;img src=x onerror=1&gt;"/);
  assert.match(html, /aria-label="Re-run &lt;script&gt;alert\(1\)&lt;\/script&gt;"/);
});

test('delegated clicks call onSelect and onRerun with the scene id', () => {
  const { root, chips } = fakeStoryboard(['s_title', 's_hero', 's_stat']);
  const calls = [];
  const mount = mountStoryboard(root, {
    onSelect: id => calls.push(['select', id]),
    onRerun: id => calls.push(['rerun', id]),
  });

  const rerun = root.querySelectorAll('[data-action="rerun"]')[1];
  root.dispatch('click', { target: rerun });
  assert.deepEqual(calls, [['rerun', 's_hero']]);

  root.dispatch('click', { target: chips[2] });
  assert.deepEqual(calls, [['rerun', 's_hero'], ['select', 's_stat']]);
  assert.equal(chips[2].getAttribute('aria-current'), 'true');
  assert.equal(chips[0].getAttribute('aria-current'), null);

  mount.destroy();
  root.dispatch('click', { target: chips[0] });
  assert.equal(calls.length, 2);
});

test('arrow keys move the selection and call onSelect', () => {
  const { root, chips } = fakeStoryboard(['s_title', 's_hero', 's_stat']);
  const selected = [];
  mountStoryboard(root, { onSelect: id => selected.push(id) });

  root.dispatch('keydown', { target: chips[0], key: 'ArrowRight' });
  assert.deepEqual(selected, ['s_hero']);
  assert.equal(chips[1].getAttribute('aria-current'), 'true');
  assert.equal(chips[0].getAttribute('aria-current'), null);
  assert.equal(chips[1].focused, true);

  root.dispatch('keydown', { target: chips[1], key: 'ArrowRight' });
  assert.deepEqual(selected, ['s_hero', 's_stat']);

  root.dispatch('keydown', { target: chips[2], key: 'ArrowRight' });
  assert.deepEqual(selected, ['s_hero', 's_stat'], 'right at the end stays put');

  root.dispatch('keydown', { target: chips[2], key: 'ArrowLeft' });
  assert.deepEqual(selected, ['s_hero', 's_stat', 's_hero']);
  assert.equal(chips[1].getAttribute('aria-current'), 'true');

  root.dispatch('keydown', { target: chips[0], key: 'ArrowLeft' });
  assert.deepEqual(selected, ['s_hero', 's_stat', 's_hero'], 'left at the start stays put');
});
