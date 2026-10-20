#!/usr/bin/env node
// Q08 - Costume and prop state ledger.
//
// Source: docs/research/MOCKUMENTARY_QUALITY_REVIEW_20261020.md section 3
// (P1 - lock recurring props and character state with actual references).
// The review measured Ada still wearing her apron/teal outfit instead of the
// paid-leave cardigan at 09:00-09:20, and two consecutive payoff shots showing
// different raccoon pictures without the opening's judicial robe.
//
// A shot declares the state visible at its cut:
//   {
//     id: "s09_payoff_a",
//     start: "09:00", end: "09:10",          // or time: "09:00-09:20"
//     characters: { ada: { costume: "apron_teal" } },
//     props: { sandwich_01: { holder: "ada" } },
//     artwork: ["raccoon_portrait@1"],
//     requires: {                              // optional script requirement
//       characters: { ada: { costume: "paid_leave_cardigan@1" } },
//       artwork: ["raccoon_portrait@1"]
//     },
//     licenses: [                              // optional licensed handoff
//       { prop: "sandwich_01", from: "ada", to: "painter", reason: "s12_handoff" }
//     ]
//   }
//
// checkLedger() reports only the ledger's three continuity defects:
//   COSTUME_NOT_PAID_OFF  a scripted costume change never appears at its cut
//   ARTWORK_SWAP          a recurring artwork beat changes id/version or is absent
//   PROP_OWNER_JUMP       a holder changes without a licensing handoff
//
// matchPairs() returns the opening and payoff shots carrying one artwork id so
// a reviewer can compare the painting's subject, robe and frame side by side.
//
// Pure module: no I/O, no clock, no network, no side effects at import time.
// The approved asset library (Q07) is read only for its approved artwork version.

export const LEDGER_SCHEMA = 'comfyrizz.state-ledger/v1';

export const FINDING_CODES = Object.freeze({
  COSTUME_NOT_PAID_OFF: 'COSTUME_NOT_PAID_OFF',
  ARTWORK_SWAP: 'ARTWORK_SWAP',
  PROP_OWNER_JUMP: 'PROP_OWNER_JUMP',
});

const OPENING_ROLES = new Set(['opening', 'open', 'establishing', 'establish', 'first']);
const PAYOFF_ROLES = new Set(['payoff', 'payoff_shot', 'closing', 'closer', 'final', 'last']);

const ARTWORK_FIELDS = ['artwork', 'artworks', 'artworkRefs'];
const REQUIREMENT_FIELDS = [
  'requires',
  'requirements',
  'required',
  'scriptRequires',
  'scriptState',
  'script',
  'expect',
  'expected',
];
const LICENSE_FIELDS = [
  'licenses',
  'license',
  'handoffs',
  'propHandoffs',
  'propLicenses',
  'licensedProps',
];

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function firstDefined(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null) return value;
  }
  return undefined;
}

function roleOf(shot) {
  const raw = shot?.role ?? shot?.reviewRole ?? shot?.beatRole ?? shot?.type ?? null;
  if (typeof raw !== 'string') return null;
  return raw.trim().toLowerCase().replace(/[\s-]+/g, '_');
}

function sceneOf(shot) {
  const raw = shot?.scene ?? shot?.sequence ?? shot?.act ?? shot?.chapter ?? null;
  return raw == null ? '' : String(raw);
}

function shotId(shot, index) {
  const raw = firstDefined(shot?.id, shot?.shot, shot?.shotId, shot?.name);
  return isNonEmptyString(raw) ? raw.trim() : `shot_${index + 1}`;
}

/**
 * Parse "raccoon_portrait@1", "raccoon_portrait", {id, version} or {ref} into
 * {id, version, ref}. A bare id keeps version null; it is compared by id only.
 */
export function parseAssetValue(value) {
  if (typeof value === 'string') {
    const text = value.trim();
    if (!text) return null;
    const match = /^([A-Za-z0-9][A-Za-z0-9_.-]*)@(\d+)$/.exec(text);
    if (match) {
      return { id: match[1], version: Number(match[2]), ref: text };
    }
    return { id: text, version: null, ref: text };
  }
  if (!isPlainObject(value)) return null;
  const raw = firstDefined(value.ref, value.asset, value.assetId, value.id, value.artifactId);
  const parsed = parseAssetValue(raw);
  if (!parsed) return null;
  const version = Number.isInteger(value.version) ? value.version : parsed.version;
  return {
    id: parsed.id,
    version,
    ref: version == null ? parsed.id : `${parsed.id}@${version}`,
  };
}

function sameAsset(actual, expected) {
  const a = parseAssetValue(actual);
  const e = parseAssetValue(expected);
  if (!a || !e) return false;
  if (a.id !== e.id) return false;
  if (e.version == null) return true;
  return a.version === e.version;
}

function sameCostume(actual, expected) {
  if (typeof actual !== 'string' || typeof expected !== 'string') return false;
  const aText = actual.trim();
  const eText = expected.trim();
  const a = parseAssetValue(aText);
  const e = parseAssetValue(eText);
  if (a && e && (a.version != null || e.version != null)) {
    if (a.id.toLowerCase() !== e.id.toLowerCase()) return false;
    if (e.version == null) return true;
    return a.version === e.version;
  }
  return aText.toLowerCase() === eText.toLowerCase();
}

/** Parse "09:20", "1:02:03", "00:09:20" or a numeric seconds value. */
function parseClock(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!text) return null;
  if (/^\d+(?:\.\d+)?$/.test(text)) return Number(text);
  const parts = text.split(':');
  if (parts.length < 2 || parts.length > 3) return null;
  const numbers = parts.map((part) => Number(part));
  if (numbers.some((part) => !Number.isFinite(part) || part < 0)) return null;
  if (numbers.length === 2) return numbers[0] * 60 + numbers[1];
  return numbers[0] * 3600 + numbers[1] * 60 + numbers[2];
}

function timeRangeOf(shot, fps) {
  const time = typeof shot?.time === 'string' ? shot.time : null;
  let start = null;
  let end = null;
  if (time) {
    const match = /^\s*([^\-–]+?)\s*[\-–]\s*([^\-–]+?)\s*$/.exec(time);
    if (match) {
      start = parseClock(match[1]);
      end = parseClock(match[2]);
    } else {
      start = parseClock(time);
    }
  }
  start = firstDefined(
    start,
    parseClock(firstDefined(shot?.start, shot?.startS, shot?.startSeconds, shot?.in, shot?.inS, shot?.from, shot?.at)),
    frameToSeconds(firstDefined(shot?.startFrame, shot?.inFrame), fps),
  );
  end = firstDefined(
    end,
    parseClock(firstDefined(shot?.end, shot?.endS, shot?.endSeconds, shot?.out, shot?.outS, shot?.to)),
    frameToSeconds(firstDefined(shot?.endFrame, shot?.outFrame), fps),
  );
  return {
    start: start == null || !Number.isFinite(start) ? null : start,
    end: end == null || !Number.isFinite(end) ? null : end,
  };
}

function frameToSeconds(value, fps) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  const rate = typeof fps === 'number' && Number.isFinite(fps) && fps > 0 ? fps : 30;
  return value / rate;
}

function normaliseShots(input) {
  if (Array.isArray(input)) {
    return { shots: input, requirements: null };
  }
  if (isPlainObject(input) && Array.isArray(input.shots)) {
    return { shots: input.shots, requirements: input.requirements ?? input.script ?? null };
  }
  throw new TypeError('checkLedger: shots must be an array or an object with a shots array');
}

function orderedShots(shots, fps) {
  return shots
    .map((shot, index) => {
      const range = timeRangeOf(shot, fps);
      return {
        shot,
        index,
        id: shotId(shot, index),
        start: range.start,
        end: range.end,
        orderStart: range.start == null ? Number.POSITIVE_INFINITY : range.start,
      };
    })
    .sort((a, b) => {
      if (a.orderStart !== b.orderStart) return a.orderStart - b.orderStart;
      return a.index - b.index;
    });
}

function timeLabel(record) {
  const raw = record.shot?.time;
  if (typeof raw === 'string' && raw.trim()) return raw.trim();
  if (record.start == null && record.end == null) return null;
  const format = (seconds) => (seconds == null ? '?' : `${Number(seconds.toFixed(3))}s`);
  return `${format(record.start)}-${format(record.end)}`;
}

function artworkEntries(shot) {
  const raw = firstDefined(...ARTWORK_FIELDS.map((field) => shot?.[field]));
  if (raw == null) return [];
  let list;
  if (Array.isArray(raw)) list = raw;
  else if (isPlainObject(raw) && !firstDefined(raw.ref, raw.asset, raw.assetId, raw.id, raw.artifactId)) {
    list = Object.values(raw);
  } else {
    list = [raw];
  }

  const entries = [];
  for (const item of list) {
    const parsed = parseAssetValue(item);
    if (!parsed) continue;
    const beat = isPlainObject(item)
      ? firstDefined(item.beat, item.beatId, item.group, item.artworkBeat)
      : null;
    entries.push({
      ...parsed,
      beat: isNonEmptyString(beat) ? beat.trim() : null,
    });
  }
  return entries;
}

function costumeOf(shot, character) {
  const characters = shot?.characters;
  if (!isPlainObject(characters)) return null;
  const exact = characters[character];
  const key = Object.keys(characters).find(
    (name) => name.toLowerCase() === String(character).toLowerCase(),
  );
  const raw = exact ?? (key ? characters[key] : undefined);
  if (raw == null) return null;
  if (typeof raw === 'string') return raw;
  if (!isPlainObject(raw)) return null;
  const value = firstDefined(raw.costume, raw.costumeId, raw.outfit, raw.wearing);
  return isNonEmptyString(value) ? value : null;
}

function characterNamesOf(shot) {
  if (!isPlainObject(shot?.characters)) return [];
  return Object.keys(shot.characters);
}

function requirementObjectOf(shot) {
  for (const field of REQUIREMENT_FIELDS) {
    if (isPlainObject(shot?.[field])) return shot[field];
  }
  return null;
}

function costumeRequirementsFrom(raw, inherited = {}) {
  const requirements = [];
  if (raw == null) return requirements;
  const list = Array.isArray(raw) ? raw : [raw];
  for (const item of list) {
    if (typeof item === 'string' && inherited.character) {
      requirements.push({ ...inherited, costume: item });
      continue;
    }
    if (!isPlainObject(item)) continue;
    const character = firstDefined(item.character, item.name, item.who, inherited.character);
    const costume = firstDefined(
      item.to,
      item.costume,
      item.costumeId,
      item.required,
      item.expected,
      inherited.costume,
    );
    if (!isNonEmptyString(character) || !isNonEmptyString(costume)) continue;
    requirements.push({
      character: character.trim(),
      costume,
      from: isNonEmptyString(item.from) ? item.from.trim() : null,
      reason: isNonEmptyString(item.reason) ? item.reason.trim() : null,
    });
  }
  return requirements;
}

function shotCostumeRequirements(shot) {
  const req = requirementObjectOf(shot);
  if (!req) return [];
  const requirements = [];

  for (const field of ['characters', 'costumes', 'requiredCharacters', 'expectedCharacters']) {
    const raw = req[field];
    if (!isPlainObject(raw)) continue;
    for (const [character, value] of Object.entries(raw)) {
      if (typeof value === 'string') {
        requirements.push({ character, costume: value, from: null, reason: null });
      } else if (isPlainObject(value)) {
        requirements.push(...costumeRequirementsFrom(value, { character }));
      }
    }
  }

  for (const field of ['costume', 'costumeChange', 'costumeChanges', 'requiredCostume']) {
    if (req[field] !== undefined) {
      requirements.push(...costumeRequirementsFrom(req[field]));
    }
  }
  for (const field of ['costumeChange', 'costumeChanges', 'requiredCostume', 'expectedCostume']) {
    if (shot?.[field] !== undefined) {
      requirements.push(...costumeRequirementsFrom(shot[field]));
    }
  }
  return requirements;
}

function expectedArtworkOf(shot) {
  const req = requirementObjectOf(shot) ?? {};
  const raw = firstDefined(
    shot?.requiredArtwork,
    shot?.expectedArtwork,
    req.artwork,
    req.artworks,
    req.artworkRefs,
    req.requiredArtwork,
    req.expectedArtwork,
  );
  if (raw == null) return [];
  const list = Array.isArray(raw) ? raw : [raw];
  const expected = [];
  for (const item of list) {
    const parsed = parseAssetValue(item);
    if (parsed) expected.push(parsed);
  }
  return expected;
}

function rootCostumeRequirements(requirements) {
  if (requirements == null) return [];
  const source = isPlainObject(requirements)
    ? firstDefined(requirements.costumes, requirements.characters, requirements.costume, requirements.costumeChanges)
    : requirements;
  if (source == null) return [];
  if (Array.isArray(source)) {
    return costumeRequirementsFrom(source);
  }
  if (isPlainObject(source)) {
    const looksLikeOne =
      firstDefined(source.character, source.name, source.who) !== undefined ||
      firstDefined(source.costume, source.to) !== undefined;
    if (looksLikeOne) return costumeRequirementsFrom(source);
    const requirementsList = [];
    for (const [character, value] of Object.entries(source)) {
      if (typeof value === 'string') {
        requirementsList.push({ character, costume: value, from: null, reason: null });
      } else if (isPlainObject(value)) {
        requirementsList.push(...costumeRequirementsFrom(value, { character }));
      }
    }
    return requirementsList;
  }
  return [];
}

function rootArtworkRequirements(requirements) {
  if (requirements == null) return [];
  const source = Array.isArray(requirements)
    ? requirements
    : isPlainObject(requirements)
      ? firstDefined(requirements.artwork, requirements.artworks, requirements.artworkBeats)
      : null;
  if (source == null) return [];
  const list = Array.isArray(source) ? source : [source];
  const out = [];
  for (const item of list) {
    const parsed = parseAssetValue(item);
    if (!parsed) continue;
    const beat = isPlainObject(item)
      ? firstDefined(item.beat, item.beatId, item.group)
      : null;
    const shots = isPlainObject(item) && Array.isArray(item.shots)
      ? item.shots.map(String)
      : null;
    out.push({
      expected: parsed,
      beat: isNonEmptyString(beat) ? beat.trim() : null,
      shots,
    });
  }
  return out;
}

function approvedArtworkVersion(lib, id) {
  const assets = Array.isArray(lib?.assets) ? lib.assets : [];
  const matches = assets.filter(
    (asset) => isPlainObject(asset) && asset.id === id && Number.isInteger(asset.version),
  );
  const artwork = matches.filter((asset) => asset.kind === 'artwork');
  const versions = new Set((artwork.length > 0 ? artwork : matches).map((asset) => asset.version));
  if (versions.size !== 1) return null;
  return [...versions][0];
}

function pushFinding(findings, seen, finding, dedupeKey) {
  if (dedupeKey) {
    if (seen.has(dedupeKey)) return;
    seen.add(dedupeKey);
  }
  findings.push(finding);
}

function costumeFindings(records, rootRequirements) {
  const findings = [];
  const seen = new Set();

  for (const record of records) {
    for (const requirement of shotCostumeRequirements(record.shot)) {
      const actual = costumeOf(record.shot, requirement.character);
      if (sameCostume(actual, requirement.costume)) continue;
      const key = [
        FINDING_CODES.COSTUME_NOT_PAID_OFF,
        sceneOf(record.shot),
        requirement.character.toLowerCase(),
        requirement.costume,
        actual ?? 'none',
      ].join('|');
      pushFinding(
        findings,
        seen,
        {
          code: FINDING_CODES.COSTUME_NOT_PAID_OFF,
          shot: record.id,
          index: record.index,
          time: timeLabel(record),
          scene: sceneOf(record.shot) || null,
          character: requirement.character,
          expected: requirement.costume,
          actual: actual ?? null,
          message:
            `${requirement.character} must wear ${requirement.costume} at ${timeLabel(record) ?? record.id}` +
            ` but the ledger shows ${actual ?? 'no costume'}.`,
        },
        key,
      );
    }
  }

  for (const requirement of rootRequirements) {
    const candidates = records.filter((record) => {
      if (requirement.from) {
        return sameCostume(costumeOf(record.shot, requirement.character), requirement.from);
      }
      return characterNamesOf(record.shot).some(
        (name) => name.toLowerCase() === requirement.character.toLowerCase(),
      );
    });
    const after = requirement.from && candidates.length > 0
      ? candidates[0].orderStart
      : Number.NEGATIVE_INFINITY;
    const paidOff = records.some(
      (record) =>
        record.orderStart >= after &&
        sameCostume(costumeOf(record.shot, requirement.character), requirement.costume),
    );
    if (paidOff) continue;

    const target = records[records.length - 1] ?? null;
    const actual = target ? costumeOf(target.shot, requirement.character) : null;
    const key = [
      FINDING_CODES.COSTUME_NOT_PAID_OFF,
      'script',
      requirement.character.toLowerCase(),
      requirement.costume,
    ].join('|');
    pushFinding(
      findings,
      seen,
      {
        code: FINDING_CODES.COSTUME_NOT_PAID_OFF,
        shot: target ? target.id : null,
        index: target ? target.index : null,
        time: target ? timeLabel(target) : null,
        scene: target ? sceneOf(target.shot) || null : null,
        character: requirement.character,
        expected: requirement.costume,
        actual: actual ?? null,
        message:
          `Scripted costume change for ${requirement.character} to ${requirement.costume}` +
          ' never appears in the ledger.',
      },
      key,
    );
  }

  return findings;
}

function artworkFindings(records, lib, rootRequirements) {
  const findings = [];
  const seen = new Set();
  const groups = new Map();

  for (const record of records) {
    const entries = artworkEntries(record.shot);
    const expectedEntries = expectedArtworkOf(record.shot);
    if (entries.length === 0 && expectedEntries.length === 0) {
      const beat = firstDefined(record.shot?.artworkBeat, record.shot?.artworkBeatId);
      if (isNonEmptyString(beat)) {
        const key = [FINDING_CODES.ARTWORK_SWAP, record.id, beat, 'none'].join('|');
        pushFinding(
          findings,
          seen,
          {
            code: FINDING_CODES.ARTWORK_SWAP,
            shot: record.id,
            index: record.index,
            time: timeLabel(record),
            artworkBeat: beat.trim(),
            expected: null,
            actual: null,
            message: `Artwork beat "${beat.trim()}" has no artwork at ${timeLabel(record) ?? record.id}.`,
          },
          key,
        );
      }
    }

    for (const entry of entries) {
      const shotBeat = firstDefined(record.shot?.artworkBeat, record.shot?.artworkBeatId);
      const beat = entry.beat ?? (isNonEmptyString(shotBeat) ? shotBeat.trim() : null);
      const groupKey = beat ?? entry.id;
      if (!groups.has(groupKey)) groups.set(groupKey, []);
      groups.get(groupKey).push({ record, entry: { ...entry, beat } });
    }

    for (const expected of expectedEntries) {
      const actual = entries.find((entry) => sameAsset(entry, expected));
      if (actual) continue;
      const present = entries.map((entry) => entry.ref).join(', ') || null;
      const key = [
        FINDING_CODES.ARTWORK_SWAP,
        record.id,
        expected.ref,
        present ?? 'none',
      ].join('|');
      pushFinding(
        findings,
        seen,
        {
          code: FINDING_CODES.ARTWORK_SWAP,
          shot: record.id,
          index: record.index,
          time: timeLabel(record),
          artworkBeat: firstDefined(record.shot?.artworkBeat, null),
          expected: expected.ref,
          actual: present,
          message:
            `Artwork at ${timeLabel(record) ?? record.id} is ${present ?? 'missing'};` +
            ` the shot requires ${expected.ref}.`,
        },
        key,
      );
    }
  }

  for (const [groupKey, entries] of groups) {
    let canonical = entries[0].entry;
    const approved = approvedArtworkVersion(lib, canonical.id);
    if (approved != null) {
      canonical = { ...canonical, version: approved, ref: `${canonical.id}@${approved}` };
    }

    for (const { record, entry } of entries) {
      let mismatch = false;
      if (entry.id !== canonical.id) {
        mismatch = true;
      } else if (
        entry.version != null &&
        canonical.version != null &&
        entry.version !== canonical.version
      ) {
        mismatch = true;
      }
      if (!mismatch) continue;

      const key = [
        FINDING_CODES.ARTWORK_SWAP,
        record.id,
        canonical.ref,
        entry.ref,
      ].join('|');
      pushFinding(
        findings,
        seen,
        {
          code: FINDING_CODES.ARTWORK_SWAP,
          shot: record.id,
          index: record.index,
          time: timeLabel(record),
          artworkBeat: entry.beat ?? null,
          expected: canonical.ref,
          actual: entry.ref,
          message:
            `Recurring artwork${entry.beat ? ` beat "${entry.beat}"` : ` "${groupKey}"`}` +
            ` uses ${entry.ref} at ${timeLabel(record) ?? record.id}; expected ${canonical.ref}.`,
        },
        key,
      );
    }
  }

  for (const requirement of rootRequirements) {
    const targets = requirement.shots
      ? records.filter((record) => requirement.shots.includes(record.id))
      : requirement.beat
        ? records.filter((record) =>
            artworkEntries(record.shot).some((entry) => entry.beat === requirement.beat) ||
            record.shot?.artworkBeat === requirement.beat,
          )
        : [];

    for (const record of targets) {
      const entries = artworkEntries(record.shot);
      if (entries.some((entry) => sameAsset(entry, requirement.expected))) continue;
      const present = entries.map((entry) => entry.ref).join(', ') || null;
      const key = [
        FINDING_CODES.ARTWORK_SWAP,
        record.id,
        requirement.expected.ref,
        present ?? 'none',
      ].join('|');
      pushFinding(
        findings,
        seen,
        {
          code: FINDING_CODES.ARTWORK_SWAP,
          shot: record.id,
          index: record.index,
          time: timeLabel(record),
          artworkBeat: requirement.beat,
          expected: requirement.expected.ref,
          actual: present,
          message:
            `Artwork at ${timeLabel(record) ?? record.id} is ${present ?? 'missing'};` +
            ` the ledger requires ${requirement.expected.ref}.`,
        },
        key,
      );
    }
  }

  return findings;
}

function propStateOf(shot, propId) {
  const props = shot?.props;
  if (!isPlainObject(props)) return { holder: null, location: null, raw: null };
  const key = Object.keys(props).find(
    (name) => name.toLowerCase() === String(propId).toLowerCase(),
  );
  const raw = key ? props[key] : undefined;
  if (raw == null) return { holder: null, location: null, raw: null };
  if (typeof raw === 'string') {
    return { holder: raw.trim() || null, location: null, raw };
  }
  if (!isPlainObject(raw)) return { holder: null, location: null, raw };
  const holder = firstDefined(raw.holder, raw.owner, raw.character, raw.heldBy);
  const location = firstDefined(raw.location, raw.on, raw.at, raw.place);
  return {
    holder: isNonEmptyString(holder) ? holder.trim() : null,
    location: isNonEmptyString(location) ? location.trim() : null,
    raw,
  };
}

function licensesOf(shot) {
  const licenses = [];
  for (const field of LICENSE_FIELDS) {
    const raw = shot?.[field];
    if (raw == null) continue;
    const list = Array.isArray(raw) ? raw : [raw];
    for (const item of list) {
      if (typeof item === 'string') {
        licenses.push({ prop: item, from: null, to: null });
      } else if (isPlainObject(item)) {
        licenses.push({
          prop: firstDefined(item.prop, item.id, item.asset, item.assetId, item.propId),
          from: firstDefined(item.from, item.holderFrom, item.previousHolder),
          to: firstDefined(item.to, item.holderTo, item.nextHolder),
          reason: firstDefined(item.reason, item.beat, item.note),
        });
      }
    }
  }
  return licenses;
}

function propEntryLicensed(shot, propId, from, to) {
  const licenses = licensesOf(shot);
  const state = propStateOf(shot, propId);
  if (isPlainObject(state.raw) && (state.raw.licensed === true || state.raw.handoff === true)) {
    return true;
  }
  if (isPlainObject(state.raw) && isNonEmptyString(state.raw.licensedBy)) return true;

  const wanted = parseAssetValue(propId)?.id ?? propId;
  for (const license of licenses) {
    const licensedProp = parseAssetValue(license.prop)?.id ?? license.prop;
    if (licensedProp !== wanted) continue;
    if (isNonEmptyString(license.from) && license.from !== from) continue;
    if (isNonEmptyString(license.to) && license.to !== to) continue;
    return true;
  }
  return false;
}

function propFindings(records) {
  const findings = [];
  const seen = new Set();
  const propIds = new Map();

  records.forEach((record, position) => {
    if (!isPlainObject(record.shot?.props)) return;
    for (const propId of Object.keys(record.shot.props)) {
      const canonical = parseAssetValue(propId)?.id ?? propId;
      if (!propIds.has(canonical)) propIds.set(canonical, []);
      propIds.get(canonical).push({ record, position, propId });
    }
  });

  for (const [canonicalId, occurrences] of propIds) {
    let previous = null;
    for (const occurrence of occurrences) {
      const state = propStateOf(occurrence.record.shot, occurrence.propId);
      if (previous && previous.holder && state.holder && previous.holder !== state.holder) {
        const licensed =
          propEntryLicensed(occurrence.record.shot, canonicalId, previous.holder, state.holder) ||
          propEntryLicensed(previous.record.shot, canonicalId, previous.holder, state.holder);
        if (!licensed) {
          const key = [
            FINDING_CODES.PROP_OWNER_JUMP,
            occurrence.record.id,
            canonicalId,
            previous.holder,
            state.holder,
          ].join('|');
          pushFinding(
            findings,
            seen,
            {
              code: FINDING_CODES.PROP_OWNER_JUMP,
              shot: occurrence.record.id,
              previousShot: previous.record.id,
              index: occurrence.record.index,
              time: timeLabel(occurrence.record),
              prop: canonicalId,
              from: previous.holder,
              to: state.holder,
              message:
                `${canonicalId} changes holder from ${previous.holder} to ${state.holder}` +
                ` at ${timeLabel(occurrence.record) ?? occurrence.record.id}` +
                ' without a licensed handoff.',
            },
            key,
          );
        }
      }
      previous = { holder: state.holder, record: occurrence.record };
    }
  }

  return findings;
}

/**
 * Check costume, artwork and prop continuity at every declared cut.
 *
 * @param {object} lib approved asset library (comfyrizz.asset-library/v1)
 * @param {Array|object} shots shot array, or {shots:[...], requirements:...}
 * @param {{fps?:number}} [options]
 * @returns {Array<object>} deterministic findings in cut order
 */
export function checkLedger(lib, shots, options = {}) {
  const { shots: list, requirements } = normaliseShots(shots);
  const fps = Number.isFinite(options.fps) ? options.fps : 30;
  const records = orderedShots(list, fps);

  const findings = [
    ...costumeFindings(records, rootCostumeRequirements(requirements)),
    ...artworkFindings(records, lib, rootArtworkRequirements(requirements)),
    ...propFindings(records),
  ];

  const rank = new Map(records.map((record, position) => [record.index, position]));
  return findings.sort((a, b) => {
    const ai = a.index == null ? Number.POSITIVE_INFINITY : rank.get(a.index) ?? a.index;
    const bi = b.index == null ? Number.POSITIVE_INFINITY : rank.get(b.index) ?? b.index;
    if (ai !== bi) return ai - bi;
    return a.code.localeCompare(b.code);
  });
}

function matchesAsset(entry, wanted) {
  if (entry.id !== wanted.id) return false;
  if (wanted.version == null) return true;
  return entry.version === wanted.version;
}

/**
 * Return the opening and payoff shots that carry one artwork id, for
 * side-by-side review of the painting's subject, robe and frame.
 *
 * @param {Array|object} shots shot array, or {shots:[...]}
 * @param {string|object} assetId "raccoon_portrait" or "raccoon_portrait@1"
 * @returns {{assetId:string|null, opening:object|null, payoff:object|null,
 *   openingRef:string|null, payoffRef:string|null, sameAsset:boolean|null,
 *   matches:number}}
 */
export function matchPairs(shots, assetId) {
  const { shots: list } = normaliseShots(shots);
  const wanted = parseAssetValue(assetId);
  if (!wanted) {
    return {
      assetId: null,
      opening: null,
      payoff: null,
      openingRef: null,
      payoffRef: null,
      sameAsset: null,
      matches: 0,
    };
  }

  const records = orderedShots(list, 30);
  const matches = [];
  for (const record of records) {
    const entries = artworkEntries(record.shot).filter((entry) => matchesAsset(entry, wanted));
    if (entries.length > 0) matches.push({ record, entry: entries[0] });
  }

  if (matches.length === 0) {
    return {
      assetId: wanted.ref,
      opening: null,
      payoff: null,
      openingRef: null,
      payoffRef: null,
      sameAsset: null,
      matches: 0,
    };
  }

  const openingByRole = matches.find((match) => OPENING_ROLES.has(roleOf(match.record.shot)));
  const payoffByRole = [...matches].reverse().find((match) => PAYOFF_ROLES.has(roleOf(match.record.shot)));
  const opening = openingByRole ?? matches[0];
  const payoff = payoffByRole ?? (matches.length > 1 ? matches[matches.length - 1] : null);

  return {
    assetId: wanted.ref,
    opening: opening.record.shot,
    payoff: payoff ? payoff.record.shot : null,
    openingRef: opening.entry.ref,
    payoffRef: payoff ? payoff.entry.ref : null,
    sameAsset:
      payoff == null
        ? null
        : opening.entry.id === payoff.entry.id &&
          (opening.entry.version == null ||
            payoff.entry.version == null ||
            opening.entry.version === payoff.entry.version),
    matches: matches.length,
  };
}
