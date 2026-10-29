import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { classifyProductionIntent, requestsLiveActionLook } from '../src/production-intent.js';
import { FICTIONAL_DATA_STORY, FICTIONAL_DATA_STORY_UI } from './fixtures/fictional-data-story.js';
import { OLIVE_BRIEF } from './fixtures/olive-action.js';

test('exact recorded raw and UI Data Story briefs do not request humans and retain the 20-second runtime', () => {
  assert.equal(createHash('sha256').update(FICTIONAL_DATA_STORY).digest('hex'), '02b9efa309347c61f188e6e9a23597c057c1a9f2b2da45c012781e6463d314b4');
  for (const brief of [FICTIONAL_DATA_STORY, FICTIONAL_DATA_STORY_UI]) {
    const intent = classifyProductionIntent(brief, 'motion-graphics');
    assert.equal(intent.liveActionHumans, false);
    assert.equal(requestsLiveActionLook(brief), false);
    assert.equal(intent.kind, 'motion-graphics');
    assert.equal(intent.requestedSeconds, 20);
    assert.equal(intent.exactDuration, true);
    assert.equal(intent.wordless, true);
    assert.equal(intent.musicRequested, true);
  }
});

test('human requirements respect whole negative clauses and lists, not fixed word windows', () => {
  for (const brief of [
    'This is not a claim about real people. Show a chart.',
    'This is not intended to make any factual claim about the activities of real people. Show a chart.',
    'Avoid depictions of identifiable real people in this chart.',
    'Do not show realistic humans.',
    "Don't include photorealistic people. Use native charts.",
    'Use native charts rather than live-action humans.',
    'Avoid photorealistic images, real people and live-action footage.',
    'No dialogue, captions, logos or real people.',
    'Use charts about real people.',
    'Use native editable typography to tell a story about real humans.',
    'Photorealistic olive. No depictions or representations of any human adults, children or people.',
    OLIVE_BRIEF,
    'A photoreal olive rolls over a table.',
    'A live-action landscape shot of waves.',
  ]) assert.equal(classifyProductionIntent(brief).liveActionHumans, false, brief);
});

test('separate positive human directives survive negative clauses and not-only constructions', () => {
  for (const brief of [
    'Show real people in a bakery.',
    'Use photorealistic humans with native chart overlays.',
    'A live-action baker kneads dough.',
    'A film featuring people skating. Make it live action.',
    'No charts. A film with real people skating.',
    'No real people in the opening. Show live-action humans in the ending.',
    'Avoid cartoons and use realistic humans.',
    'No charts, use live-action humans.',
    'Not only live action, but also human actors.',
    'Do not show real people initially; include live-action dancers at the end.',
    'Avoid real people at first, then show photorealistic adults.',
    'Not a claim about real people, but show live-action fictional humans in the closing shot.',
    'No humans in the opening\nShow a live-action chef at the end.',
    `${FICTIONAL_DATA_STORY} Separately, show live-action human adults in a closing shot.`,
  ]) assert.equal(classifyProductionIntent(brief).liveActionHumans, true, brief);
});
