import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyProductionIntent } from '../src/production-intent.js';

test('duration intent distinguishes explicit exact targets from approximate requests', () => {
  for (const seconds of [12, 40, 45]) {
    const intent = classifyProductionIntent(`Motion explainer. Length: exactly ${seconds} seconds; account for transitions.`);
    assert.equal(intent.requestedSeconds, seconds);
    assert.equal(intent.exactDuration, true);
  }
  assert.equal(classifyProductionIntent('About 45 seconds of motion graphics.').exactDuration, false);
  assert.equal(classifyProductionIntent('Exactly one minute and 12 seconds.').requestedSeconds, 72);
  assert.equal(classifyProductionIntent('Exactly one minute and 12 seconds.').exactDuration, true);
});

test('recorded Data Story runtime wins over minute-valued source measurements', () => {
  const brief = 'Make exactly 20 seconds of landscape Data Story using these supplied fictional practice values: Monday 10 minutes, Tuesday 15 minutes, Wednesday 20 minutes, Thursday 25 minutes. The attached fictional-study.csv contains the same four values. Label the film FICTIONAL STUDY LOG so it is clearly an illustration, not a claim about real people. Show four bars in that order, labelled with the exact day and minutes. These are measurements, not counts of CSV rows. End by highlighting Thursday, 25 minutes. Navy, cream and one orange highlight. Use a simple bar reveal and a readable final hold. No narration, inferred causes, percentages or additional statistics. Use a gentle instrumental bed if supported. Aspect: 16:9. Look: photorealistic live-action humans, natural skin and real-world materials.';
  const intent = classifyProductionIntent(brief);
  assert.equal(intent.requestedSeconds, 20);
  assert.equal(intent.exactDuration, true);
});

test('explicit output duration wins regardless of source-data position or unit', () => {
  for (const source of ['Monday 10 minutes, Tuesday 15 minutes.', 'Measured exactly 10 minutes.', 'A measurement of 900 seconds.']) {
    for (const output of ['Make exactly 20 seconds of Data Story.', 'The full film runtime is exactly 20 seconds.', 'Length: exactly 20 seconds.', 'Create exactly20seconds of motion graphics.', 'The video should be exactly 20 seconds.', 'The film lasts exactly 20 seconds.']) {
      for (const brief of [`${source} ${output}`, `${output} ${source}`]) {
        const intent = classifyProductionIntent(brief);
        assert.equal(intent.requestedSeconds, 20, brief);
        assert.equal(intent.exactDuration, true, brief);
      }
    }
    const approximate = classifyProductionIntent(`${source} Make about 20 seconds of motion graphics.`);
    assert.equal(approximate.requestedSeconds, 20);
    assert.equal(approximate.exactDuration, false);
  }
});

test('duration units and adjacent minute/second pairs remain one output duration', () => {
  for (const [duration, expected] of [
    ['20 seconds', 20], ['20-second', 20], ['20secs', 20], ['20 sec', 20], ['20s', 20],
    ['one minute and 12 seconds', 72], ['1 minute 30 seconds', 90], ['1 minute, 30 seconds', 90],
    ['1 min and 30 sec', 90], ['1m30s', 90], ['1.5-minute', 90], ['two minutes', 120],
    ['2 mins', 120], ['2m', 120], ['0.5 seconds', 0.5],
  ] as const) {
    const brief = `Source value: 10 seconds. Make exactly ${duration} of film. Other source value: 25 minutes.`;
    const intent = classifyProductionIntent(brief);
    assert.equal(intent.requestedSeconds, expected, brief);
    assert.equal(intent.exactDuration, true, brief);
  }
  assert.equal(classifyProductionIntent('Make a film without a specified length.').requestedSeconds, null);
});
