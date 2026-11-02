import test from 'node:test';
import assert from 'node:assert/strict';
import { steerPrompt } from '../../src/ref-watch/steer.mjs';

test('a negative clause drops only that clause, not the whole one-sentence prompt', () => {
  const out = steerPrompt({
    previousPrompt: 'Wide shot at night of Gus racing down a rainy street on a red scooter, grinning, dark brick walls, no shops, no signs.',
    verdict: { checks: [{ dimension: 'identity', pass: true, evidence: 'Gus is not off-model.' }], fixHints: ['full-body wide shot with the whole scooter'] },
    characters: [{ identityLock: 'curly ginger hair' }],
  });
  const text = typeof out === 'string' ? out : out.prompt ?? JSON.stringify(out);
  assert.match(text, /racing down a rainy street on a red scooter/);
  assert.doesNotMatch(text, /The finished still shows\.\s/);
  assert.doesNotMatch(text, /\bno signs\b/);
});

test('a framing failure puts the framing first in the regen prompt', () => {
  const out = steerPrompt({
    previousPrompt: 'Wide shot at night of Gus racing down a rainy street on a red scooter, grinning.',
    verdict: { checks: [{ dimension: 'framing', pass: false, severity: 'hard', evidence: 'medium shot' }], fixHints: ['full-body wide shot with the whole scooter'] },
    characters: [{ identityLock: 'curly ginger hair' }],
  });
  assert.match(out, /^Wide shot, camera at a moderate distance, full body framed from head to toe/);
  assert.match(out, /racing down a rainy street/);
});

test('without a framing failure the prompt order is unchanged', () => {
  const out = steerPrompt({
    previousPrompt: 'Wide shot at night of Gus racing down a rainy street.',
    verdict: { checks: [{ dimension: 'anatomy', pass: false, severity: 'hard', evidence: 'extra finger' }], fixHints: ['five fingers on each hand'] },
    characters: [],
  });
  assert.match(out, /^Wide shot at night of Gus/);
});
