import { createHash } from 'node:crypto';
import { buildCredits } from './credits.js';
import { DEFAULT_LICENSE_POLICY, isAssetRedistributable } from './licenses.js';
import type { ExcludedAsset, PackageAssetLike, PackageZipInput, PackageZipResult, ZipEntry } from './types.js';

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (let index = 0; index < data.length; index += 1) crc = CRC_TABLE[(crc ^ data[index]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function toBytes(data: Uint8Array | Buffer | string): Buffer {
  if (typeof data === 'string') return Buffer.from(data, 'utf8');
  return Buffer.from(data);
}

function safePath(path: string): string {
  const normalized = path.replace(/\\/g, '/').replace(/^\/+/, '');
  const parts = normalized.split('/').filter(part => part && part !== '.');
  if (parts.length === 0 || parts.some(part => part === '..')) throw new Error(`unsafe zip path: ${path}`);
  return parts.join('/');
}

/** Deterministic store-only zip (no compression, fixed 1980-01-01 timestamp). */
export function createZip(entries: ZipEntry[]): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  const seen = new Set<string>();
  let offset = 0;
  for (const entry of entries) {
    const name = safePath(entry.path);
    if (seen.has(name)) throw new Error(`duplicate zip entry: ${name}`);
    seen.add(name);
    const nameBuf = Buffer.from(name, 'utf8');
    const data = toBytes(entry.data);
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0x0021, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    localParts.push(local, nameBuf, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0x0021, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, nameBuf);
    offset += local.length + nameBuf.length + data.length;
  }
  const centralSize = centralParts.reduce((total, part) => total + part.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(seen.size, 8);
  end.writeUInt16LE(seen.size, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...localParts, ...centralParts, end]);
}

function assetPath(assetId: string, asset: PackageAssetLike): string {
  const file = asset.file?.replace(/\\/g, '/');
  if (file?.startsWith('assets/') && !file.includes('..')) return file;
  const ext = asset.kind === 'video' ? 'mp4' : asset.kind === 'audio' ? 'wav' : 'bin';
  return `assets/${assetId}.${ext}`;
}

export function sha256Hex(data: Uint8Array | Buffer | string): string {
  return createHash('sha256').update(toBytes(data)).digest('hex');
}

/**
 * Build package.zip: project + timeline + workflows + credits + only assets
 * whose rights and approvals allow redistribution. Everything else is listed in
 * the manifest with its source URL and hash and the archive is marked incomplete.
 * No keys, signed URLs or model weights are written.
 */
export function buildPackageZip(input: PackageZipInput): PackageZipResult {
  const policy = input.licensePolicy ?? DEFAULT_LICENSE_POLICY;
  const generatedAt = input.generatedAt ?? new Date().toISOString();
  const entries: ZipEntry[] = [];
  const included: string[] = [];
  const excluded: ExcludedAsset[] = [];

  entries.push({ path: 'package.json', data: `${JSON.stringify(input.package, null, 2)}\n` });
  if (input.timeline !== undefined) entries.push({ path: 'timeline.json', data: `${JSON.stringify(input.timeline, null, 2)}\n` });
  for (const [name, data] of Object.entries(input.workflows ?? {})) {
    entries.push({ path: safePath(name.startsWith('workflows/') ? name : `workflows/${name}`), data });
  }

  for (const [assetId, asset] of Object.entries(input.package.assets ?? {})) {
    if (!isAssetRedistributable(asset, policy)) {
      excluded.push({
        assetId,
        ...(asset.file ? { file: asset.file } : {}),
        ...(asset.sha256 ? { sha256: asset.sha256 } : {}),
        ...(asset.license?.id ? { licenseId: asset.license.id } : {}),
        ...(asset.source?.landing_url ? { sourceUrl: asset.source.landing_url } : {}),
        reason: asset.license?.blocked_reason ?? asset.license?.blocked ? 'licence policy blocked this asset' : 'not marked redistributable under the v0.1 licence policy',
      });
      continue;
    }
    const bytes = input.assets?.[assetId];
    if (bytes === undefined) {
      excluded.push({ assetId, ...(asset.file ? { file: asset.file } : {}), ...(asset.sha256 ? { sha256: asset.sha256 } : {}), reason: 'asset bytes were not provided to the archive builder' });
      continue;
    }
    const buffer = toBytes(bytes);
    if (asset.sha256 && sha256Hex(buffer) !== asset.sha256) {
      excluded.push({ assetId, ...(asset.file ? { file: asset.file } : {}), sha256: asset.sha256, reason: 'sha256 mismatch; refusing to ship a different file' });
      continue;
    }
    entries.push({ path: assetPath(assetId, asset), data: buffer });
    included.push(assetId);
  }

  const credits = input.credits ?? buildCredits(input.package, { generatedAt, policy, excluded });
  entries.push({ path: 'credits.json', data: `${JSON.stringify({ ...credits, markdown: undefined }, null, 2)}\n` });
  entries.push({ path: 'CREDITS.md', data: credits.markdown });
  const complete = excluded.length === 0;
  const manifest = {
    version: 1,
    packageId: input.package.id ?? 'unknown',
    revision: input.package.revision ?? null,
    generatedAt,
    complete,
    included,
    excluded,
    note: 'Only assets marked redistributable under the v0.1 licence policy are included. Excluded assets are listed with source URL and hash; fetch them again before reproducing the edit. No keys, signed URLs or model weights.',
  };
  entries.push({ path: 'manifest.json', data: `${JSON.stringify(manifest, null, 2)}\n` });
  if (!complete) {
    entries.push({
      path: 'INCOMPLETE.md',
      data: `# Incomplete package\n\n${excluded.length} asset(s) are not redistributable and are not included. See manifest.json and CREDITS.md; fetch them yourself before reproducing this edit.\n`,
    });
  }
  const bytes = createZip(entries);
  return { bytes, complete, included, excluded, entries: entries.map(entry => safePath(entry.path)), manifest };
}
