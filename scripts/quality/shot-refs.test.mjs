import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { attachRefs, DEFAULT_ROLE_BY_KIND, REF_ROLES } from './shot-refs.mjs';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(SCRIPT_DIR, 'fixtures', 'library.json');

// From scripts/quality/fixtures/library.json (Q07). The raccoon portrait is the
// approved artwork reused by the opening and the 09:00-09:20 payoff.
const RACCOON_SHA = '2d1c0837512faa7e9d0a7b77d07a439f8330a5a2f86628d1e3d66ce2ead73120';

function loadLibrary() {
  return JSON.parse(readFileSync(FIXTURE, 'utf8'));
}

function clone(value) {
  return structuredClone(value);
}

function missingRefs(result, code = 'REF_MISSING') {
  return result.findings.filter((finding) => finding.code === code);
}

test('raccoon shot gets raccoon_portrait@1 with its approved sha256 as composite', () => {
  const lib = loadLibrary();
  const shots = [
    {
      id: 's06_raccoon_reveal',
      prompt: 'Reveal the signed courtroom picture of the raccoon in its judicial robe.',
      artwork: ['raccoon_portrait@1'],
    },
  ];

  const result = attachRefs(shots, lib);
  assert.deepEqual(result.findings, []);
  assert.equal(result.shots.length, 1);

  const [ref] = result.shots[0].refs;
  assert.deepEqual(ref, {
    id: 'raccoon_portrait',
    version: 1,
    sha256: RACCOON_SHA,
    role: 'composite',
  });
  assert.deepEqual(Object.keys(ref), ['id', 'version', 'sha256', 'role']);
  assert.ok(REF_ROLES.includes(ref.role));
});

test('characters, props, costumes and sets bind as condition references', () => {
  const lib = loadLibrary();
  const result = attachRefs(
    [
      {
        id: 's08_unreachable_sandwich',
        props: { sandwich_01: { holder: 'bench' }, pose_frame_01: { location: 'bench' } },
        characters: { ada: { costume: 'paid_leave_cardigan' } },
        set: 'workshop_layout',
      },
    ],
    lib,
  );

  const refs = result.shots[0].refs;
  const byId = Object.fromEntries(refs.map((ref) => [ref.id, ref]));
  assert.equal(byId.sandwich_01.role, 'condition');
  assert.equal(byId.sandwich_01.version, 1);
  assert.equal(byId.paid_leave_cardigan.role, 'condition');
  assert.equal(byId.workshop_layout.role, 'condition');
  assert.equal(Object.hasOwn(byId, 'pose_frame_01'), false, 'unknown non-library prop is declared');
  const missing = missingRefs(result);
  assert.deepEqual(
    missing.map((finding) => finding.ref),
    ['pose_frame_01'],
    'an authored prop with no approved asset is REF_MISSING',
  );
});

test('kind defaults are artwork composite and everything else condition', () => {
  assert.equal(DEFAULT_ROLE_BY_KIND.artwork, 'composite');
  for (const kind of ['character', 'prop', 'costume', 'set', 'sign']) {
    assert.equal(DEFAULT_ROLE_BY_KIND[kind], 'condition');
  }
});

test('artwork defaults to composite and an explicit role can override it', () => {
  const lib = loadLibrary();
  const composite = attachRefs(
    [{ id: 'opening', artwork: ['raccoon_portrait@1'] }],
    lib,
  );
  assert.equal(composite.shots[0].refs[0].role, 'composite');

  const conditioned = attachRefs(
    [{ id: 'close-up', artwork: [{ ref: 'raccoon_portrait@1', role: 'condition' }] }],
    lib,
  );
  assert.equal(conditioned.shots[0].refs[0].role, 'condition');
  assert.match(conditioned.shots[0].refs[0].sha256, /^[0-9a-f]{64}$/);

  const mapped = attachRefs(
    [{ id: 'mapped', artwork: ['raccoon_portrait@1'], refRoles: { raccoon_portrait: 'condition' } }],
    lib,
  );
  assert.equal(mapped.shots[0].refs[0].role, 'condition');
});

test('an explicit version is never silently substituted', () => {
  const lib = loadLibrary();
  const result = attachRefs(
    [
      { id: 'wrong_version', artwork: ['raccoon_portrait@2'] },
      { id: 'unknown_id', assets: ['human_portrait@1'] },
      { id: 'unversioned_unknown', props: { biscuit_tin: { holder: 'ada' } } },
    ],
    lib,
  );

  assert.deepEqual(result.shots.map((shot) => shot.refs), [[], [], []]);
  const missing = missingRefs(result);
  assert.deepEqual(
    missing.map((finding) => [finding.shot, finding.ref]),
    [
      ['wrong_version', 'raccoon_portrait@2'],
      ['unknown_id', 'human_portrait@1'],
      ['unversioned_unknown', 'biscuit_tin'],
    ],
  );
  for (const finding of missing) {
    assert.match(finding.message, /approved/);
    assert.doesNotMatch(JSON.stringify(finding), /(?:^|[\s"'])\/[A-Za-z]/);
  }
});

test('a library entry that is not approved is REF_MISSING', () => {
  const lib = loadLibrary();
  const draft = {
    id: 'human_portrait',
    version: 1,
    kind: 'artwork',
    label: 'Rejected human portrait',
    file: 'assets/human_portrait@1.png',
    sha256: 'a'.repeat(64),
    approvedBy: 'continuity-lead',
    approved: false,
  };
  lib.assets.push(draft);

  const result = attachRefs(
    [{ id: 'wrong_portrait', prompt: 'Show the human_portrait above the bench.' }],
    lib,
  );
  assert.deepEqual(result.shots[0].refs, []);
  const [finding] = missingRefs(result);
  assert.equal(finding.shot, 'wrong_portrait');
  assert.equal(finding.ref, 'human_portrait');
});

test('prompt mentions bind by id and by id@version without double-binding', () => {
  const lib = loadLibrary();
  const result = attachRefs(
    [
      {
        id: 's06_reveal',
        imagePrompt:
          'Keep raccoon_portrait@1 on the wall and the sandwich_01 on the workbench, with the paid_leave_cardigan folded nearby.',
      },
    ],
    lib,
  );

  const refs = result.shots[0].refs;
  assert.deepEqual(
    refs.map((ref) => [ref.id, ref.version, ref.role]),
    [
      ['raccoon_portrait', 1, 'composite'],
      ['sandwich_01', 1, 'condition'],
      ['paid_leave_cardigan', 1, 'condition'],
    ],
  );
  assert.deepEqual(result.findings, []);
});

test('an unversioned id binds the highest approved version deterministically', () => {
  const lib = loadLibrary();
  const second = clone(lib.assets[0]);
  second.version = 2;
  second.file = 'assets/raccoon_portrait@2.png';
  second.sha256 = 'b'.repeat(64);
  lib.assets.push(second);

  const result = attachRefs(
    [{ id: 'untagged', prompt: 'The raccoon_portrait stays on the wall.' }],
    lib,
  );
  assert.deepEqual(result.shots[0].refs, [
    { id: 'raccoon_portrait', version: 2, sha256: 'b'.repeat(64), role: 'composite' },
  ]);

  const pinned = attachRefs([{ id: 'pinned', artwork: ['raccoon_portrait@1'] }], lib);
  assert.equal(pinned.shots[0].refs[0].version, 1);
  assert.equal(pinned.shots[0].refs[0].sha256, RACCOON_SHA);
});

test('a shot with no recurring asset gets an empty refs array and no findings', () => {
  const lib = loadLibrary();
  const result = attachRefs(
    [{ id: 'empty_workshop', prompt: 'An empty workbench in warm afternoon light.' }],
    lib,
  );
  assert.deepEqual(result.shots[0].refs, []);
  assert.deepEqual(result.findings, []);
});

test('duplicate declarations bind once and an explicit role wins', () => {
  const lib = loadLibrary();
  const result = attachRefs(
    [
      {
        id: 'dupes',
        artwork: ['raccoon_portrait@1'],
        assets: [{ ref: 'raccoon_portrait@1', role: 'condition' }],
        prompt: 'Use raccoon_portrait@1 and raccoon_portrait again.',
        props: { sandwich_01: { role: 'condition' }, 'sandwich_01@1': { role: 'condition' } },
      },
    ],
    lib,
  );

  assert.deepEqual(result.shots[0].refs, [
    { id: 'raccoon_portrait', version: 1, sha256: RACCOON_SHA, role: 'condition' },
    {
      id: 'sandwich_01',
      version: 1,
      sha256: lib.assets[1].sha256,
      role: 'condition',
    },
  ]);
});

test('an invalid role is reported and falls back to the kind default', () => {
  const lib = loadLibrary();
  const result = attachRefs(
    [{ id: 'bad_role', artwork: [{ ref: 'raccoon_portrait@1', role: 'backdrop' }] }],
    lib,
  );

  assert.equal(result.shots[0].refs[0].role, 'composite');
  const [finding] = missingRefs(result, 'REF_ROLE_INVALID');
  assert.equal(finding.shot, 'bad_role');
  assert.equal(finding.ref, 'raccoon_portrait@1');
});

test('string, object and id-keyed map declaration forms are accepted', () => {
  const lib = loadLibrary();
  const result = attachRefs(
    [
      {
        id: 'forms',
        references: ['sandwich_01@1'],
        requiredProps: [{ id: 'raccoon_portrait', version: 1 }],
        props: { 'paid_leave_cardigan@1': { role: 'condition' } },
      },
    ],
    lib,
  );

  assert.deepEqual(
    result.shots[0].refs.map((ref) => [ref.id, ref.version, ref.role]),
    [
      ['sandwich_01', 1, 'condition'],
      ['raccoon_portrait', 1, 'composite'],
      ['paid_leave_cardigan', 1, 'condition'],
    ],
  );
});

test('input shots and library are not mutated and output refs are independent', () => {
  const lib = loadLibrary();
  const shots = [
    {
      id: 'immutable',
      prompt: 'Show raccoon_portrait on the wall.',
      artwork: ['raccoon_portrait@1'],
      props: { sandwich_01: { holder: 'bench' } },
      nested: { keep: ['original'] },
    },
  ];
  const shotsBefore = clone(shots);
  const libBefore = clone(lib);

  const result = attachRefs(shots, lib);
  assert.deepEqual(shots, shotsBefore, 'shots are untouched, including no refs field');
  assert.equal(Object.hasOwn(shots[0], 'refs'), false);
  assert.deepEqual(lib, libBefore, 'the library is untouched');

  assert.notEqual(result.shots[0], shots[0]);
  assert.notEqual(result.shots[0].nested, shots[0].nested);
  result.shots[0].refs[0].role = 'condition';
  result.shots[0].nested.keep.push('changed');
  assert.deepEqual(shots, shotsBefore);
  assert.deepEqual(lib, libBefore);
});

test('attachRefs is idempotent', () => {
  const lib = loadLibrary();
  const shots = [
    { id: 's06', artwork: ['raccoon_portrait@1'], prompt: 'raccoon_portrait reveal' },
    { id: 's08', props: { sandwich_01: { holder: 'bench' } } },
  ];

  const once = attachRefs(shots, lib);
  const twice = attachRefs(once.shots, lib);
  assert.deepEqual(twice, once);
});

test('output is deterministic for the same input', () => {
  const lib = loadLibrary();
  const shots = [
    { id: 'a', prompt: 'sandwich_01 and raccoon_portrait@1' },
    { id: 'b', characters: { ada: { costume: 'paid_leave_cardigan' } } },
  ];
  assert.deepEqual(attachRefs(shots, lib), attachRefs(clone(shots), clone(lib)));
});

test('a missing asset named twice is reported once per shot', () => {
  const lib = loadLibrary();
  const result = attachRefs(
    [
      {
        id: 'twice_missing',
        artwork: ['human_portrait@1'],
        prompt: 'Hang human_portrait@1 above the bench.',
      },
      { id: 'other_shot', assetRefs: ['human_portrait@1'] },
    ],
    lib,
  );

  assert.deepEqual(
    missingRefs(result).map((finding) => finding.shot),
    ['twice_missing', 'other_shot'],
  );
});

test('a non-array shots argument is rejected', () => {
  assert.throws(() => attachRefs(null, loadLibrary()), TypeError);
  assert.throws(() => attachRefs({ id: 'x' }, loadLibrary()), TypeError);
  assert.throws(() => attachRefs([null], loadLibrary()), TypeError);
});

test('an empty or missing library reports every explicit asset as REF_MISSING', () => {
  for (const lib of [undefined, {}, { schema: 'comfyrizz.asset-library/v1', assets: [] }]) {
    const result = attachRefs([{ id: 'needs_art', artwork: ['raccoon_portrait@1'] }], lib);
    assert.deepEqual(result.shots[0].refs, []);
    assert.equal(missingRefs(result).length, 1);
  }
});
