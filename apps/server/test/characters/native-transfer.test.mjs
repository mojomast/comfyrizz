// UX14: approved recording references and the native transfer test.
//
// Fixtures only. Nothing here starts a backend, asks for Google Colab, touches
// the network or spends budget. The reference fixture bytes are hashes of
// labelled strings, so a checksum change is easy to see and no media file is
// needed.
//
// The transfer test is technical evidence tied to one exact recording, model,
// workflow and conditioning set. A human verdict is recorded separately and is
// invalidated when any of those inputs changes.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import {
  VOICE_PROJECTION_SCHEMA,
  VOICE_REFERENCE_SCHEMA,
  VOICE_TRANSFER_CAPABILITY_SCHEMA,
  VoiceProjectionError,
  inspectVoiceTransferCapability,
  projectCharacterVoice,
  projectVoiceReference,
  resolveOwnVoiceReference,
  sameReferenceBytes,
  validateVoiceReference,
} from '../../src/characters/voice-projection.mjs';
import {
  NATIVE_TRANSFER_KIND,
  NATIVE_TRANSFER_SCHEMA,
  NATIVE_TRANSFER_VERDICT_KIND,
  NATIVE_TRANSFER_VERDICT_USER_ONLY,
  NATIVE_TRANSFER_UNSUPPORTED,
  buildNativeTransferTest,
  nativeTransferStatus,
  recordNativeTransferVerdict,
} from '../../src/productions/native-test.mjs';

const IDS = Object.freeze({
  basil: 'chr_1111111111111111',
  molty: 'chr_2222222222222222',
  donPiedro: 'chr_3333333333333333',
  qc1: 'chr_4444444444444444',
  qc2: 'chr_5555555555555555',
});

const LINE = Object.freeze({ text: 'The roof is heavy.', language: 'en-us', delivery: 'low and measured' });

const MODEL = Object.freeze({
  id: 'native-transfer-model',
  capabilities: Object.freeze({
    voiceTransfer: true,
    supportsNativeVoice: true,
    nativeVoices: Object.freeze([Object.freeze({ id: 'fixture-voice', language: 'en-us' })]),
    defaultNativeVoice: 'fixture-voice',
  }),
});

const WORKFLOW = Object.freeze({
  id: 'workflow_native_transfer',
  revision: 'wf-7',
  conditioning: Object.freeze(['voice_reference_audio']),
});

function fixtureSha(label) {
  return createHash('sha256').update(`ux14-fixture-bytes:${label}`).digest('hex');
}

function reference(characterId, label, overrides = {}) {
  return {
    schema: VOICE_REFERENCE_SCHEMA,
    referenceId: `vref_${label}`,
    characterId,
    kind: 'recording',
    language: 'en-us',
    delivery: 'Low, measured and intimate.',
    audio: {
      sha256: fixtureSha(label),
      bytes: 48000,
      mimeType: 'audio/wav',
    },
    provenance: {
      source: 'recording',
      originProjectId: 'proj_origin',
      capturedAt: '2026-10-20T00:00:00.000Z',
      note: `Approved ${label} fixture recording.`,
    },
    status: 'approved',
    decidedBy: 'user',
    availability: 'available',
    ...overrides,
  };
}

function rejectedReference(characterId, label) {
  return reference(characterId, label, {
    status: 'rejected',
    rejectionReason: 'The performance reads as a different character.',
  });
}

function transferInput(overrides = {}) {
  return {
    actionId: 'act_native_transfer',
    shotId: 'shot_transfer',
    upperBound: 1.5,
    characterId: IDS.basil,
    reference: reference(IDS.basil, 'basil'),
    model: MODEL,
    workflow: WORKFLOW,
    line: { ...LINE },
    ...overrides,
  };
}

function code(expected) {
  return (error) => {
    assert.ok(error instanceof VoiceProjectionError, `expected VoiceProjectionError, got ${error?.name}`);
    assert.equal(error.code, expected, error.message);
    return true;
  };
}

test('fixture reference bytes stay identical when projected into another project', () => {
  const source = validateVoiceReference(reference(IDS.basil, 'basil'));
  const first = projectVoiceReference(source, { projectId: 'proj_first' });
  const second = projectVoiceReference(source, { projectId: 'proj_second' });

  assert.equal(first.schema, VOICE_PROJECTION_SCHEMA);
  assert.equal(first.projectId, 'proj_first');
  assert.equal(second.projectId, 'proj_second');
  assert.equal(first.referenceId, source.referenceId);
  assert.equal(first.characterId, IDS.basil);
  assert.equal(first.audio.sha256, source.audio.sha256);
  assert.equal(first.audio.bytes, source.audio.bytes);
  assert.equal(second.audio.sha256, source.audio.sha256);
  assert.equal(second.audio.bytes, source.audio.bytes);
  assert.equal(sameReferenceBytes(first, second), true);
  assert.equal(first.portable, true);
  assert.equal(Object.isFrozen(first), true);
  assert.equal(Object.isFrozen(first.audio), true);
  assert.doesNotMatch(JSON.stringify(first), /"(?:path|file|url|ticket)"\s*:/);
});

test('Basil, Molty and Don Piedro keep separate approved references', () => {
  const references = [
    reference(IDS.basil, 'basil'),
    reference(IDS.molty, 'molty'),
    reference(IDS.donPiedro, 'don-piedro'),
  ];

  const basil = resolveOwnVoiceReference({
    characterId: IDS.basil,
    references,
    referenceId: 'vref_basil',
  });
  const molty = resolveOwnVoiceReference({
    characterId: IDS.molty,
    references,
    referenceId: 'vref_molty',
  });
  const don = resolveOwnVoiceReference({
    characterId: IDS.donPiedro,
    references,
    referenceId: 'vref_don-piedro',
  });

  assert.notEqual(basil.audio.sha256, molty.audio.sha256);
  assert.notEqual(molty.audio.sha256, don.audio.sha256);
  assert.notEqual(basil.audio.sha256, don.audio.sha256);

  assert.throws(
    () => resolveOwnVoiceReference({
      characterId: IDS.basil,
      references,
      referenceId: 'vref_molty',
    }),
    code('VOICE_REFERENCE_FOREIGN_CHARACTER'),
  );
});

test('QC1 and QC2 rejected references are never selectable or transferable', () => {
  const references = [
    rejectedReference(IDS.qc1, 'qc1'),
    rejectedReference(IDS.qc2, 'qc2'),
  ];

  for (const [characterId, referenceId] of [
    [IDS.qc1, 'vref_qc1'],
    [IDS.qc2, 'vref_qc2'],
  ]) {
    assert.throws(
      () => resolveOwnVoiceReference({ characterId, references, referenceId }),
      code('VOICE_REFERENCE_REJECTED'),
    );
    assert.throws(
      () => buildNativeTransferTest(transferInput({
        characterId,
        reference: references[characterId === IDS.qc1 ? 0 : 1],
        actionId: `act_${referenceId}`,
      })),
      (error) => error.code === 'VOICE_REFERENCE_REJECTED',
    );
  }
});

test('missing reference bytes refuse selection instead of recasting the character', () => {
  const missing = reference(IDS.basil, 'basil-missing', {
    availability: 'missing',
    missingReason: 'The approved recording bytes are not connected.',
  });

  assert.throws(
    () => resolveOwnVoiceReference({
      characterId: IDS.basil,
      references: [missing],
      referenceId: 'vref_basil-missing',
    }),
    code('VOICE_REFERENCE_MISSING'),
  );
  assert.throws(
    () => buildNativeTransferTest(transferInput({ reference: missing })),
    (error) => error.code === 'VOICE_REFERENCE_MISSING',
  );
});

test('transfer capability is read from explicit declarations, never a model name', () => {
  const labelOnly = inspectVoiceTransferCapability({
    model: { id: 'Google Colab native voice', capabilities: {} },
    workflow: WORKFLOW,
  });
  assert.equal(labelOnly.schema, VOICE_TRANSFER_CAPABILITY_SCHEMA);
  assert.equal(labelOnly.supportsTransfer, false);
  assert.ok(labelOnly.reasons.includes('MODEL_TRANSFER_CAPABILITY_MISSING'));

  const supported = inspectVoiceTransferCapability({ model: MODEL, workflow: WORKFLOW });
  assert.equal(supported.supportsTransfer, true);
  assert.deepEqual(supported.reasons, []);
  assert.equal(supported.modelId, 'native-transfer-model');
  assert.equal(supported.workflowId, 'workflow_native_transfer');
  assert.deepEqual(supported.conditioning, ['voice_reference_audio']);

  const unsupportedWorkflow = inspectVoiceTransferCapability({
    model: MODEL,
    workflow: { id: 'workflow_plain', revision: 'wf-1', conditioning: ['text_prompt'] },
  });
  assert.equal(unsupportedWorkflow.supportsTransfer, false);
  assert.ok(unsupportedWorkflow.reasons.includes('WORKFLOW_VOICE_REFERENCE_UNSUPPORTED'));
});

test('a native transfer test pins the exact recording, model, workflow and conditioning', () => {
  let touched = 0;
  const backend = {
    get start() {
      touched += 1;
      throw new Error('a transfer test must not start a backend');
    },
  };

  const action = buildNativeTransferTest(transferInput({ backend }));

  assert.equal(action.schema, NATIVE_TRANSFER_SCHEMA);
  assert.equal(action.kind, NATIVE_TRANSFER_KIND);
  assert.equal(action.id, 'act_native_transfer');
  assert.equal(action.shotId, 'shot_transfer');
  assert.equal(action.characterId, IDS.basil);
  assert.equal(action.state, 'planned');
  assert.equal(action.approved, false);
  assert.equal(action.autoDispatch, false);
  assert.equal(action.approvalRequired, true);
  assert.equal(action.verdict, null);
  assert.equal(action.humanReviewRequired, true);

  assert.equal(action.dependencies.reference.referenceId, 'vref_basil');
  assert.equal(action.dependencies.reference.characterId, IDS.basil);
  assert.equal(action.dependencies.reference.sha256, fixtureSha('basil'));
  assert.equal(action.dependencies.reference.bytes, 48000);
  assert.equal(action.dependencies.model.id, 'native-transfer-model');
  assert.equal(action.dependencies.workflow.id, 'workflow_native_transfer');
  assert.equal(action.dependencies.workflow.revision, 'wf-7');
  assert.deepEqual(action.dependencies.workflow.conditioning, ['voice_reference_audio']);
  assert.deepEqual(action.conditioning, [
    {
      kind: 'voice_reference_audio',
      referenceId: 'vref_basil',
      sha256: fixtureSha('basil'),
      bytes: 48000,
    },
  ]);
  assert.equal(touched, 0);
  assert.equal(Object.isFrozen(action), true);
  assert.equal(Object.isFrozen(action.dependencies), true);
  assert.doesNotMatch(JSON.stringify(action), /"(?:path|file|url)"\s*:/);
});

test('a model or workflow without an explicit transfer declaration refuses the plan', () => {
  const unsupportedModel = buildRefusal(() => buildNativeTransferTest(transferInput({
    model: { id: 'native-transfer-model', capabilities: {} },
  })));
  assert.equal(unsupportedModel.code, NATIVE_TRANSFER_UNSUPPORTED);
  assert.equal(unsupportedModel.field, 'model');

  const unsupportedWorkflow = buildRefusal(() => buildNativeTransferTest(transferInput({
    workflow: { id: 'workflow_plain', revision: 'wf-1', conditioning: ['text_prompt'] },
  })));
  assert.equal(unsupportedWorkflow.code, NATIVE_TRANSFER_UNSUPPORTED);
  assert.equal(unsupportedWorkflow.field, 'workflow');
});

test('technical success alone stays unreviewed and cannot approve acting', () => {
  const action = buildNativeTransferTest(transferInput());
  const status = nativeTransferStatus({
    test: action,
    technical: { clean: true, transcript: 'The roof is heavy.', wordErrorRate: 0 },
  });

  assert.equal(status.status, 'unreviewed');
  assert.equal(status.accepted, false);
  assert.equal(status.technicalClean, true);
  assert.equal(status.requiresHumanReview, true);
  assert.equal(status.invalidated, false);
});

test('a changed recording invalidates an accepted transfer', () => {
  const action = buildNativeTransferTest(transferInput());
  const verdict = recordNativeTransferVerdict({
    test: action,
    verdict: 'accepted',
    reviewedBy: 'user',
    note: 'The user accepted this exact transfer test.',
  });

  assert.equal(verdict.kind, NATIVE_TRANSFER_VERDICT_KIND);
  assert.equal(verdict.testId, action.id);
  assert.equal(verdict.verdict, 'accepted');

  const fresh = nativeTransferStatus({ test: action, verdict });
  assert.equal(fresh.status, 'accepted');
  assert.equal(fresh.accepted, true);
  assert.equal(fresh.invalidated, false);

  const changed = buildNativeTransferTest(transferInput({
    reference: reference(IDS.basil, 'basil-take-two'),
  }));
  const stale = nativeTransferStatus({ test: action, current: changed, verdict });
  assert.equal(stale.status, 'invalidated');
  assert.equal(stale.accepted, false);
  assert.equal(stale.invalidated, true);
  assert.ok(stale.reasons.includes('reference'));

  assert.equal(
    nativeTransferStatus({ test: action, verdict: { ...verdict, testId: 'act_other' } }).status,
    'invalidated',
  );
});

test('a changed model or workflow also invalidates an accepted transfer', () => {
  const action = buildNativeTransferTest(transferInput());
  const verdict = recordNativeTransferVerdict({ test: action, verdict: 'accepted', reviewedBy: 'user' });

  const modelChanged = buildNativeTransferTest(transferInput({
    model: { ...MODEL, id: 'native-transfer-model-v2' },
  }));
  const workflowChanged = buildNativeTransferTest(transferInput({
    workflow: { ...WORKFLOW, revision: 'wf-8' },
  }));

  assert.ok(nativeTransferStatus({ test: action, current: modelChanged, verdict }).reasons.includes('model'));
  assert.ok(nativeTransferStatus({ test: action, current: workflowChanged, verdict }).reasons.includes('workflow'));
});

test('only a user verdict decides, and rejection stays explicit and separate', () => {
  const action = buildNativeTransferTest(transferInput());

  assert.throws(
    () => recordNativeTransferVerdict({ test: action, verdict: 'accepted', reviewedBy: 'agent' }),
    (error) => error.code === NATIVE_TRANSFER_VERDICT_USER_ONLY,
  );

  const rejected = recordNativeTransferVerdict({
    test: action,
    verdict: 'rejected',
    reviewedBy: 'user',
    note: 'Acting does not fit the character.',
  });
  const status = nativeTransferStatus({ test: action, verdict: rejected, technical: { clean: true } });
  assert.equal(status.status, 'rejected');
  assert.equal(status.accepted, false);
  assert.equal(status.requiresHumanReview, false);
});

test('returning characters reuse their own reference and appearance-only edits preserve voice', () => {
  const references = [
    reference(IDS.basil, 'basil'),
    reference(IDS.molty, 'molty'),
  ];
  const previous = {
    id: IDS.basil,
    revision: 2,
    voice: { engine: 'kokoro', voice: 'am_michael', language: 'en-us' },
    visual: { identityPrompt: 'brown bear in cobalt armor' },
  };
  const appearanceOnly = {
    id: IDS.basil,
    revision: 3,
    voice: { engine: 'kokoro', voice: 'am_michael', language: 'en-us' },
    visual: { identityPrompt: 'brown bear in repaired cobalt armor' },
  };

  const reused = projectCharacterVoice({
    character: appearanceOnly,
    previous,
    references,
    referenceId: 'vref_basil',
    projectId: 'proj_returning',
  });

  assert.equal(reused.status, 'reused');
  assert.equal(reused.appearanceOnly, true);
  assert.equal(reused.voiceChanged, false);
  assert.equal(reused.reference.referenceId, 'vref_basil');
  assert.equal(reused.reference.characterId, IDS.basil);
  assert.equal(sameReferenceBytes(reused.reference, references[0]), true);

  const voiceChanged = projectCharacterVoice({
    character: { ...appearanceOnly, voice: { ...appearanceOnly.voice, voice: 'af_heart' } },
    previous,
    references,
    referenceId: 'vref_basil',
    projectId: 'proj_returning',
  });
  assert.equal(voiceChanged.status, 'voice_changed');
  assert.equal(voiceChanged.voiceChanged, true);
  assert.equal(voiceChanged.appearanceOnly, false);
});

function buildRefusal(run) {
  try {
    run();
  } catch (error) {
    return error;
  }
  return assert.fail('expected the builder to refuse');
}
