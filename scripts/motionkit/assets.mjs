import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ASSETS_PATH = join(__dirname, 'data', 'assets.json');

const ALLOWED_LICENSES = new Set(['MIT', 'ISC', 'CC0-1.0', 'OFL-1.1']);

function loadAssets() {
  return JSON.parse(readFileSync(ASSETS_PATH, 'utf8'));
}

function validateManifest() {
  const assets = loadAssets();
  const errors = [];

  for (const category of ['fonts', 'icons', 'sfx', 'textures', 'shaders']) {
    const items = assets[category];
    if (!Array.isArray(items)) {
      errors.push(`${category}: expected array, got ${typeof items}`);
      continue;
    }

    for (const item of items) {
      // Validate required fields
      if (typeof item.id !== 'string') {
        errors.push(`${category}/${item.id || '?'}: missing or invalid id`);
      }
      if (typeof item.kind !== 'string') {
        errors.push(`${category}/${item.id}: missing or invalid kind`);
      }
      if (typeof item.name !== 'string') {
        errors.push(`${category}/${item.id}: missing or invalid name`);
      }

      // Validate license is in allowlist
      if (item.license) {
        if (!ALLOWED_LICENSES.has(item.license)) {
          errors.push(`${category}/${item.id}: disallowed license ${item.license}`);
        }
      } else {
        errors.push(`${category}/${item.id}: missing license`);
      }

      // Validate licenseUrl is https only (no http://)
      if (item.licenseUrl) {
        if (item.licenseUrl.startsWith('http://')) {
          errors.push(`${category}/${item.id}: licenseUrl must not use http://`);
        }
        // Must be a valid URL
        try {
          new URL(item.licenseUrl);
        } catch {
          errors.push(`${category}/${item.id}: licenseUrl is not a valid URL: ${item.licenseUrl}`);
        }
      }

      // Validate source is https only (no http://)
      if (item.source) {
        if (item.source.startsWith('http://')) {
          errors.push(`${category}/${item.id}: source must not use http://`);
        }
        try {
          new URL(item.source);
        } catch {
          errors.push(`${category}/${item.id}: source is not a valid URL: ${item.source}`);
        }
      }

      // Validate vendor strategy
      if (item.vendor !== 'vendored' && item.vendor !== 'fetch-on-demand') {
        errors.push(`${category}/${item.id}: invalid vendor strategy ${item.vendor}`);
      }

      // Vendored items must have sha256 or be marked pending
      if (item.vendor === 'vendored') {
        if (item.sha256 === null || typeof item.sha256 === 'string') {
          // valid: null or hex string
        } else {
          errors.push(`${category}/${item.id}: vendored item must have sha256 (null or hex)`);
        }
      }

      // Fetch-on-demand items should not have sha256 (or have null)
      if (item.vendor === 'fetch-on-demand') {
        if (item.sha256 !== null && typeof item.sha256 !== 'undefined') {
          errors.push(`${category}/${item.id}: fetch-on-demand items should not have sha256`);
        }
      }

      // Validate files array
      if (!Array.isArray(item.files)) {
        errors.push(`${category}/${item.id}: files must be an array`);
      } else if (item.files.length === 0) {
        errors.push(`${category}/${item.id}: files array must not be empty`);
      }

      // Validate id is kebab-case (lowercase, hyphen-separated)
      if (item.id && !/^[a-z][a-z0-9-]*$/.test(item.id)) {
        errors.push(`${category}/${item.id}: id must be kebab-case`);
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

function listLicenses() {
  const assets = loadAssets();
  const groups = {};

  for (const category of ['fonts', 'icons', 'sfx', 'textures', 'shaders']) {
    const items = assets[category];
    if (!Array.isArray(items)) continue;

    for (const item of items) {
      const license = item.license || 'unknown';
      if (!groups[license]) {
        groups[license] = [];
      }
      groups[license].push({
        id: item.id,
        name: item.name,
        kind: item.kind,
        vendor: item.vendor,
      });
    }
  }

  return groups;
}

export { validateManifest, listLicenses };

// Allow running standalone for verification
if (import.meta.filename === process.argv[1]) {
  const v = validateManifest();
  console.log('validateManifest:', v.valid ? 'PASS' : 'FAIL');
  if (v.errors.length > 0) {
    console.log('Errors:');
    v.errors.forEach((e) => console.log(' -', e));
  }
  const licenses = listLicenses();
  console.log('\nLicenses groups:');
  for (const [license, items] of Object.entries(licenses)) {
    console.log(`  ${license}: ${items.map((i) => i.id).join(', ')}`);
  }
}