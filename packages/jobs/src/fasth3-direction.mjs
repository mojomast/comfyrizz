// Full-reference prompt contract, based on MiniMax's official ref-mode guide.
// This supports the shipped two-image / one-audio graph and a single shot/voice.
// It is prompt conditioning, not a guarantee of composition or exact speech.
const text = (value, name) => {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`FastH3 direction.${name} must be nonempty text`);
  if (/[<>]/.test(value)) throw new Error(`FastH3 direction.${name} must contain plain text, not reference/dialogue tags`);
  return value.trim();
};
const positive = value => typeof value === 'number' && Number.isFinite(value) && value > 0;
const normalized = value => value.normalize('NFKC').replace(/\s+/g, ' ').trim();

/** Build one native-AV shot. Metadata is planner-only, never a Comfy node input. */
export function buildFastH3Prompt(direction, { slotSeconds, sourceSeconds, conditioningSeconds } = {}) {
  if (!direction || typeof direction !== 'object' || Array.isArray(direction)) throw new Error('FastH3 direction must be an object');
  const subject = text(direction.subject, 'subject');
  const composition = text(direction.composition, 'composition');
  const action = text(direction.action, 'action');
  const camera = text(direction.camera, 'camera');
  const soundscape = text(direction.soundscape, 'soundscape');
  const count = direction.characterCount;
  if (!Number.isInteger(count) || count < 0) throw new Error('FastH3 direction.characterCount must be a nonnegative integer');
  const reaction = direction.reactionSeconds ?? .2;
  if (typeof reaction !== 'number' || !Number.isFinite(reaction) || reaction < 0) throw new Error('FastH3 direction.reactionSeconds must be nonnegative');
  if (!positive(slotSeconds) || slotSeconds <= .2 || !positive(sourceSeconds) || slotSeconds > sourceSeconds + 1 / 24) {
    throw new Error('FastH3 direction needs a positive editorial slot that fits the generated source');
  }
  let voiceDefinition = '<Audio 1> is a silent conditioning signal.';
  let retention = '<Audio 1>: reference - silence provides no vocal content.';
  let speech = 'The shot contains only the physical sounds described below.';
  if (direction.dialogue !== undefined) {
    const d = direction.dialogue;
    if (!d || typeof d !== 'object' || Array.isArray(d)) throw new Error('FastH3 direction.dialogue must be an object');
    const line = text(d.text, 'dialogue.text');
    const language = text(d.language, 'dialogue.language');
    const voice = text(d.voice, 'dialogue.voice');
    const delivery = text(d.delivery, 'dialogue.delivery');
    if (d.offscreen !== undefined && typeof d.offscreen !== 'boolean') throw new Error('FastH3 dialogue.offscreen must be boolean');
    if (count === 0 && d.offscreen !== true) throw new Error('FastH3 an unoccupied shot needs an offscreen speaker');
    if (count > 1 && !d.offscreen) throw new Error('FastH3 this direction helper supports one visible speaker; use separate coverage for multi-character dialogue');
    if (normalized(text(d.conditioningText, 'dialogue.conditioningText')) !== normalized(line)) {
      throw new Error('FastH3 conditioning text must contain only this shot\'s exact dialogue; prepare a shot-specific reference');
    }
    if (!positive(conditioningSeconds) || conditioningSeconds + reaction > slotSeconds + 1 / 24) {
      throw new Error('FastH3 measured conditioning audio plus reaction time must fit the editorial slot at natural speed; revise the line or timing');
    }
    const speaker = d.offscreen ? `${voice} (S1), off-screen` : '<Subject 1> (S1)';
    voiceDefinition = `<Audio 1> is the voice-timbre and delivery reference for ${d.offscreen ? `${voice} (S1)` : '<Subject 1> (S1)'}.`;
    retention = '<Audio 1>: reference - guide timbre and delivery while generating a new synchronized performance.';
    speech = `${speaker} says once, ${delivery}, <d>[${language}] ${line}</d> The line begins with the action and finishes within ${(slotSeconds - reaction).toFixed(2)} seconds, leaving ${reaction.toFixed(2)} seconds for the response to land. ${d.offscreen ? 'The composition remains unoccupied by the speaker.' : '<Subject 1> closes their mouth afterward.'}`;
  }
  return `subject_definitions:
<Subject 1> is ${subject} from <Picture 1>.
<Picture 2> is the composition reference: ${composition}
${voiceDefinition}

summary:
[reference generation${direction.dialogue ? ' + audio reference' : ''}] One continuous shot of <Subject 1> using <Picture 2> for framing and spatial relationships.

retention_analysis:
<Subject 1> (appears in [Shot 1]): fully_preserved - retain the defined appearance and physical features.
<Picture 2> ([Shot 1] composition): fully_preserved - retain the described subject placement and contact points.
${retention}

detailed_description:
The visual style and lighting follow the supplied references.
[Shot 1] ${composition} ${count === 0 ? 'The setting is unoccupied throughout.' : `Exactly ${count} visible character${count === 1 ? '' : 's'} occupy the shot.`} ${camera} ${action} ${speech} Hold the resulting state through the remaining source duration of ${sourceSeconds.toFixed(3)} seconds.

overall_soundscape:
${soundscape}

non_diegetic_music:
N/A`;
}

/** Check every scene use, not just the first occurrence of a reused asset. */
export function fastH3SlotSeconds(pkg, assetId, requested) {
  const uses = (pkg.scenes ?? []).filter(scene => scene.background?.asset === assetId);
  const slots = uses.map(scene => {
    if (scene.background?.speed !== undefined && scene.background.speed !== 1) {
      throw new Error(`FastH3 ${assetId}: directed native speech/motion needs natural-speed playback`);
    }
    if (scene.background?.trim?.startSeconds || scene.background?.trim?.endSeconds !== undefined) {
      throw new Error(`FastH3 ${assetId}: apply source trims after reviewing the generated performance`);
    }
    return scene.preferredFrames / pkg.format?.fps;
  });
  if (slots.some(slot => !positive(slot))) throw new Error(`FastH3 ${assetId}: set explicit scene frames/fps before directing a shot`);
  if (requested !== undefined) {
    if (!positive(requested)) throw new Error(`FastH3 ${assetId}: direction.slotSeconds must be positive`);
    slots.push(requested);
  }
  return slots.length ? Math.min(...slots) : undefined;
}

// ---------------------------------------------------------------------------
// IP47: exact-line conditioning artifact.
//
// The caller has already resolved the speaking voice (IP44:
// apps/server/src/characters/voice.mjs resolveSpeakingVoice). packages/* must
// not import apps/server, so this module only validates the resolved shape and
// never re-implements model capability checks, native catalogues or Kokoro
// voice lists. Selecting a take is likewise a user decision: there is no
// "best take" fallback, and a rejected, purged or final-speech take never
// becomes conditioning.

const CONDITIONING_VOICE_PATHS = Object.freeze(['native', 'kokoro']);
const CONDITIONING_LANGUAGE_RE = /^[a-z]{2,3}(?:-[a-z0-9]{2,8})?$/;
const CONDITIONING_SHA256_RE = /^[0-9a-f]{64}$/i;
const CONDITIONING_TAKE_VERDICTS = Object.freeze(['unreviewed', 'approved', 'rejected']);

// A voice-cloning payload is never accepted. Only a built-in voice id or a
// Kokoro voice id may be named; the audio itself stays in the take system.
const CLONE_FIELDS = new Set([
  'clone',
  'clonePayload',
  'cloneSample',
  'cloneVoice',
  'embedding',
  'referenceAudio',
  'referenceSample',
  'referenceVoice',
  'referenceWav',
  'sample',
  'sampleAudio',
  'samples',
  'speakerAudio',
  'speakerEmbedding',
  'speakerWav',
  'voiceClone',
  'voiceEmbedding',
  'voiceSample',
]);

// Conditioning is a reference to a take, not the take's bytes. Final speech
// audio and raw media payloads are refused for the same reason.
const BYTE_FIELDS = new Set([
  'audio',
  'audioBase64',
  'audioBytes',
  'base64',
  'blob',
  'buffer',
  'bytes',
  'data',
  'waveform',
]);

const FINAL_SPEECH_FIELDS = new Set(['finalSpeech', 'finalSpeechTake', 'finalTake']);

const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const hasOwn = (object, key) => Object.prototype.hasOwnProperty.call(object, key);

function conditioningFail(code, message) {
  const error = new Error(message);
  error.name = 'ExactLineConditioningError';
  error.code = code;
  throw error;
}

function conditioningText(value, code, path) {
  if (typeof value !== 'string' || value.trim() === '') {
    conditioningFail(code, `${path} must be nonempty text`);
  }
  return value;
}

function refuseForbidden(object, path) {
  for (const key of Object.keys(object)) {
    if (CLONE_FIELDS.has(key)) {
      conditioningFail('VOICE_CLONE_FORBIDDEN', `${path}.${key} is a voice-cloning payload; only built-in or Kokoro voices may be used`);
    }
    if (BYTE_FIELDS.has(key)) {
      conditioningFail('EXACT_LINE_BYTES', `${path}.${key} carries audio bytes; conditioning is a metadata reference only`);
    }
    if (FINAL_SPEECH_FIELDS.has(key) && object[key] === true) {
      conditioningFail('EXACT_LINE_FINAL_SPEECH', `${path}.${key} marks final speech; final speech never conditions`);
    }
  }
}

/**
 * Build the metadata-only conditioning reference for one shot's exact line.
 *
 * @param {{
 *   shotId: string,
 *   line: { text: string, language: string, delivery?: string, offscreen?: boolean, slotSeconds?: number, reactionSeconds?: number },
 *   speakingVoice: { voicePath: 'native'|'kokoro', voice: string, language: string },
 *   takes?: Array<{ takeId: string, text: string, voicePath: string, voice: string, language: string, verdict: 'unreviewed'|'approved'|'rejected', purged?: boolean, sha256: string, file: string, durationSeconds: number }>,
 *   selectedTakeId?: string,
 *   finalSpeechTakeId?: string,
 * }} input
 */
export function buildExactLineConditioning(input, ...extra) {
  if (extra.length > 0) {
    conditioningFail('EXACT_LINE_INPUT', 'buildExactLineConditioning takes exactly one input object; merge options into the input');
  }
  if (!isRecord(input)) conditioningFail('EXACT_LINE_INPUT', 'exact-line conditioning input must be an object');

  refuseForbidden(input, 'input');

  const shotId = conditioningText(input.shotId, 'EXACT_LINE_SHOT_ID', 'input.shotId');

  const line = input.line;
  if (!isRecord(line)) conditioningFail('EXACT_LINE_LINE', 'input.line must be an object');
  refuseForbidden(line, 'input.line');
  const text = conditioningText(line.text, 'EXACT_LINE_TEXT', 'input.line.text');
  const language = conditioningText(line.language, 'EXACT_LINE_LANGUAGE', 'input.line.language');

  let delivery;
  if (line.delivery !== undefined) {
    delivery = conditioningText(line.delivery, 'EXACT_LINE_DELIVERY', 'input.line.delivery');
  }
  if (line.offscreen !== undefined && typeof line.offscreen !== 'boolean') {
    conditioningFail('EXACT_LINE_OFFSCREEN', 'input.line.offscreen must be boolean');
  }
  let slotSeconds;
  if (line.slotSeconds !== undefined) {
    if (!positive(line.slotSeconds)) conditioningFail('EXACT_LINE_SLOT', 'input.line.slotSeconds must be positive');
    slotSeconds = line.slotSeconds;
  }
  let reactionSeconds;
  if (line.reactionSeconds !== undefined) {
    if (typeof line.reactionSeconds !== 'number' || !Number.isFinite(line.reactionSeconds) || line.reactionSeconds < 0) {
      conditioningFail('EXACT_LINE_REACTION', 'input.line.reactionSeconds must be nonnegative');
    }
    reactionSeconds = line.reactionSeconds;
  }

  const speakingVoice = input.speakingVoice;
  if (!isRecord(speakingVoice)) conditioningFail('EXACT_LINE_SPEAKING_VOICE', 'input.speakingVoice must be an object');
  refuseForbidden(speakingVoice, 'input.speakingVoice');
  if (!CONDITIONING_VOICE_PATHS.includes(speakingVoice.voicePath)) {
    conditioningFail('EXACT_LINE_VOICE_PATH', `input.speakingVoice.voicePath must be one of: ${CONDITIONING_VOICE_PATHS.join(', ')}`);
  }
  const voice = conditioningText(speakingVoice.voice, 'EXACT_LINE_VOICE', 'input.speakingVoice.voice');
  if (typeof speakingVoice.language !== 'string' || !CONDITIONING_LANGUAGE_RE.test(speakingVoice.language)) {
    conditioningFail('EXACT_LINE_VOICE_LANGUAGE', 'input.speakingVoice.language must be a language tag such as en-us');
  }
  const voiceLanguage = speakingVoice.language;
  // The line is spoken by the resolved voice: its language must be that voice's
  // language, never silently relabelled (same rule as IP44 VOICE_VOICE_LANGUAGE).
  if (language.toLowerCase() !== voiceLanguage) {
    conditioningFail('EXACT_LINE_VOICE_LANGUAGE', `input.line.language ${JSON.stringify(language)} does not match the resolved speaking voice language ${JSON.stringify(voiceLanguage)}`);
  }

  if (input.finalSpeechTakeId !== undefined) {
    conditioningText(input.finalSpeechTakeId, 'EXACT_LINE_FINAL_SPEECH', 'input.finalSpeechTakeId');
  }

  let takes;
  if (input.takes === undefined) {
    takes = [];
  } else {
    if (!Array.isArray(input.takes)) conditioningFail('EXACT_LINE_TAKES', 'input.takes must be an array');
    takes = input.takes;
  }

  const takeIds = new Set();
  for (const [index, candidate] of takes.entries()) {
    if (!isRecord(candidate)) conditioningFail('EXACT_LINE_TAKE', `input.takes[${index}] must be an object`);
    refuseForbidden(candidate, `input.takes[${index}]`);
    if (hasOwn(candidate, 'kind') && candidate.kind === 'finalSpeech') {
      conditioningFail('EXACT_LINE_FINAL_SPEECH', `input.takes[${index}] is final speech and cannot condition`);
    }
    const takeId = conditioningText(candidate.takeId, 'EXACT_LINE_TAKE', `input.takes[${index}].takeId`);
    if (takeIds.has(takeId)) conditioningFail('EXACT_LINE_TAKE', `input.takes contains duplicate takeId ${JSON.stringify(takeId)}`);
    takeIds.add(takeId);
  }

  let selected;
  if (takes.length > 0 && input.selectedTakeId === undefined) {
    conditioningFail('EXACT_LINE_TAKE_NOT_SELECTED', 'input.selectedTakeId is required when takes are supplied; every take selection is a user decision');
  }
  if (input.selectedTakeId !== undefined) {
    const selectedTakeId = conditioningText(input.selectedTakeId, 'EXACT_LINE_TAKE_UNKNOWN', 'input.selectedTakeId');
    if (selectedTakeId === input.finalSpeechTakeId) {
      conditioningFail('EXACT_LINE_FINAL_SPEECH', 'the selected take is the final speech take; final speech never conditions');
    }
    selected = takes.find(candidate => candidate.takeId === selectedTakeId);
    if (!selected) conditioningFail('EXACT_LINE_TAKE_UNKNOWN', `input.selectedTakeId ${JSON.stringify(selectedTakeId)} does not name a supplied take`);
  }

  let durationSeconds;
  let takeSha256;
  let takeFile;
  if (selected) {
    const path = `input.takes[${selected.takeId}]`;
    if (selected.purged !== undefined && typeof selected.purged !== 'boolean') {
      conditioningFail('EXACT_LINE_TAKE', `${path}.purged must be boolean`);
    }
    if (selected.purged === true) {
      conditioningFail('EXACT_LINE_TAKE_PURGED', `${path} is purged and cannot condition`);
    }
    if (!CONDITIONING_TAKE_VERDICTS.includes(selected.verdict)) {
      conditioningFail('EXACT_LINE_TAKE_VERDICT', `${path}.verdict must be one of: ${CONDITIONING_TAKE_VERDICTS.join(', ')}`);
    }
    if (selected.verdict === 'rejected') {
      conditioningFail('EXACT_LINE_TAKE_REJECTED', `${path} is rejected and cannot condition`);
    }

    const takeText = conditioningText(selected.text, 'EXACT_LINE_TEXT', `${path}.text`);
    if (takeText !== text) {
      conditioningFail('EXACT_LINE_TEXT_MISMATCH', `${path}.text must be the shot's exact line; conditioning never mixes in another line`);
    }

    const takeVoicePath = conditioningText(selected.voicePath, 'EXACT_LINE_VOICE_MISMATCH', `${path}.voicePath`);
    const takeVoice = conditioningText(selected.voice, 'EXACT_LINE_VOICE_MISMATCH', `${path}.voice`);
    const takeLanguage = conditioningText(selected.language, 'EXACT_LINE_VOICE_MISMATCH', `${path}.language`);
    if (takeVoicePath !== speakingVoice.voicePath || takeVoice !== voice || takeLanguage !== voiceLanguage) {
      conditioningFail('EXACT_LINE_VOICE_MISMATCH', `${path} was not produced by the resolved speaking voice (${speakingVoice.voicePath}/${voice}/${voiceLanguage})`);
    }

    if (typeof selected.sha256 !== 'string' || !CONDITIONING_SHA256_RE.test(selected.sha256)) {
      conditioningFail('EXACT_LINE_SHA256', `${path}.sha256 must be a SHA-256 hex digest`);
    }
    const file = conditioningText(selected.file, 'EXACT_LINE_FILE', `${path}.file`);

    if (!positive(selected.durationSeconds)) {
      conditioningFail('EXACT_LINE_DURATION', `${path}.durationSeconds must be the measured duration of the take`);
    }
    durationSeconds = selected.durationSeconds;

    if (slotSeconds === undefined) {
      conditioningFail('EXACT_LINE_SLOT_REQUIRED', 'input.line.slotSeconds is required to check measured conditioning plus reaction against the editorial slot');
    }
    const reaction = reactionSeconds ?? 0;
    if (durationSeconds + reaction > slotSeconds + 1 / 24) {
      conditioningFail('EXACT_LINE_SLOT_OVERFLOW', 'measured conditioning audio plus reaction time must fit the editorial slot at natural speed; revise the line or timing');
    }

    takeSha256 = selected.sha256;
    takeFile = file;
  }

  const artifact = {
    kind: 'conditioning',
    role: 'conditioning',
    finalSpeech: false,
    retention: 'reference',
    shotId,
    text,
    language,
    speakingVoice: Object.freeze({ voicePath: speakingVoice.voicePath, voice, language: voiceLanguage }),
    voiceTakeId: selected ? selected.takeId : null,
  };
  if (delivery !== undefined) artifact.delivery = delivery;
  if (line.offscreen !== undefined) artifact.offscreen = line.offscreen;
  if (slotSeconds !== undefined) artifact.slotSeconds = slotSeconds;
  if (reactionSeconds !== undefined) artifact.reactionSeconds = reactionSeconds;
  if (selected) {
    artifact.sha256 = takeSha256;
    artifact.file = takeFile;
    artifact.durationSeconds = durationSeconds;
  }
  return Object.freeze(artifact);
}
