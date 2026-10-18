/**
 * B1: server-side brand-kit handling.
 *
 * The browser posts a loose kit (palette hexes, fonts with a licence, tone
 * words and an optional base64 logo). This module normalises it through the
 * agent's `normalizeBrandKit`, writes an uploaded logo next to the runtime
 * package assets, and returns the theme fragment to store plus the asset that
 * `theme.logo_asset` points at. No model, no network.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { applyBrandKit, brandTheme, normalizeBrandKit } from '../../../packages/agent/dist/src/index.js';

const LOGO_EXTENSIONS = { svg: 'svg', png: 'image', jpg: 'image', jpeg: 'image' };

function logoAssetId(filename, bytes) {
  const digest = createHash('sha256').update(filename).update(bytes).digest('hex').slice(0, 12);
  return `a_logo_${digest}`;
}

/**
 * Normalise a brand payload into a kit + theme + uploaded logo asset.
 * @param {any} input
 * @param {{ assetsDir?: string }} [options]
 */
export function prepareBrand(input, { assetsDir } = {}) {
  const raw = input && typeof input === 'object' ? { ...input } : {};
  const warnings = [];
  const assets = {};
  let logoId;

  const logo = raw.logo;
  if (logo && typeof logo === 'object' && typeof logo.dataBase64 === 'string' && logo.dataBase64) {
    const filename = typeof logo.filename === 'string' ? logo.filename : '';
    const extension = filename.includes('.') ? filename.split('.').pop().toLowerCase() : '';
    const kind = LOGO_EXTENSIONS[extension];
    if (!kind) {
      warnings.push({ code: 'BRAND_LOGO_INVALID', field: 'logo.filename', message: 'logo must be an SVG or PNG file' });
    } else {
      const bytes = Buffer.from(logo.dataBase64, 'base64');
      const id = logoAssetId(filename, bytes);
      assets[id] = {
        kind,
        origin: 'upload',
        status: 'ready',
        file: `assets/${id}.${extension}`,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        bytes: bytes.length,
        license: { id: 'user-provided', approved_by_user: true },
      };
      if (assetsDir) {
        mkdirSync(assetsDir, { recursive: true });
        writeFileSync(join(assetsDir, `${id}.${extension}`), bytes);
      }
      logoId = id;
    }
  } else if (typeof logo?.assetId === 'string' && logo.assetId) {
    logoId = logo.assetId;
  } else if (typeof raw.logo_asset === 'string' && raw.logo_asset) {
    logoId = raw.logo_asset;
  }

  delete raw.logo;
  const { kit, warnings: kitWarnings } = normalizeBrandKit({ ...raw, ...(logoId ? { logo_asset: logoId } : {}) });
  return { kit, theme: brandTheme(kit), assets, warnings: [...warnings, ...kitWarnings] };
}

/** Merge a prepared brand into a saved package (theme + uploaded logo assets). */
export function mergeBrandIntoPackage(pkg, brand) {
  if (!brand) return pkg;
  const withAssets = Object.keys(brand.assets ?? {}).length > 0
    ? { ...pkg, assets: { ...(pkg.assets ?? {}), ...brand.assets } }
    : pkg;
  return applyBrandKit(withAssets, brand.kit ?? {});
}
