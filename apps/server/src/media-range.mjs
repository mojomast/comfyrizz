/**
 * Authenticated byte-range media.
 *
 * Native <audio>/<video> cannot set the API header, so an authenticated POST
 * mints a short-lived ticket scoped to one file. The ticket URL does not carry
 * the API token and is never written into an export.
 */
import { randomBytes } from 'node:crypto';
import { existsSync, statSync } from 'node:fs';
import { relative, resolve, sep } from 'node:path';
import { serveStaticFile } from './static-file.mjs';

const TICKET_TTL_MS = 10 * 60 * 1000;

export function createMediaTickets() {
  const tickets = new Map();
  return {
    mint(file) {
      const ticket = randomBytes(16).toString('hex');
      const expires = Date.now() + TICKET_TTL_MS;
      tickets.set(ticket, { file, expires });
      return { ticket, expiresAt: new Date(expires).toISOString(), url: `/api/media/${ticket}` };
    },
    resolve(ticket) {
      const row = tickets.get(ticket);
      if (!row || row.expires < Date.now()) return null;
      return row.file;
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
