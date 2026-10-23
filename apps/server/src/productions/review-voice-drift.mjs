/**
 * VX10: prompt-voice drift review warning.
 *
 * A prompt-mode H3 take has no audio clip to compare automatically: the voice
 * is a written description plus a pinned seed. The review therefore asks the
 * user to listen to the take against the approved audition (manual A/B). The
 * emitted REVIEW_H3_VOICE_DRIFT warning is always non-blocking and never
 * approves a take or records a verdict.
 *
 * An identity comparison is available as evidence: the take's prompt-voice
 * hash is checked against the approved audition hash. An embedding comparison
 * runs only when the caller injects a local embedder (or precomputed local
 * vectors). This module never loads a model, calls a provider or touches a
 * network, and it has no clock, randomness or filesystem access.
 */

import {
  promptVoiceAuditionStatus,
  promptVoiceHash,
} from '../characters/audition.mjs';
import { validateH3Mode } from '../characters/voice.mjs';
import { cosineSimilarity } from '../characters/identity-qa.mjs';

export const REVIEW_H3_VOICE_DRIFT_SCHEMA = 'comfyrizz.h3-voice-drift-review/v1';
export const REVIEW_H3_VOICE_DRIFT = 'REVIEW_H3_VOICE_DRIFT';
export const REVIEW_H3_VOICE_DRIFT_KIND = 'h3_voice_drift_review';
export const DEFAULT_VOICE_DRIFT_THRESHOLD = 0.75;

export const REVIEW_H3_VOICE_DRIFT_REASONS = Object.freeze([
  'APPROVED_AUDITION_STALE',
  'NO_APPROVED_AUDITION',
  'TAKE_VOICE_HASH_MISMATCH',
  'EMBEDDING_DRIFT',
]);

const HASH_RE = /^[0-9a-f]{16,64}$/;

const MANUAL_REVIEW_MESSAGE =
  'Compare the take with the approved audition by manual A/B; this review warning never blocks dispatch and never approves the take.';

export class ReviewVoiceDriftError extends Error {
  constructor(code, field, message) {
    super(message);
    this.name = 'ReviewVoiceDriftError';
    this.code = code;
    this.field = field;
    this.ok = false;
  }
}

function fail(code, field, message) {
  throw new ReviewVoiceDriftError(code, field, message);
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function thresholdValue(value) {
  if (value === undefined) return DEFAULT_VOICE_DRIFT_THRESHOLD;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < -1 || value > 1) {
    fail(
      'REVIEW_H3_VOICE_DRIFT_INVALID',
      'threshold',
      'threshold must be a finite number from -1 to 1',
    );
  }
  return value;
}

function characterIdValue(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 256
    || /[\s/\\\u0000-\u001f]/u.test(value)) {
    fail(
      'REVIEW_H3_VOICE_DRIFT_INVALID',
      'characterId',
      'characterId must be a character id',
    );
  }
  return value;
}

function hashValue(value) {
  if (typeof value !== 'string') return null;
  const hash = value.trim().toLowerCase();
  return HASH_RE.test(hash) ? hash : null;
}

/**
 * The take's prompt-voice identity, when it records one. A malformed take voice
 * is simply no identity evidence: the review warning still asks for manual A/B.
 */
function takeVoiceHash(characterId, take) {
  if (!isPlainObject(take)) return null;
  const direct = hashValue(take.voiceHash);
  if (direct) return direct;

  const candidate = isPlainObject(take.voice)
    ? take.voice
    : isPlainObject(take.direction?.voice)
      ? take.direction.voice
      : null;
  if (!candidate) return null;
  if (candidate.mode === 'clip' || candidate.h3Mode === 'clip') return null;

  const embedded = hashValue(candidate.voiceHash);
  if (embedded) return embedded;

  try {
    if (typeof candidate.description === 'string' && candidate.seed !== undefined) {
      return hashValue(promptVoiceHash({ voice: candidate }));
    }
    if (typeof candidate.voiceDescription === 'string') {
      return hashValue(promptVoiceHash({ characterId, voice: candidate }));
    }
  } catch {
    return null;
  }
  return null;
}

function vectorValue(value) {
  if (Array.isArray(value)) return value;
  if (value instanceof Float32Array || value instanceof Float64Array) return Array.from(value);
  if (isPlainObject(value)) {
    const nested = value.embedding ?? value.vector;
    if (Array.isArray(nested)) return nested;
    if (nested instanceof Float32Array || nested instanceof Float64Array) return Array.from(nested);
  }
  return null;
}

function finiteVector(value) {
  const vector = vectorValue(value);
  if (!vector || vector.length === 0) return null;
  for (const item of vector) {
    if (typeof item !== 'number' || !Number.isFinite(item)) return null;
  }
  return vector;
}

async function resolveEmbedding(value, embed, kind) {
  const precomputed = finiteVector(value);
  if (precomputed) return { vector: precomputed, reason: null };
  if (typeof embed !== 'function') return { vector: null, reason: 'NO_LOCAL_EMBEDDING' };
  try {
    const computed = finiteVector(await embed(value, { kind }));
    return computed
      ? { vector: computed, reason: null }
      : { vector: null, reason: 'EMBEDDING_INVALID' };
  } catch {
    return { vector: null, reason: 'EMBEDDING_UNAVAILABLE' };
  }
}

function unusedEmbedding(threshold, reason) {
  return {
    used: false,
    threshold,
    similarity: null,
    drifted: null,
    reason,
  };
}

async function embeddingEvidence(input, threshold) {
  const source = isPlainObject(input.embedding) ? input.embedding : null;
  if (!source || source.take === undefined || source.audition === undefined) {
    return unusedEmbedding(
      threshold,
      source ? 'EMBEDDING_MISSING' : 'NO_LOCAL_EMBEDDING',
    );
  }

  const take = await resolveEmbedding(source.take, input.embed, 'take');
  const audition = await resolveEmbedding(source.audition, input.embed, 'audition');
  if (!take.vector || !audition.vector) {
    return unusedEmbedding(threshold, take.reason ?? audition.reason);
  }

  let similarity;
  try {
    similarity = cosineSimilarity(take.vector, audition.vector);
  } catch {
    return unusedEmbedding(threshold, 'EMBEDDING_INVALID');
  }
  const rounded = Math.round(similarity * 1e6) / 1e6;
  return {
    used: true,
    threshold,
    similarity: rounded,
    drifted: rounded < threshold,
    reason: null,
  };
}

function warningMessage(detected) {
  const lead = detected === true
    ? 'Possible prompt-voice drift needs a listening check.'
    : 'Prompt-voice takes need a listening check.';
  return `${lead} ${MANUAL_REVIEW_MESSAGE}`;
}

function clipResult(threshold) {
  return deepFreeze({
    schema: REVIEW_H3_VOICE_DRIFT_SCHEMA,
    kind: REVIEW_H3_VOICE_DRIFT_KIND,
    applicable: false,
    blocking: false,
    approved: false,
    autoDispatch: false,
    requiresUserReview: true,
    requiresManualReview: true,
    voiceState: null,
    voiceHash: null,
    approvedVoiceHash: null,
    takeVoiceHash: null,
    detected: null,
    reasons: [],
    embedding: unusedEmbedding(threshold, 'NOT_PROMPT_MODE'),
    warnings: [],
  });
}

/**
 * Review one prompt-mode H3 take against the character's approved audition.
 *
 * @param {{
 *   characterId: string,
 *   voice: object,
 *   h3VoiceMode?: 'clip' | 'prompt',
 *   audition?: { voiceHash?: string, line?: string },
 *   take?: { voiceHash?: string, voice?: object, direction?: { voice?: object } },
 *   embedding?: { take?: unknown, audition?: unknown },
 *   embed?: (media: unknown, context: { kind: 'take' | 'audition' }) => unknown,
 *   threshold?: number,
 * }} input
 * @returns {Promise<object>} a frozen warning record; never an approval.
 */
export async function reviewVoiceDrift(input = {}, ...extra) {
  if (extra.length > 0) {
    fail(
      'REVIEW_H3_VOICE_DRIFT_INVALID',
      'input',
      'reviewVoiceDrift takes exactly one input object',
    );
  }
  if (!isPlainObject(input)) {
    fail('REVIEW_H3_VOICE_DRIFT_INVALID', 'input', 'reviewVoiceDrift needs an object');
  }
  if (!isPlainObject(input.voice)) {
    fail('REVIEW_H3_VOICE_DRIFT_INVALID', 'voice', 'a character voice record is required');
  }

  const mode = input.h3VoiceMode !== undefined && input.h3VoiceMode !== null
    ? validateH3Mode(input.h3VoiceMode)
    : input.voice.h3Mode !== undefined && input.voice.h3Mode !== null
      ? validateH3Mode(input.voice.h3Mode)
      : 'clip';
  const threshold = thresholdValue(input.threshold);
  if (mode !== 'prompt') return clipResult(threshold);

  const characterId = characterIdValue(input.characterId);
  const status = promptVoiceAuditionStatus({
    characterId,
    voice: input.voice,
    ...(input.audition !== undefined ? { audition: input.audition } : {}),
  });

  const takeHash = takeVoiceHash(characterId, input.take);
  const embedding = status.state === 'missing'
    ? unusedEmbedding(threshold, 'NO_APPROVED_AUDITION')
    : await embeddingEvidence(input, threshold);

  const reasons = [];
  let detected = null;

  if (status.stale) {
    reasons.push('APPROVED_AUDITION_STALE');
    detected = true;
  } else if (status.state === 'missing') {
    reasons.push('NO_APPROVED_AUDITION');
  } else if (takeHash && status.approvedVoiceHash && takeHash !== status.approvedVoiceHash) {
    reasons.push('TAKE_VOICE_HASH_MISMATCH');
    detected = true;
  } else if (takeHash && status.approvedVoiceHash) {
    detected = false;
  }

  if (embedding.drifted === true) {
    if (!reasons.includes('EMBEDDING_DRIFT')) reasons.push('EMBEDDING_DRIFT');
    detected = true;
  } else if (embedding.drifted === false && detected === null) {
    detected = false;
  }

  const warning = {
    code: REVIEW_H3_VOICE_DRIFT,
    severity: 'warning',
    blocking: false,
    requiresManualReview: true,
    message: warningMessage(detected),
    voiceState: status.state,
    detected,
    reasons: [...reasons],
  };

  return deepFreeze({
    schema: REVIEW_H3_VOICE_DRIFT_SCHEMA,
    kind: REVIEW_H3_VOICE_DRIFT_KIND,
    applicable: true,
    blocking: false,
    approved: false,
    autoDispatch: false,
    requiresUserReview: true,
    requiresManualReview: true,
    voiceState: status.state,
    voiceHash: status.currentVoiceHash,
    approvedVoiceHash: status.approvedVoiceHash,
    takeVoiceHash: takeHash,
    detected,
    reasons,
    embedding,
    warnings: [warning],
  });
}
