// UX14: approved voice reference UI projection.
//
// The browser only reads records the server already validated. It never picks
// a different character's recording, never treats a rejected or missing-byte
// reference as usable, and never turns a model name into a capability claim.
// These are string-level tests: no DOM, network or Google Colab call.

// @ts-nocheck
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  VOICE_REFERENCE_UI_SCHEMA,
  readVoiceReferenceState,
  renderVoiceReference,
  voiceReferenceCapabilityNote,
} from './voice-reference.ts';
import {
  readVoiceModeState,
  renderVoiceMode,
} from './voice-mode.ts';

const CHARACTER_ID = 'chr_0123456789abcdef';
const OTHER_ID = 'chr_fedcba9876543210';

function reference(overrides = {}) {
  return {
    referenceId: 'vref_approved',
    characterId: CHARACTER_ID,
    kind: 'recording',
    language: 'en-us',
    delivery: 'Low, warm and measured.',
    audio: {
      sha256: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      bytes: 48000,
      mimeType: 'audio/wav',
    },
    provenance: {
      source: 'recording',
      originProjectId: 'proj_origin',
      capturedAt: '2026-10-20T00:00:00.000Z',
      note: 'Approved studio recording.',
    },
    status: 'approved',
    decidedBy: 'user',
    availability: 'available',
    ...overrides,
  };
}

function character(voice = {}) {
  return {
    id: CHARACTER_ID,
    revision: 3,
    voice: {
      engine: 'kokoro',
      voice: 'af_heart',
      ...voice,
    },
  };
}

function count(html, pattern) {
  return (html.match(pattern) ?? []).length;
}

test('an approved own reference exposes its checksum, language, delivery and provenance', () => {
  const state = readVoiceReferenceState({
    characterId: CHARACTER_ID,
    references: [reference()],
    selectedReferenceId: 'vref_approved',
    capability: { supportsTransfer: true, reasons: [], modelId: 'fixture-model', workflowId: 'workflow_1' },
  });

  assert.equal(state.schema, VOICE_REFERENCE_UI_SCHEMA);
  assert.equal(state.status, 'approved');
  assert.equal(state.characterId, CHARACTER_ID);
  assert.equal(state.selected.referenceId, 'vref_approved');
  assert.equal(state.selected.shortChecksum, '0123456789ab');
  assert.equal(state.selected.language, 'en-us');
  assert.equal(state.selected.delivery, 'Low, warm and measured.');
  assert.equal(state.selected.provenance.source, 'recording');
  assert.equal(state.capability.supportsTransfer, true);
  assert.match(state.guidance, /approved voice recording/i);

  const html = renderVoiceReference(state);
  assert.match(html, /data-voice-reference/);
  assert.match(html, /data-reference-status="approved"/);
  assert.match(html, /data-reference-id="vref_approved"/);
  assert.match(html, /data-reference-sha256="0123456789abcdef/);
  assert.match(html, /data-reference-language="en-us"/);
  assert.match(html, /Low, warm and measured\./);
  assert.match(html, /declares native transfer/i);
  assert.equal(count(html, /<input\b/g), 0, 'reference status is read-only');
});

test('rejected, missing-byte, foreign and ambiguous selections fail closed', () => {
  const rejected = readVoiceReferenceState({
    characterId: CHARACTER_ID,
    references: [reference({ status: 'rejected', rejectionReason: 'Wrong character.' })],
    selectedReferenceId: 'vref_approved',
  });
  assert.equal(rejected.status, 'rejected');
  assert.equal(rejected.selected, null);
  assert.match(rejected.guidance, /rejected/i);

  const unavailable = readVoiceReferenceState({
    characterId: CHARACTER_ID,
    references: [reference({ availability: 'missing', missingReason: 'Original bytes missing.' })],
    selectedReferenceId: 'vref_approved',
  });
  assert.equal(unavailable.status, 'unavailable');
  assert.equal(unavailable.selected, null);
  assert.match(unavailable.guidance, /does not recast/i);

  const foreign = readVoiceReferenceState({
    characterId: OTHER_ID,
    references: [reference()],
    selectedReferenceId: 'vref_approved',
  });
  assert.equal(foreign.status, 'foreign');
  assert.equal(foreign.selected, null);
  assert.match(foreign.guidance, /another character/i);

  const ambiguous = readVoiceReferenceState({
    characterId: CHARACTER_ID,
    references: [reference(), reference({ referenceId: 'vref_second' })],
  });
  assert.equal(ambiguous.status, 'selection_required');
  assert.equal(ambiguous.selected, null);

  const none = readVoiceReferenceState({ characterId: CHARACTER_ID, references: [] });
  assert.equal(none.status, 'missing');
  assert.equal(none.selected, null);
});

test('the capability note uses only the explicit capability report', () => {
  const supported = voiceReferenceCapabilityNote({
    supportsTransfer: true,
    reasons: [],
    modelId: 'Google Colab native voice',
    workflowId: 'workflow_1',
  });
  assert.match(supported, /declares native transfer/i);
  assert.match(supported, /Google Colab/);

  const unsupported = voiceReferenceCapabilityNote({
    supportsTransfer: false,
    reasons: ['MODEL_TRANSFER_CAPABILITY_MISSING'],
    modelId: 'Google Colab native voice',
    workflowId: 'workflow_1',
  });
  assert.match(unsupported, /not available/i);
  assert.match(unsupported, /MODEL_TRANSFER_CAPABILITY_MISSING/);

  const labelOnly = readVoiceReferenceState({
    characterId: CHARACTER_ID,
    references: [reference()],
    selectedReferenceId: 'vref_approved',
    capability: { supportsTransfer: false, reasons: ['MODEL_TRANSFER_CAPABILITY_MISSING'] },
  });
  assert.equal(labelOnly.capability.supportsTransfer, false);
});

test('voice mode clip guidance names the approved recording and never implies clip reuse', () => {
  const approved = readVoiceModeState({
    character: character(),
    reference: {
      references: [reference()],
      selectedReferenceId: 'vref_approved',
      capability: { supportsTransfer: true, reasons: [] },
    },
  });
  const html = renderVoiceMode(approved, { tier: 'easy' });
  assert.equal(approved.reference.status, 'approved');
  assert.match(html, /approved voice recording/i);
  assert.equal(/Uses the character's voice clip/.test(html), false);
  assert.match(html, /data-voice-reference/);

  const missing = readVoiceModeState({ character: character() });
  const missingHtml = renderVoiceMode(missing, { tier: 'easy' });
  assert.equal(missing.reference.status, 'missing');
  assert.match(missingHtml, /does not recast/i);
});

test('reference text is escaped and the card never exposes a path or URL', () => {
  const state = readVoiceReferenceState({
    characterId: CHARACTER_ID,
    references: [reference({
      delivery: '<img src=x onerror=alert(1)>',
      provenance: {
        source: 'recording',
        note: '<script>alert(1)</script>',
      },
    })],
    selectedReferenceId: 'vref_approved',
  });

  const html = renderVoiceReference(state);
  assert.equal(html.includes('<img'), false);
  assert.equal(html.includes('<script>'), false);
  assert.match(html, /&lt;img/);
  assert.match(html, /&lt;script&gt;/);
  assert.doesNotMatch(html, /https?:\/\//);
  assert.doesNotMatch(html, /(?:^|["'\s])\/[A-Za-z0-9._-]+\//);
});
