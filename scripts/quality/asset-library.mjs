// Approved continuity asset library (QUALITY-FIXES Q07).
//
// Pure manifest helpers over comfyrizz.asset-library/v1. This is not the
// REFERENCE-ASSETS feature's UI or routes; it is the small approved library
// the QA passes (state ledger, shot refs) read so recurring props, costume,
// artwork, characters, sets and signs stay locked to one versioned file hash.
//
// Manifest shape:
//   {
//     "schema": "comfyrizz.asset-library/v1",
//     "assets": [
//       {
//         "id": "raccoon_portrait",
//         "version": 1,
//         "kind": "character" | "prop" | "artwork" | "costume" | "set" | "sign",
//         "label": "Courtroom raccoon portrait",
//         "file": "assets/raccoon_portrait@1.png",
//         "sha256": "<64 lowercase hex>",
//         "approvedBy": "continuity-lead",
//         "notes": "optional editorial note"
//       }
//     ]
//   }
//
// Refs are "id@version" strings, e.g. "raccoon_portrait@1". Unknown ids or
// versions resolve to null / land in the unknown list; they are never silently
// substituted with another version. verifyAssetFiles reports FILE_MISSING,
// HASH_MISMATCH and UNVERIFIABLE findings keyed by the manifest-relative file
// path (never an absolute path). Nothing here touches the network, logs,
// or writes to disk; file reads go through an injected fs.
import { createHash } from 'node:crypto';
import * as nodeFs from 'node:fs';
import { join } from 'node:path';

export const LIBRARY_SCHEMA = 'comfyrizz.asset-library/v1';
export const ASSET_KINDS = Object.freeze([
  'character',
  'prop',
  'artwork',
  'costume',
  'set',
  'sign',
]);

const ID_PATTERN = /^[a-z][a-z0-9_]*$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const REF_PATTERN = /^([a-z][a-z0-9_]*)@(\d+)$/;

export function parseRef(ref) {
  if (typeof ref !== 'string') return null;
  const match = REF_PATTERN.exec(ref);
  if (!match) return null;
  const version = Number(match[2]);
  if (!Number.isSafeInteger(version) || version < 1) return null;
  return { id: match[1], version };
}

export function assetRef(asset) {
  if (!asset || typeof asset !== 'object') return null;
  if (typeof asset.id !== 'string' || !Number.isInteger(asset.version)) return null;
  return `${asset.id}@${asset.version}`;
}

function isRelativePath(value) {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    !value.startsWith('/') &&
    !value.includes('\\') &&
    !value.split('/').includes('..')
  );
}

export function validateLibrary(lib) {
  const errors = [];
  const push = (path, code, message) => errors.push({ path, code, message });

  if (!lib || typeof lib !== 'object' || Array.isArray(lib)) {
    push('', 'INVALID_ROOT', 'library must be an object');
    return { ok: false, errors };
  }
  if (lib.schema !== LIBRARY_SCHEMA) {
    push('/schema', 'SCHEMA_MISMATCH', `schema must be "${LIBRARY_SCHEMA}"`);
  }
  if (!Array.isArray(lib.assets)) {
    push('/assets', 'INVALID_ASSETS', 'assets must be an array');
    return { ok: false, errors };
  }

  const seen = new Map();
  lib.assets.forEach((asset, index) => {
    const path = `/assets/${index}`;
    if (!asset || typeof asset !== 'object' || Array.isArray(asset)) {
      push(path, 'INVALID_ASSET', 'asset must be an object');
      return;
    }

    if (typeof asset.id !== 'string' || !ID_PATTERN.test(asset.id)) {
      push(`${path}/id`, 'INVALID_ID', 'id must match /^[a-z][a-z0-9_]*$/');
    }
    if (!Number.isInteger(asset.version) || asset.version < 1) {
      push(`${path}/version`, 'INVALID_VERSION', 'version must be an integer >= 1');
    }
    if (!ASSET_KINDS.includes(asset.kind)) {
      push(
        `${path}/kind`,
        'INVALID_KIND',
        `kind must be one of: ${ASSET_KINDS.join(', ')}`,
      );
    }
    if (typeof asset.label !== 'string' || !asset.label.trim()) {
      push(`${path}/label`, 'INVALID_LABEL', 'label must be a non-empty string');
    }
    if (!isRelativePath(asset.file)) {
      push(
        `${path}/file`,
        'INVALID_FILE',
        'file must be a relative path with no backslashes or ".." segments',
      );
    }
    if (typeof asset.sha256 !== 'string' || !SHA256_PATTERN.test(asset.sha256)) {
      push(`${path}/sha256`, 'INVALID_SHA256', 'sha256 must be 64 lowercase hex characters');
    }
    if (typeof asset.approvedBy !== 'string' || !asset.approvedBy.trim()) {
      push(`${path}/approvedBy`, 'INVALID_APPROVER', 'approvedBy must be a non-empty string');
    }
    if (asset.notes !== undefined && typeof asset.notes !== 'string') {
      push(`${path}/notes`, 'INVALID_NOTES', 'notes must be a string when present');
    }

    if (typeof asset.id === 'string' && Number.isInteger(asset.version)) {
      const key = `${asset.id}@${asset.version}`;
      if (seen.has(key)) {
        push(
          path,
          'DUPLICATE_ID_VERSION',
          `duplicate id@version "${key}" (first declared at /assets/${seen.get(key)})`,
        );
      } else {
        seen.set(key, index);
      }
    }
  });

  return { ok: errors.length === 0, errors };
}

export function resolveAsset(lib, ref) {
  const parsed = parseRef(ref);
  if (!parsed || !lib || !Array.isArray(lib.assets)) return null;
  for (const asset of lib.assets) {
    if (
      asset &&
      typeof asset === 'object' &&
      asset.id === parsed.id &&
      asset.version === parsed.version
    ) {
      return asset;
    }
  }
  return null;
}

export function resolveAssets(lib, refs) {
  const list = Array.isArray(refs) ? refs : [];
  const resolved = [];
  const unknown = [];
  for (const ref of list) {
    const asset = resolveAsset(lib, ref);
    if (asset) resolved.push(asset);
    else unknown.push(ref);
  }
  return { resolved, unknown };
}

export function hashFile(path, options = {}) {
  const fs = options.fs ?? nodeFs;
  if (typeof path !== 'string' || !path) {
    throw new TypeError('hashFile: path must be a non-empty string');
  }
  if (!fs || typeof fs.readFileSync !== 'function') {
    throw new TypeError('hashFile: options.fs must provide readFileSync');
  }
  return createHash('sha256').update(fs.readFileSync(path)).digest('hex');
}

export function verifyAssetFiles(lib, options = {}) {
  const fs = options.fs ?? nodeFs;
  const root = options.root ?? '.';
  const findings = [];
  const assets = Array.isArray(lib?.assets) ? lib.assets : [];

  assets.forEach((asset, index) => {
    const base = {
      path: `/assets/${index}`,
      id: asset && typeof asset.id === 'string' ? asset.id : null,
      version: asset && Number.isInteger(asset.version) ? asset.version : null,
      file: asset && typeof asset.file === 'string' ? asset.file : null,
      expected: asset && typeof asset.sha256 === 'string' ? asset.sha256 : null,
    };
    if (!asset || typeof asset !== 'object') {
      findings.push({ ...base, code: 'UNVERIFIABLE', actual: null });
      return;
    }
    if (!isRelativePath(asset.file) || !SHA256_PATTERN.test(asset.sha256 ?? '')) {
      findings.push({ ...base, code: 'UNVERIFIABLE', actual: null });
      return;
    }

    let actual;
    try {
      actual = hashFile(join(root, asset.file), { fs });
    } catch {
      findings.push({ ...base, code: 'FILE_MISSING', actual: null });
      return;
    }
    if (actual !== asset.sha256) {
      findings.push({ ...base, code: 'HASH_MISMATCH', actual });
    }
  });

  return { ok: findings.length === 0, findings };
}
