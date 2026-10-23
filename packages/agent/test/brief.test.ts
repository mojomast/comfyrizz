import assert from 'node:assert/strict';
import test from 'node:test';
import {
  BRIEF_EXAMPLE_PROMPTS,
  QUESTION_BANK,
  STYLE_PRESETS,
  STYLE_PRESET_DEFAULTS,
  applyDecisions,
  buildOutline,
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
  // The rich prompt answered key_message/audience/length/cta; only look remains (no data mention).
  assert.deepEqual(questions.map(question => question.id), ['look']);
  assert.ok(questions.every(question => question.chips.length > 0));

  const bare = missingQuestions(extractBrief('Make a video about our app.'));
  assert.deepEqual(bare.map(question => question.id), ['audience', 'length', 'look']);
  assert.equal(bare.length, 3, 'never asks more than three');

  const bank = missingQuestions({ source_prompt: 'revenue grew 40%' }, QUESTION_BANK.length);
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

test('buildOutline: four beats, estimated seconds and the brief in the notes', () => {
  const brief = completeBrief(applyDecisions(extractBrief(RICH), {}));
  const outline = buildOutline(brief);
  assert.deepEqual(outline.beats.map(beat => beat.id), ['s_title', 's_point', 's_proof', 's_outro']);
  assert.deepEqual(outline.beats.map(beat => beat.role), ['hook', 'point', 'proof', 'cta']);
  for (const beat of outline.beats) assert.ok(beat.seconds > 0, `${beat.id} has no estimate`);
  const sum = Number(outline.beats.reduce((total, beat) => total + beat.seconds, 0).toFixed(2));
  assert.equal(outline.narrationSeconds, sum);
  assert.equal(outline.estimatedSeconds, Number((sum + 0.4 * 4).toFixed(2)));
  assert.equal(outline.targetSeconds, brief.length_s);
  assert.equal(outline.language, 'en');
  assert.equal(outline.style.preset, brief.style.preset);
  assert.match(outline.notes[0], /Look: cinematic-dark/);
  assert.match(outline.beats.find(beat => beat.id === 's_outro')!.narration, /star the repo/);
});

test('buildOutline: no facts is an honest placeholder, a fact becomes the proof', () => {
  const bare = completeBrief({ ...extractBrief(RICH), facts: [] });
  const placeholder = buildOutline(bare);
  const proof = placeholder.beats.find(beat => beat.id === 's_proof')!;
  assert.equal(proof.placeholder, true);
  assert.match(proof.headline, /Add a source/);
  assert.ok(placeholder.notes.some(note => /visible placeholder/.test(note)));

  const sourced = completeBrief({ ...extractBrief(RICH), facts: [{ claim: 'CPU render takes 6 min', source: 'local benchmark' }] });
  const withFact = buildOutline(sourced);
  assert.equal(withFact.beats.find(beat => beat.id === 's_proof')!.placeholder, false);
  assert.match(withFact.beats.find(beat => beat.id === 's_proof')!.narration, /local benchmark/);
});

test('buildOutline: missing CTA still closes, French estimates run longer', () => {
  const noCta = completeBrief({ ...extractBrief(RICH), cta: undefined });
  const outline = buildOutline(noCta);
  assert.match(outline.beats.find(beat => beat.id === 's_outro')!.narration, /whole idea/);
  assert.ok(outline.notes.some(note => /No CTA/.test(note)));

  const english = completeBrief(extractBrief(RICH));
  const french = completeBrief({ ...extractBrief(RICH), audience: { ...extractBrief(RICH).audience, language: 'fr' } });
  const en = buildOutline(english);
  const fr = buildOutline(french);
  assert.ok(fr.narrationSeconds > en.narrationSeconds, `fr ${fr.narrationSeconds} should beat en ${en.narrationSeconds}`);
  assert.equal(fr.language, 'fr');
});

test('buildOutline: fit reports short, on-target and long against the requested length', () => {
  const base = completeBrief(extractBrief(RICH));
  const outline = buildOutline(base);
  assert.equal(outline.fit, 'short', 'four short spoken beats cannot fill a 45 s target');
  // A gap that lands the on-screen estimate exactly on the target is on-target.
  const gap = (outline.targetSeconds - outline.narrationSeconds) / outline.beats.length;
  assert.equal(buildOutline(base, { gapSeconds: gap }).fit, 'on-target');
  assert.equal(buildOutline({ ...base, length_s: 8 }).fit, 'long');
});

test('extractBrief: the presenter is off unless the prompt asks for one', () => {
  assert.equal(extractBrief(RICH).presenter, 'none');
  assert.ok(extractBrief(RICH).decided_by_agent?.includes('presenter'));
  assert.equal(extractBrief('A launch video with an AI presenter on the intro and outro.').presenter, 'bookends');
  assert.equal(extractBrief('A presenter on every scene of the launch video.').presenter, 'all');
  assert.equal(extractBrief('A launch video with no presenter.').presenter, 'none');
});

test('applyDecisions + completeBrief: the presenter chip round-trips', () => {
  const draft = extractBrief('Make a video about our app.');
  const all = applyDecisions(draft, { presenter: 'all scenes' });
  assert.equal(all.presenter, 'all');
  assert.equal(completeBrief(all).presenter, 'all');
  assert.equal(completeBrief({}).presenter, 'none', 'default is off');
  assert.equal(completeBrief(applyDecisions(draft, { presenter: 'intro + outro' })).presenter, 'bookends');
});

test('buildOutline: a presenter adds an opt-in note', () => {
  const on = buildOutline(completeBrief({ ...extractBrief(RICH), presenter: 'bookends' }));
  assert.ok(on.notes.some(note => /Presenter: intro and outro/.test(note)));
  const off = buildOutline(completeBrief(extractBrief(RICH)));
  assert.ok(!off.notes.some(note => /Presenter/.test(note)));
});


test('UR12: bakery prompt asks no data question, numeric prompt does', () => {
  const none = missingQuestions(extractBrief('A 30 second video for my bakery announcing a sourdough subscription'));
  assert.ok(!none.some(question => question.id === 'data'));
  const some = missingQuestions(extractBrief('A 30 second video for my bakery announcing a sourdough subscription … revenue grew 40%'));
  assert.ok(some.some(question => question.id === 'data'));
});

test('UR12: cta chips do not include star the repo', () => {
  const cta = QUESTION_BANK.find(question => question.id === 'cta');
  assert.ok(cta);
  assert.ok(!cta.chips.includes('star the repo'));
  assert.deepEqual(cta.chips, ['visit the website', 'sign up', 'get in touch', 'none']);
});
