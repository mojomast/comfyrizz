// RW06: turn an RW05 decision into a Klein-safe end-state caption, and pick a
// replacement reference when identity keeps failing.
// Pure module: no network, clock or disk. Contracts live in
// docs/tasks/RW00_CONTRACTS.md and @comfyrizz/schema/ref-review.

const STEER_PLACEHOLDER = '<steer>';
const REPLACE_REF_PLACEHOLDER = '<replace-ref>';
const MIN_WORDS = 100;
const MAX_WORDS = 350;

const NEGATIVE_TERMS = [
  ["don't", /\bdon['\u2019]t\b/gi],
  ['without', /\bwithout\b/gi],
  ['avoid', /\bavoid(?:s|ed|ing)?\b/gi],
  ['never', /\bnever\b/gi],
  ['remove', /\bremove(?:s|d|ing)?\b/gi],
  ['not', /\bnot\b/gi],
  ['no', /\bno\b/gi],
];



const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const textOf = (value) => (typeof value === 'string' ? value.trim() : '');
const wordsOf = (value) => (typeof value === 'string' ? value.trim().split(/\s+/).filter(Boolean).length : 0);

function asSentence(value) {
  const text = textOf(value);
  if (!text) return '';
  return /[.!?]$/.test(text) ? text : `${text}.`;
}

// Flipping negative words ("not" -> "fully") can invert meaning, so a sentence with
// negative wording is dropped rather than rewritten. Fix hints are positive by contract.
function oppositeWords(value) {
  return value
    .split(/(?<=[.!?])\s+/)
    .filter((sentence) => sentence && lintSteer(sentence).length === 0)
    .join(' ')
    .replace(/\s+/g, ' ')
    .replace(/\s+([,.;:!?])/g, '$1')
    .trim();
}

/**
 * Report forbidden negative wording for a Klein caption.
 * Returns the matched terms in the order they appear, so an empty array means clean.
 */
export function lintSteer(text) {
  if (typeof text !== 'string') return ['text'];
  const hits = [];
  for (const [term, pattern] of NEGATIVE_TERMS) {
    pattern.lastIndex = 0;
    let match = pattern.exec(text);
    while (match) {
      hits.push({ term, index: match.index });
      match = pattern.exec(text);
    }
  }
  hits.sort((a, b) => a.index - b.index || a.term.localeCompare(b.term));
  return hits.map((hit) => hit.term);
}

function captionParts(previousPrompt, verdict, characters) {
  const checks = Array.isArray(verdict?.checks) ? verdict.checks : [];
  const fixHints = Array.isArray(verdict?.fixHints) ? verdict.fixHints : [];
  const cast = Array.isArray(characters) ? characters : [];
  const parts = [];
  const add = (value, mandatory) => {
    const sentence = asSentence(value);
    if (sentence) parts.push({ text: sentence, mandatory });
  };

  add(oppositeWords(textOf(previousPrompt)), false);

  for (const item of checks) {
    if (item?.pass !== true) continue;
    add(`The finished still shows ${oppositeWords(textOf(item.evidence))}`, false);
  }

  for (const hint of fixHints) {
    add(`In the finished still, ${oppositeWords(textOf(hint))}`, true);
  }

  for (const character of cast) {
    if (!isObject(character)) continue;
    const identityLock = textOf(character.identityLock);
    if (identityLock) add(`Identity stays true to ${identityLock}`, true);
    const wardrobeState = textOf(character.wardrobeState);
    if (wardrobeState) add(`Wardrobe remains ${wardrobeState}`, true);
  }

  return { parts, cast, previousPrompt: oppositeWords(textOf(previousPrompt)) };
}

function trimToMax(parts) {
  let total = parts.reduce((sum, part) => sum + wordsOf(part.text), 0);
  for (let index = parts.length - 1; index >= 0 && total > MAX_WORDS; index -= 1) {
    const part = parts[index];
    if (part.mandatory) continue;
    total -= wordsOf(part.text);
    parts.splice(index, 1);
  }
  return total;
}

function paddingSources(cast, previousPrompt) {
  const sources = [];
  const push = (value) => {
    const sentence = asSentence(value);
    if (sentence) sources.push(sentence);
  };
  for (const character of cast) {
    if (!isObject(character)) continue;
    const identityLock = textOf(character.identityLock);
    if (identityLock) push(`Every detail of ${identityLock} stays clearly visible in the finished still`);
    const wardrobeState = textOf(character.wardrobeState);
    if (wardrobeState) push(`The ${wardrobeState} stays consistent through the scene`);
  }
  if (previousPrompt) push(`The scene keeps ${previousPrompt}`);
  return sources;
}

/**
 * Build the caption for a regenerated still.
 * Keeps passing-check detail, folds every fix hint in as finished image state,
 * restates each identity lock and wardrobe state verbatim, and is 100-350 words.
 */
export function steerPrompt({ previousPrompt, verdict, characters } = {}) {
  const { parts, cast, previousPrompt: cleanPrompt } = captionParts(previousPrompt, verdict, characters);
  let total = trimToMax(parts);

  if (total < MIN_WORDS) {
    const sources = paddingSources(cast, cleanPrompt);
    for (let index = 0; index < sources.length && total < MIN_WORDS; index += 1) {
      const sentence = sources[index];
      const added = wordsOf(sentence);
      if (total + added > MAX_WORDS) break;
      parts.push({ text: sentence, mandatory: false });
      total += added;
    }
  }

  return parts.map((part) => part.text).join(' ').replace(/\s+/g, ' ').trim();
}

/**
 * Replace RW05 placeholders with real values. A decision with no placeholder is
 * returned unchanged; a filled decision is a new object.
 */
export function fillDecision(decision, { nextPrompt, replaceRef } = {}) {
  if (!isObject(decision)) return decision;
  const steer = decision.nextPrompt === STEER_PLACEHOLDER;
  const replace = decision.replaceRef === REPLACE_REF_PLACEHOLDER;
  if (!steer && !replace) return decision;

  const filled = { ...decision };
  if (steer && textOf(nextPrompt)) filled.nextPrompt = nextPrompt;
  if (replace && textOf(replaceRef)) filled.replaceRef = replaceRef;
  return filled;
}

function identityImagePath(value) {
  if (typeof value === 'string') return textOf(value);
  if (isObject(value)) {
    return textOf(value.imagePath) || textOf(value.path) || textOf(value.image) || textOf(value.relative);
  }
  return '';
}

function primaryRef(primaryImage) {
  if (typeof primaryImage === 'string') return textOf(primaryImage);
  if (isObject(primaryImage)) return identityImagePath(primaryImage);
  return '';
}

function stillImagePath(still) {
  return textOf(still.imagePath) || textOf(still.image) || textOf(still.path)
    || textOf(still.relative) || textOf(still.ref);
}

function matchesCharacter(still, characterId) {
  if (!characterId) return false;
  if (textOf(still.characterId) === characterId) return true;
  if (textOf(still.character) === characterId) return true;
  if (Array.isArray(still.characterIds) && still.characterIds.map(textOf).includes(characterId)) return true;
  if (Array.isArray(still.characters)) {
    return still.characters.some((entry) => {
      if (typeof entry === 'string') return entry === characterId;
      return isObject(entry) && (textOf(entry.characterId) === characterId || textOf(entry.id) === characterId);
    });
  }
  return false;
}

function isAccepted(still) {
  if (still.accepted === false) return false;
  const state = textOf(still.state) || textOf(still.gateState) || textOf(still.status);
  if (state && ['pending', 'reviewing', 'regenerating', 'held', 'rejected'].includes(state.toLowerCase())) return false;
  return true;
}

function identityChecks(still) {
  const sources = [still.checks, still.verdict?.checks, still.review?.checks, still.identityChecks];
  const checks = [];
  for (const source of sources) {
    if (!Array.isArray(source)) continue;
    for (const item of source) {
      if (isObject(item) && item.dimension === 'identity') checks.push(item);
    }
  }
  return checks;
}

function identityPassed(still) {
  if (typeof still.identityPassed === 'boolean') return still.identityPassed;
  const checks = identityChecks(still);
  if (checks.length > 0) return checks.every((item) => item.pass === true);

  const holders = [still.identityCheck, still.identity, still.verdict, still.review];
  for (const holder of holders) {
    if (typeof holder === 'boolean') return holder;
    if (!isObject(holder)) continue;
    if (typeof holder.pass === 'boolean') return holder.pass;
    if (typeof holder.passed === 'boolean') return holder.passed;
    if (holder.overall === 'pass') return true;
    if (holder.overall === 'fail' || holder.overall === 'error') return false;
  }

  const status = textOf(still.identityStatus) || textOf(still.identity);
  if (status === 'pass' || status === 'passed') return true;
  if (status === 'fail' || status === 'failed') return false;
  return still.verdict?.overall === 'pass';
}

function timestampOf(still) {
  for (const key of ['acceptedAt', 'createdAt', 'completedAt', 'at', 'timestamp']) {
    const value = still[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && value) {
      const parsed = Date.parse(value);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return null;
}

/**
 * Pick a replacement reference image path for a character: newest accepted
 * still whose identity check passed, else the primary image, else null.
 */
export function chooseReplacementRef({ characterId, primaryImage, acceptedStills } = {}) {
  const id = textOf(characterId);
  const stills = Array.isArray(acceptedStills) ? acceptedStills : [];
  let best = null;

  stills.forEach((still, index) => {
    if (!isObject(still) || !isAccepted(still)) return;
    if (!matchesCharacter(still, id) || !identityPassed(still)) return;
    const imagePath = stillImagePath(still);
    if (!imagePath) return;
    const time = timestampOf(still);
    if (best === null) {
      best = { imagePath, time, index };
      return;
    }
    if (time !== null && best.time !== null) {
      if (time > best.time || (time === best.time && index > best.index)) best = { imagePath, time, index };
      return;
    }
    if (time !== null) {
      best = { imagePath, time, index };
      return;
    }
    if (best.time === null && index > best.index) best = { imagePath, time, index };
  });

  return best ? best.imagePath : primaryRef(primaryImage) || null;
}
