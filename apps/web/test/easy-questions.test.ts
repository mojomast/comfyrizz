// @ts-nocheck
// UR11: inline questions on the Idea step.

import test from 'node:test';
import assert from 'node:assert/strict';

import { COPY } from '../src/easy/copy.ts';
import { answersToDecisions, renderQuestions } from '../src/easy/steps/questions.ts';

const questions = [
  {
    id: 'cta',
    field: 'cta',
    prompt: 'What should viewers do at the end?',
    options: ['visit the website', 'subscribe', 'none'],
    decide: 'none',
  },
  {
    id: 'audience',
    field: 'audience.who',
    prompt: 'Who is this for?',
    options: ['customers', 'developers'],
    decide: 'developers',
  },
  {
    id: 'length',
    field: 'length_s',
    prompt: 'How long?',
    options: ['30 s social', '45-60 s landing page'],
    decide: '45-60 s landing page',
  },
];

function count(html, pattern) {
  return (html.match(pattern) || []).length;
}

test('three questions render three fieldsets with the decide radio checked', () => {
  const html = renderQuestions(questions, {});

  assert.match(html, /<section\b[^>]*aria-labelledby="easy-q-h"/);
  assert.match(html, /<h2\b[^>]*id="easy-q-h"[^>]*tabindex="-1"[^>]*>/);
  assert.ok(html.includes(COPY.questions.heading));

  assert.equal(count(html, /<fieldset\b/g), 3);
  assert.equal(count(html, /<legend\b/g), 3);

  const decide = html.match(/<input[^>]*value="__decide__"[^>]*>/g) || [];
  assert.equal(decide.length, 3);
  for (const input of decide) {
    assert.match(input, /checked/);
  }
  assert.equal(count(html, new RegExp(`>${COPY.questions.decide}<`, 'g')), 3);

  assert.ok(html.includes('Visit the website'));
  assert.ok(!html.includes('>visit the website<'));
  assert.ok(html.includes(COPY.questions.none));
  assert.ok(html.includes(COPY.questions.decide));
  assert.ok(html.includes('>customers<') === false);
  assert.ok(html.includes('Customers'));
});

test('answersToDecisions skips decide answers and maps field', () => {
  const decisions = answersToDecisions(questions, {
    cta: '__decide__',
    audience: 'customers',
    length: '30 s social',
  });

  assert.deepEqual(decisions, {
    'audience.who': 'customers',
    length_s: '30 s social',
  });
  assert.equal('cta' in decisions, false);
});

test('the legend text is escaped', () => {
  const html = renderQuestions([
    {
      id: 'audience',
      field: 'audience.who',
      prompt: '<script>alert("hi")</script>',
      options: ['<b>customers</b>'],
      decide: 'developers',
    },
  ], {});

  assert.ok(html.includes('&lt;script&gt;alert(&quot;hi&quot;)&lt;/script&gt;'));
  assert.ok(!html.includes('<script>'));
  assert.ok(html.includes('&lt;b&gt;customers&lt;/b&gt;'));
});
