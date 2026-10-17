import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { basename, extname } from 'node:path';
import type { PackageAssetLike, UploadOptions, UploadResult } from './types.js';

const MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
};

function sniff(bytes: Buffer, ext: string): string {
  if (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (bytes.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) return 'image/jpeg';
  if (bytes.subarray(0, 6).toString('ascii') === 'GIF87a' || bytes.subarray(0, 6).toString('ascii') === 'GIF89a') return 'image/gif';
  if (bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  if (bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WAVE') return 'audio/wav';
  if (bytes.subarray(4, 8).toString('ascii') === 'ftyp') return 'video/mp4';
  if (bytes.subarray(0, 4).toString('ascii') === 'OggS') return 'video/ogg';
  if (bytes.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))) return 'video/webm';
  return MIME_BY_EXT[ext.toLowerCase()] ?? 'application/octet-stream';
}

/**
 * Inspect a user upload and build asset metadata. The user must assert rights;
 * shareability is a separate opt-in and controls package.zip. No absolute path
 * enters the package: the stored file is always under assets/.
 */
export async function inspectUpload(options: UploadOptions): Promise<UploadResult> {
  if (!options.rightsAsserted) throw new Error('upload rights must be asserted by the user');
  const info = await stat(options.filePath).catch(() => undefined);
  if (!info?.isFile()) throw new Error('upload is not a readable file');
  const maxBytes = options.maxBytes ?? 100 * 1024 * 1024;
  if (info.size > maxBytes) throw new Error(`upload exceeds ${maxBytes} bytes`);
  const bytes = await readFile(options.filePath);
  const ext = extname(options.filePath).toLowerCase();
  const mime = sniff(bytes, ext);
  if (mime === 'application/octet-stream') throw new Error(`unsupported upload type ${ext || '(no extension)'}`);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const assetId = options.assetId ?? `upload_${sha256.slice(0, 16)}`;
  const file = `assets/${assetId}${ext}`;
  const title = options.title?.trim() || basename(options.filePath);
  const creator = options.creator?.trim() || 'User upload';
  const license: NonNullable<PackageAssetLike['license']> = {
    id: 'User-Upload',
    attribution: `“${title}” by ${creator}, supplied by the user`,
    approved_by_user: true,
    ...(options.retrievedAt ? { approved_at: options.retrievedAt } : {}),
  };
  const asset: PackageAssetLike = {
    kind: mime.startsWith('video/') ? 'video' : mime.startsWith('audio/') ? 'audio' : 'image',
    origin: 'upload',
    status: 'ready',
    file,
    sha256,
    bytes: bytes.byteLength,
    source: {
      provider: 'upload',
      id: assetId,
      title,
      creator,
      original_file: basename(options.filePath),
      ...(options.retrievedAt ? { retrieved_at: options.retrievedAt } : {}),
    },
    license,
    redistributable: options.shareable,
    notes: options.shareable ? 'user marked this upload shareable' : 'user upload; not redistributable',
  };
  if (mime === 'image/svg+xml') {
    asset.kind = 'svg';
    asset.notes = `${asset.notes}; SVG upload must still pass A5 sanitize/render-check before render`;
  }
  return { asset, bytes: bytes.byteLength, sha256, mime, file };
}
