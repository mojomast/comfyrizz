// @ts-nocheck
// UR10: the Idea step render, the brief prompt and the short-idea error.

import test from 'node:test';
import assert from 'node:assert/strict';

import { COPY } from '../src/easy/copy.ts';
import { defaultEasyState } from '../src/easy/store.ts';
import { step } from '../src/easy/steps/idea.ts';
import { ideaPrompt } from '../src/easy/idea-prompt.ts';

const facts = {
  hasPackage: false,
  planApproved: false,
  actionsActive: false,
  allShotsKept: false,
  exportCurrent: false,
};

function count(html, pattern) {
  return (html.match(pattern) || []).length;
}

function ideaState() {
  const state = defaultEasyState();
  state.idea.text = 'A 30-second video for my bakery.';
  return state;
}

test('the idea render has one labelled textarea, templates, segments and look cards', () => {
  const html = step.render(ideaState(), facts);

  assert.equal(step.id, 'idea');
  assert.equal(step.heading, COPY.idea.heading);
  assert.equal(step.intro, COPY.idea.intro);

  assert.equal(count(html, /<textarea\b/g), 1);
  assert.match(html, /<textarea[^>]*id="easy-idea"/);
  assert.match(html, /<textarea[^>]*rows="4"/);
  assert.match(html, /<label[^>]*for="easy-idea"[^>]*>Your idea<\/label>/);

  assert.equal(count(html, /data-easy-template=/g), 4);
  for (const template of COPY.idea.templates) {
    assert.match(html, new RegExp(`data-easy-template="${template.id}"`));
    assert.ok(html.includes(template.label));
  }

  const lengths = html.match(/<input[^>]*name="easy-idea-length"[^>]*>/g) || [];
  assert.equal(lengths.length, 4);
  assert.match(html, /name="easy-idea-length"[^>]*value="30"[^>]*checked/);
  for (const seconds of [15, 30, 60, 90]) {
    assert.match(html, new RegExp(`name="easy-idea-length"[^>]*value="${seconds}"`));
  }

  const shapes = html.match(/<input[^>]*name="easy-idea-shape"[^>]*>/g) || [];
  assert.equal(shapes.length, 3);
  for (const aspect of ['16:9', '9:16', '1:1']) {
    assert.ok(html.includes(`value="${aspect}"`));
  }

  const looks = html.match(/<label[^>]*data-easy-look="[^"]+"/g) || [];
  assert.equal(looks.length, 6);
  for (const id of ['clay', 'glass', 'editorial-flat', 'isometric-tech', 'paper-cut', 'cinematic-dark']) {
    assert.match(html, new RegExp(`data-easy-look="${id}"`));
    assert.ok(html.includes(COPY.idea.looks[id]));
  }

  assert.match(html, /<details[^>]*class="easy-idea-more"/);
  assert.match(html, /data-easy-references/);
  assert.match(html, /type="checkbox"[^>]*id="easy-idea-sound"[^>]*checked/);
});

test('ideaPrompt keeps the brief sentence order and skips decide answers', () => {
  const state = ideaState();
  state.questions = [
    {
      id: 'cta',
      field: 'cta',
      prompt: 'What should viewers do at the end?',
      options: ['Visit the website', 'Subscribe'],
      decide: 'none',
    },
  ];
  state.answers = { cta: 'Visit the website', audience: '__decide__' };

  assert.equal(
    ideaPrompt(state),
    'A 30-second video for my bakery. Length: about 30 seconds. Aspect: 16:9. Look: clay. Music: instrumental bed. What should viewers do at the end? Visit the website',
  );

  state.idea.sound = false;
  assert.ok(ideaPrompt(state).includes('No music.'));
});

test('a short idea renders the tooShort message linked by aria-describedby', () => {
  const state = ideaState();
  state.idea.text = 'Hi';
  const html = step.render(state, facts, { error: 'tooShort' });

  assert.match(html, /id="easy-idea-too-short"/);
  assert.ok(html.includes(COPY.idea.tooShort));
  assert.match(html, /<textarea[^>]*aria-describedby="[^"]*easy-idea-too-short/);
});
