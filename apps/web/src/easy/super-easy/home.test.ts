// The web package typecheck has no @types/node; node:test imports are only
// for this file's runtime, so type checking is skipped here like the other
// Easy render tests.
// @ts-nocheck
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { COPY } from './copy.ts';
import { renderSuperEasyHome } from './home.ts';

const MIN_PROMPT_CHARS = 10;

function count(html: string, pattern: RegExp): number {
  return (html.match(pattern) || []).length;
}

function tagWith(html: string, attribute: string): string {
  const match = html.match(new RegExp(`<[a-z]+\\b[^>]*${attribute}[^>]*>`, 'u'));
  assert.ok(match, `missing ${attribute}`);
  return match[0];
}

test('Super Easy shows the Comfyrizz brand on the home screen', () => {
  const html = renderSuperEasyHome();
  assert.match(html, /class="super-easy-brand" aria-label="Comfyrizz"/u);
  assert.match(html, /class="super-easy-brand-name">Comfyrizz<\/span>/u);
  assert.match(html, /AI film studio/u);
});

test('Super Easy shows one primary Generate button and no level picker', () => {
  const html = renderSuperEasyHome();

  const buttons = html.match(/<button\b[^>]*>/g) ?? [];
  const primary = buttons.filter((button) => /class="[^"]*\bbtn-primary\b/u.test(button));
  assert.equal(primary.length, 1, 'exactly one primary button');
  assert.match(primary[0], /data-super-easy-generate/u);
  assert.match(html, /<button[^>]*data-super-easy-generate[^>]*>Generate<\/button>/u);
  assert.equal(COPY.home.generate, 'Generate');

  assert.match(html, /data-super-easy-home/u);
  assert.match(html, /data-super-easy-form/u);
  assert.equal(count(html, /data-iteration-choice=/g), 0);
  assert.equal(count(html, /data-easy-level=/g), 0);
  assert.equal(count(html, /iteration-card/g), 0);
  assert.equal(count(html, /<select\b/g), 1, 'one motion-model selector, not an iteration-level or plan editor');
  assert.match(html, /data-super-easy-motion-model/u);
  assert.equal(count(html, /<input\b/g), 0, 'the happy path is one text box');
});

test('the prompt is a textarea with a real accessible label and the friendlier copy', () => {
  const html = renderSuperEasyHome();

  const textareas = html.match(/<textarea\b[^>]*>/g) ?? [];
  assert.equal(textareas.length, 1, 'one prompt box');
  const textarea = textareas[0];
  assert.match(textarea, /id="super-easy-prompt"/u);
  assert.match(textarea, /name="prompt"/u);
  assert.match(textarea, /rows="4"/u);
  assert.match(textarea, /required/u);
  assert.match(textarea, new RegExp(`minlength="${MIN_PROMPT_CHARS}"`, 'u'));
  assert.match(textarea, new RegExp(`placeholder="${COPY.home.promptPlaceholder}"`, 'u'));

  const label = html.match(/<label\b[^>]*for="super-easy-prompt"[^>]*>([^<]*)<\/label>/u);
  assert.ok(label, 'the label points at the prompt');
  assert.equal(label[1], COPY.home.promptLabel);
  assert.equal(COPY.home.promptLabel, 'What is your video about?');

  const describedBy = textarea.match(/aria-describedby="([^"]+)"/u);
  assert.ok(describedBy, 'the prompt explains itself');
  assert.match(html, new RegExp(`id="${describedBy[1]}"`, 'u'));
  assert.match(html, new RegExp(`>${COPY.home.emptyPrompt}</p>`, 'u'));
});

test('the more-control link leaves for the Easy studio without looking like a submit button', () => {
  const html = renderSuperEasyHome();
  const link = html.match(/<a\b[^>]*data-super-easy-more-control[^>]*>([^<]*)<\/a>/u);
  assert.ok(link, 'the more-control link is present');
  assert.equal(link[1], COPY.home.moreControl);
  assert.equal(COPY.home.moreControl, 'I want more control');
  assert.match(link[0], /href="\?step=idea"/u);
  assert.equal(count(html, /data-super-easy-more-control/g), 1);
});

test('Try an example is an optional secondary action, never a second primary', () => {
  const html = renderSuperEasyHome();
  const example = tagWith(html, 'data-super-easy-example');
  assert.match(example, /type="button"/u);
  assert.match(example, /btn-secondary/u);
  assert.doesNotMatch(example, /btn-primary/u);
  assert.match(html, /<button[^>]*data-super-easy-example[^>]*>Try an example<\/button>/u);
  assert.equal(COPY.home.tryExample, 'Try an example');
});

test('the home has no plan or shot editing on the happy path', () => {
  const html = renderSuperEasyHome();
  assert.equal(count(html, /data-easy-plan/g), 0);
  assert.equal(count(html, /data-easy-shot/g), 0);
  assert.equal(count(html, /data-shot-/g), 0);
});

test('the section is labelled by its heading', () => {
  const html = renderSuperEasyHome();
  assert.match(html, /<section[^>]*aria-labelledby="super-easy-title"[^>]*data-super-easy-home/u);
  assert.match(html, /<h1[^>]*id="super-easy-title"[^>]*>Make a video<\/h1>/u);
  assert.equal(COPY.home.title, 'Make a video');
});

test('a prefilled prompt is escaped before it reaches the page', () => {
  const html = renderSuperEasyHome({ prompt: '<script>alert("hi")</script>' });
  assert.doesNotMatch(html, /<script>/u);
  assert.match(html, /&lt;script&gt;alert\(&quot;hi&quot;\)&lt;\/script&gt;/u);
  const primary = (html.match(/<button\b[^>]*>/g) ?? [])
    .filter((button) => /class="[^"]*\bbtn-primary\b/u.test(button));
  assert.equal(primary.length, 1, 'still one primary Generate');
});

test('home.css styles the Super Easy home without a second layout system', () => {
  const css = readFileSync(fileURLToPath(new URL('./home.css', import.meta.url)), 'utf8');
  for (const selector of [
    '.super-easy-home',
    '.super-easy-home-title',
    '.super-easy-home-prompt',
    '.super-easy-home-generate',
    '.super-easy-home-example',
    '.super-easy-home-more',
  ]) {
    assert.ok(css.includes(selector), `missing ${selector}`);
  }
});

test('the hint coaches instead of scolding, and the empty-prompt message waits for a short Generate', () => {
  const html = renderSuperEasyHome();
  assert.match(html, new RegExp(`id="super-easy-prompt-hint">${COPY.home.hint}</p>`, 'u'));
  assert.match(COPY.home.hint, /Google Colab/u);
  const error = tagWith(html, 'data-super-easy-prompt-error');
  assert.match(error, /role="alert"/u);
  assert.match(error, /\bhidden\b/u);
  assert.match(html, /<form[^>]*data-super-easy-form[^>]*novalidate/u, 'our message, not the browser tooltip');
});

test('idea chips are one-click starting prompts, never a second primary', () => {
  const html = renderSuperEasyHome();
  const chips = html.match(/<button\b[^>]*data-super-easy-idea="[a-z]+"[^>]*>[^<]+<\/button>/gu) ?? [];
  assert.equal(chips.length, Object.keys(COPY.ideas).length);
  assert.ok(chips.length >= 3);
  for (const chip of chips) {
    assert.match(chip, /type="button"/u);
    assert.doesNotMatch(chip, /btn-primary/u);
  }
  assert.match(html, new RegExp(`>${COPY.ideas.coffee}</button>`, 'u'));
});
