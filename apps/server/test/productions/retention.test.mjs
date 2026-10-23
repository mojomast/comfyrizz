// IP61: opt-in import and reference-aware retention.
//
// The planner is pure: it never deletes anything, never mutates its inputs and
// never infers approval from a successful run. Applying a plan is a separate,
// explicit step that re-derives the protected set at apply time, so a plan
// made stale by a newer decision or pin cannot purge a referenced artifact.
//
// The import planner verifies content hashes with an injected reader and
// records provenance/approval as unknown unless the record carries explicit
// human evidence. Repeating an import is idempotent; changing the bytes behind
// an existing id is a conflict.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import {
  IMPORT_SCHEMA,
  RETENTION_SCHEMA,
  applyRetention,
  planImport,
  planRetention,
} from '../../src/productions/retention.mjs';

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);
const HASH_C = 'c'.repeat(64);
const HASH_D = 'd'.repeat(64);
const AT = '2026-10-22T12:00:00.000Z';

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function artifact(id, logicalId, version, overrides = {}) {
  return {
    id,
    logicalId,
    version,
    productionId: 'prod_1',
    kind: 'native_take',
    contentHash: HASH_A,
    mediaId: `med_${id}`,
    metadata: {},
    derivedFrom: [],
    createdBy: { actor: 'agent' },
    provenance: { backend: 'google-colab' },
    access: { private: true, conditionAllowed: true, redistributeAllowed: false },
    ...overrides,
  };
}

function decision(id, overrides = {}) {
  return {
    id,
    productionId: 'prod_1',
    kind: 'take_selection',
    status: 'pending',
    targetIds: [],
    inputFingerprint: HASH_A,
    proposalVersion: 0,
    options: [],
    ...overrides,
  };
}

test('planRetention protects derivedFrom, decisions, deliveries, production pointers and explicit refs', () => {
  const artifacts = [
    artifact('av_brief', 'lg_brief', 1),
    artifact('av_script', 'lg_script', 1),
    artifact('av_char', 'lg_char', 1),
    artifact('av_target', 'lg_target', 1),
    artifact('av_option', 'lg_option', 1),
    artifact('av_delivery', 'lg_delivery', 1),
    artifact('av_nested', 'lg_nested', 1),
    artifact('av_explicit', 'lg_explicit', 1),
    artifact('av_pinned', 'lg_pinned', 1),
    artifact('av_source', 'lg_source', 1),
    artifact('av_dependent', 'lg_dependent', 1, {
      derivedFrom: [{ artifactId: 'av_source', hash: HASH_A, role: 'conditioning' }],
    }),
    artifact('av_orphan', 'lg_orphan', 1),
    artifact('av_orphan_new', 'lg_orphan', 2),
  ];

  const plan = planRetention({
    artifacts,
    versionWindow: 1,
    decisions: [
      decision('dec_1', {
        targetIds: ['av_target'],
        options: [{ id: 'opt_1', label: 'A', artifactIds: ['av_option'] }],
      }),
    ],
    deliveries: [
      {
        id: 'del_1',
        artifactIds: ['av_delivery'],
        manifest: { artifacts: [{ artifactId: 'av_nested' }] },
      },
    ],
    production: {
      briefVersionId: 'av_brief',
      scriptVersionId: 'av_script',
      characterBindings: [{ characterId: 'char_1', artifactId: 'av_char' }],
    },
    references: ['av_explicit'],
    pinnedIds: ['av_pinned'],
  });

  assert.equal(plan.schema, RETENTION_SCHEMA);
  for (const id of [
    'av_brief',
    'av_script',
    'av_char',
    'av_target',
    'av_option',
    'av_delivery',
    'av_nested',
    'av_explicit',
    'av_pinned',
    'av_source',
    'av_dependent',
  ]) {
    assert.ok(plan.keep.includes(id), `${id} must be kept`);
    assert.equal(plan.purge.includes(id), false, `${id} must not be purged`);
  }
  assert.deepEqual(plan.purge, ['av_orphan']);
  assert.deepEqual(plan.keep, [...plan.keep].sort(), 'keep is deterministically ordered');
  assert.deepEqual(plan.purge, [...plan.purge].sort(), 'purge is deterministically ordered');
});

test('planRetention keeps a version window per logicalId', () => {
  const artifacts = [
    artifact('av_v1', 'lg_take', 1),
    artifact('av_v2', 'lg_take', 2),
    artifact('av_v3', 'lg_take', 3),
    artifact('av_v4', 'lg_take', 4),
    artifact('av_other', 'lg_other', 1),
  ];

  assert.deepEqual(planRetention({ artifacts, versionWindow: 2 }).purge, ['av_v1', 'av_v2']);
  assert.deepEqual(planRetention({ artifacts, keepVersions: 1 }).purge, ['av_v1', 'av_v2', 'av_v3']);
  assert.deepEqual(planRetention({ artifacts, window: 4 }).purge, []);
});

test('imported records are kept by default and can be released explicitly', () => {
  const artifacts = [
    artifact('av_new', 'lg_take', 2),
    artifact('av_import_v1', 'lg_take', 1, { imported: true, contentHash: HASH_B }),
  ];

  assert.deepEqual(planRetention({ artifacts, versionWindow: 1 }).purge, []);
  assert.deepEqual(
    planRetention({ artifacts, versionWindow: 1, keepImported: false }).purge,
    ['av_import_v1'],
  );
});

test('planRetention never mutates its inputs', () => {
  const artifacts = [artifact('av_v1', 'lg_take', 1), artifact('av_v2', 'lg_take', 2)];
  const input = {
    artifacts,
    decisions: [decision('dec_1', { targetIds: ['av_v1'] })],
    deliveries: [{ id: 'del_1', artifactIds: ['av_v2'] }],
    production: { briefVersionId: 'av_v1' },
    references: ['av_v2'],
    pinnedIds: ['av_v1'],
    versionWindow: 1,
  };
  const snapshot = clone(input);

  const plan = planRetention(input);

  assert.deepEqual(input, snapshot);
  assert.deepEqual(plan.purge, []);
});

test('applyRetention refuses a stale plan that would purge a newly referenced artifact', () => {
  const artifacts = [artifact('av_victim', 'lg_take', 1), artifact('av_new', 'lg_take', 2)];
  const plan = planRetention({ artifacts, versionWindow: 1 });
  assert.deepEqual(plan.purge, ['av_victim']);

  const removed = [];
  const result = applyRetention({
    plan,
    artifacts,
    decisions: [decision('dec_late', { targetIds: ['av_victim'] })],
    versionWindow: 1,
    remover: (id) => removed.push(id),
  });

  assert.equal(result.ok, true);
  assert.deepEqual(removed, [], 'a stale plan may not remove a referenced artifact');
  assert.deepEqual(result.removed, []);
  assert.deepEqual(result.refused, [{ id: 'av_victim', reason: 'referenced' }]);
  assert.deepEqual(result.tombstones, []);
});

test('applyRetention refuses to purge an artifact that became pinned', () => {
  const artifacts = [artifact('av_victim', 'lg_take', 1), artifact('av_new', 'lg_take', 2)];
  const plan = planRetention({ artifacts, versionWindow: 1 });

  const removed = [];
  const result = applyRetention({
    plan,
    artifacts,
    pinnedIds: ['av_victim'],
    remover: (id) => removed.push(id),
  });

  assert.deepEqual(removed, []);
  assert.deepEqual(result.refused, [{ id: 'av_victim', reason: 'pinned' }]);
});

test('applyRetention refuses a plan when no reference inputs are supplied', () => {
  const plan = planRetention({
    artifacts: [artifact('av_victim', 'lg_take', 1), artifact('av_new', 'lg_take', 2)],
    versionWindow: 1,
  });
  let calls = 0;

  const result = applyRetention({ plan, remover: () => { calls += 1; } });

  assert.equal(result.ok, false);
  assert.equal(result.code, 'INVALID_PLAN');
  assert.match(result.error, /references required/);
  assert.equal(calls, 0);
  assert.deepEqual(result.refused, []);
  assert.deepEqual(result.tombstones, []);
});

test('applyRetention removes bytes but returns a history-preserving tombstone', () => {
  const old = artifact('av_old', 'lg_take', 1, {
    contentHash: HASH_B,
    derivedFrom: [{ artifactId: 'av_source', hash: HASH_C, role: 'conditioning' }],
    provenance: { backend: 'google-colab', modelRevision: 'ltx-2.5' },
    createdBy: { actionId: 'act_1', actor: 'agent' },
  });
  const artifacts = [old, artifact('av_new', 'lg_take', 2)];
  const plan = planRetention({ artifacts, versionWindow: 1 });

  const removed = [];
  const result = applyRetention({
    plan,
    artifacts,
    now: AT,
    remover: (id) => removed.push(id),
  });

  assert.deepEqual(removed, ['av_old']);
  assert.deepEqual(result.removed, ['av_old']);
  assert.equal(result.tombstones.length, 1);
  const [tombstone] = result.tombstones;
  assert.equal(tombstone.id, 'av_old');
  assert.equal(tombstone.logicalId, 'lg_take');
  assert.equal(tombstone.version, 1);
  assert.equal(tombstone.status, 'unavailable');
  assert.equal(tombstone.reason, 'retention');
  assert.equal(tombstone.evictedAt, AT);
  assert.equal(tombstone.contentHash, HASH_B, 'the hash survives eviction');
  assert.deepEqual(tombstone.derivedFrom, old.derivedFrom, 'lineage survives eviction');
  assert.deepEqual(tombstone.provenance, old.provenance);
  assert.equal(JSON.stringify(result).includes('"rejected"'), false, 'eviction is not creative rejection');
  assert.equal(JSON.stringify(result).includes("'rejected'"), false);
});

test('planImport verifies hashes and never infers approval from success', () => {
  const records = [
    {
      id: 'imp_good',
      logicalId: 'lg_import',
      version: 1,
      sha256: HASH_A,
      status: 'succeeded',
      contentHash: HASH_A,
    },
    {
      id: 'imp_missing',
      logicalId: 'lg_import',
      version: 2,
      status: 'ready',
    },
    {
      id: 'imp_mismatch',
      logicalId: 'lg_import',
      version: 3,
      sha256: HASH_B,
      status: 'succeeded',
    },
  ];
  const before = clone(records);

  const result = planImport({
    records,
    hashFile: (record) => {
      if (record.id === 'imp_good') return HASH_A;
      if (record.id === 'imp_missing') return HASH_C;
      return HASH_D;
    },
  });

  assert.equal(result.schema, IMPORT_SCHEMA);
  assert.equal(result.ok, true);
  assert.deepEqual(result.imported.map((record) => record.id), ['imp_good']);
  assert.deepEqual(result.skipped, [
    { id: 'imp_mismatch', reason: 'hash_mismatch' },
    { id: 'imp_missing', reason: 'hash_missing' },
  ]);
  assert.deepEqual(result.conflicts, []);
  assert.equal(result.imported[0].provenance, 'unknown');
  assert.equal(result.imported[0].approval, 'unknown', 'a succeeded import is not human approval');
  assert.equal(result.imported[0].imported, true);
  assert.deepEqual(records, before, 'the import planner never mutates its input');
});

test('planImport accepts bytesFor and keeps explicit human approval evidence', () => {
  const bytes = Buffer.from('imported bytes', 'utf8');
  const digest = createHash('sha256').update(bytes).digest('hex');
  const records = [
    {
      id: 'imp_bytes',
      logicalId: 'lg_import',
      version: 1,
      sha256: digest,
      approval: {
        status: 'accepted',
        userEventId: 'ue_1',
        resolution: { actor: 'user', userEventId: 'ue_1' },
      },
    },
  ];

  const result = planImport({ records, bytesFor: () => bytes });
  assert.equal(result.ok, true);
  assert.equal(result.imported.length, 1);
  assert.equal(result.imported[0].approval, 'approved');
  assert.equal(result.imported[0].provenance, 'unknown');

  const noProvider = planImport({ records });
  assert.equal(noProvider.ok, false);
  assert.equal(noProvider.code, 'IMPORT_HASH_REQUIRED');
});

test('planImport is idempotent for the same id and bytes and conflicts on different bytes', () => {
  const record = {
    id: 'imp_1',
    logicalId: 'lg_import',
    version: 1,
    sha256: HASH_A,
    contentHash: HASH_A,
  };
  const hashFile = () => HASH_A;

  const first = planImport({ records: [record], hashFile });
  assert.deepEqual(first.imported.map((entry) => entry.id), ['imp_1']);

  const second = planImport({ records: [record], existing: first.imported, hashFile });
  assert.deepEqual(second.imported, []);
  assert.deepEqual(second.skipped, [{ id: 'imp_1', reason: 'already_imported' }]);
  assert.deepEqual(second.conflicts, []);

  const conflict = planImport({
    records: [record],
    existing: [{ id: 'imp_1', sha256: HASH_B }],
    hashFile,
  });
  assert.deepEqual(conflict.imported, []);
  assert.deepEqual(conflict.skipped, [{ id: 'imp_1', reason: 'hash_conflict' }]);
  assert.deepEqual(conflict.conflicts, [
    { id: 'imp_1', reason: 'hash_conflict', existingSha256: HASH_B, incomingSha256: HASH_A },
  ]);
});

test('planImport dedupes within one batch deterministically', () => {
  const records = [
    { id: 'imp_b', sha256: HASH_A },
    { id: 'imp_a', sha256: HASH_B },
    { id: 'imp_b', sha256: HASH_A },
  ];

  const result = planImport({
    records,
    hashFile: (record) => record.sha256,
  });

  assert.deepEqual(result.imported.map((entry) => entry.id), ['imp_a', 'imp_b']);
  assert.deepEqual(result.skipped, [{ id: 'imp_b', reason: 'already_imported' }]);
});
