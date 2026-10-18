import assert from 'node:assert/strict';
import test from 'node:test';
import {
  BRIEF_EXAMPLE_PROMPTS,
  QUESTION_BANK,
  STYLE_PRESETS,
  STYLE_PRESET_DEFAULTS,
  applyDecisions,
  completeBrief,
  draftKeyMessages,
  estimateNarrationSeconds,
  extractBrief,
  missingQuestions,
  secondsPerWord,
} from '../src/brief.js';

const RICH = 'A 45 second launch video for developers, calm and confident, ending with a star-the-repo CTA.';

test('extractBrief: goal, audience, length, tone, CTA and language from the prompt', () => {
  const draft = extractBrief(RICH);
  assert.equal(draft.goal, 'launch');
  assert.equal(draft.key_message, RICH);
  assert.equal(draft.audience?.who, 'developers');
  assert.equal(draft.audience?.language, 'en');
  assert.equal(draft.length_s, 45);
  assert.deepEqual(draft.tone, ['calm', 'confident', 'clear']);
  assert.equal(draft.cta, 'star the repo');
  assert.equal(draft.voice?.persona, 'warm narrator, measured pace');
  assert.equal(draft.style?.preset, undefined, 'the look stays unanswered');
  assert.equal(draft.facts, undefined, 'the extractor never invents facts');
  // Aspect was not stated, so the agent decided it.
  assert.equal(draft.aspect, '16:9');
  assert.ok(draft.decided_by_agent?.includes('aspect'));
  assert.ok(draft.decided_by_agent?.includes('tone'));
});

test('extractBrief: vertical French explainer with an explicit look and avoid list', () => {
  const draft = extractBrief('Explique comment ça marche for customers, en français, vertical. Style: paper-cut. Avoid: stock-photo people, red');
  assert.equal(draft.goal, 'explain');
  assert.equal(draft.audience?.language, 'fr');
  assert.equal(draft.aspect, '9:16');
  assert.deepEqual(draft.avoid, ['stock-photo people', 'red']);
});

test('missingQuestions: priority order, cap of three, answered fields skipped', () => {
  const questions = missingQuestions(extractBrief(RICH));
  // The rich prompt answered key_message/audience/length/cta; only look + data remain.
  assert.deepEqual(questions.map(question => question.id), ['look', 'data']);
  assert.ok(questions.every(question => question.chips.length > 0));

  const bare = missingQuestions(extractBrief('Make a video about our app.'));
  assert.deepEqual(bare.map(question => question.id), ['audience', 'length', 'look']);
  assert.equal(bare.length, 3, 'never asks more than three');

  const bank = missingQuestions({}, 7);
  assert.deepEqual(bank.map(question => question.id), QUESTION_BANK.map(question => question.id));
});

test('missingQuestions: key-message chips come from the prompt sentences', () => {
  const prompt = 'Our renderer runs on the CPU. It exports in minutes. No GPU is required.';
  const prompt2 = 'Make a video about our app.'; // one sentence, so no chips
  const options = draftKeyMessages(prompt);
  assert.deepEqual(options, ['Our renderer runs on the CPU.', 'It exports in minutes.', 'No GPU is required.']);
  const questions = missingQuestions(extractBrief(''), 3, options);
  const keyMessage = questions.find(question => question.id === 'key_message');
  assert.deepEqual(keyMessage?.chips, options);
  assert.deepEqual(missingQuestions(extractBrief(prompt2), 3, draftKeyMessages(prompt2)).map(q => q.id), ['audience', 'length', 'look']);
});

test('applyDecisions: chip answers are recorded, Decide-for-me fills defaults', () => {
  const draft = extractBrief('Make a video about our app.');
  const answered = applyDecisions(draft, {
    audience: 'customers',
    look: 'clay',
    length: '30 s social',
    key_message: undefined, // Decide for me
  });
  assert.equal(answered.audience?.who, 'customers');
  assert.equal(answered.style?.preset, 'clay');
  assert.equal(answered.length_s, 30);
  assert.equal(answered.key_message, QUESTION_BANK[0].decide);
  for (const id of ['audience', 'look', 'length', 'key_message']) {
    assert.ok(answered.decided_by_agent?.includes(id), `${id} recorded as decided`);
  }
  // Unknown ids are ignored, and the input draft is untouched.
  assert.deepEqual(applyDecisions(draft, { nope: 'x' }).decided_by_agent, draft.decided_by_agent);
  assert.equal(draft.audience?.who, undefined);
});

test('applyDecisions: voice none drops the persona, cta none drops the CTA', () => {
  const draft = extractBrief(RICH);
  const noVoice = applyDecisions(draft, { voice: 'none', cta: 'none' });
  assert.equal(noVoice.voice?.persona, undefined);
  assert.equal(noVoice.cta, undefined);
  assert.ok(!missingQuestions(noVoice).some(question => question.id === 'cta'));
});

test('completeBrief: fills preset defaults and validates', () => {
  const brief = completeBrief(applyDecisions(extractBrief('Make a video about our app.'), { look: 'paper-cut' }));
  assert.equal(brief.style.preset, 'paper-cut');
  assert.deepEqual(brief.style.palette, STYLE_PRESET_DEFAULTS['paper-cut'].palette);
  assert.equal(brief.style.font, 'Inter');
  assert.equal(brief.tone.length, 3);
  assert.equal(brief.aspect, '16:9');
  assert.equal(brief.voice.engine, 'kokoro');
  assert.equal(brief.music.enabled, false);
  assert.deepEqual(brief.facts, []);
  assert.equal(brief.mode, 'plan');
});

test('completeBrief: every bundled preset is schema-valid', () => {
  for (const preset of STYLE_PRESETS) {
    const brief = completeBrief({ style: { preset } });
    assert.equal(brief.style.preset, preset);
    assert.equal(brief.style.palette?.length, 4);
  }
});

test('estimateNarrationSeconds: 2.5 words/s English, slower French', () => {
  assert.equal(secondsPerWord('en'), 2.5);
  assert.equal(secondsPerWord('fr'), 2.1);
  assert.equal(estimateNarrationSeconds('one two three four five', 'en'), 2);
  assert.equal(estimateNarrationSeconds('one two three four five', 'fr'), 2.38);
  assert.equal(estimateNarrationSeconds('   ', 'en'), 0);
});

test('the bundled example prompts each extract a usable brief', () => {
  assert.equal(BRIEF_EXAMPLE_PROMPTS.length, 3);
  for (const prompt of BRIEF_EXAMPLE_PROMPTS) {
    const brief = completeBrief(applyDecisions(extractBrief(prompt), {}));
    assert.ok(brief.key_message.length > 0);
    assert.ok(brief.length_s && brief.length_s > 0);
  }
});
