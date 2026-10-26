// EX06: the default Idea path runs textarea -> templates -> length -> shape,
// with Look tucked behind More options. Wide screens get a tip/example column
// instead of an empty gutter. This is a markup contract test: no CSS file is
// read from disk, because steps/*.ts is eagerly bundled by index.ts.
// @ts-nocheck
import test from 'node:test';
import assert from 'node:assert/strict';

import { COPY } from '../copy.ts';
import { step } from './idea.ts';

const state = {
  version: 1,
  packageId: null,
  chatId: null,
  productionId: null,
  offline: false,
  idea: {
    text: 'A thirty second video for my bakery announcing our new sourdough subscription.',
    lengthS: 30,
    aspect: '16:9',
    look: 'clay',
    sound: true,
  },
  questions: [],
  questionsAsked: true,
  answers: {},
  cast: [],
  narration: { on: false, voiceId: null },
  level: 'draft',
  levelTouched: false,
  compute: 'cpu',
  spendCap: null,
  planHash: null,
  plan: { status: 'none', error: null, errorAt: null, wordsChanged: false },
  generate: { status: 'idle' },
  review: { shotId: null },
  exported: { revision: null, at: null },
};

const facts = {
  hasPackage: false,
  planApproved: false,
  actionsActive: false,
  allShotsKept: false,
  exportCurrent: false,
};

function markup(): string {
  return step.render(state, facts);
}

function indexOf(html: string, needle: string): number {
  const index = html.indexOf(needle);
  assert.notEqual(index, -1, `missing ${needle}`);
  return index;
}

if (typeof window === 'undefined') {
  test('the default Idea path stops at Continue without surfacing Look', () => {
    const html = markup();
    const textarea = indexOf(html, 'id="easy-idea"');
    const templates = indexOf(html, 'class="easy-idea-templates"');
    const length = indexOf(html, 'class="easy-segmented easy-idea-length"');
    const shape = indexOf(html, 'class="easy-segmented easy-idea-shape"');

    assert.ok(textarea < templates, 'templates should follow the textarea');
    assert.ok(templates < length, 'length should follow templates');
    assert.ok(length < shape, 'shape should follow length');
    assert.equal(step.primaryLabel(state), COPY.idea.continue);
  });

  test('Look sits behind More options', () => {
    const html = markup();
    const shape = indexOf(html, 'class="easy-segmented easy-idea-shape"');
    const detailsStart = indexOf(html, '<details class="easy-idea-more"');
    const detailsEnd = indexOf(html, '</details>');
    const look = indexOf(html, 'class="easy-choice-cards easy-idea-looks"');

    assert.ok(shape < detailsStart, 'More options should follow shape');
    assert.ok(look > detailsStart, 'Look cards should be inside More options');
    assert.ok(look < detailsEnd, 'Look cards should not follow More options');
    assert.ok(
      html.slice(detailsStart, detailsEnd).includes(COPY.idea.look),
      'More options should name the Look choice',
    );
    assert.ok(
      html.slice(html.indexOf('class="easy-idea-form"'), detailsStart).includes('easy-idea-looks') === false,
      'Look cards must not stay in the default path',
    );
  });

  test('wide screens get a tip/example aside in the layout', () => {
    const html = markup();
    const layout = indexOf(html, 'class="easy-two-col easy-idea-layout"');
    const tip = indexOf(html, 'class="easy-idea-tip"');
    const example = indexOf(html, 'class="easy-idea-tip-example"');

    assert.ok(layout < tip, 'the tip should live in the wide layout');
    assert.ok(tip < example, 'the tip should lead with its example');
    assert.ok(html.includes(COPY.idea.placeholder), 'the example reuses the idea placeholder');

    const asideStart = html.lastIndexOf('<aside', tip);
    const asideEnd = html.indexOf('</aside>', tip);
    assert.notEqual(asideStart, -1, 'the tip should be an aside');
    assert.ok(asideEnd > tip, 'the tip should close');
    const aside = html.slice(asideStart, asideEnd);
    assert.equal(/tabindex|<button|<input|<a\s/i.test(aside), false, 'the tip must stay out of the tab path');
  });

  test('the Idea markup has no fixed widths that break at 390px', () => {
    const html = markup();
    assert.equal(/\sstyle=/i.test(html), false, 'layout should come from classes, not inline widths');
    assert.equal(/<table/i.test(html), false, 'the Idea form should not depend on a fixed table');
    indexOf(html, 'easy-idea-layout');
    indexOf(html, 'class="easy-idea-form"');
    indexOf(html, 'class="easy-idea-templates"');
    indexOf(html, 'class="easy-segmented easy-idea-length"');
    indexOf(html, 'class="easy-segmented easy-idea-shape"');
  });
}
