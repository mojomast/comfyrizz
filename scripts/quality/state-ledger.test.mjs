import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  FINDING_CODES,
  LEDGER_SCHEMA,
  checkLedger,
  matchPairs,
  parseAssetValue,
} from './state-ledger.mjs';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const LEDGER_FIXTURE = join(SCRIPT_DIR, 'fixtures', 'ledger.json');
const LIBRARY_FIXTURE = join(SCRIPT_DIR, 'fixtures', 'library.json');

function loadJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function clone(value) {
  return structuredClone(value);
}

function loadFixtures() {
  return { lib: loadJson(LIBRARY_FIXTURE), ledger: loadJson(LEDGER_FIXTURE) };
}

function shotById(ledger, id) {
  return ledger.shots.find((shot) => shot.id === id);
}

function codesOf(findings) {
  return findings.map((finding) => finding.code);
}

test('fixture is a comfyrizz.state-ledger/v1 with the measured closing and payoff cuts', () => {
  const { ledger } = loadFixtures();
  assert.equal(ledger.schema, LEDGER_SCHEMA);
  assert.ok(Array.isArray(ledger.shots));
  assert.equal(shotById(ledger, 's00_opening_portrait').role, 'opening');
  assert.equal(shotById(ledger, 's18_payoff_a').time, '09:00-09:10');
  assert.equal(shotById(ledger, 's18_payoff_b').time, '09:10-09:20');
  assert.deepEqual(shotById(ledger, 's18_payoff_a').artwork, ['raccoon_portrait@1']);
  assert.deepEqual(shotById(ledger, 's18_payoff_b').artwork, ['raccoon_portrait@2']);
});

test('closing scene with Ada in the apron, not paid_leave_cardigan -> COSTUME_NOT_PAID_OFF', () => {
  const { lib, ledger } = loadFixtures();
  const findings = checkLedger(lib, ledger);
  const costume = findings.filter(
    (finding) => finding.code === FINDING_CODES.COSTUME_NOT_PAID_OFF,
  );

  assert.equal(costume.length, 1);
  assert.equal(costume[0].shot, 's18_payoff_a');
  assert.equal(costume[0].scene, 'closing');
  assert.equal(costume[0].character, 'ada');
  assert.equal(costume[0].expected, 'paid_leave_cardigan@1');
  assert.equal(costume[0].actual, 'apron_teal');
  assert.match(costume[0].message, /paid_leave_cardigan@1/);
});

test('09:00-09:20 shots with two different raccoon ids -> ARTWORK_SWAP', () => {
  const { lib, ledger } = loadFixtures();
  const findings = checkLedger(lib, ledger);
  const swaps = findings.filter((finding) => finding.code === FINDING_CODES.ARTWORK_SWAP);

  assert.equal(swaps.length, 1);
  assert.equal(swaps[0].shot, 's18_payoff_b');
  assert.equal(swaps[0].expected, 'raccoon_portrait@1');
  assert.equal(swaps[0].actual, 'raccoon_portrait@2');
  assert.match(swaps[0].time, /^09:10-09:20$/);
});

test('matchPairs returns opening and payoff shots of raccoon_portrait', () => {
  const { ledger } = loadFixtures();
  const pair = matchPairs(ledger.shots, 'raccoon_portrait');

  assert.equal(pair.assetId, 'raccoon_portrait');
  assert.equal(pair.opening.id, 's00_opening_portrait');
  assert.equal(pair.payoff.id, 's18_payoff_b');
  assert.equal(pair.openingRef, 'raccoon_portrait@1');
  assert.equal(pair.payoffRef, 'raccoon_portrait@2');
  assert.equal(pair.sameAsset, false);
  assert.equal(pair.matches, ledger.shots.length);

  const approved = matchPairs(ledger.shots, 'raccoon_portrait@1');
  assert.equal(approved.opening.id, 's00_opening_portrait');
  assert.equal(approved.payoff.id, 's18_payoff_a');
  assert.equal(approved.sameAsset, true);
  assert.equal(approved.matches, ledger.shots.length - 1);
});

test('matchPairs reports an absent artwork instead of inventing a pair', () => {
  const { ledger } = loadFixtures();
  const pair = matchPairs(ledger.shots, 'missing_artwork');
  assert.deepEqual(pair, {
    assetId: 'missing_artwork',
    opening: null,
    payoff: null,
    openingRef: null,
    payoffRef: null,
    sameAsset: null,
    matches: 0,
  });
  assert.equal(matchPairs(ledger.shots, '').assetId, null);
});

test('an unlicensed holder change -> PROP_OWNER_JUMP', () => {
  const { lib, ledger } = loadFixtures();
  const findings = checkLedger(lib, ledger);
  const jumps = findings.filter((finding) => finding.code === FINDING_CODES.PROP_OWNER_JUMP);

  assert.equal(jumps.length, 1);
  assert.equal(jumps[0].shot, 's08_unreachable_line_end');
  assert.equal(jumps[0].previousShot, 's08_unreachable_line');
  assert.equal(jumps[0].prop, 'sandwich_01');
  assert.equal(jumps[0].from, 'ada');
  assert.equal(jumps[0].to, 'painter');
});

test('a licensing handoff on the cut removes the PROP_OWNER_JUMP finding', () => {
  const { lib, ledger } = loadFixtures();
  const licensed = clone(ledger);
  shotById(licensed, 's08_unreachable_line_end').licenses = [
    {
      prop: 'sandwich_01',
      from: 'ada',
      to: 'painter',
      reason: 's12_handoff',
    },
  ];

  const findings = checkLedger(lib, licensed);
  assert.equal(
    findings.some((finding) => finding.code === FINDING_CODES.PROP_OWNER_JUMP),
    false,
  );
  const unlicensed = checkLedger(lib, ledger);
  assert.equal(
    unlicensed.filter((finding) => finding.code === FINDING_CODES.PROP_OWNER_JUMP).length,
    1,
  );
});

test('a prop that stays with one holder across cuts is not a jump', () => {
  const { lib, ledger } = loadFixtures();
  const steady = clone(ledger);
  shotById(steady, 's08_unreachable_line_end').props.sandwich_01 = { holder: 'ada' };
  delete shotById(steady, 's08_unreachable_line_end').licenses;

  const findings = checkLedger(lib, steady);
  assert.equal(
    findings.some((finding) => finding.code === FINDING_CODES.PROP_OWNER_JUMP),
    false,
  );
});

test('a required artwork that is absent -> ARTWORK_SWAP with actual null', () => {
  const { lib, ledger } = loadFixtures();
  const missing = clone(ledger);
  shotById(missing, 's18_payoff_b').artwork = [];

  const findings = checkLedger(lib, missing);
  const swap = findings.find(
    (finding) =>
      finding.code === FINDING_CODES.ARTWORK_SWAP &&
      finding.shot === 's18_payoff_b' &&
      finding.actual === null,
  );
  assert.ok(swap, 'the missing artwork is reported');
  assert.equal(swap.expected, 'raccoon_portrait@1');
});

test('the approved library version anchors a recurring artwork beat', () => {
  const { lib, ledger } = loadFixtures();
  const drifted = clone(ledger);
  shotById(drifted, 's00_opening_portrait').artwork = ['raccoon_portrait@2'];
  shotById(drifted, 's18_payoff_b').artwork = ['raccoon_portrait@1'];

  const findings = checkLedger(lib, drifted);
  const swaps = findings.filter((finding) => finding.code === FINDING_CODES.ARTWORK_SWAP);
  assert.deepEqual(
    swaps.map((finding) => [finding.shot, finding.expected, finding.actual]),
    [['s00_opening_portrait', 'raccoon_portrait@1', 'raccoon_portrait@2']],
  );
});

test('a clean ledger has no continuity findings', () => {
  const { lib, ledger } = loadFixtures();
  const clean = clone(ledger);
  for (const shot of clean.shots) {
    if (shot.scene === 'closing') {
      shot.characters.ada.costume = 'paid_leave_cardigan@1';
      shot.artwork = ['raccoon_portrait@1'];
    }
  }
  shotById(clean, 's08_unreachable_line_end').licenses = [
    { prop: 'sandwich_01', from: 'ada', to: 'painter', reason: 's12_handoff' },
  ];

  assert.deepEqual(checkLedger(lib, clean), []);
});

test('root costume and artwork requirements are checked when shots are wrapped', () => {
  const { lib, ledger } = loadFixtures();
  const wrapped = {
    shots: clone(ledger.shots),
    requirements: {
      costumes: [
        { character: 'ada', from: 'apron_teal', to: 'paid_leave_cardigan@1' },
      ],
      artwork: [
        { asset: 'raccoon_portrait@1', shots: ['s18_payoff_b'] },
      ],
    },
  };

  const findings = checkLedger(lib, wrapped);
  assert.ok(
    findings.some(
      (finding) =>
        finding.code === FINDING_CODES.COSTUME_NOT_PAID_OFF &&
        /never appears/.test(finding.message),
    ),
    'the scripted change is reported when it never appears',
  );
  assert.ok(
    findings.some(
      (finding) =>
        finding.code === FINDING_CODES.ARTWORK_SWAP && finding.shot === 's18_payoff_b',
    ),
  );
});

test('parseAssetValue accepts versioned refs, bare ids and objects', () => {
  assert.deepEqual(parseAssetValue('raccoon_portrait@1'), {
    id: 'raccoon_portrait',
    version: 1,
    ref: 'raccoon_portrait@1',
  });
  assert.deepEqual(parseAssetValue('raccoon_portrait'), {
    id: 'raccoon_portrait',
    version: null,
    ref: 'raccoon_portrait',
  });
  assert.deepEqual(parseAssetValue({ id: 'raccoon_portrait', version: 2 }), {
    id: 'raccoon_portrait',
    version: 2,
    ref: 'raccoon_portrait@2',
  });
  assert.equal(parseAssetValue(''), null);
  assert.equal(parseAssetValue(null), null);
});

test('checkLedger and matchPairs are deterministic and do not mutate inputs', () => {
  const { lib, ledger } = loadFixtures();
  const before = clone(ledger);
  const first = checkLedger(lib, ledger);
  const second = checkLedger(lib, ledger);
  matchPairs(ledger.shots, 'raccoon_portrait');
  matchPairs(ledger, 'raccoon_portrait@1');

  assert.deepEqual(first, second);
  assert.deepEqual(ledger, before);
  assert.deepEqual(lib, loadJson(LIBRARY_FIXTURE));
});

test('findings only use the three continuity codes and carry a message', () => {
  const { lib, ledger } = loadFixtures();
  const allowed = new Set(Object.values(FINDING_CODES));
  const findings = checkLedger(lib, ledger);

  assert.equal(findings.length > 0, true);
  for (const finding of findings) {
    assert.ok(allowed.has(finding.code), `${finding.code} must be a ledger code`);
    assert.equal(typeof finding.message, 'string');
    assert.equal(finding.message.length > 0, true);
  }
  assert.deepEqual(codesOf(findings).sort(), [
    'ARTWORK_SWAP',
    'COSTUME_NOT_PAID_OFF',
    'PROP_OWNER_JUMP',
  ]);
});

test('findings and review pairs never carry secret-like values', () => {
  const { lib, ledger } = loadFixtures();
  const output = JSON.stringify([
    checkLedger(lib, ledger),
    matchPairs(ledger.shots, 'raccoon_portrait'),
  ]);
  assert.doesNotMatch(output, /(?:api[_-]?key|secret|password|authorization|bearer)/i);
});

test('invalid shots input is rejected instead of silently passing', () => {
  const { lib } = loadFixtures();
  assert.throws(() => checkLedger(lib, null), TypeError);
  assert.throws(() => checkLedger(lib, { shots: {} }), TypeError);
  assert.throws(() => matchPairs(undefined, 'raccoon_portrait'), TypeError);
});
