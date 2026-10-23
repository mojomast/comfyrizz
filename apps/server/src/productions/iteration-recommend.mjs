// IL07: recommend an iteration level from length, shots, characters and cap.
//
// Pure: no backend, no filesystem, no clock, no randomness, no Google Colab.
// The server owns identity and revisions; this only proposes a policy that
// the user must still approve via iteration.set (choosing a level is never a
// spend approval).

import { ITERATION_PRESETS, validateIterationPolicy } from './iteration.mjs';
import { estimateIteration } from './iteration-estimate.mjs';

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function clone(value) {
  return structuredClone(value);
}

function applyVoiceAuditions(policy, newCharacterCount) {
  if (newCharacterCount <= 0) return { policy, applied: false };
  const voice = policy.stages.voice;
  if (voice.auditions !== 0) return { policy, applied: false };
  const next = clone(policy);
  next.stages = clone(policy.stages);
  next.stages.voice = clone(policy.stages.voice);
  next.stages.voice.auditions = ITERATION_PRESETS.balanced.stages.voice.auditions;
  return { policy: next, applied: true };
}

export function recommendIteration(input) {
  if (!isPlainObject(input)) throw new TypeError('recommendIteration input must be an object');

  const {
    durationSeconds,
    shotCount,
    characterCount,
    newCharacterCount,
    ceiling,
    userDefault,
    estimate,
  } = input;

  if (typeof durationSeconds !== 'number' || !Number.isFinite(durationSeconds) || durationSeconds < 0) {
    throw new TypeError('durationSeconds must be a finite number >= 0');
  }
  if (!Number.isInteger(shotCount) || shotCount < 0) {
    throw new TypeError('shotCount must be an integer >= 0');
  }
  if (!Number.isInteger(characterCount) || characterCount < 0) {
    throw new TypeError('characterCount must be an integer >= 0');
  }
  if (!Number.isInteger(newCharacterCount) || newCharacterCount < 0) {
    throw new TypeError('newCharacterCount must be an integer >= 0');
  }
  if (ceiling !== null && ceiling !== undefined) {
    if (typeof ceiling !== 'number' || !Number.isFinite(ceiling) || ceiling < 0) {
      throw new TypeError('ceiling must be null or a finite number >= 0');
    }
  }
  if (userDefault !== null && userDefault !== undefined) {
    try {
      validateIterationPolicy(userDefault);
    } catch {
      throw new TypeError('userDefault must be a valid iteration policy');
    }
  }
  if (estimate !== undefined && typeof estimate !== 'function') {
    throw new TypeError('estimate must be a function');
  }

  const isUserDefault = userDefault !== null && userDefault !== undefined;

  const estimateFn = estimate === undefined
    ? (policy) => {
        const shots = [];
        const n = shotCount > 0 ? shotCount : 0;
        const per = n > 0 ? durationSeconds / n : 0;
        for (let i = 0; i < n; i++) {
          shots.push({ id: `shot-${i + 1}`, durationSeconds: per });
        }
        return estimateIteration({ policy, shots, characters: characterCount, ceiling });
      }
    : (policy) => estimate(policy);

  // Rule 1: candidate.
  let candidateRaw;
  const candidateReasons = [];
  if (isUserDefault) {
    candidateRaw = clone(validateIterationPolicy(userDefault));
    candidateReasons.push('using your saved default');
  } else if (durationSeconds > 90 || shotCount >= 12) {
    candidateRaw = clone(ITERATION_PRESETS.balanced);
    candidateReasons.push('no history: balanced');
  } else if (durationSeconds < 20 && shotCount <= 3) {
    candidateRaw = clone(ITERATION_PRESETS.director);
    candidateReasons.push('director');
  } else {
    candidateRaw = clone(ITERATION_PRESETS.balanced);
    candidateReasons.push('no history: balanced');
  }

  // Rule 2: voice auditions for new characters, before cap check.
  const { policy: candidateWithAuditions, applied: auditionsApplied } = applyVoiceAuditions(candidateRaw, newCharacterCount);
  if (auditionsApplied) {
    candidateReasons.push(`voice auditions on for ${newCharacterCount} new character(s)`);
  }
  const candidate = validateIterationPolicy(candidateWithAuditions);
  const candidateUnitsHigh = estimateFn(candidate).units.high;

  const noCap = ceiling === null || ceiling === undefined;
  const fits = (policy) => noCap || estimateFn(policy).units.high <= ceiling;

  if (fits(candidate)) {
    return {
      level: candidate.level,
      policy: candidate,
      reasons: candidateReasons.length > 0 ? candidateReasons : ['balanced'],
    };
  }

  const candidateName = isUserDefault ? 'your saved default' : candidate.level;
  const exceedsReason = (level) => `${candidateName} exceeds the cap; using ${level}`;

  // Walk order.
  let walkLevels;
  if (isUserDefault || candidate.level === 'custom') {
    walkLevels = ['balanced', 'draft'];
  } else if (candidate.level === 'director') {
    walkLevels = ['balanced', 'draft'];
  } else if (candidate.level === 'balanced') {
    walkLevels = ['draft'];
  } else {
    walkLevels = [];
  }

  for (const level of walkLevels) {
    const preset = ITERATION_PRESETS[level];
    const presetAuditionsZero = preset.stages.voice.auditions === 0;
    const audAppliedThis = newCharacterCount > 0 && presetAuditionsZero;

    // with auditions
    const withAudRaw = clone(preset);
    const { policy: withAudPolicyRaw, applied: withAudApplied } = applyVoiceAuditions(withAudRaw, newCharacterCount);
    const withAudPolicy = validateIterationPolicy(withAudPolicyRaw);
    const withAudUnits = estimateFn(withAudPolicy).units.high;

    const withoutPolicy = withAudApplied ? validateIterationPolicy(clone(preset)) : null;
    const withoutUnits = withoutPolicy ? estimateFn(withoutPolicy).units.high : null;

    const cheaperWith = withAudUnits < candidateUnitsHigh;
    const cheaperWithout = withoutUnits !== null && withoutUnits < candidateUnitsHigh;

    if (!cheaperWith && !cheaperWithout) continue; // not cheaper

    if (cheaperWith && fits(withAudPolicy)) {
      return {
        level: withAudPolicy.level,
        policy: withAudPolicy,
        reasons: [exceedsReason(level)],
      };
    }

    // without auditions (if auditions were applied)
    if (withAudApplied && cheaperWithout && fits(withoutPolicy)) {
      return {
        level: withoutPolicy.level,
        policy: withoutPolicy,
        reasons: [exceedsReason(level), 'voice auditions would exceed the cap'],
      };
    }
  }

  const plainDraft = validateIterationPolicy(clone(ITERATION_PRESETS.draft));
  return {
    level: 'draft',
    policy: plainDraft,
    reasons: ['no level fits the cap'],
  };
}
