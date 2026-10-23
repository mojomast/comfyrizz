// UR60: list videos for Home. Reads the package directory only; it does not
// open a renderer or a Google Colab session.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const DEFAULT_LIMIT = 50;
const FILE_PATTERN = /^[A-Za-z0-9_.-]+\.json$/;

function sendJson(response, status, value) {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  response.end(body);
}

function gcd(a, b) {
  let x = Math.abs(a);
  let y = Math.abs(b);
  while (y) {
    const next = x % y;
    x = y;
    y = next;
  }
  return x || 1;
}

function durationSeconds(pkg) {
  const frames = pkg?.duration?.targetFrames;
  const fps = pkg?.format?.fps;
  if (!Number.isFinite(frames) || !Number.isFinite(fps) || fps <= 0) return null;
  return frames / fps;
}

function aspectRatio(pkg) {
  const width = pkg?.format?.width;
  const height = pkg?.format?.height;
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;
  const divisor = gcd(Math.round(width), Math.round(height));
  return `${Math.round(width) / divisor}:${Math.round(height) / divisor}`;
}

export function summarizePackage(pkg, updatedAt) {
  return {
    id: pkg.id,
    title: typeof pkg.title === 'string' ? pkg.title : '',
    durationS: durationSeconds(pkg),
    aspect: aspectRatio(pkg),
    updatedAt,
    thumbnail: null,
  };
}

/**
 * Newest package files first. Directories, non-JSON names, unreadable files
 * and JSON that is not a package for that file name are skipped.
 */
export function listPackages(dir, { fs = { readdirSync, readFileSync, statSync }, limit = DEFAULT_LIMIT } = {}) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
  const rows = [];
  for (const entry of entries) {
    if (typeof entry.isFile === 'function' ? !entry.isFile() : entry.isFile !== true) continue;
    if (!FILE_PATTERN.test(entry.name)) continue;
    const id = entry.name.slice(0, -'.json'.length);
    let pkg;
    let stat;
    try {
      pkg = JSON.parse(fs.readFileSync(join(dir, entry.name), 'utf8'));
      stat = fs.statSync(join(dir, entry.name));
    } catch {
      continue;
    }
    if (!pkg || typeof pkg !== 'object' || Array.isArray(pkg) || pkg.id !== id) continue;
    const mtimeMs = Number.isFinite(stat.mtimeMs) ? stat.mtimeMs : stat.mtime?.getTime?.() ?? 0;
    const updatedAt = stat.mtime instanceof Date ? stat.mtime.toISOString() : new Date(mtimeMs).toISOString();
    rows.push({ mtimeMs, summary: summarizePackage(pkg, updatedAt) });
  }
  rows.sort((a, b) => b.mtimeMs - a.mtimeMs || a.summary.id.localeCompare(b.summary.id));
  const cap = Number.isFinite(limit) && limit >= 0 ? limit : DEFAULT_LIMIT;
  return rows.slice(0, cap).map(row => row.summary);
}

export function createPackageRoutes({ packagesDir, fs, limit = DEFAULT_LIMIT } = {}) {
  return {
    async handle(request, response, url) {
      if (url.pathname !== '/api/packages') return false;
      if (request.method !== 'GET') {
        sendJson(response, 405, { error: 'method not allowed' });
        return true;
      }
      if (typeof packagesDir !== 'string' || packagesDir.length === 0) {
        sendJson(response, 500, { error: 'package store unavailable', code: 'PACKAGE_STORE_UNAVAILABLE' });
        return true;
      }
      try {
        sendJson(response, 200, listPackages(packagesDir, { fs, limit }));
      } catch {
        sendJson(response, 500, { error: 'could not list packages', code: 'PACKAGE_LIST_FAILED' });
      }
      return true;
    },
  };
}
