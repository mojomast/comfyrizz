import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CharacterValidationError, makeCharacter } from '../../src/characters/model.mjs';
import {
  CHAR_CONSENT_INVALID,
  CHAR_CONSENT_REQUIRED,
  CHAR_CONSENT_REVOKED,
  CHAR_KIND_UNSUPPORTED,
  CONSENT_LIMITS,
  CONSENT_SCHEMA,
  ConsentError,
  assertBuildable,
  assertConsent,
  authorizeCharacter,
  buildEligibility,
  buildPartition,
  canBuild,
  consentOf,
  createRealAuthorizedCharacter,
  filterForNewBuild,
  isBuildable,
  isConsentActive,
  isConsentRevoked,
  isFictional,
  isRealAuthorized,
  makeConsent,
  makeRealAuthorizedCharacter,
  normalizeConsent,
  partitionForNewBuild,
  requireConsent,
  revokeCharacterConsent,
  revokeConsent,
  validateCharacterConsent,
  validateConsent,
  validateRealCharacter,
} from '../../src/characters/consent.mjs';

const ID = 'chr_0123456789abcdef';
const OTHER_ID = 'chr_fedcba9876543210';
const NOW = '2026-10-21T12:00:00.000Z';

const realCharacter = (overrides = {}) => ({
  id: ID,
  name: 'Ava Reyes',
  handle: 'ava-reyes',
  role: 'presenter',
  kind: 'real_authorized',
  summary: 'Authorized presenter for the product launch',
  ...overrides,
});

const consentRecord = (overrides = {}) => ({
  assertedBy: 'Ava Reyes',
  assertedAt: NOW,
  scope: 'character',
  likenessWarningShown: true,
  ...overrides,
});

const consentError = (code) => (error) => {
  assert.ok(error instanceof ConsentError);
  assert.equal(error.code, code);
  return true;
};

test('CCL5a: a complete consent record is normalized, frozen and schema-tagged', () => {
  const consent = validateConsent(consentRecord());

  assert.equal(consent.schema, CONSENT_SCHEMA);
  assert.equal(consent.assertedBy, 'Ava Reyes');
  assert.equal(consent.assertedAt, NOW);
  assert.equal(consent.scope, 'character');
  assert.equal(consent.likenessWarningShown, true);
  assert.equal(consent.characterId, undefined);
  assert.ok(Object.isFrozen(consent));

  assert.deepEqual(makeConsent(consentRecord()), consent);
  assert.deepEqual(normalizeConsent(consentRecord()), consent);

  const dated = validateConsent(consentRecord({
    assertedAt: new Date('2026-10-20T08:30:00.000Z'),
  }));
  assert.equal(dated.assertedAt, '2026-10-20T08:30:00.000Z');

  const bound = validateConsent(consentRecord({ characterId: ID }));
  assert.equal(bound.characterId, ID);

  const supplied = validateConsent(consentRecord(), { characterId: ID });
  assert.equal(supplied.characterId, ID);

  assert.equal(validateConsent({ ...consentRecord(), notes: 'Signed release on file.' }).notes, 'Signed release on file.');
});

test('CCL5a: every required consent field is enforced', () => {
  assert.throws(() => validateConsent(), consentError(CHAR_CONSENT_INVALID));
  assert.throws(() => validateConsent(null), consentError(CHAR_CONSENT_INVALID));

  for (const field of ['assertedBy', 'assertedAt', 'scope']) {
    const missing = consentRecord();
    delete missing[field];
    assert.throws(
      () => validateConsent(missing),
      consentError(CHAR_CONSENT_REQUIRED),
      `${field} must be required`,
    );
    assert.throws(
      () => validateConsent({ ...consentRecord(), [field]: '   ' }),
      consentError(field === 'assertedAt' ? CHAR_CONSENT_INVALID : CHAR_CONSENT_REQUIRED),
      `${field} must not be blank`,
    );
  }

  for (const shown of [false, undefined, null]) {
    assert.throws(
      () => validateConsent({ ...consentRecord(), likenessWarningShown: shown }),
      consentError(CHAR_CONSENT_REQUIRED),
    );
  }
  assert.throws(
    () => validateConsent({ ...consentRecord(), likenessWarningShown: 'yes' }),
    consentError(CHAR_CONSENT_INVALID),
  );

  assert.throws(
    () => validateConsent({ ...consentRecord(), assertedAt: 'not-a-date' }),
    consentError(CHAR_CONSENT_INVALID),
  );
  assert.throws(
    () => validateConsent({ ...consentRecord(), assertedBy: 7 }),
    consentError(CHAR_CONSENT_INVALID),
  );
  assert.throws(
    () => validateConsent({ ...consentRecord(), scope: 'x'.repeat(CONSENT_LIMITS.scopeChars + 1) }),
    consentError(CHAR_CONSENT_INVALID),
  );
  assert.throws(
    () => validateConsent({ ...consentRecord(), assertedBy: 'Ava\u0000Reyes' }),
    consentError(CHAR_CONSENT_INVALID),
  );
  assert.throws(
    () => validateConsent({ ...consentRecord(), apiKey: 'not-a-secret' }),
    consentError(CHAR_CONSENT_INVALID),
  );
  assert.throws(
    () => validateConsent({ ...consentRecord(), schema: 'comfyrizz.character-consent/v9' }),
    consentError(CHAR_CONSENT_INVALID),
  );
});

test('CCL5a: consent is bound to one character when an id is present', () => {
  assert.throws(
    () => validateConsent(consentRecord({ characterId: OTHER_ID }), { characterId: ID }),
    consentError(CHAR_CONSENT_INVALID),
  );
  assert.throws(
    () => validateConsent(consentRecord({ characterId: 'not a character id' })),
    consentError(CHAR_CONSENT_INVALID),
  );

  const character = realCharacter({ consent: consentRecord({ characterId: OTHER_ID }) });
  assert.throws(
    () => requireConsent(character),
    consentError(CHAR_CONSENT_INVALID),
  );
});

test('CCL5a: fictional characters need no consent and real ones require it', () => {
  const fictional = makeCharacter({ name: 'Pip', handle: 'pip' });
  assert.equal(requireConsent(fictional), null);
  assert.equal(validateCharacterConsent(fictional), null);
  assert.equal(isFictional(fictional), true);
  assert.equal(isRealAuthorized(fictional), false);

  const missing = realCharacter();
  assert.equal(isRealAuthorized(missing), true);
  assert.throws(() => requireConsent(missing), consentError(CHAR_CONSENT_REQUIRED));
  assert.throws(() => assertConsent({ ...missing, consent: null }), consentError(CHAR_CONSENT_REQUIRED));

  const embedded = { ...missing, consent: consentRecord() };
  const required = requireConsent(embedded);
  assert.equal(required.assertedBy, 'Ava Reyes');
  assert.equal(required.characterId, ID);
  assert.ok(Object.isFrozen(required));

  const supplied = requireConsent(missing, consentRecord({ characterId: ID }));
  assert.equal(supplied.scope, 'character');

  assert.equal(consentOf(embedded).assertedBy, 'Ava Reyes');
  assert.equal(consentOf(missing), null);
  assert.throws(() => requireConsent({ ...missing, kind: 'person' }), consentError(CHAR_KIND_UNSUPPORTED));
});

test('CCL5a: authorizing a real character builds a frozen real_authorized record', () => {
  const authorized = authorizeCharacter(realCharacter(), consentRecord(), { now: NOW });

  assert.equal(authorized.kind, 'real_authorized');
  assert.equal(authorized.id, ID);
  assert.equal(authorized.name, 'Ava Reyes');
  assert.equal(authorized.consent.schema, CONSENT_SCHEMA);
  assert.equal(authorized.consent.characterId, ID);
  assert.equal(authorized.revision, 1);
  assert.ok(Object.isFrozen(authorized));
  assert.ok(Object.isFrozen(authorized.consent));

  assert.deepEqual(makeRealAuthorizedCharacter(realCharacter(), consentRecord(), { now: NOW }), authorized);
  assert.deepEqual(createRealAuthorizedCharacter(realCharacter(), consentRecord(), { now: NOW }), authorized);

  const embedded = authorizeCharacter({ ...realCharacter(), kind: undefined, consent: consentRecord() }, undefined, { now: NOW });
  assert.equal(embedded.kind, 'real_authorized');
  assert.equal(embedded.consent.scope, 'character');

  assert.throws(
    () => authorizeCharacter(realCharacter(), undefined),
    consentError(CHAR_CONSENT_REQUIRED),
  );
  assert.throws(
    () => authorizeCharacter(realCharacter({ kind: 'fictional' }), consentRecord()),
    consentError(CHAR_KIND_UNSUPPORTED),
  );
  assert.throws(
    () => authorizeCharacter(realCharacter(), consentRecord({ characterId: OTHER_ID })),
    consentError(CHAR_CONSENT_INVALID),
  );
  assert.throws(
    () => authorizeCharacter(realCharacter({ apiKey: 'not-a-secret' }), consentRecord()),
    (error) => error instanceof CharacterValidationError && error.code === 'CHAR_UNKNOWN_FIELD',
  );
  assert.throws(
    () => authorizeCharacter(realCharacter({ name: '' }), consentRecord()),
    (error) => error instanceof CharacterValidationError && error.code === 'CHAR_NAME',
  );

  const validated = validateRealCharacter({ ...realCharacter(), consent: consentRecord() }, { now: NOW });
  assert.equal(validated.kind, 'real_authorized');
  assert.equal(validated.consent.assertedBy, 'Ava Reyes');
  assert.equal(validateRealCharacter(makeCharacter({ name: 'Pip' })), null);
});

test('CCL5a: revoked consent is inactive and cannot authorize a build', () => {
  const original = validateConsent(consentRecord({ characterId: ID }));
  assert.equal(isConsentActive(original), true);
  assert.equal(isConsentRevoked(original), false);

  const revoked = revokeConsent(original, { now: NOW, reason: 'Talent withdrew authorization.' });
  assert.equal(revoked.revokedAt, NOW);
  assert.equal(revoked.revocationReason, 'Talent withdrew authorization.');
  assert.equal(isConsentRevoked(revoked), true);
  assert.equal(isConsentActive(revoked), false);
  assert.ok(Object.isFrozen(revoked));
  assert.equal(original.revokedAt, undefined);

  const again = revokeConsent(revoked, { now: '2026-10-22T00:00:00.000Z' });
  assert.equal(again.revokedAt, NOW);

  const updated = revokeCharacterConsent({ ...realCharacter(), consent: original }, {
    now: NOW,
    reason: 'Talent withdrew authorization.',
  });
  assert.equal(updated.kind, 'real_authorized');
  assert.equal(updated.consent.revokedAt, NOW);
  assert.equal(updated.consent.revocationReason, 'Talent withdrew authorization.');
  assert.equal(canBuild(updated), false);
  assert.equal(original.revokedAt, undefined);
  assert.throws(
    () => revokeCharacterConsent(makeCharacter({ name: 'Pip' })),
    consentError(CHAR_KIND_UNSUPPORTED),
  );

  const character = { ...realCharacter(), consent: revoked };
  assert.throws(() => requireConsent(character), consentError(CHAR_CONSENT_REVOKED));
  assert.equal(requireConsent(character, revoked, { allowRevoked: true }).revokedAt, NOW);
  assert.equal(isBuildable(character), false);
  assert.equal(buildEligibility(character).code, CHAR_CONSENT_REVOKED);
  assert.throws(() => assertBuildable(character), consentError(CHAR_CONSENT_REVOKED));

  assert.throws(
    () => revokeConsent(consentRecord({ scope: '' })),
    consentError(CHAR_CONSENT_REQUIRED),
  );
  assert.throws(
    () => revokeConsent(original, { reason: 'x'.repeat(CONSENT_LIMITS.revocationReasonChars + 1) }),
    consentError(CHAR_CONSENT_INVALID),
  );
});

test('CCL5a: revocation removes real characters from new builds only', () => {
  const fictional = makeCharacter({ id: OTHER_ID, name: 'Pip', handle: 'pip' });
  const authorizedCharacter = authorizeCharacter(realCharacter(), consentRecord());
  const revokedConsent = revokeConsent(authorizedCharacter.consent, { now: NOW });
  const revokedCharacter = { ...authorizedCharacter, consent: revokedConsent };
  const missingCharacter = realCharacter({ id: 'chr_aaaaaaaaaaaaaaaa', name: 'No Consent', handle: 'no-consent' });

  const cast = [
    { castId: 'c_pip', characterId: fictional.id, snapshot: fictional },
    { castId: 'c_ava', characterId: authorizedCharacter.id, snapshot: authorizedCharacter },
    { castId: 'c_revoked', characterId: revokedCharacter.id, snapshot: revokedCharacter },
    { castId: 'c_missing', characterId: missingCharacter.id, snapshot: missingCharacter },
  ];

  assert.equal(isBuildable(fictional), true);
  assert.equal(isBuildable(authorizedCharacter), true);
  assert.equal(isBuildable(missingCharacter), false);
  assert.equal(buildEligibility(missingCharacter).code, CHAR_CONSENT_REQUIRED);

  const kept = filterForNewBuild(cast);
  assert.deepEqual(kept.map((entry) => entry.castId), ['c_pip', 'c_ava']);
  assert.deepEqual([...kept.removedCastIds], ['c_revoked', 'c_missing']);
  assert.deepEqual([...kept.removedCharacterIds], [revokedCharacter.id, missingCharacter.id]);
  assert.deepEqual(kept.excluded.map((entry) => entry.code), [
    CHAR_CONSENT_REVOKED,
    CHAR_CONSENT_REQUIRED,
  ]);
  assert.ok(Object.isFrozen(kept));
  assert.ok(Object.isFrozen(kept.removed));

  const partitioned = partitionForNewBuild({ cast });
  assert.deepEqual(partitioned.map((entry) => entry.castId), ['c_pip', 'c_ava']);
  assert.equal(partitioned.excluded.length, 2);

  const summary = buildPartition(cast);
  assert.deepEqual(summary.eligible.map((entry) => entry.castId), ['c_pip', 'c_ava']);
  assert.deepEqual(summary.removedCastIds, ['c_revoked', 'c_missing']);
  assert.deepEqual(summary.removedCharacterIds, [revokedCharacter.id, missingCharacter.id]);

  const byMap = filterForNewBuild(
    [
      { castId: 'c_ava', characterId: authorizedCharacter.id, snapshot: realCharacter() },
      { castId: 'c_revoked', characterId: OTHER_ID, snapshot: realCharacter({ id: OTHER_ID, name: 'Other', handle: 'other' }) },
    ],
    new Map([[authorizedCharacter.id, authorizedCharacter.consent]]),
  );
  assert.deepEqual(byMap.map((entry) => entry.castId), ['c_ava']);

  const byLookup = filterForNewBuild(
    [{ castId: 'c_ava', characterId: authorizedCharacter.id, snapshot: realCharacter() }],
    (character) => (character.id === authorizedCharacter.id ? authorizedCharacter.consent : null),
  );
  assert.deepEqual(byLookup.map((entry) => entry.castId), ['c_ava']);

  assert.throws(() => filterForNewBuild('nope'), consentError(CHAR_CONSENT_INVALID));
  assert.throws(
    () => assertBuildable(missingCharacter),
    consentError(CHAR_CONSENT_REQUIRED),
  );
});
