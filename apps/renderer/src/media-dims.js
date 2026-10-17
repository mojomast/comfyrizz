/**
 * Real media dimensions (A8).
 *
 * GPU test 3 showed a package's declared media size can be wrong: reference-edit
 * stills were sized to the package format (N4) and a 960x544 plate came back
 * 960x512 (N9). This module probes the actual file (PNG/JPEG/GIF header for
 * stills, ffprobe for video) so the render path can size panels from the real
 * aspect ratio, fit media with object-fit cover centred so nothing stretches,
 * and log a warning when the manifest disagrees with the file.
 *
 * Pure JS + JSDoc so Node 20 can run it in tests. No network.
 */
import { existsSync, openSync, readSync, closeSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { extname, join } from 'node:path';

/** 16:9, the format the renderer falls back to when no size is known. */
export const DEFAULT_ASPECT = 16 / 9;

/** @typedef {{ width: number, height: number }} Size */

/** PNG IHDR width/height (big-endian) at byte offsets 16 and 20. @param {Buffer} buffer @returns {Size | null} */
export function parsePngSize(buffer) {
  if (buffer.length < 24) return null;
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  for (let i = 0; i < signature.length; i += 1) if (buffer[i] !== signature[i]) return null;
  if (buffer.toString('ascii', 12, 16) !== 'IHDR') return null;
  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);
  return width > 0 && height > 0 ? { width, height } : null;
}

/** JPEG SOFn height/width. @param {Buffer} buffer @returns {Size | null} */
export function parseJpegSize(buffer) {
  if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) return null;
  let offset = 2;
  while (offset + 9 < buffer.length) {
    if (buffer[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = buffer[offset + 1];
    // Standalone markers carry no length.
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }
    const length = buffer.readUInt16BE(offset + 2);
    const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) {
      const height = buffer.readUInt16BE(offset + 5);
      const width = buffer.readUInt16BE(offset + 7);
      return width > 0 && height > 0 ? { width, height } : null;
    }
    offset += 2 + length;
  }
  return null;
}

/** GIF logical screen descriptor (little-endian) at byte offsets 6 and 8. @param {Buffer} buffer @returns {Size | null} */
export function parseGifSize(buffer) {
  if (buffer.length < 10) return null;
  const header = buffer.toString('ascii', 0, 6);
  if (header !== 'GIF87a' && header !== 'GIF89a') return null;
  const width = buffer.readUInt16LE(6);
  const height = buffer.readUInt16LE(8);
  return width > 0 && height > 0 ? { width, height } : null;
}

/**
 * Read width/height from an in-memory raster header.
 * @param {Buffer} buffer
 * @returns {Size | null}
 */
export function imageSizeFromBytes(buffer) {
  if (!buffer || buffer.length === 0) return null;
  return parsePngSize(buffer) ?? parseJpegSize(buffer) ?? parseGifSize(buffer);
}

const VIDEO_EXTENSIONS = new Set(['.mp4', '.mov', '.mkv', '.webm', '.m4v', '.avi']);

/**
 * Probe one file's real pixel size. Stills are read from the header; video goes
 * through ffprobe. Returns null when the file is absent or unreadable, so the
 * caller falls back to the declared size (a clean clone has no media at all).
 * @param {string} file absolute path
 * @returns {Size | null}
 */
export function probeMediaFile(file) {
  if (!existsSync(file)) return null;
  const extension = extname(file).toLowerCase();
  if (!VIDEO_EXTENSIONS.has(extension)) {
    const header = Buffer.alloc(65536);
    let fd;
    try {
      fd = openSync(file, 'r');
      const bytes = readSync(fd, header, 0, header.length, 0);
      const size = imageSizeFromBytes(header.subarray(0, bytes));
      if (size) return size;
    } catch {
      // fall through to ffprobe
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }
  const probe = spawnSync(
    'ffprobe',
    ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'json', file],
    { encoding: 'utf8', maxBuffer: 1024 * 1024 },
  );
  if (probe.status !== 0) return null;
  try {
    const stream = JSON.parse(probe.stdout).streams?.[0];
    const width = Number(stream?.width);
    const height = Number(stream?.height);
    return width > 0 && height > 0 ? { width, height } : null;
  } catch {
    return null;
  }
}

/**
 * Real size of every image/video the package declares and this clone has.
 * Keyed by the package-relative file path so the renderer can look it up.
 * @param {any} pkg
 * @param {string} packageDir
 * @param {(file: string) => (Size | null)} [probe]
 * @returns {Record<string, Size>}
 */
export function collectMediaDims(pkg, packageDir, probe = probeMediaFile) {
  /** @type {Record<string, Size>} */
  const dims = {};
  for (const asset of Object.values(pkg?.assets ?? {})) {
    if (asset?.kind !== 'image' && asset?.kind !== 'video') continue;
    if (typeof asset.file !== 'string' || asset.file.length === 0) continue;
    if (dims[asset.file]) continue;
    const size = probe(join(packageDir, asset.file));
    if (size) dims[asset.file] = size;
  }
  return dims;
}

/**
 * The size the manifest claims, preferring the SVG render-check raster then the
 * media metadata. Returns null when it declares nothing.
 * @param {any} asset
 * @returns {Size | null}
 */
export function declaredDims(asset) {
  const renderCheck = asset?.gen?.render_check;
  if (renderCheck?.width && renderCheck?.height) return { width: renderCheck.width, height: renderCheck.height };
  const media = asset?.media;
  if (media?.width && media?.height) return { width: media.width, height: media.height };
  return null;
}

/**
 * Assets whose manifest size disagrees with the probed file. One entry per
 * asset, ready to log.
 * @param {any} pkg
 * @param {Record<string, Size>} dims
 * @returns {{ id: string, file: string, declared: Size, real: Size }[]}
 */
export function dimMismatches(pkg, dims) {
  const mismatches = [];
  for (const [id, asset] of Object.entries(pkg?.assets ?? {})) {
    if (asset?.kind !== 'image' && asset?.kind !== 'video') continue;
    const real = typeof asset?.file === 'string' ? dims[asset.file] : undefined;
    const declared = declaredDims(asset);
    if (!real || !declared) continue;
    if (declared.width !== real.width || declared.height !== real.height) {
      mismatches.push({ id, file: asset.file, declared, real });
    }
  }
  return mismatches;
}

/**
 * Geometry for fitting `srcW x srcH` into `dstW x dstH` without stretching.
 * `cover` fills the box and crops the overflow (centred); `contain` letterboxes
 * to show the whole frame. `scale` is uniform, so width/srcW always equals
 * height/srcH — that is the no-stretch invariant A8 asserts.
 * @param {number} srcW
 * @param {number} srcH
 * @param {number} dstW
 * @param {number} dstH
 * @param {'cover' | 'contain'} [mode]
 * @returns {{ mode: 'cover' | 'contain', scale: number, width: number, height: number, offsetX: number, offsetY: number }}
 */
export function fitRect(srcW, srcH, dstW, dstH, mode = 'cover') {
  const safeSrcW = srcW > 0 ? srcW : dstW;
  const safeSrcH = srcH > 0 ? srcH : dstH;
  const scale = mode === 'contain' ? Math.min(dstW / safeSrcW, dstH / safeSrcH) : Math.max(dstW / safeSrcW, dstH / safeSrcH);
  const width = safeSrcW * scale;
  const height = safeSrcH * scale;
  return { mode, scale, width, height, offsetX: (dstW - width) / 2, offsetY: (dstH - height) / 2 };
}

/**
 * Aspect ratio (width / height) using the probed size first, then the manifest.
 * @param {any} asset
 * @param {Record<string, Size>} [dims]
 * @returns {number}
 */
export function aspectFor(asset, dims) {
  const real = typeof asset?.file === 'string' ? dims?.[asset.file] : undefined;
  if (real?.width && real?.height) return real.width / real.height;
  const declared = declaredDims(asset);
  if (declared) return declared.width / declared.height;
  return DEFAULT_ASPECT;
}
