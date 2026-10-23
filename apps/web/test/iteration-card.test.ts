// IL15: Easy iteration picker. Node has no DOM, so the card is pure HTML.
// @ts-nocheck
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ITERATION_CHOICES,
  ITERATION_SPEND_NOTE,
  bareColabMentions,
  describeIterationLevel,
  iterationCardOnKey,
  iterationPresets,
  policyForIterationChoice,
  readIterationCard,
  renderIterationCard,
} from '../src/productions/cards/iteration-card.ts';

const PRODUCTION_ID = 'prod_0123456789abcdef01234567';

function range(low, expected, high) {
  return { low, expected, high };
}

function estimate(overrides = {}) {
  return {
    gpuMinutes: range(1.2, 2.4, 3.8),
    units: range(0.2, 0.4, 0.6),
    wallMinutes: range(5.2, 6.4, 7.8),
    voiceSamples: 2,
    vsCap: { ceiling: null, fraction: null, status: 'no_cap' },
    labels: ['estimate; other sessions may be running'],
    ...overrides,
  };
}

function policy(level) {
  return iterationPresets()[level];
}

function readBody(overrides = {}) {
  return {
    policy: null,
    level: null,
    estimates: {
      draft: estimate({ units: range(0.1, 0.2, 0.3), vsCap: { ceiling: null, fraction: null, status: 'no_cap' } }),
      balanced: estimate(),
      director: estimate({
        units: range(0.8, 1.2, 1.8),
        vsCap: { ceiling: 1, fraction: 1.2, status: 'exceeds' },
        suggestedLevel: 'balanced',
        labels: ['estimate; other sessions may be running', 'unmeasured estimate'],
      }),
    },
    recommendation: {
      level: 'balanced',
      policy: policy('balanced'),
      reasons: ['no history: balanced'],
    },
    prefill: null,
    lockedShotIds: [],
    revision: 4,
    ...overrides,
  };
}

function ready(overrides = {}, readOverrides = {}) {
  return readIterationCard(readBody(readOverrides), { productionId: PRODUCTION_ID, ...overrides });
}

test('describeIterationLevel uses the preset numbers', () => {
  const presets = iterationPresets();
  assert.equal(
    describeIterationLevel(presets.draft),
    'One version of everything. Fastest. Picked for you.',
  );
  assert.equal(
    describeIterationLevel(presets.balanced),
    '2 voice options, 2 image options, 2 versions of each shot. You pick the best version.',
  );
  assert.equal(
    describeIterationLevel(presets.director),
    '2 scripts, 3 voice options, 3 image options, up to 6 versions of each shot over 2 rounds. You pick at every stage.',
  );
});

test('the Easy picker renders four cards and does not preselect one', () => {
  const html = renderIterationCard(ready());
  assert.equal(html.match(/data-iteration-choice="/g).length, 4);
  for (const choice of ITERATION_CHOICES) {
    assert.match(html, new RegExp(`data-iteration-choice="${choice}"`));
  }
  assert.match(html, /role="radiogroup"/);
  assert.equal(html.match(/role="radio"/g).length, 4);
  assert.equal(html.match(/aria-checked="true"/g), null);
  assert.match(html, /data-recommended="true"/);
  assert.match(html, /Recommended for this project/);
  assert.match(html, /Fine-tune in Advanced/);
  assert.match(html, /How many versions should we try/);
});

test('ranges are labelled estimate, no-cap copy shows, and exceeds has a badge', () => {
  const html = renderIterationCard(ready());
  assert.match(html, /Estimate:/);
  assert.match(html, /estimate; other sessions may be running/);
  assert.match(html, /No spend cap set/);
  assert.match(html, /data-cap-status="exceeds"/);
  assert.match(html, /data-iteration-exceeds/);
  assert.match(html, /Over the cap/);
  assert.match(html, /unmeasured estimate/);
  assert.match(html, /A lower level may fit: Balanced/);
  assert.match(html, new RegExp(ITERATION_SPEND_NOTE.replace(/[.]/g, '\\.')));
});

test('loading, empty, error and stale states are distinct', () => {
  const loading = renderIterationCard(readIterationCard(null, { loading: true, productionId: PRODUCTION_ID }));
  assert.match(loading, /data-card-status="loading"/);
  assert.match(loading, /aria-busy="true"/);
  assert.match(loading, /Loading iteration levels/);

  const empty = renderIterationCard(readIterationCard(null, { productionId: PRODUCTION_ID }));
  assert.match(empty, /data-card-status="empty"/);
  assert.match(empty, /No iteration level to show yet/);

  const error = renderIterationCard(readIterationCard(readBody(), {
    error: 'The iteration read failed.',
    productionId: PRODUCTION_ID,
  }));
  assert.match(error, /data-card-status="error"/);
  assert.match(error, /role="alert"/);
  assert.match(error, /The iteration read failed/);

  const stale = renderIterationCard(ready({ stale: true }));
  assert.match(stale, /data-card-status="stale"/);
  assert.match(stale, /Refresh before choosing/);
  assert.match(stale, /aria-disabled="true"/);
});

test('arrow keys are a radio group and a stale card does not choose', () => {
  const first = iterationCardOnKey(ready(), 'ArrowLeft');
  assert.equal(first.handled, true);
  assert.equal(first.choice, 'director');
  assert.equal(first.model.selected, 'director');
  const html = renderIterationCard(first.model);
  assert.match(html, /data-iteration-choice="director"[^>]*aria-checked="true"|aria-checked="true"[^>]*data-iteration-choice="director"/);
  assert.match(html, /role="status"/);
  assert.match(html, /aria-live="polite"/);
  assert.match(html, /Director selected/);
  assert.match(html, /You still approve each spend/);
  const tabindexes = [...html.matchAll(/tabindex="([^"]+)"/g)].map((match) => match[1]);
  assert.equal(tabindexes.filter((value) => value === '0').length, 1);

  const stale = iterationCardOnKey(ready({ stale: true }), 'ArrowRight');
  assert.equal(stale.handled, true);
  assert.equal(stale.choice, null);
  assert.equal(stale.model.selected, null);
});

test('choosing a level returns a policy and never a spend approval', () => {
  const read = readBody();
  const chosen = policyForIterationChoice(read, 'draft');
  assert.equal(chosen.level, 'draft');
  assert.equal(chosen.stages.video.takes, 1);
  assert.equal('kind' in chosen, false);
  assert.equal('actor' in chosen, false);
  assert.equal(JSON.stringify(chosen).includes('plan.approve'), false);

  const recommended = policyForIterationChoice(read, 'recommended');
  assert.equal(recommended.level, 'balanced');
  assert.equal(JSON.stringify(recommended).includes('plan.approve'), false);
});

test('visible copy says Google Colab and never Colab alone', () => {
  const html = renderIterationCard(ready());
  assert.match(html, /Google Colab/);
  assert.deepEqual(bareColabMentions(html), []);
});
