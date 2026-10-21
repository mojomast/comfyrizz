// @ts-nocheck
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CharacterConsentController,
  ConsentError,
  CONSENT_CHECKBOX_LABEL,
  CONSENT_INVALID_CODE,
  CONSENT_REQUIRED_CODE,
  CONSENT_REQUIRED_MESSAGE,
  DEFAULT_ASSERTED_BY,
  DEFAULT_SCOPE,
  KIND_FICTIONAL,
  KIND_REAL_AUTHORIZED,
  KIND_UNSUPPORTED_CODE,
  LIKENESS_WARNING,
  consentForState,
  createConsentController,
  emptyConsentState,
  normalizeConsentKind,
  renderConsentSection,
  validateConsent,
  validateConsentRecord,
} from '../src/characters/consent.ts';

const FIXED_NOW = '2026-10-21T12:34:56.000Z';
const clock = () => FIXED_NOW;
const EXISTING = {
  assertedBy: 'Ada Lovelace',
  assertedAt: '2026-10-20T08:00:00.000Z',
  scope: 'launch_video',
  likenessWarningShown: true,
};

function create(options = {}) {
  return createConsentController({ clock, ...options });
}

function checkboxTag(html) {
  const match = html.match(/<input[^>]*data-consent-checkbox[^>]*>/);
  assert.ok(match, 'the consent checkbox is rendered');
  return match[0];
}

test('fictional characters keep the existing save path with no consent UI', () => {
  const consent = create();
  const state = consent.getState();

  assert.equal(state.kind, KIND_FICTIONAL);
  assert.equal(state.consentRequired, false);
  assert.equal(state.warningVisible, false);
  assert.equal(state.checked, false);
  assert.equal(state.message, '');
  assert.equal(consent.canSave(), true);
  assert.equal(consent.isSaveBlocked(), false);
  assert.equal(consent.saveBlockedReason(), '');
  assert.equal(consent.consentRecord(), null);
  assert.deepEqual(consent.fields(), { kind: KIND_FICTIONAL });

  const html = consent.render();
  assert.match(html, /data-kind="fictional"/);
  assert.doesNotMatch(html, /data-likeness-warning/);
  assert.doesNotMatch(html, /data-consent-checkbox/);
  assert.doesNotMatch(html, /Likeness warning/);

  assert.equal(consent.setChecked(true), false);
  assert.equal(consent.getState().checked, false);
  assert.equal(consent.canSave(), true);
});

test('choosing real person shows the likeness warning and an unchecked checkbox', () => {
  const consent = create();
  assert.equal(consent.chooseRealPerson(), true);

  const state = consent.getState();
  assert.equal(state.kind, KIND_REAL_AUTHORIZED);
  assert.equal(state.consentRequired, true);
  assert.equal(state.warningVisible, true);
  assert.equal(state.checked, false);
  assert.equal(state.assertedAt, '');
  assert.equal(state.message, CONSENT_REQUIRED_MESSAGE);
  assert.equal(state.messageError, true);
  assert.equal(consent.canSave(), false);
  assert.equal(consent.isSaveBlocked(), true);
  assert.equal(consent.saveBlockedReason(), CONSENT_REQUIRED_MESSAGE);

  const validation = consent.validate();
  assert.equal(validation.ok, false);
  assert.equal(validation.code, CONSENT_REQUIRED_CODE);
  assert.equal(validation.consent, null);
  assert.throws(() => consent.fields(), (error) => {
    assert.ok(error instanceof ConsentError);
    assert.equal(error.code, CONSENT_REQUIRED_CODE);
    return true;
  });

  const html = consent.render();
  assert.match(html, /data-kind="real_authorized"/);
  assert.match(html, /data-likeness-warning[^>]*role="alert"/);
  assert.match(html, /Likeness warning/);
  assert.ok(html.includes(LIKENESS_WARNING.replace(/'/g, '&#39;')));
  assert.match(html, /data-consent-status[^>]*>Confirm that you have permission/);

  const tag = checkboxTag(html);
  assert.doesNotMatch(tag, /\bchecked\b/);
  assert.match(tag, /required/);
  assert.match(html, new RegExp(CONSENT_CHECKBOX_LABEL.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('save stays blocked until the consent checkbox is checked', () => {
  const consent = create();
  consent.chooseRealPerson();

  assert.equal(consent.canSave(), false);
  assert.equal(consent.setChecked(true), true);
  assert.equal(consent.canSave(), true);
  assert.equal(consent.isSaveBlocked(), false);
  assert.equal(consent.saveBlockedReason(), '');

  const record = consent.consentRecord();
  assert.deepEqual(record, {
    assertedBy: DEFAULT_ASSERTED_BY,
    assertedAt: FIXED_NOW,
    scope: DEFAULT_SCOPE,
    likenessWarningShown: true,
  });
  assert.equal(Object.isFrozen(record), true);

  const fields = consent.toCharacterFields();
  assert.equal(fields.kind, KIND_REAL_AUTHORIZED);
  assert.deepEqual(fields.consent, record);

  assert.match(checkboxTag(consent.render()), /\bchecked\b/);
  assert.match(consent.render(), /Consent recorded\. Save is enabled\./);
});

test('assertedBy and scope flow into the consent record', () => {
  const consent = create();
  consent.chooseRealPerson();
  consent.setAssertedBy('Ada Lovelace');
  consent.setScope('launch_video');
  consent.setChecked(true);

  assert.deepEqual(consent.consentRecord(), {
    assertedBy: 'Ada Lovelace',
    assertedAt: FIXED_NOW,
    scope: 'launch_video',
    likenessWarningShown: true,
  });
  assert.match(consent.render(), /value="Ada Lovelace"/);
  assert.match(consent.render(), /value="launch_video"/);

  consent.setAssertedBy('   ');
  assert.equal(consent.canSave(), true);
  assert.equal(consent.consentRecord().assertedBy, DEFAULT_ASSERTED_BY);

  consent.setScope('');
  assert.equal(consent.canSave(), true);
  assert.equal(consent.consentRecord().scope, DEFAULT_SCOPE);
});

test('the consent timestamp is captured when checked and cleared when unchecked', () => {
  let now = '2026-10-21T10:00:00.000Z';
  const consent = new CharacterConsentController({
    kind: KIND_REAL_AUTHORIZED,
    clock: () => now,
  });

  consent.setChecked(true);
  assert.equal(consent.consentRecord().assertedAt, '2026-10-21T10:00:00.000Z');

  consent.setChecked(false);
  assert.equal(consent.getState().checked, false);
  assert.equal(consent.getState().assertedAt, '');
  assert.equal(consent.canSave(), false);
  assert.doesNotMatch(checkboxTag(consent.render()), /\bchecked\b/);

  now = '2026-10-21T11:15:00.000Z';
  consent.setChecked(true);
  assert.equal(consent.consentRecord().assertedAt, '2026-10-21T11:15:00.000Z');
});

test('switching back to fictional restores the unchanged fiction path', () => {
  const consent = create();
  consent.chooseRealPerson();
  consent.setAssertedBy('Ada Lovelace');
  consent.setChecked(true);
  assert.equal(consent.canSave(), true);

  assert.equal(consent.chooseFictional(), true);
  const state = consent.getState();
  assert.equal(state.kind, KIND_FICTIONAL);
  assert.equal(state.checked, false);
  assert.equal(state.warningVisible, false);
  assert.equal(state.consentRequired, false);
  assert.equal(state.assertedAt, '');
  assert.equal(consent.canSave(), true);
  assert.equal(consent.consentRecord(), null);
  assert.deepEqual(consent.fields(), { kind: KIND_FICTIONAL });

  const html = consent.render();
  assert.doesNotMatch(html, /data-likeness-warning/);
  assert.doesNotMatch(html, /data-consent-checkbox/);

  consent.setRealPerson(true);
  assert.equal(consent.getState().kind, KIND_REAL_AUTHORIZED);
  assert.equal(consent.getState().checked, false);
  assert.equal(consent.canSave(), false);
});

test('an existing consent record pre-checks the box and keeps its timestamp', () => {
  const consent = create({ kind: KIND_REAL_AUTHORIZED, consent: EXISTING });
  const state = consent.getState();

  assert.equal(state.checked, true);
  assert.equal(state.assertedBy, EXISTING.assertedBy);
  assert.equal(state.assertedAt, EXISTING.assertedAt);
  assert.equal(state.scope, EXISTING.scope);
  assert.equal(consent.canSave(), true);
  assert.deepEqual(consent.consentRecord(), EXISTING);
  assert.match(checkboxTag(consent.render()), /\bchecked\b/);

  const inferred = create({ consent: EXISTING });
  assert.equal(inferred.getState().kind, KIND_REAL_AUTHORIZED);
  assert.equal(inferred.canSave(), true);
});

test('a malformed existing consent keeps the save blocked', () => {
  const consent = create({
    kind: KIND_REAL_AUTHORIZED,
    consent: { assertedBy: '', assertedAt: 'not-a-date', scope: '', likenessWarningShown: false },
  });
  assert.equal(consent.getState().checked, false);
  assert.equal(consent.canSave(), false);
  assert.equal(consent.validate().code, CONSENT_REQUIRED_CODE);

  assert.equal(consent.applyConsent(KIND_REAL_AUTHORIZED, EXISTING), true);
  assert.equal(consent.canSave(), true);
  assert.deepEqual(consent.consentRecord(), EXISTING);

  assert.equal(consent.applyConsent(KIND_FICTIONAL, EXISTING), true);
  assert.equal(consent.getState().kind, KIND_FICTIONAL);
  assert.equal(consent.consentRecord(), null);
});

test('validateConsentRecord rejects missing and malformed records', () => {
  assert.equal(validateConsentRecord(undefined).code, CONSENT_REQUIRED_CODE);
  assert.equal(validateConsentRecord(null).code, CONSENT_REQUIRED_CODE);
  assert.equal(validateConsentRecord('nope').code, CONSENT_INVALID_CODE);
  assert.equal(validateConsentRecord({}).code, CONSENT_INVALID_CODE);
  assert.equal(validateConsentRecord({ ...EXISTING, assertedBy: '' }).code, CONSENT_INVALID_CODE);
  assert.equal(validateConsentRecord({ ...EXISTING, assertedBy: 'x'.repeat(201) }).code, CONSENT_INVALID_CODE);
  assert.equal(validateConsentRecord({ ...EXISTING, scope: '' }).code, CONSENT_INVALID_CODE);
  assert.equal(validateConsentRecord({ ...EXISTING, assertedAt: 'yesterday' }).code, CONSENT_INVALID_CODE);
  assert.equal(
    validateConsentRecord({ ...EXISTING, likenessWarningShown: false }).code,
    CONSENT_INVALID_CODE,
  );

  const ok = validateConsentRecord(EXISTING);
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.consent, EXISTING);
  assert.equal(Object.isFrozen(ok.consent), true);
});

test('validateConsent requires consent only for real_authorized', () => {
  assert.deepEqual(validateConsent(KIND_FICTIONAL, undefined), {
    ok: true,
    code: '',
    message: '',
    consent: null,
  });
  assert.equal(validateConsent(KIND_FICTIONAL, { junk: true }).ok, true);
  assert.equal(validateConsent(KIND_REAL_AUTHORIZED, undefined).code, CONSENT_REQUIRED_CODE);
  assert.equal(validateConsent(KIND_REAL_AUTHORIZED, EXISTING).ok, true);
  assert.equal(validateConsent('real_person', EXISTING).code, KIND_UNSUPPORTED_CODE);
  assert.equal(validateConsent('', EXISTING).code, KIND_UNSUPPORTED_CODE);

  assert.throws(() => normalizeConsentKind('real_person'), (error) => {
    assert.equal(error.code, KIND_UNSUPPORTED_CODE);
    return true;
  });
  assert.equal(normalizeConsentKind(' real_authorized '), KIND_REAL_AUTHORIZED);
  assert.equal(normalizeConsentKind(KIND_FICTIONAL), KIND_FICTIONAL);
});

test('consentForState mirrors the controller gate', () => {
  const state = emptyConsentState(KIND_REAL_AUTHORIZED);
  assert.equal(consentForState(state, clock).code, CONSENT_REQUIRED_CODE);

  state.checked = true;
  state.assertedAt = FIXED_NOW;
  const result = consentForState(state, clock);
  assert.equal(result.ok, true);
  assert.deepEqual(result.consent, {
    assertedBy: DEFAULT_ASSERTED_BY,
    assertedAt: FIXED_NOW,
    scope: DEFAULT_SCOPE,
    likenessWarningShown: true,
  });

  const fictional = emptyConsentState(KIND_FICTIONAL);
  assert.equal(consentForState(fictional, clock).ok, true);
});

test('rendered consent escapes user text and can omit the kind chooser', () => {
  const consent = create({ kind: KIND_REAL_AUTHORIZED });
  consent.setAssertedBy('<img src=x onerror="alert(1)">');
  consent.setScope('<b>all</b>');

  const html = consent.render();
  assert.doesNotMatch(html, /<img src=x/);
  assert.match(html, /&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;/);
  assert.match(html, /&lt;b&gt;all&lt;\/b&gt;/);

  const noChooser = renderConsentSection(consent.getState(), {
    idPrefix: 'custom-consent',
    showKindChoice: false,
  });
  assert.doesNotMatch(noChooser, /data-consent-kind-choice/);
  assert.match(noChooser, /id="custom-consent-warning"/);
  assert.match(noChooser, /id="custom-consent-status"/);

  const fictional = renderConsentSection(emptyConsentState(), {
    fictionalNotice: 'A made-up character.',
  });
  assert.match(fictional, /data-consent-fictional-notice/);
  assert.doesNotMatch(fictional, /data-consent-checkbox/);
});

test('listeners see every consent change and snapshots are isolated', () => {
  const seen = [];
  const consent = create({ onChange: (state) => seen.push(state.kind) });
  const unsubscribe = consent.subscribe((state) => seen.push(state.checked));

  consent.chooseRealPerson();
  consent.setChecked(true);
  consent.setChecked(false);

  assert.deepEqual(seen.slice(0, 6), [
    false, KIND_REAL_AUTHORIZED,
    true, KIND_REAL_AUTHORIZED,
    false, KIND_REAL_AUTHORIZED,
  ]);

  unsubscribe();
  const count = seen.length;
  consent.setChecked(true);
  assert.equal(seen.length, count + 1);

  const snapshot = consent.getState();
  snapshot.checked = false;
  snapshot.kind = KIND_FICTIONAL;
  assert.equal(consent.getState().checked, true);
  assert.equal(consent.getState().kind, KIND_REAL_AUTHORIZED);
});

test('the controller rejects an unsupported kind without changing state', () => {
  const consent = create();
  assert.throws(() => consent.setKind('real_person'), (error) => {
    assert.equal(error.code, KIND_UNSUPPORTED_CODE);
    return true;
  });
  assert.equal(consent.getState().kind, KIND_FICTIONAL);
  assert.equal(consent.canSave(), true);
});
