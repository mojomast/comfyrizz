// Q09 - Bind approved references into shot prompts.
//
// Source: docs/research/MOCKUMENTARY_QUALITY_REVIEW_20261020.md section 3
// ("Lock recurring props and character state with actual references") and
// docs/specs/QUALITY_FIXES.md Q09.
//
// attachRefs(shots, lib) returns a sidecar the still/video generator can read:
// every shot keeps its authored fields and gains
//
//   refs: [{ id, version, sha256, role: 'composite' | 'condition' }]
//
// `composite` means the exact approved bytes are placed as a composited surface
// (the default for artwork: the raccoon portrait, signs, framed pictures).
// `condition` means the file is a reference image for reference-conditioned
// generation (characters, props, costumes, sets), i.e. the LoadImage /
// ReferenceMultiLatent path in workflows/flux3_klein_ref_edit.api.json (read
// only; this module never imports or writes generator code).
//
// Recurring assets are declared by id or "id@version" in the shot's asset,
// artwork, prop, character-costume, set or sign fields, or named by id in its
// prompt text. Only entries present in the approved comfyrizz.asset-library/v1
// manifest are bound. An explicitly requested version is never silently
// substituted with another version; a missing or unapproved entry is reported
// as REF_MISSING and the shot gets no ref for it.
//
// Pure data: no I/O, no network, no clock, no side effects at import time.
// Neither the shots nor the library are mutated; the output is deep-cloned.
// Only the documented four ref fields are emitted. Findings use shot ids and
// manifest-relative or logical names, never absolute paths.

import {
  ASSET_KINDS,
  assetRef,
  parseRef,
} from './asset-library.mjs';

export const REF_ROLES = Object.freeze(['composite', 'condition']);

// Artwork is placed as an exact composited surface by default; everything else
// is a reference image used for conditioning.
export const DEFAULT_ROLE_BY_KIND = Object.freeze({
  artwork: 'composite',
  character: 'condition',
  prop: 'condition',
  costume: 'condition',
  set: 'condition',
  sign: 'condition',
});

export const REF_FINDING_CODES = Object.freeze({
  REF_MISSING: 'REF_MISSING',
  REF_ROLE_INVALID: 'REF_ROLE_INVALID',
});

const ID_PATTERN = /^[a-z][a-z0-9_]*$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

// Fields that hold a value, an array of values or an id-keyed map.
const ASSET_LIST_FIELDS = Object.freeze([
  'refs',
  'references',
  'assets',
  'requiredProps',
  'artwork',
  'artworks',
  'costume',
  'costumes',
  'outfit',
  'set',
  'sets',
  'sign',
  'signs',
  'mentions',
  'assetMentions',
  'assetRefs',
  'recurringAssets',
  'continuityAssets',
]);

// Map fields whose keys are asset ids (Q08 state-ledger shape).
const ASSET_MAP_FIELDS = Object.freeze(['props']);

// Prompt-bearing fields scanned for ids / id@version tokens. Labels are not
// scanned: ids and refs are the authoring contract, labels are prose.
const PROMPT_FIELDS = Object.freeze([
  'prompt',
  'imagePrompt',
  'actionPrompt',
  'action',
  'image',
  'description',
]);

const CHARACTER_ASSET_FIELDS = Object.freeze([
  'costume',
  'costumeRef',
  'costumeAsset',
  'outfit',
  'asset',
  'ref',
]);

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function normalizeVersion(value) {
  if (Number.isInteger(value) && value >= 1) return value;
  if (typeof value === 'string' && /^\d+$/.test(value)) {
    const parsed = Number(value);
    if (Number.isSafeInteger(parsed) && parsed >= 1) return parsed;
  }
  return null;
}

function normalizeRole(value) {
  if (value === 'composite' || value === 'condition') return value;
  return null;
}

// A declaration is { id, version|null, role|null } where version null means
// "the approved version" (the highest approved version of that id).
function normalizeDeclaration(value, roleHint = null) {
  if (typeof value === 'string') {
    const text = value.trim();
    const parsed = parseRef(text);
    if (parsed) return { id: parsed.id, version: parsed.version, role: roleHint };
    if (ID_PATTERN.test(text)) return { id: text, version: null, role: roleHint };
    return null;
  }
  if (!isObject(value)) return null;

  const refValue =
    typeof value.ref === 'string'
      ? value.ref
      : typeof value.asset === 'string'
        ? value.asset
        : null;
  const parsed = refValue ? parseRef(refValue) : null;
  const id = parsed ? parsed.id : typeof value.id === 'string' ? value.id.trim() : null;
  if (!id || !ID_PATTERN.test(id)) return null;
  const version = parsed
    ? parsed.version
    : normalizeVersion(value.version);
  const roleValue = value.role ?? value.as ?? roleHint ?? null;
  return { id, version, role: normalizeRole(roleValue) ?? roleValue };
}

function pushDeclaration(out, value, roleHint = null) {
  if (Array.isArray(value)) {
    for (const item of value) pushDeclaration(out, item, roleHint);
    return;
  }
  if (typeof value === 'string') {
    const declaration = normalizeDeclaration(value, roleHint);
    if (declaration) out.push(declaration);
    return;
  }
  if (!isObject(value)) return;

  const declaration = normalizeDeclaration(value, roleHint);
  if (declaration) {
    out.push(declaration);
    return;
  }

  // Id-keyed map, e.g. props: { sandwich_01: { holder: 'painter' } }.
  for (const [key, entry] of Object.entries(value)) {
    const keyRef = parseRef(key);
    if (keyRef) {
      out.push({
        id: keyRef.id,
        version: keyRef.version,
        role: isObject(entry) ? entry.role ?? entry.as ?? roleHint ?? null : roleHint,
      });
      continue;
    }
    if (!ID_PATTERN.test(key)) continue;
    if (isObject(entry)) {
      const entryRef =
        typeof entry.ref === 'string'
          ? entry.ref
          : typeof entry.asset === 'string'
            ? entry.asset
            : null;
      if (entryRef) {
        const nested = normalizeDeclaration(entryRef, entry.role ?? entry.as ?? roleHint);
        if (nested) out.push(nested);
        continue;
      }
    }
    out.push({
      id: key,
      version: isObject(entry) ? normalizeVersion(entry.version) : null,
      role: isObject(entry) ? entry.role ?? entry.as ?? roleHint ?? null : roleHint,
    });
  }
}

function declarationsFromCharacters(out, characters) {
  if (!isObject(characters)) return;
  for (const value of Object.values(characters)) {
    if (isObject(value)) {
      for (const field of CHARACTER_ASSET_FIELDS) {
        if (value[field] !== undefined) pushDeclaration(out, value[field]);
      }
    }
  }
}

function declarationsFromPrompt(out, text, libraryIds) {
  if (typeof text !== 'string' || text.length === 0) return;

  // Explicit "id@version" tokens are authoritative, even when unknown.
  const versioned = text.match(/\b[a-z][a-z0-9_]*@\d+\b/g) ?? [];
  for (const token of versioned) {
    const parsed = parseRef(token);
    if (parsed) out.push({ id: parsed.id, version: parsed.version, role: null });
  }

  // Known library ids mentioned without a version bind to the latest approved
  // version; an unapproved entry is still declared so REF_MISSING can report it.
  const stripped = text.replace(/\b[a-z][a-z0-9_]*@\d+\b/g, ' ');
  for (const id of libraryIds) {
    if (!ID_PATTERN.test(id)) continue;
    const pattern = new RegExp(`(?<![a-z0-9_])${id}(?![a-z0-9_])`);
    if (pattern.test(stripped)) out.push({ id, version: null, role: null });
  }
}

function shotLabel(shot, index) {
  if (typeof shot?.id === 'string' && shot.id) return shot.id;
  if (typeof shot?.shotId === 'string' && shot.shotId) return shot.shotId;
  if (typeof shot?.shot === 'string' && shot.shot) return shot.shot;
  return index;
}

function isApproved(asset) {
  if (!isObject(asset)) return false;
  if (asset.approved === false) return false;
  if (typeof asset.status === 'string' && /^(draft|rejected|unapproved)$/i.test(asset.status)) {
    return false;
  }
  return true;
}

function isBindable(asset) {
  return (
    isApproved(asset) &&
    typeof asset.id === 'string' &&
    ID_PATTERN.test(asset.id) &&
    Number.isInteger(asset.version) &&
    asset.version >= 1 &&
    typeof asset.sha256 === 'string' &&
    SHA256_PATTERN.test(asset.sha256)
  );
}

function findAsset(lib, id, version) {
  const assets = Array.isArray(lib?.assets) ? lib.assets : [];
  let best = null;
  for (const asset of assets) {
    if (!isBindable(asset) || asset.id !== id) continue;
    if (version !== null) {
      if (asset.version === version) return asset;
      continue;
    }
    if (!best || asset.version > best.version) best = asset;
  }
  return best;
}

function roleFor(asset, declaration, shot) {
  const explicit = normalizeRole(declaration.role);
  if (explicit) return { role: explicit, explicit: true };

  const maps = [shot?.refRoles, shot?.roles];
  for (const map of maps) {
    if (!isObject(map)) continue;
    const value = map[assetRef(asset)] ?? map[asset.id];
    const role = normalizeRole(value);
    if (role) return { role, explicit: true };
  }

  const kind = ASSET_KINDS.includes(asset.kind) ? asset.kind : null;
  return { role: (kind && DEFAULT_ROLE_BY_KIND[kind]) || 'condition', explicit: false };
}

function missingFinding(shot, declaration) {
  const ref = declaration.version === null
    ? declaration.id
    : `${declaration.id}@${declaration.version}`;
  const reason = declaration.version === null
    ? 'the approved library has no approved entry for that asset'
    : `the approved library has no approved version ${declaration.version} for that asset`;
  return {
    shot,
    code: REF_FINDING_CODES.REF_MISSING,
    ref,
    id: declaration.id,
    version: declaration.version,
    message: `shot "${shot}" names "${ref}" but ${reason}`,
  };
}

/**
 * Attach approved continuity references to shots.
 *
 * @param {Array<object>} shots authored shots; JSON-like, never mutated
 * @param {{schema?:string, assets?:Array<object>}} lib approved asset library (Q07)
 * @returns {{shots: Array<object>, findings: Array<object>}}
 */
export function attachRefs(shots, lib) {
  if (!Array.isArray(shots)) {
    throw new TypeError('attachRefs: shots must be an array');
  }

  // Every id in the library is scanned in prompts, including unapproved
  // entries, so a named-but-unapproved asset is reported instead of skipped.
  const libraryIds = [];
  const seenIds = new Set();
  if (Array.isArray(lib?.assets)) {
    for (const asset of lib.assets) {
      if (!isObject(asset) || typeof asset.id !== 'string') continue;
      if (!ID_PATTERN.test(asset.id) || seenIds.has(asset.id)) continue;
      seenIds.add(asset.id);
      libraryIds.push(asset.id);
    }
  }

  const findings = [];
  const outShots = [];

  shots.forEach((shot, index) => {
    if (!isObject(shot)) {
      throw new TypeError('attachRefs: every shot must be an object');
    }
    const label = shotLabel(shot, index);
    const declarations = [];
    const reported = new Set();
    const report = (finding) => {
      const key = `${finding.code}|${finding.ref ?? ''}`;
      if (reported.has(key)) return;
      reported.add(key);
      findings.push(finding);
    };

    for (const field of ASSET_LIST_FIELDS) {
      if (shot[field] !== undefined) pushDeclaration(declarations, shot[field]);
    }
    for (const field of ASSET_MAP_FIELDS) {
      if (shot[field] !== undefined) pushDeclaration(declarations, shot[field]);
    }
    declarationsFromCharacters(declarations, shot.characters);

    for (const field of PROMPT_FIELDS) {
      declarationsFromPrompt(declarations, shot[field], libraryIds);
    }

    // id@version -> { asset, role, explicit }; insertion order is stable.
    const bound = new Map();
    for (const declaration of declarations) {
      if (declaration.role !== null && !normalizeRole(declaration.role)) {
        report({
          shot: label,
          code: REF_FINDING_CODES.REF_ROLE_INVALID,
          ref:
            declaration.version === null
              ? declaration.id
              : `${declaration.id}@${declaration.version}`,
          role: declaration.role,
          message: `shot "${label}" declares role "${String(declaration.role)}" for "${declaration.id}"; expected "composite" or "condition"`,
        });
      }

      const asset = findAsset(lib, declaration.id, declaration.version);
      if (!asset) {
        report(missingFinding(label, declaration));
        continue;
      }

      const key = assetRef(asset);
      const resolved = roleFor(asset, declaration, shot);
      const existing = bound.get(key);
      if (!existing) {
        bound.set(key, { asset, role: resolved.role, explicit: resolved.explicit });
      } else if (!existing.explicit && resolved.explicit) {
        existing.role = resolved.role;
        existing.explicit = true;
      }
    }

    const refs = [];
    for (const { asset, role } of bound.values()) {
      refs.push({
        id: asset.id,
        version: asset.version,
        sha256: asset.sha256,
        role,
      });
    }

    const copy = structuredClone(shot);
    copy.refs = refs;
    outShots.push(copy);
  });

  return { shots: outShots, findings };
}
