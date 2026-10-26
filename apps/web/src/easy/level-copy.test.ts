// EX05: the compact stepper uses the short "Level" label, and the level intro
// tells the truth for the compute the user picked. No network, no Google Colab
// session and no rendering code: these are pure copy and stepper tests.
//
// node:test imports are runtime-only, so type checking is skipped like the
// other Easy tests.
// @ts-nocheck
import test from 'node:test';
import assert from 'node:assert/strict';

import { COPY } from './copy.ts';
import { compactStepName, levelIntro } from './level-copy.ts';
import { renderStepper } from './stepper.ts';

const state = {
  version: 1,
  packageId: null,
  chatId: null,
  productionId: null,
  offline: false,
  idea: { text: 'A thirty second video about a bakery.', lengthS: 30, aspect: '16:9', look: 'clay', sound: true },
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

const facts = { hasPackage: true, planApproved: false, actionsActive: false, allShotsKept: false, exportCurrent: false };

function compactText(html) {
  const match = html.match(/class="stepper-compact"[^>]*>([^<]*)<\/button>/);
  return match ? match[1] : '';
}

test('the compact stepper shows the short Level label', () => {
  assert.equal(compactStepName('level'), 'Level');
  assert.equal(compactStepName('idea'), COPY.steps.idea);

  const html = renderStepper({ current: 'level', state, facts });
  const compact = compactText(html);
  assert.match(compact, /Step 3 of 7 · Level/);
  assert.equal(compact.includes('Iteration level'), false);

  assert.match(html, /Iteration level/);
});

test('the This computer intro does not claim versions use Google Colab', () => {
  const intro = levelIntro('cpu');
  assert.match(intro, /more versions/i);
  assert.equal(intro.toLowerCase().includes(COPY.compute.colabTitle.toLowerCase()), false);
  assert.equal(intro, COPY.level.intro);
  assert.equal(COPY.level.intro.toLowerCase().includes(COPY.compute.colabTitle.toLowerCase()), false);
});

test('the Google Colab intro stays honest about units', () => {
  const intro = levelIntro('colab');
  assert.match(intro, /more versions/i);
  assert.match(intro, new RegExp(COPY.compute.colabTitle));
  assert.match(intro, /units/);
});

test('the level heading stays friendly and unchanged', () => {
  assert.equal(COPY.level.heading, 'How many versions should we try?');
});
