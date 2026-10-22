// IP02: a CPU media backend that implements the same runPackage contract as the
// Google Colab and BYO ComfyUI backends.
//
// It is deliberately local and deterministic: for each requested asset it copies the
// package's current raster/video file (or writes a deterministic PNG stand-in for a
// vector asset) into the run's output directory and records the result in a normal
// runner manifest. The server's take ingestion then lands that file as a new take, so
// Redo is testable without a GPU and without pretending a paid session exists.
//
// A genuinely missing backend still returns BACKEND_UNAVAILABLE (422); this backend is
// only used when a caller registers it.
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, extname, isAbsolute, relative, resolve, sep } from 'node:path';

import { deflateSync } from 'node:zlib';

import { applyManifestToPackage } from '../../jobs/src/apply.mjs';

const CONTROL_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const DEFAULT_DIMS = Object.freeze({ width: 640, height: 360 });
// The package schema's closed backend enum has no `cpu` value. A CPU run is local
// compute, so its provenance is written as the schema's local backend (BYO ComfyUI)
// while the run record itself keeps backendId `cpu`.
const LOCAL_BACKEND = 'byo-comfyui';

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function inside(root, target) {
  const rel = relative(resolve(root), resolve(target));
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function safeRelative(file) {
  if (typeof file !== 'string' || file === '' || CONTROL_RE.test(file)) return false;
  if (isAbsolute(file) || /^[A-Za-z]:[\\/]/.test(file)) return false;
  return !file.split(/[\\/]+/).some(part => part === '..');
}

function sha256File(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

function extensionFor(asset) {
  const declared = safeRelative(asset?.file) ? extname(asset.file).toLowerCase() : '';
  if (declared) return declared;
  if (asset?.kind === 'svg' || asset?.kind === 'vector-anim') return '.svg';
  if (asset?.kind === 'audio') return '.wav';
  if (asset?.kind === 'video' || Number.isFinite(asset?.media?.fps)) return '.mp4';
  return '.png';
}

function isVector(asset) {
  return asset?.kind === 'svg' || asset?.kind === 'vector-anim'
    || (safeRelative(asset?.file) && extname(asset.file).toLowerCase() === '.svg');
}

function outputFor(assetId, asset) {
  const file = safeRelative(asset?.file)
    ? asset.file
    : `assets/${assetId}${extensionFor(asset)}`;
  if (isVector(asset)) return file.replace(/\.svg$/i, '.png');
  return file;
}

function jobKind(asset) {
  if (asset?.kind === 'svg' || asset?.kind === 'vector-anim' || asset?.kind === 'audio') return asset.kind;
  if (asset?.kind === 'video' || Number.isFinite(asset?.media?.fps)) return 'plate';
  return 'still';
}

function sourceFor(asset, roots) {
  if (!safeRelative(asset?.file)) return null;
  for (const root of roots) {
    if (typeof root !== 'string' || root === '') continue;
    const candidate = resolve(root, asset.file);
    if (!inside(root, candidate)) continue;
    try {
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      /* try the next root */
    }
  }
  return null;
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const head = Buffer.alloc(4);
  head.writeUInt32BE(data.length, 0);
  const name = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([name, data])), 0);
  return Buffer.concat([head, name, data, crc]);
}

// A deterministic PNG stand-in for a vector asset: take files must be raster or
// video, so a CPU run cannot hand the store an .svg. The seed changes the accent
// colour, which keeps successive Redos distinguishable without a GPU or network.
function pngStandIn(assetId, seed, width, height) {
  const w = Number.isInteger(width) && width > 0 && width <= 4096 ? width : DEFAULT_DIMS.width;
  const h = Number.isInteger(height) && height > 0 && height <= 4096 ? height : DEFAULT_DIMS.height;
  const value = Number.isSafeInteger(seed) ? seed >>> 0 : createHash('sha256').update(String(assetId)).digest().readUInt32BE(0);
  const accent = [64 + (value & 0x7f), 64 + ((value >>> 8) & 0x7f), 64 + ((value >>> 16) & 0x7f), 255];
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y += 1) {
    const row = y * (w * 4 + 1);
    raw[row] = 0;
    for (let x = 0; x < w; x += 1) {
      const offset = row + 1 + x * 4;
      const band = y > h / 3 && y < (h * 2) / 3 && x > w / 4 && x < (w * 3) / 4;
      const colour = band ? accent : [0x10, 0x16, 0x22, 255];
      raw[offset] = colour[0];
      raw[offset + 1] = colour[1];
      raw[offset + 2] = colour[2];
      raw[offset + 3] = colour[3];
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    PNG_SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function plannedJob(assetId, asset) {
  const media = isObject(asset?.media) ? asset.media : {};
  const kind = jobKind(asset);
  const gen = isObject(asset?.gen) ? asset.gen : {};
  const inputs = isObject(gen.inputs) ? clone(gen.inputs) : undefined;
  const dims = {
    ...(Number.isInteger(media.width) ? { width: media.width } : {}),
    ...(Number.isInteger(media.height) ? { height: media.height } : {}),
  };
  return {
    id: `${assetId}.cpu`,
    asset: assetId,
    kind,
    generator: gen.generator,
    backend: LOCAL_BACKEND,
    output: outputFor(assetId, asset),
    ...(typeof gen.workflow === 'string' && gen.workflow ? { workflow: gen.workflow } : {}),
    ...(typeof gen.workflow_sha256 === 'string' && gen.workflow_sha256 ? { workflowSha256: gen.workflow_sha256 } : {}),
    ...(typeof gen.model === 'string' && gen.model ? { model: gen.model } : {}),
    ...(inputs ? { inputs } : {}),
    ...(Number.isFinite(media.fps) ? { fps: media.fps } : {}),
    ...(Number.isInteger(media.frames) ? { frames: media.frames } : {}),
    ...(Object.keys(dims).length ? { dims } : {}),
  };
}

function selectedAssetIds(pkg, assets) {
  if (Array.isArray(assets) && assets.length > 0) {
    return assets.filter(id => typeof id === 'string' && isObject(pkg?.assets?.[id]));
  }
  return Object.entries(pkg?.assets ?? {})
    .filter(([, asset]) => isObject(asset) && isObject(asset.gen) && typeof asset.gen.generator === 'string')
    .map(([id]) => id);
}

/**
 * @param {object} [options]
 * @param {string} [options.workDir]  where the server stages package.json and its files
 * @param {string} [options.outDir]   the run's output directory
 * @param {string} [options.packageDir] the stored package directory (fallback source root)
 */
export function createCpuBackend(options = {}) {
  const fixed = isObject(options) ? options : {};
  const id = 'cpu';

  async function describe() {
    return { label: 'local CPU media runner', costVisibility: 'local' };
  }

  async function estimate() {
    return { gpuMinutes: 0, overheadMinutes: 0, ratePerHour: 0 };
  }

  async function runPackage(pkg, opts = {}) {
    if (!isObject(pkg) || !isObject(pkg.assets)) throw new TypeError('createCpuBackend.runPackage needs a package');
    const workDir = opts.workDir ?? fixed.workDir ?? null;
    const outDir = opts.outDir ?? fixed.outDir ?? null;
    const packageDir = opts.packageDir ?? fixed.packageDir ?? null;
    const roots = [workDir, packageDir, outDir].filter(root => typeof root === 'string' && root !== '');
    const ids = selectedAssetIds(pkg, opts.assets);
    const jobsDoc = { v: 1, jobs: ids.map(assetId => plannedJob(assetId, pkg.assets[assetId])) };
    const estimateValue = await estimate(jobsDoc.jobs);

    if (opts.dryRun) {
      return { jobsDoc, estimate: estimateValue, dryRun: true, teardown: null };
    }
    if (typeof outDir !== 'string' || outDir === '') throw new Error('createCpuBackend needs an output directory');
    if (opts.signal?.aborted) {
      const error = new Error('the CPU run was cancelled');
      error.name = 'AbortError';
      throw error;
    }

    mkdirSync(outDir, { recursive: true });
    const manifestJobs = [];
    let succeeded = 0;
    let failed = 0;

    for (const job of jobsDoc.jobs) {
      const asset = pkg.assets[job.asset];
      const target = resolve(outDir, job.output);
      if (!inside(outDir, target)) {
        failed += 1;
        manifestJobs.push({ job: job.id, status: 'failed', reason: 'the output path escapes the run directory' });
        continue;
      }
      try {
        mkdirSync(dirname(target), { recursive: true });
        const source = sourceFor(asset, roots);
        if (isVector(asset)) {
          // Take files must be raster or video, so a vector asset becomes a
          // deterministic PNG at the asset's own size (or 640x360).
          const seed = Number.isSafeInteger(job.inputs?.seed)
            ? job.inputs.seed
            : (Number.isSafeInteger(asset?.gen?.seed) ? asset.gen.seed : undefined);
          writeFileSync(target, pngStandIn(job.asset, seed, asset?.media?.width, asset?.media?.height));
        } else if (source) {
          copyFileSync(source, target);
        } else {
          throw new Error(`no staged source file for ${job.asset}; the CPU backend can only copy existing media or stand in for vector assets`);
        }
        const bytes = statSync(target).size;
        const sha256 = sha256File(target);
        const media = isObject(asset?.media) ? asset.media : {};
        const measured = {
          ...(Number.isInteger(media.width) ? { width: media.width } : {}),
          ...(Number.isInteger(media.height) ? { height: media.height } : {}),
          ...(Number.isFinite(media.fps) ? { fps: media.fps } : {}),
          ...(Number.isInteger(media.frames) ? { frames: media.frames } : {}),
          ...(Number.isFinite(media.durationSeconds) ? { durationSeconds: media.durationSeconds } : {}),
        };
        succeeded += 1;
        manifestJobs.push({
          job: job.id,
          status: 'succeeded',
          job_id: `cpu_${job.asset}`,
          attempt_id: `cpu_${job.asset}_1`,
          outputs: [{
            relative: job.output,
            sha256,
            bytes,
            ...(Object.keys(measured).length ? { measured } : {}),
          }],
        });
      } catch (error) {
        failed += 1;
        manifestJobs.push({
          job: job.id,
          status: 'failed',
          reason: String(error?.message ?? error).slice(0, 2000),
        });
      }
    }

    const manifest = {
      v: 1,
      complete: failed === 0,
      counts: { succeeded, failed },
      updatedAt: new Date().toISOString(),
      jobs: manifestJobs,
    };
    const appliedResult = applyManifestToPackage(pkg, {
      manifest,
      jobsDoc,
      outDir,
      backend: null,
    });
    return {
      jobsDoc,
      estimate: estimateValue,
      manifest,
      counts: manifest.counts,
      ok: manifest.complete,
      package: appliedResult.package,
      applied: appliedResult.applied,
      candidates: appliedResult.candidates,
      untouched: appliedResult.untouched,
      teardown: { state: 'stopped', evidence: 'local CPU work finished; no remote session existed' },
    };
  }

  return Object.freeze({
    id,
    describe,
    estimate,
    runPackage,
  });
}

export default createCpuBackend;
