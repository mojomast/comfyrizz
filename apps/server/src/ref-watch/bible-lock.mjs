// RW07: Build the per-shot story-bible lock for the reference watcher.
// The lock is pure: the same character snapshots and shot always produce the
// same identity strings and wardrobe states, and the shot only ever changes
// the wardrobe state, never the identity.

export const IDENTITY_TRAIT_ORDER = Object.freeze(['age', 'hair', 'eyes', 'build', 'marks']);

const MIN_IDENTITY_WORDS = 25;
const MAX_IDENTITY_WORDS = 45;
const CLAUSE_SPLIT = /[,;]+|\.\s+/;
const AGE_CLAUSE = /\b(?:age|aged|years?\s+old|year-old|\d+\s*s)\b/i;
const HAIR_CLAUSE = /\b(?:hair|haired)\b/i;
const EYES_CLAUSE = /\b(?:eyes?|eyed)\b/i;
const MARKS_CLAUSE = /\b(?:freckles?|scars?|tattoos?|birthmarks?|moles?|marks?|piercings?|brand|burn)\b/i;
const BUILD_CLAUSE = /\b(?:build|body|frame|height|tall|short|slim|slender|stocky|broad|lean|muscular|heavyset|round)\b/i;

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const textOf = (value) => (typeof value === 'string' ? value.trim() : '');

function textList(value) {
  if (Array.isArray(value)) return value.map(textOf).filter(Boolean).join(', ');
  return textOf(value);
}

function clausesOf(value) {
  const text = textList(value);
  if (!text) return [];
  return text.split(CLAUSE_SPLIT).map((clause) => clause.trim()).filter(Boolean);
}

function wordCount(value) {
  return value.trim().split(/\s+/).filter(Boolean).length;
}

function traitOfClause(clause) {
  if (AGE_CLAUSE.test(clause)) return 'age';
  if (HAIR_CLAUSE.test(clause)) return 'hair';
  if (EYES_CLAUSE.test(clause)) return 'eyes';
  if (MARKS_CLAUSE.test(clause)) return 'marks';
  if (BUILD_CLAUSE.test(clause)) return 'build';
  return null;
}

function traitContainers(record) {
  const containers = [];
  for (const base of [record, record.snapshot]) {
    if (!isObject(base)) continue;
    containers.push(
      base.traits,
      base.appearance,
      base.bible?.traits,
      base.bible?.appearance,
      base.visual?.traits,
      base.visual?.appearance,
    );
    if (isObject(base.bible) && IDENTITY_TRAIT_ORDER.some((key) => key in base.bible)) {
      containers.push(base.bible);
    }
    if (isObject(base.visual) && IDENTITY_TRAIT_ORDER.some((key) => key in base.visual)) {
      containers.push(base.visual);
    }
  }
  return containers.filter(isObject);
}

function explicitTraits(record) {
  const traits = {};
  const containers = traitContainers(record);
  for (const key of IDENTITY_TRAIT_ORDER) {
    for (const container of containers) {
      const value = textList(container[key]);
      if (value) {
        traits[key] = value;
        break;
      }
    }
  }
  return traits;
}

function inferredTraits(record, traits) {
  const sources = [record.visual?.identityPrompt, record.summary, record.bible?.notes];
  for (const key of IDENTITY_TRAIT_ORDER) {
    if (traits[key]) continue;
    for (const source of sources) {
      for (const clause of clausesOf(source)) {
        if (traitOfClause(clause) === key) {
          traits[key] = clause;
          break;
        }
      }
      if (traits[key]) break;
    }
  }
  return traits;
}

function fillerSegments(record, usedClauses) {
  const segments = [];
  const push = (value) => {
    const text = textOf(value);
    if (text) segments.push(text);
  };
  for (const clause of clausesOf(record.visual?.identityPrompt)) {
    if (!usedClauses.has(clause.toLowerCase())) push(clause);
  }
  push(record.summary);
  push(record.bible?.personality);
  push(record.bible?.notes);
  if (Array.isArray(record.bible?.mannerisms)) {
    for (const mannerism of record.bible.mannerisms) push(mannerism);
  }
  return segments;
}

function identityLockFor(record, characterId) {
  const traits = inferredTraits(record, explicitTraits(record));
  const usedClauses = new Set();
  const parts = [];
  for (const key of IDENTITY_TRAIT_ORDER) {
    if (!traits[key]) continue;
    parts.push(traits[key]);
    usedClauses.add(traits[key].toLowerCase());
  }

  const name = textOf(record.name) || textOf(record.handle) || characterId;
  let identity = parts.length ? `${name}: ${parts.join(', ')}` : `${name}:`;

  for (const segment of fillerSegments(record, usedClauses)) {
    if (wordCount(identity) >= MIN_IDENTITY_WORDS) break;
    if (identity.toLowerCase().includes(segment.toLowerCase())) continue;
    identity = `${identity}, ${segment}`;
  }

  const words = identity.trim().split(/\s+/).filter(Boolean);
  if (words.length > MAX_IDENTITY_WORDS) {
    identity = words.slice(0, MAX_IDENTITY_WORDS).join(' ').replace(/[\s,;:.!?-]+$/, '');
  }
  return identity;
}

function wardrobeById(record, wardrobeId) {
  if (!wardrobeId) return null;
  const wardrobe = Array.isArray(record.visual?.wardrobe) ? record.visual.wardrobe : [];
  return wardrobe.find((item) => isObject(item) && item.id === wardrobeId) ?? null;
}

function defaultWardrobe(record) {
  const wardrobe = Array.isArray(record.visual?.wardrobe) ? record.visual.wardrobe : [];
  return wardrobe.find((item) => isObject(item) && item.default === true) ?? wardrobe[0] ?? null;
}

function wardrobeText(item) {
  if (!isObject(item)) return '';
  return textOf(item.prompt) || textOf(item.label);
}

function shotEntry(source, characterId) {
  if (typeof source === 'string') return source;
  if (Array.isArray(source)) {
    const item = source.find((entry) => isObject(entry)
      && (entry.characterId === characterId || entry.id === characterId));
    if (!item) return undefined;
    return item.wardrobeState ?? item.state ?? item.wardrobe ?? item.wardrobeId ?? item.value;
  }
  if (!isObject(source)) return undefined;
  if (source.characterId === characterId || source.id === characterId) {
    return source.wardrobeState ?? source.state ?? source.wardrobe ?? source.wardrobeId ?? source.value;
  }
  if (Object.hasOwn(source, characterId)) return source[characterId];
  const byCharacter = source.byCharacterId ?? source.states;
  if (isObject(byCharacter) && Object.hasOwn(byCharacter, characterId)) return byCharacter[characterId];
  return undefined;
}

function shotWardrobe(shot, characterId) {
  for (const base of [shot, shot?.beat]) {
    if (!isObject(base)) continue;
    for (const source of [
      base.wardrobeState,
      base.wardrobe,
      base.characterWardrobe,
      base.wardrobeByCharacter,
      base.characters,
    ]) {
      const value = shotEntry(source, characterId);
      if (value !== undefined && value !== null && value !== '') return value;
    }
  }
  return undefined;
}

function normalizeWardrobe(value, record) {
  if (typeof value === 'string') {
    const item = wardrobeById(record, value);
    return item ? wardrobeText(item) || value : value;
  }
  if (!isObject(value)) return '';
  const state = textOf(value.state)
    || textOf(value.wardrobeState)
    || textOf(value.prompt)
    || textOf(value.label);
  if (state) return state;
  const wardrobeId = textOf(value.wardrobeId) || textOf(value.id);
  return wardrobeId ? normalizeWardrobe(wardrobeId, record) : '';
}

function wardrobeStateFor(record, overrides, shot, characterId) {
  const fromShot = shotWardrobe(shot, characterId);
  const shotState = fromShot === undefined ? '' : normalizeWardrobe(fromShot, record);
  if (shotState) return shotState;

  const overrideId = textOf(overrides?.wardrobeId);
  const item = wardrobeById(record, overrideId) ?? defaultWardrobe(record);
  return wardrobeText(item);
}

export function bibleLockForShot({ characters, shot } = {}) {
  if (!Array.isArray(characters)) throw new TypeError('characters must be an array');
  if (!isObject(shot)) throw new TypeError('shot must be an object');

  return characters.map((character) => {
    if (!isObject(character)) throw new TypeError('each character must be an object');
    const snapshot = isObject(character.snapshot) ? character.snapshot : character;
    const characterId = textOf(character.characterId) || textOf(character.id) || textOf(snapshot.id);
    if (!characterId) throw new TypeError('each character needs a characterId');
    const overrides = isObject(character.overrides) ? character.overrides : {};

    const lock = {
      characterId,
      identityLock: identityLockFor(snapshot, characterId),
    };
    const wardrobeState = wardrobeStateFor(snapshot, overrides, shot, characterId);
    if (wardrobeState) lock.wardrobeState = wardrobeState;
    return lock;
  });
}
