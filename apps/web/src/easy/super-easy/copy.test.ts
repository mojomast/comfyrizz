// The web package typecheck has no @types/node; node:test imports are only
// for this file's runtime, so type checking is skipped here like api.test.ts.
// @ts-nocheck
import test from 'node:test';
import assert from 'node:assert/strict';
import { COPY, fill, keys } from './copy.ts';

function strings(value: unknown, path = ''): Array<{ path: string; text: string }> {
  if (typeof value === 'string') return [{ path, text: value }];
  const out: Array<{ path: string; text: string }> = [];
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    out.push(...strings(child, path === '' ? key : `${path}.${key}`));
  }
  return out;
}

test('keys cover the home, making, gauge, gallery, done and Google Colab copy', () => {
  const all = keys();
  const required = [
    'home.promptPlaceholder',
    'home.generate',
    'home.tryExample',
    'home.moreControl',
    'making.title',
    'stages.plan',
    'stages.characters',
    'stages.shots',
    'stages.voice',
    'stages.video',
    'gallery.empty',
    'gallery.loading',
    'gallery.error',
    'done.download',
    'done.again',
    'googleColab.title',
    'googleColab.body',
    'googleColab.confirm',
    'googleColab.cancel',
  ];
  for (const key of required) {
    assert.ok(all.includes(key), `missing copy key ${key}`);
  }
});

test('keys lists every leaf once, in a stable dotted order', () => {
  const all = keys();
  const leaves = strings(COPY).map((entry) => entry.path);
  assert.deepEqual(all.slice().sort(), leaves.slice().sort());
  assert.deepEqual(all, all.slice().sort(), 'keys are sorted');
  assert.equal(new Set(all).size, all.length, 'keys are unique');
  for (const key of all) {
    assert.match(key, /^[A-Za-z][A-Za-z0-9]*(\.[A-Za-z][A-Za-z0-9]*)+$/, `bad key ${key}`);
  }
});

test('the primary call to action and gauge labels use the agreed child-simple words', () => {
  assert.equal(COPY.home.generate, 'Generate');
  assert.equal(COPY.home.tryExample, 'Try an example');
  assert.equal(COPY.home.moreControl, 'I want more control');
  assert.equal(COPY.stages.plan, 'Plan');
  assert.equal(COPY.stages.characters, 'Characters');
  assert.equal(COPY.stages.shots, 'Shots');
  assert.equal(COPY.stages.voice, 'Voice');
  assert.equal(COPY.stages.video, 'Video');
  assert.equal(COPY.done.download, 'Download');
  assert.equal(COPY.done.again, 'Make another');
  assert.ok(COPY.home.promptPlaceholder.length > 0);
  assert.ok(COPY.making.title.length > 0);
  assert.ok(COPY.gallery.empty.length > 0);
  assert.ok(COPY.gallery.loading.length > 0);
  assert.ok(COPY.gallery.error.includes("Couldn't make"));
});

test('fill substitutes named values and leaves unknown placeholders alone', () => {
  assert.equal(
    fill(COPY.gallery.error, { stage: 'the shots' }),
    "Couldn't make the shots. Try again.",
  );
  assert.equal(fill(COPY.gallery.error, {}), COPY.gallery.error);
  assert.equal(fill('{a} and {b}', { a: 1, b: 'two' }), '1 and two');
});

test('every Google Colab mention is spelled out and never bare', () => {
  let mentions = 0;
  for (const { path, text } of strings(COPY)) {
    for (const match of text.matchAll(/Colab/g)) {
      mentions += 1;
      const before = text.slice(0, match.index);
      assert.ok(
        before.endsWith('Google '),
        `${path} is missing the Google prefix: ${text}`,
      );
    }
  }
  assert.ok(mentions > 0, 'the Google Colab confirm copy exists');
});

test('copy is frozen all the way down', () => {
  assert.ok(Object.isFrozen(COPY));
  for (const { path } of strings(COPY)) {
    const parts = path.split('.');
    let node: unknown = COPY;
    for (const part of parts.slice(0, -1)) node = (node as Record<string, unknown>)[part];
    assert.ok(Object.isFrozen(node), `${path} parent is frozen`);
  }
  assert.throws(() => {
    COPY.home.generate = 'Ship it';
  });
});
