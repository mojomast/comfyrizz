import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  REF_DECISION_SCHEMA,
  REF_VERDICT_SCHEMA,
  validateRefDecision,
  validateRefVerdict,
} from '../../../../packages/schema/src/ref-review.mjs';
import { decide } from '../../src/ref-watch/decide.mjs';
import {
  chooseReplacementRef,
  fillDecision,
  lintSteer,
  steerPrompt,
} from '../../src/ref-watch/steer.mjs';

const SHA = 'a'.repeat(64);

const wordCount = (value) => value.trim().split(/\s+/).filter(Boolean).length;

const MIRA = {
  characterId: 'mira',
  identityLock: 'Mira: thirty-eight years old, shoulder-length copper hair with a centre part, green eyes flecked with amber, weathered compact build, freckles across both cheeks and a pale scar over the left brow',
  wardrobeState: 'yellow oilskin coat, dry',
};

const THEO = {
  characterId: 'theo',
  identityLock: 'Theo: fifty-one years old, short black hair with silver at the temples, deep brown eyes, broad sturdy build, a faded anchor tattoo on the right forearm',
  wardrobeState: 'grey trench coat, buttoned',
};

const characters = [MIRA, THEO];

const previousPrompt = 'Mira and Theo stand at the lamp room window of a northern lighthouse at dusk, the copper lamp warm behind them while grey Atlantic weather gathers beyond the glass.';

function check(dimension, pass, severity, evidence) {
  return { dimension, pass, severity, evidence };
}

function verdict(overall, checks, fixHints) {
  return {
    schema: REF_VERDICT_SCHEMA,
    jobId: 'still_s03',
    keyframeSha256: SHA,
    reviewer: 'pi',
    model: 'deepseek-v4.1-flash',
    overall,
    checks,
    fixHints,
  };
}

const fixtures = [
  {
    name: 'anatomy',
    input: {
      previousPrompt,
      characters,
      verdict: verdict('fail', [
        check('technical', true, 'hard', 'the still fills a 1024 by 576 frame with a wide tonal range'),
        check('identity', true, 'hard', 'copper hair with a centre part and freckles are visible'),
        check('anatomy', false, 'hard', 'the left hand has six fingers'),
        check('framing', true, 'soft', 'the medium framing holds both figures at the window'),
      ], ["Mira's left hand rests flat on the window sill, five slender fingers clearly visible"]),
    },
  },
  {
    name: 'identity',
    input: {
      previousPrompt,
      characters,
      verdict: verdict('fail', [
        check('technical', true, 'hard', 'the still fills a 1024 by 576 frame with a wide tonal range'),
        check('identity', false, 'hard', 'the hair is black instead of copper'),
        check('anatomy', true, 'hard', 'both hands rest naturally with five fingers on each'),
        check('framing', true, 'soft', 'the medium framing holds both figures at the window'),
      ], [
        'Mira keeps shoulder-length copper hair with a centre part and warm freckles',
        'Theo keeps short black hair with silver at the temples',
      ]),
    },
  },
  {
    name: 'framing',
    input: {
      previousPrompt,
      characters,
      verdict: verdict('fail', [
        check('technical', true, 'hard', 'the still fills a 1024 by 576 frame with a wide tonal range'),
        check('identity', true, 'hard', 'copper hair with a centre part and freckles are visible'),
        check('anatomy', true, 'hard', 'both hands rest naturally with five fingers on each'),
        check('framing', false, 'hard', 'the heads sit too close to the top edge'),
      ], ['Both figures sit comfortably inside the frame with clean air above their heads']),
    },
  },
  {
    name: 'text_artifact',
    input: {
      previousPrompt,
      characters,
      verdict: verdict('fail', [
        check('technical', true, 'hard', 'the still fills a 1024 by 576 frame with a wide tonal range'),
        check('identity', true, 'hard', 'copper hair with a centre part and freckles are visible'),
        check('framing', true, 'soft', 'the medium framing holds both figures at the window'),
        check('text_artifact', false, 'hard', 'the shop sign carries garbled letters'),
      ], ['The shop sign reads HARBOUR in clean painted letters']),
    },
  },
  {
    name: 'mixed',
    input: {
      previousPrompt,
      characters,
      verdict: verdict('fail', [
        check('technical', true, 'hard', 'the still fills a 1024 by 576 frame with a wide tonal range'),
        check('identity', false, 'hard', 'the eyes are grey instead of green'),
        check('anatomy', false, 'hard', 'the right arm bends at an odd angle'),
        check('framing', false, 'soft', 'the horizon tilts slightly'),
        check('text_artifact', false, 'hard', 'the brass plate carries smudged letters'),
      ], [
        'Mira keeps green eyes flecked with amber and warm freckles across both cheeks',
        'The right arm hangs straight with a natural elbow',
        'The brass plate reads LAMP ROOM in crisp engraved letters',
      ]),
    },
  },
];

test('RW06: five fixture captions stay 100-350 words with zero lint problems', () => {
  assert.equal(fixtures.length, 5);
  for (const fixture of fixtures) {
    assert.equal(validateRefVerdict(fixture.input.verdict).ok, true, `${fixture.name}: fixture verdict is valid`);
    const text = steerPrompt(fixture.input);
    const words = wordCount(text);
    assert.ok(words >= 100 && words <= 350, `${fixture.name}: word count ${words} is outside 100-350`);
    assert.deepEqual(lintSteer(text), [], `${fixture.name}: negative wording in caption`);
  }
});

test('RW06: every identity lock, wardrobe state and fix hint survives verbatim', () => {
  for (const fixture of fixtures) {
    const text = steerPrompt(fixture.input);
    for (const character of fixture.input.characters) {
      assert.ok(text.includes(character.identityLock), `${fixture.name}: ${character.characterId} identity lock is verbatim`);
      if (character.wardrobeState) {
        assert.ok(text.includes(character.wardrobeState), `${fixture.name}: ${character.characterId} wardrobe is verbatim`);
      }
    }
    for (const hint of fixture.input.verdict.fixHints) {
      assert.ok(text.includes(hint), `${fixture.name}: fix hint is folded in verbatim`);
    }
  }
});

test('RW06: passing check details are kept', () => {
  for (const fixture of fixtures) {
    const text = steerPrompt(fixture.input);
    for (const item of fixture.input.verdict.checks.filter((entry) => entry.pass === true)) {
      assert.ok(text.toLowerCase().includes(item.evidence.toLowerCase()), `${fixture.name}: keeps passing evidence "${item.evidence}"`);
    }
  }
});

test('RW06: a short source prompt is padded from the locks and prompt only', () => {
  const input = {
    previousPrompt: 'Mira at the lighthouse window.',
    characters,
    verdict: verdict('fail', [
      check('anatomy', false, 'hard', 'the left hand has six fingers'),
    ], ["Mira's left hand rests flat on the window sill, five slender fingers clearly visible"]),
  };
  const text = steerPrompt(input);
  const words = wordCount(text);
  assert.ok(words >= 100 && words <= 350, `padded word count ${words} is outside 100-350`);
  assert.deepEqual(lintSteer(text), []);
  assert.ok(text.includes(MIRA.identityLock));
  assert.ok(text.includes(THEO.identityLock));
});

test('RW06: lintSteer reports every forbidden negative term', () => {
  assert.deepEqual(lintSteer('Five fingers rest clearly on the sill'), []);
  for (const term of ['no', 'not', 'without', 'avoid', 'never', "don't", 'remove']) {
    assert.ok(lintSteer(`The still has ${term} stray marks`).includes(term), `reports ${term}`);
  }
  assert.ok(lintSteer('The still has don’t wording').includes("don't"), 'reports a curly apostrophe');
  assert.deepEqual(lintSteer('The window frame carries clean paint'), []);
});

test('RW06: steerPrompt rewrites negative source wording into a clean caption', () => {
  const input = {
    previousPrompt: 'Mira waits at the window with no hat, without gloves, and she will not turn away.',
    characters,
    verdict: verdict('fail', [
      check('anatomy', false, 'hard', 'the left hand has six fingers'),
    ], ["Mira's left hand rests flat on the window sill, five slender fingers clearly visible"]),
  };
  const text = steerPrompt(input);
  assert.deepEqual(lintSteer(text), []);
  assert.ok(wordCount(text) >= 100 && wordCount(text) <= 350);
  assert.ok(text.includes(MIRA.identityLock));
});

test('RW06: fillDecision replaces the RW05 steer placeholder and validates', () => {
  const source = verdict('fail', [
    check('anatomy', false, 'hard', 'the left hand has six fingers'),
  ], ["Mira's left hand rests flat on the window sill, five slender fingers clearly visible"]);
  const decision = decide({ verdict: source, attempt: 0, regenJobsUsed: 0, stillCount: 8, identityFailures: 0 });
  assert.equal(decision.action, 'reprompt');
  assert.equal(decision.nextPrompt, '<steer>');

  const nextPrompt = steerPrompt({ previousPrompt, verdict: source, characters });
  const filled = fillDecision(decision, { nextPrompt });

  assert.equal(validateRefDecision(filled).ok, true, validateRefDecision(filled).errors.join('; '));
  assert.equal(filled.nextPrompt, nextPrompt);
  assert.equal(filled.nextPrompt.includes('<steer>'), false);
  assert.equal(decision.nextPrompt, '<steer>', 'the source decision is not mutated');
});

test('RW06: fillDecision replaces the RW05 replace-ref placeholder and validates', () => {
  const source = verdict('fail', [
    check('identity', false, 'hard', 'the hair is black instead of copper'),
  ], ['Mira keeps shoulder-length copper hair with a centre part']);
  const decision = decide({ verdict: source, attempt: 0, regenJobsUsed: 0, stillCount: 8, identityFailures: 2 });
  assert.equal(decision.action, 'replace_ref');
  assert.equal(decision.replaceRef, '<replace-ref>');

  const filled = fillDecision(decision, { replaceRef: 'out/still_s03.png' });

  assert.equal(validateRefDecision(filled).ok, true, validateRefDecision(filled).errors.join('; '));
  assert.equal(filled.replaceRef, 'out/still_s03.png');
  assert.equal(filled.replaceRef.includes('<replace-ref>'), false);
  assert.equal(decision.replaceRef, '<replace-ref>', 'the source decision is not mutated');
});

test('RW06: fillDecision returns a decision without a placeholder unchanged', () => {
  const source = verdict('pass', [
    check('identity', true, 'hard', 'copper hair with a centre part and freckles are visible'),
  ], []);
  const decision = decide({ verdict: source, attempt: 0, regenJobsUsed: 0, stillCount: 8, identityFailures: 0 });
  assert.equal(decision.action, 'accept');
  assert.equal(decision.schema, REF_DECISION_SCHEMA);
  assert.equal(fillDecision(decision, { nextPrompt: 'ignored', replaceRef: 'ignored' }), decision);
});

test('RW06: chooseReplacementRef takes the newest accepted still whose identity passed', () => {
  const acceptedStills = [
    { characterId: 'mira', imagePath: 'out/mira_early.png', acceptedAt: '2026-10-30T10:00:00.000Z', identityCheck: { pass: true } },
    { characterId: 'mira', imagePath: 'out/mira_newest_failed.png', acceptedAt: '2026-10-30T12:00:00.000Z', identityCheck: { pass: false } },
    { characterId: 'mira', imagePath: 'out/mira_late.png', acceptedAt: '2026-10-30T11:00:00.000Z', identityCheck: { pass: true } },
    { characterId: 'theo', imagePath: 'out/theo_newest.png', acceptedAt: '2026-10-30T13:00:00.000Z', identityCheck: { pass: true } },
  ];
  assert.equal(
    chooseReplacementRef({ characterId: 'mira', primaryImage: 'out/mira_primary.png', acceptedStills }),
    'out/mira_late.png',
  );
});

test('RW06: chooseReplacementRef reads identity from a verdict and falls back to the primary image', () => {
  const acceptedStills = [
    { characterId: 'mira', imagePath: 'out/mira_a.png', acceptedAt: '2026-10-30T10:00:00.000Z',
      verdict: { checks: [{ dimension: 'identity', pass: true, severity: 'hard', evidence: 'copper hair' }] } },
  ];
  assert.equal(
    chooseReplacementRef({ characterId: 'mira', primaryImage: 'out/mira_primary.png', acceptedStills }),
    'out/mira_a.png',
  );
  assert.equal(
    chooseReplacementRef({
      characterId: 'mira',
      primaryImage: 'out/mira_primary.png',
      acceptedStills: [{ characterId: 'mira', imagePath: 'out/mira_bad.png', acceptedAt: '2026-10-30T10:00:00.000Z', identityCheck: { pass: false } }],
    }),
    'out/mira_primary.png',
  );
});

test('RW06: chooseReplacementRef returns null when nothing usable remains', () => {
  assert.equal(chooseReplacementRef({ characterId: 'mira', primaryImage: null, acceptedStills: [] }), null);
  assert.equal(chooseReplacementRef({
    characterId: 'mira',
    primaryImage: '',
    acceptedStills: [{ characterId: 'theo', imagePath: 'out/theo.png', acceptedAt: 1, identityCheck: { pass: true } }],
  }), null);
});

test('negative sentences are dropped, never flipped into the opposite meaning', async () => {
  const { steerPrompt } = await import('../../src/ref-watch/steer.mjs');
  const out = steerPrompt({ previousPrompt: 'A lighthouse keeper at the lamp room window at dusk. The face is not blurry.', verdict: { checks: [], fixHints: [] }, characters: [] });
  assert.doesNotMatch(out, /fully blurry|not blurry/);
  assert.match(out, /lighthouse keeper/);
});
