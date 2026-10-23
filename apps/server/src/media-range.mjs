/**
 * Authenticated byte-range media.
 *
 * Native <audio>/<video> cannot set the API header, so an authenticated POST
 * mints a short-lived ticket scoped to one file. The ticket URL does not carry
 * the API token and is never written into an export.
 *
 * A ticket is a bearer credential and stays in memory only. What survives a
 * restart is the artifact/media identity: when the authenticated client asks
 * again by artifact id, `remintForArtifact` mints a fresh ticket for the same
 * file. Expired tickets are refused and are never a way to renew access.
 */
import { createHash, randomBytes } from 'node:crypto';
import {
  chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { serveStaticFile } from './static-file.mjs';

const TICKET_TTL_MS = 10 * 60 * 1000;
const MEDIA_ID_RE = /^med_[a-f0-9]{32}$/;

/**
 * Stable opaque media id for an artifact id (or a file when no artifact
 * identity exists yet). The id is the only thing a caller needs to remember
 * across a restart, and it carries no path or token.
 */
export function mediaIdFor(identity) {
  if (typeof identity !== 'string' || identity.length === 0) {
    throw new TypeError('mediaIdFor requires a non-empty string');
  }
  const digest = createHash('sha256').update(identity, 'utf8').digest('hex');
  return `med_${digest.slice(0, 32)}`;
}

export function createMediaTickets(options = {}) {
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    throw new TypeError('createMediaTickets options must be an object');
  }
  const ttlMs = options.ttlMs === undefined ? TICKET_TTL_MS : options.ttlMs;
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) throw new TypeError('ttlMs must be a positive finite number');
  const now = options.now === undefined ? Date.now : options.now;
  if (typeof now !== 'function') throw new TypeError('now must be a function');
  const stateFile = options.stateFile === undefined ? null : options.stateFile;
  if (stateFile !== null && (typeof stateFile !== 'string' || stateFile.length === 0)) {
    throw new TypeError('stateFile must be a non-empty string');
  }
  const statePath = stateFile === null ? null : resolve(stateFile);

  const tickets = new Map();
  const index = new Map();
  const byArtifact = new Map();

  if (statePath !== null) loadIndex();

  function loadIndex() {
    if (!existsSync(statePath)) return;
    let document;
    try {
      document = JSON.parse(readFileSync(statePath, 'utf8'));
    } catch (error) {
      if (error instanceof SyntaxError) return;
      throw error;
    }
    const rows = Array.isArray(document) ? document : Array.isArray(document?.media) ? document.media : [];
    for (const row of rows) {
      if (!row || typeof row !== 'object') continue;
      if (typeof row.mediaId !== 'string' || !MEDIA_ID_RE.test(row.mediaId)) continue;
      if (typeof row.file !== 'string' || row.file.length === 0) continue;
      const artifactId = typeof row.artifactId === 'string' && row.artifactId.length > 0 ? row.artifactId : null;
      index.set(row.mediaId, { mediaId: row.mediaId, artifactId, file: row.file });
      if (artifactId !== null) byArtifact.set(artifactId, row.mediaId);
    }
  }

  function writeIndex() {
    if (statePath === null) return;
    const rows = [...index.values()].map(row => ({
      mediaId: row.mediaId,
      artifactId: row.artifactId,
      file: row.file,
    }));
    const body = `${JSON.stringify({ version: 1, media: rows }, null, 2)}\n`;
    const directory = dirname(statePath);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const temporary = join(directory, `.${basename(statePath)}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
    writeFileSync(temporary, body, { mode: 0o600 });
    try { chmodSync(temporary, 0o600); } catch { /* mode is best effort */ }
    try {
      renameSync(temporary, statePath);
    } catch (error) {
      try { unlinkSync(temporary); } catch { /* best effort */ }
      throw error;
    }
    try { chmodSync(statePath, 0o600); } catch { /* not every filesystem supports it */ }
  }

  function remember(mediaId, artifactId, file) {
    const current = index.get(mediaId);
    if (current && current.artifactId === artifactId && current.file === file) return;
    index.set(mediaId, { mediaId, artifactId, file });
    if (artifactId !== null) byArtifact.set(artifactId, mediaId);
    writeIndex();
  }

  function pruneExpired(at) {
    for (const [token, row] of tickets) {
      if (row.expires <= at) tickets.delete(token);
    }
  }

  function issue(row) {
    const at = now();
    pruneExpired(at);
    const ticket = randomBytes(16).toString('hex');
    const expires = at + ttlMs;
    tickets.set(ticket, { file: row.file, mediaId: row.mediaId, artifactId: row.artifactId, expires });
    return {
      ticket,
      expiresAt: new Date(expires).toISOString(),
      url: `/api/media/${ticket}`,
      mediaId: row.mediaId,
      artifactId: row.artifactId,
    };
  }

  return {
    mint(file, options = {}) {
      if (typeof file !== 'string' || file.length === 0) throw new TypeError('mint requires a file path');
      if (options === null || typeof options !== 'object' || Array.isArray(options)) {
        throw new TypeError('mint options must be an object');
      }
      const { artifactId } = options;
      if (artifactId !== undefined && artifactId !== null
        && (typeof artifactId !== 'string' || artifactId.length === 0)) {
        throw new TypeError('artifactId must be a non-empty string');
      }
      const artifact = artifactId ?? null;
      const mediaId = mediaIdFor(artifact ?? file);
      remember(mediaId, artifact, file);
      return issue({ mediaId, artifactId: artifact, file });
    },

    resolve(ticket) {
      if (typeof ticket !== 'string') return null;
      pruneExpired(now());
      return tickets.get(ticket)?.file ?? null;
    },

    inspect(ticket) {
      if (typeof ticket !== 'string') return { status: 'unknown' };
      const row = tickets.get(ticket);
      if (!row) return { status: 'unknown' };
      const expiresAt = new Date(row.expires).toISOString();
      if (row.expires <= now()) {
        tickets.delete(ticket);
        return { status: 'expired', mediaId: row.mediaId, artifactId: row.artifactId, expiresAt };
      }
      return {
        status: 'active',
        mediaId: row.mediaId,
        artifactId: row.artifactId,
        expiresAt,
        file: row.file,
      };
    },

    remintForArtifact(identity) {
      if (typeof identity !== 'string' || identity.length === 0) return null;
      const mediaId = byArtifact.get(identity) ?? (index.has(identity) ? identity : null);
      if (mediaId === null) return null;
      const row = index.get(mediaId);
      if (!row) return null;
      return issue(row);
    },

    close() {
      tickets.clear();
      index.clear();
      byArtifact.clear();
    },
  };
}

/** A relative path that stays inside `root`. */
export function safeMediaPath(root, relPath) {
  if (typeof relPath !== 'string' || relPath.length === 0 || relPath.length > 512) return null;
  if (relPath.startsWith('/') || relPath.includes('\\') || relPath.includes('\0')) return null;
  const parts = relPath.split('/');
  if (parts.some(part => part === '' || part === '.' || part === '..')) return null;
  const file = resolve(root, relPath);
  const rel = relative(resolve(root), file);
  if (rel.startsWith(`..${sep}`) || rel === '..') return null;
  return file;
}

const MIME = {
  '.wav': 'audio/wav',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
};

export function mediaContentType(file) {
  const dot = file.lastIndexOf('.');
  const ext = dot >= 0 ? file.slice(dot).toLowerCase() : '';
  return MIME[ext] ?? 'application/octet-stream';
}

export function serveTicket(request, response, file) {
  if (!file || !existsSync(file) || !statSync(file).isFile()) {
    response.writeHead(404, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    response.end(JSON.stringify({ error: 'media not found' }));
    return;
  }
  return serveStaticFile(request, response, file, {
    'content-type': mediaContentType(file),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
}
