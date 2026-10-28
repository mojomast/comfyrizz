// @ts-nocheck
// UR10: the Idea step render, the brief prompt and the short-idea error.

import test from 'node:test';
import assert from 'node:assert/strict';

import { COPY } from '../src/easy/copy.ts';
import { defaultEasyState } from '../src/easy/store.ts';
import { templateChangeNeedsConfirm, templateChangePlan, step } from '../src/easy/steps/idea.ts';
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
  assert.match(html, /<fieldset[^>]*class="easy-idea-templates"/);
  assert.match(html, /<legend[^>]*>Start from<\/legend>/);
  for (const template of COPY.idea.templates) {
    assert.match(html, new RegExp(`<label[^>]*class="easy-chip easy-idea-template"[^>]*data-easy-template="${template.id}"`));
    assert.match(html, new RegExp(`<input[^>]*type="radio"[^>]*name="easy-idea-template"[^>]*value="${template.id}"`));
    assert.ok(html.includes(template.label));
  }

  const templates = html.match(/<input[^>]*name="easy-idea-template"[^>]*>/g) || [];
  assert.equal(templates.length, 4);
  assert.equal(count(html, /<button\b/g), 0);
  assert.equal(count(html, /tabindex=/g), 0);

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

test('(a) checking a template with an empty textarea applies its text with no confirm', () => {
  const template = COPY.idea.templates[0];
  const plan = templateChangePlan('', template.id, null);

  assert.ok(plan);
  assert.equal(plan.needsConfirm, false);
  assert.equal(plan.text, template.text);
  assert.equal(plan.restoreId, null);

  assert.equal(templateChangeNeedsConfirm('   ', COPY.idea.templates), false);
});

test('(b) moving between templates while the textarea holds template text needs no confirm', () => {
  const first = COPY.idea.templates[0];
  const second = COPY.idea.templates[1];
  const plan = templateChangePlan(first.text, second.id, first.id);

  assert.ok(plan);
  assert.equal(plan.needsConfirm, false);
  assert.equal(plan.text, second.text);
  assert.equal(templateChangeNeedsConfirm(first.text, COPY.idea.templates), false);
  assert.equal(templateChangeNeedsConfirm(`  ${first.text}  `, COPY.idea.templates), false);
});

test('(c) user-written text needs a confirm and cancelling restores the previous template', () => {
  const target = COPY.idea.templates[2];
  const plan = templateChangePlan('My own bakery idea', target.id, 'launch');

  assert.ok(plan);
  assert.equal(plan.needsConfirm, true);
  assert.equal(plan.text, target.text);
  assert.equal(plan.restoreId, 'launch');
  assert.equal(templateChangeNeedsConfirm('My own bakery idea', COPY.idea.templates), true);

  const withoutPrevious = templateChangePlan('My own bakery idea', target.id, null);
  assert.ok(withoutPrevious);
  assert.equal(withoutPrevious.restoreId, null);
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
    'A 30-second video for my bakery. Aspect: 16:9. Look: cinematic-dark. Music: instrumental bed. Finishing narration: meaningful scene-specific Kokoro voiceover that preserves the native soundscape. What should viewers do at the end? Visit the website',
  );

  state.idea.sound = false;
  assert.ok(ideaPrompt(state).includes('No music.'));
});

test('ideaPrompt uses the selected duration but explicit typed durations win', () => {
  const state = ideaState();
  state.idea.text = 'A warm bakery launch with a friendly ending';
  state.idea.lengthS = 60;
  assert.match(ideaPrompt(state), /Length: about 60 seconds\./u);

  state.idea.text = 'A 15-second bakery teaser with a warm ending';
  state.idea.lengthS = 90;
  const prompt = ideaPrompt(state);
  assert.match(prompt, /A 15-second bakery teaser/u);
  assert.doesNotMatch(prompt, /Length: about/u);
});

test('ideaPrompt defaults to meaningful Kokoro finishing narration without replacing native sound', () => {
  const state = ideaState();
  state.idea.text = 'A baker shapes a loaf as the morning market wakes up';
  const prompt = ideaPrompt(state);
  assert.match(prompt, /Finishing narration: meaningful scene-specific Kokoro voiceover that preserves the native soundscape\./u);
  assert.doesNotMatch(prompt, /H3|native[ -]dialogue/iu);
});

test('explicit wordless and no-speech requests suppress automatic narration guidance', () => {
  for (const text of [
    'A wordless bakery story told through hands and warm light',
    'A bakery story with no dialogue, just the morning market',
    'A bakery story with no narration please',
    'A bakery story with no speech at all',
    'A bakery story with no voiceover',
  ]) {
    const state = ideaState();
    state.idea.text = text;
    state.narration.on = true;
    const prompt = ideaPrompt(state);
    assert.ok(prompt.startsWith(text));
    assert.doesNotMatch(prompt, /Kokoro|Finishing narration:/u);
  }
});

test('narration off adds no narration only when the prompt has no speech intent', () => {
  const state = ideaState();
  state.idea.text = 'A baker shapes a loaf as the morning market wakes up';
  state.narration.on = false;
  assert.match(ideaPrompt(state), /No narration\./u);

  state.idea.text = 'A cheerful narrator introduces the morning bakery special';
  assert.doesNotMatch(ideaPrompt(state), /No narration\./u);

  state.idea.text = 'Two bakers speak on camera about their morning special';
  assert.doesNotMatch(ideaPrompt(state), /No narration\./u);

  state.idea.text = 'A wordless morning bakery story';
  assert.doesNotMatch(ideaPrompt(state), /No narration\./u);
});

test('a short idea renders the tooShort message linked by aria-describedby', () => {
  const state = ideaState();
  state.idea.text = 'Hi';
  const html = step.render(state, facts, { error: 'tooShort' });

  assert.match(html, /id="easy-idea-too-short"/);
  assert.ok(html.includes(COPY.idea.tooShort));
  assert.match(html, /<textarea[^>]*aria-describedby="[^"]*easy-idea-too-short/);
});
