/**
 * Q02 - script-to-shot beat lint (pre-generation).
 *
 * Source: docs/research/MOCKUMENTARY_QUALITY_REVIEW_20261020.md section 3 (P0)
 * and docs/specs/QUALITY_FIXES.md Q02. The lint compares the story-beat
 * contract from Q01 with the shots and dialogue that are about to be sent to a
 * generator. It is intentionally additive: it reports findings and never edits
 * a plan.
 *
 * Findings:
 *   ANCHOR_MISSING          beat.dialogueAnchor is not in the speaker's line
 *   STATE_CHANGE_UNLICENSED beat.duringLine changes state with no licensing
 *                           phrase in the speaker's line
 *   PROMPT_CONTRADICTS      an image/action prompt matches rejectIf, or moves a
 *                           prop the contract keeps "outside reach"
 *   SPEAKER_UNASSIGNED      a shot for the beat does not list the speaker in
 *                           its participants (the 02:10 chair gag)
 *
 * Inputs are deliberately tolerant about field spelling because the shot-plan
 * authoring formats are still in flux. Beat ids may be `beat` or `id`; shots
 * may carry `id`/`shot`; prompts may be `imagePrompt`, `actionPrompt`, their
 * snake_case forms, or nested `image.prompt`/`action.prompt`. The script may
 * be an array of `{speaker, text}` lines, a `{lines: [...]}` object, or a
 * speaker-to-line(s) object.
 *
 * Pure module: no I/O, no clock, no network, no side effects at import time.
 * Inputs are never mutated.
 */

export const FINDING_CODES = Object.freeze({
  ANCHOR_MISSING: 'ANCHOR_MISSING',
  STATE_CHANGE_UNLICENSED: 'STATE_CHANGE_UNLICENSED',
  PROMPT_CONTRADICTS: 'PROMPT_CONTRADICTS',
  SPEAKER_UNASSIGNED: 'SPEAKER_UNASSIGNED',
});

const FINDING_ORDER = Object.freeze([
  FINDING_CODES.ANCHOR_MISSING,
  FINDING_CODES.STATE_CHANGE_UNLICENSED,
  FINDING_CODES.SPEAKER_UNASSIGNED,
  FINDING_CODES.PROMPT_CONTRADICTS,
]);

const STOP_WORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'been', 'being', 'but', 'by',
  'for', 'from', 'had', 'has', 'have', 'he', 'her', 'hers', 'him', 'his',
  'in', 'into', 'is', 'it', 'its', 'may', 'must', 'of', 'on', 'or', 'our',
  'she', 'should', 'so', 'some', 'that', 'the', 'their', 'them', 'then',
  'there', 'these', 'they', 'this', 'those', 'to', 'was', 'we', 'were',
  'will', 'with', 'would', 'you', 'your',
]);

// Verbs that normally authorize a state change. "reach" and "sit" are included
// because the review's own lines use them ("can't reach", "haven't sat").
const LICENSING_VERBS = new Set([
  'bring', 'carry', 'close', 'drop', 'give', 'grab', 'hand', 'hold', 'lift',
  'move', 'offer', 'open', 'pass', 'pick', 'place', 'pull', 'push', 'put',
  'reach', 'release', 'remove', 'sit', 'stand', 'switch', 'swap', 'take',
  'toss', 'turn',
]);

const MOVEMENT_VERBS = new Set([
  'bring', 'carry', 'drop', 'give', 'grab', 'hand', 'hold', 'lift', 'move',
  'offer', 'pass', 'pick', 'place', 'pull', 'push', 'put', 'reach', 'release',
  'slide', 'take', 'toss', 'throw',
]);

const NEGATIONS = new Set([
  'cannot', 'cant', 'didnt', 'doesnt', 'dont', 'hadnt', 'hasnt', 'havent',
  'isnt', 'never', 'no', 'not', 'unable', 'wasnt', 'werent', 'without', 'wont',
]);

const IRREGULAR_STEMS = new Map([
  ['carried', 'carry'],
  ['carries', 'carry'],
  ['dropped', 'drop'],
  ['dropping', 'drop'],
  ['gave', 'give'],
  ['given', 'give'],
  ['giving', 'give'],
  ['grabbed', 'grab'],
  ['grabbing', 'grab'],
  ['handed', 'hand'],
  ['handing', 'hand'],
  ['held', 'hold'],
  ['holding', 'hold'],
  ['lifted', 'lift'],
  ['lifting', 'lift'],
  ['moved', 'move'],
  ['moves', 'move'],
  ['moving', 'move'],
  ['offered', 'offer'],
  ['offering', 'offer'],
  ['picked', 'pick'],
  ['picking', 'pick'],
  ['placed', 'place'],
  ['places', 'place'],
  ['placing', 'place'],
  ['pulled', 'pull'],
  ['pulling', 'pull'],
  ['pushed', 'push'],
  ['pushing', 'push'],
  ['reached', 'reach'],
  ['reaches', 'reach'],
  ['reaching', 'reach'],
  ['sat', 'sit'],
  ['seated', 'seat'],
  ['seats', 'seat'],
  ['seating', 'seat'],
  ['slid', 'slide'],
  ['slides', 'slide'],
  ['sliding', 'slide'],
  ['stood', 'stand'],
  ['swapped', 'swap'],
  ['swapping', 'swap'],
  ['switched', 'switch'],
  ['switching', 'switch'],
  ['taken', 'take'],
  ['takes', 'take'],
  ['taking', 'take'],
  ['took', 'take'],
  ['tossed', 'toss'],
  ['tossing', 'toss'],
  ['threw', 'throw'],
  ['thrown', 'throw'],
]);

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function firstString(...values) {
  for (const value of values) {
    if (isNonEmptyString(value)) return value.trim();
  }
  return null;
}

function normalizeName(value) {
  if (!isNonEmptyString(value)) return '';
  return value.trim().toLowerCase().replace(/[\s_-]+/g, ' ');
}

/** Lowercase, straighten quotes, remove punctuation except apostrophes. */
export function canonicalText(value) {
  if (typeof value !== 'string') return '';
  return value
    .normalize('NFKC')
    .replace(/[\u2018\u2019\u02BC]/g, "'")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}'\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function words(value) {
  const canonical = canonicalText(value);
  return canonical.length === 0 ? [] : canonical.split(' ');
}

function stemWord(word) {
  if (IRREGULAR_STEMS.has(word)) return IRREGULAR_STEMS.get(word);
  if (word.length > 4 && word.endsWith('ies')) return `${word.slice(0, -3)}y`;
  if (word.length > 5 && word.endsWith('ing')) {
    const base = word.slice(0, -3);
    return IRREGULAR_STEMS.get(base) ?? base;
  }
  if (word.length > 4 && word.endsWith('ed')) {
    const base = word.slice(0, -2);
    return IRREGULAR_STEMS.get(base) ?? base;
  }
  if (word.length > 3 && word.endsWith('es')) {
    const base = word.slice(0, -2);
    return IRREGULAR_STEMS.get(base) ?? base;
  }
  if (word.length > 3 && word.endsWith('s') && !word.endsWith('ss')) {
    return word.slice(0, -1);
  }
  return word;
}

function significantTokens(value) {
  return words(value)
    .filter((word) => !STOP_WORDS.has(word))
    .map(stemWord)
    .filter(Boolean);
}

function tokensEquivalent(left, right) {
  if (left === right) return true;
  if (left.length < 4 || right.length < 4) return false;
  const [shorter, longer] = left.length <= right.length ? [left, right] : [right, left];
  return longer.startsWith(shorter) && longer.length - shorter.length <= 3;
}

function containsPhraseTokens(promptTokens, phraseTokens) {
  if (phraseTokens.length === 0) return false;
  return phraseTokens.every((phraseToken) => (
    promptTokens.some((promptToken) => tokensEquivalent(phraseToken, promptToken))
  ));
}

function hasNegation(text) {
  return words(text).some((word) => (
    NEGATIONS.has(word)
    || NEGATIONS.has(word.replace(/'/g, ''))
    || word.endsWith("n't")
  ));
}

function deepEqual(left, right) {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((item, index) => deepEqual(item, right[index]));
  }
  if (isPlainObject(left) && isPlainObject(right)) {
    const leftKeys = Object.keys(left);
    const rightKeys = Object.keys(right);
    return leftKeys.length === rightKeys.length
      && leftKeys.every((key) => Object.prototype.hasOwnProperty.call(right, key)
        && deepEqual(left[key], right[key]));
  }
  return false;
}

function flattenStateText(value) {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return value.map(flattenStateText).join(' ');
  if (isPlainObject(value)) return Object.values(value).map(flattenStateText).join(' ');
  return '';
}

function isOutsideReach(value) {
  const text = canonicalText(flattenStateText(value));
  return text.includes('outside reach')
    || text.includes('out of reach')
    || text.includes('unreachable')
    || text.includes('beyond reach');
}

function normalizeBeats(beats) {
  if (Array.isArray(beats)) return beats;
  if (isPlainObject(beats) && Array.isArray(beats.beats)) return beats.beats;
  throw new TypeError('beats must be an array or an object with a beats array');
}

function normalizeShots(shots) {
  if (Array.isArray(shots)) return shots;
  if (isPlainObject(shots) && Array.isArray(shots.shots)) return shots.shots;
  throw new TypeError('shots must be an array or an object with a shots array');
}

function beatIdOf(beat) {
  return firstString(beat?.beat, beat?.id, beat?.beatId, beat?.beat_id);
}

function shotIdOf(shot, index) {
  return firstString(shot?.id, shot?.shot, shot?.shotId, shot?.shot_id) ?? `shot-${index + 1}`;
}

function shotBeatRef(shot) {
  const raw = shot?.beat ?? shot?.beatId ?? shot?.beat_id ?? shot?.contract ?? shot?.contractId;
  if (isPlainObject(raw)) return firstString(raw.beat, raw.id, raw.beatId);
  return firstString(raw);
}

function lineFromObject(obj, inheritedSpeaker = null) {
  if (!isPlainObject(obj)) return null;
  const speaker = firstString(
    obj.speaker,
    obj.character,
    obj.who,
    obj.name,
    obj.role,
    inheritedSpeaker,
  );
  const text = firstString(
    obj.text,
    obj.line,
    obj.dialogue,
    obj.content,
    obj.caption,
    obj.says,
    typeof obj.script === 'string' ? obj.script : null,
  );
  if (!isNonEmptyString(text)) return null;
  return {
    speaker,
    text,
    beat: firstString(obj.beat, obj.beatId, obj.beat_id),
  };
}

function extractLines(source, inheritedSpeaker, out, depth) {
  if (source == null || depth > 4) return out;
  if (typeof source === 'string') {
    if (isNonEmptyString(source)) {
      out.push({ speaker: inheritedSpeaker, text: source, beat: null });
    }
    return out;
  }
  if (Array.isArray(source)) {
    for (const item of source) {
      if (typeof item === 'string') {
        extractLines(item, inheritedSpeaker, out, depth + 1);
      } else if (isPlainObject(item)) {
        if (Array.isArray(item.lines)) {
          extractLines(item.lines, firstString(item.speaker, inheritedSpeaker), out, depth + 1);
        } else {
          const line = lineFromObject(item, inheritedSpeaker);
          if (line) out.push(line);
        }
      }
    }
    return out;
  }
  if (isPlainObject(source)) {
    const line = lineFromObject(source, inheritedSpeaker);
    if (line) {
      out.push(line);
      return out;
    }
    for (const key of ['lines', 'dialogue', 'script', 'utterances', 'turns']) {
      if (Array.isArray(source[key])) {
        extractLines(source[key], inheritedSpeaker, out, depth + 1);
        return out;
      }
    }
    for (const [key, value] of Object.entries(source)) {
      if (['schema', 'note', 'title'].includes(key)) continue;
      if (typeof value === 'string' || Array.isArray(value)) {
        extractLines(value, key, out, depth + 1);
      } else if (isPlainObject(value)) {
        const nested = lineFromObject(value, key);
        if (nested) out.push(nested);
      }
    }
  }
  return out;
}

function normalizeScript(script) {
  return extractLines(script, null, [], 0);
}

function collectStrings(value, out, depth = 0) {
  if (depth > 3) return out;
  if (typeof value === 'string') {
    if (value.trim().length > 0) out.push(value);
  } else if (Array.isArray(value)) {
    value.forEach((item) => collectStrings(item, out, depth + 1));
  } else if (isPlainObject(value)) {
    for (const key of ['prompt', 'text', 'description', 'subject', 'action', 'motion']) {
      if (key in value) collectStrings(value[key], out, depth + 1);
    }
  }
  return out;
}

function promptTexts(shot) {
  const texts = [];
  const directKeys = [
    'imagePrompt', 'image_prompt', 'stillPrompt', 'still_prompt',
    'visualPrompt', 'visual_prompt', 'subjectPrompt', 'subject_prompt',
    'actionPrompt', 'action_prompt', 'motionPrompt', 'motion_prompt',
    'videoPrompt', 'video_prompt',
  ];
  for (const key of directKeys) {
    if (key in shot) collectStrings(shot[key], texts);
  }
  for (const key of ['prompt', 'image', 'still', 'visual', 'subject', 'action', 'motion', 'video']) {
    if (key in shot) collectStrings(shot[key], texts);
  }
  return [...new Set(texts)];
}

const PARTICIPANT_FIELDS = [
  'participants',
  'cast',
  'characters',
  'talent',
  'subjects',
  'who',
];

function hasParticipantField(shot) {
  return isPlainObject(shot)
    && PARTICIPANT_FIELDS.some((key) => shot[key] != null);
}

function participantNames(shot) {
  const raw = shot?.participants
    ?? shot?.cast
    ?? shot?.characters
    ?? shot?.talent
    ?? shot?.subjects
    ?? shot?.who;
  const names = [];
  const add = (value) => {
    if (isNonEmptyString(value)) names.push(normalizeName(value));
  };
  if (Array.isArray(raw)) {
    for (const item of raw) {
      if (isNonEmptyString(item)) add(item);
      else if (isPlainObject(item)) add(firstString(item.name, item.id, item.character, item.speaker));
    }
  } else if (isPlainObject(raw)) {
    Object.keys(raw).forEach(add);
  } else {
    add(raw);
  }
  return names.filter(Boolean);
}

function licensingPhrases(beat) {
  const raw = beat?.licensingPhrase
    ?? beat?.licensingPhrases
    ?? beat?.license
    ?? beat?.licenses
    ?? beat?.licensedBy;
  const list = Array.isArray(raw) ? raw : [raw];
  return list.filter(isNonEmptyString).map((item) => item.trim());
}

function hasUnnegatedVerb(text, verbs) {
  const tokens = words(text);
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    const stem = stemWord(token.replace(/'/g, ''));
    if (!verbs.has(stem) && !verbs.has(token)) continue;
    const window = tokens.slice(Math.max(0, index - 3), index);
    const negated = window.some((word) => (
      NEGATIONS.has(word)
      || NEGATIONS.has(word.replace(/'/g, ''))
      || word.endsWith("n't")
    ));
    if (!negated) return true;
  }
  return false;
}

function isLicensed(beat, lineText) {
  const explicit = licensingPhrases(beat);
  if (explicit.length > 0) {
    const line = canonicalText(lineText);
    return explicit.some((phrase) => {
      const canonicalPhrase = canonicalText(phrase);
      return canonicalPhrase.length > 0 && line.includes(canonicalPhrase);
    });
  }
  return hasUnnegatedVerb(lineText, LICENSING_VERBS);
}

function stateChanges(before, duringLine) {
  if (!isPlainObject(duringLine)) return [];
  const source = isPlainObject(before) ? before : {};
  return Object.keys(duringLine)
    .filter((key) => !deepEqual(source[key], duringLine[key]))
    .map((key) => ({ key, before: source[key], during: duringLine[key] }));
}

function propBaseName(propId) {
  return canonicalText(
    String(propId)
      .replace(/@\d+$/, '')
      .replace(/[_-]v?\d+$/i, '')
      .replace(/[_-]+/g, ' '),
  );
}

function outsideReachProps(beat) {
  const props = new Set(Array.isArray(beat?.requiredProps) ? beat.requiredProps : []);
  const states = [];
  if (isPlainObject(beat?.duringLine)) states.push(beat.duringLine);
  if (isPlainObject(beat?.before)) states.push(beat.before);
  const found = [];
  for (const state of states) {
    for (const [key, value] of Object.entries(state)) {
      if (!isOutsideReach(value)) continue;
      found.push(canonicalText(key));
      props.forEach((prop) => {
        const base = propBaseName(prop);
        if (base && (canonicalText(key).includes(base) || base.includes(canonicalText(key)))) {
          found.push(base);
        }
      });
    }
  }
  return [...new Set(found.filter(Boolean))];
}

function clauses(text) {
  return String(text)
    .split(/[.!?;\n]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

const SAFE_MOVEMENT_PHRASES = [
  'outside reach',
  'out of reach',
  'unreachable',
  'beyond reach',
  "can't reach",
  'cannot reach',
  'does not move',
  "doesn't move",
  'never moves',
  'remains',
  'stays',
  'keeps',
  'no one touches',
];

function clauseMovesProp(clause, propTokens) {
  const clauseTokens = significantTokens(clause);
  if (!propTokens.every((propToken) => (
    clauseTokens.some((token) => tokensEquivalent(propToken, token))
  ))) {
    return false;
  }
  const canonical = canonicalText(clause);
  if (SAFE_MOVEMENT_PHRASES.some((phrase) => canonical.includes(canonicalText(phrase)))) {
    return false;
  }
  // "out of the painter's reach" and similar possessives are still safe.
  if (/(?:out of|outside|beyond)(?: [\p{L}']+){0,3} reach\b/u.test(canonical)) return false;
  return hasUnnegatedVerb(clause, MOVEMENT_VERBS);
}

function promptContradiction(shot, beat, propNames) {
  const texts = promptTexts(shot);
  const reasons = [];
  const rejectPhrases = Array.isArray(beat?.rejectIf) ? beat.rejectIf.filter(isNonEmptyString) : [];

  for (const text of texts) {
    for (const phrase of rejectPhrases) {
      const phraseTokens = significantTokens(phrase);
      const matched = clauses(text).some((clause) => (
        !hasNegation(clause) && containsPhraseTokens(significantTokens(clause), phraseTokens)
      ));
      if (matched) reasons.push(`matches rejectIf "${phrase}"`);
    }
    for (const prop of propNames) {
      const propTokens = significantTokens(prop);
      if (propTokens.length === 0) continue;
      const moved = clauses(text).some((clause) => clauseMovesProp(clause, propTokens));
      if (moved) reasons.push(`moves ${prop}, which the contract keeps outside reach`);
    }
  }

  return [...new Set(reasons)];
}

function makeFinding(beat, shot, code, message) {
  return { beat, shot, code, message };
}

/**
 * Lint a planned beat/shot/script set before generation is paid for.
 *
 * @param {unknown} beats a beat array or `{beats: [...]}`
 * @param {unknown} shots a shot array or `{shots: [...]}`
 * @param {unknown} script dialogue lines (array, `{lines: [...]}`, or speaker map)
 * @returns {Array<{beat: string|null, shot: string|null, code: string, message: string}>}
 */
export function lintShotPlan(beats, shots, script) {
  const beatList = normalizeBeats(beats);
  const shotList = normalizeShots(shots);
  const lines = normalizeScript(script);

  const shotsByBeat = new Map();
  shotList.forEach((shot, index) => {
    if (!isPlainObject(shot)) return;
    const ref = shotBeatRef(shot);
    if (!ref) return;
    const key = normalizeName(ref);
    if (!shotsByBeat.has(key)) shotsByBeat.set(key, []);
    shotsByBeat.get(key).push({ shot, index });
  });

  const findings = [];
  const seen = new Set();
  const push = (finding) => {
    const key = `${finding.beat ?? ''}\u0000${finding.shot ?? ''}\u0000${finding.code}`;
    if (seen.has(key)) return;
    seen.add(key);
    findings.push(finding);
  };

  const order = [];
  beatList.forEach((beat, index) => {
    if (!isPlainObject(beat)) return;
    const beatId = beatIdOf(beat) ?? `beat-${index + 1}`;
    const speaker = normalizeName(beat.speaker);
    const anchor = canonicalText(beat.dialogueAnchor);
    const speakerLines = speaker
      ? lines.filter((line) => normalizeName(line.speaker) === speaker)
      : [];
    const anchorLine = anchor
      ? speakerLines.find((line) => canonicalText(line.text).includes(anchor))
      : null;

    if (!anchor) {
      push(makeFinding(
        beatId,
        null,
        FINDING_CODES.ANCHOR_MISSING,
        `Beat "${beatId}" has no dialogueAnchor to find in the script.`,
      ));
    } else if (!anchorLine) {
      const who = beat.speaker ? `speaker "${beat.speaker}"` : 'a speaker';
      push(makeFinding(
        beatId,
        null,
        FINDING_CODES.ANCHOR_MISSING,
        `dialogueAnchor "${beat.dialogueAnchor}" was not found in the lines for ${who}.`,
      ));
    }

    const changes = stateChanges(beat.before, beat.duringLine);
    if (changes.length > 0) {
      const lineText = anchorLine?.text
        ?? speakerLines.map((line) => line.text).join(' ');
      if (!isLicensed(beat, lineText)) {
        const detail = changes
          .map((change) => `${change.key} ${JSON.stringify(change.before)} -> ${JSON.stringify(change.during)}`)
          .join(', ');
        push(makeFinding(
          beatId,
          null,
          FINDING_CODES.STATE_CHANGE_UNLICENSED,
          `Beat "${beatId}" changes duringLine state (${detail}) without a licensing phrase in the speaker's line.`,
        ));
      }
    }

    const linked = shotsByBeat.get(normalizeName(beatId)) ?? [];
    const propNames = outsideReachProps(beat);
    for (const { shot, index } of linked) {
      const shotId = shotIdOf(shot, index);
      // A shot that does not declare its own cast inherits the beat contract;
      // only an explicit cast can prove the speaker was left out.
      const participants = hasParticipantField(shot)
        ? participantNames(shot)
        : participantNames({ participants: beat.participants });
      if (speaker && !participants.includes(speaker)) {
        push(makeFinding(
          beatId,
          shotId,
          FINDING_CODES.SPEAKER_UNASSIGNED,
          `Shot "${shotId}" does not list speaker "${beat.speaker}" in its participants.`,
        ));
      }

      const reasons = promptContradiction(shot, beat, propNames);
      if (reasons.length > 0) {
        push(makeFinding(
          beatId,
          shotId,
          FINDING_CODES.PROMPT_CONTRADICTS,
          `Shot "${shotId}" prompt ${reasons.join(' and ')}.`,
        ));
      }
    }

    order.push(beatId);
  });

  const beatPosition = new Map(order.map((id, index) => [id, index]));
  const codePosition = new Map(FINDING_ORDER.map((code, index) => [code, index]));
  findings.sort((left, right) => (
    (beatPosition.get(left.beat) ?? 0) - (beatPosition.get(right.beat) ?? 0)
    || (codePosition.get(left.code) ?? 0) - (codePosition.get(right.code) ?? 0)
    || String(left.shot ?? '').localeCompare(String(right.shot ?? ''))
  ));

  return findings;
}

export default lintShotPlan;
