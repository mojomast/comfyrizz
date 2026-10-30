// A conversation's explicitly authorized, user-supplied TrueType font.
// Font bytes are data: they are never sent to a model or executed as code.
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CHAT_ID_PATTERN } from './context-attachments.mjs';

export const MAX_FONT_BYTES = 5 * 1024 * 1024;

export function validateSuppliedTtf(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 12 || bytes.length > MAX_FONT_BYTES || bytes.readUInt32BE(0) !== 0x00010000) throw new Error('Expected a TrueType .ttf font, up to 5 MiB');
  const count = bytes.readUInt16BE(4);
  if (!count || count > 256 || 12 + count * 16 > bytes.length) throw new Error('Invalid TrueType table directory');
  const tables = new Set();
  for (let i = 0; i < count; i++) {
    const at = 12 + i * 16;
    const tag = bytes.toString('latin1', at, at + 4);
    const offset = bytes.readUInt32BE(at + 8);
    const length = bytes.readUInt32BE(at + 12);
    if (tables.has(tag) || offset < 12 + count * 16 || offset > bytes.length || length > bytes.length - offset) throw new Error('Invalid TrueType table bounds');
    tables.add(tag);
  }
  for (const tag of ['head', 'hhea', 'maxp', 'hmtx', 'cmap', 'loca', 'glyf', 'name']) {
    if (!tables.has(tag)) throw new Error(`Missing TrueType ${tag} table`);
  }
}

function filePath(runtimeDir, chatId) {
  if (!CHAT_ID_PATTERN.test(chatId)) throw new Error('Invalid conversation id');
  return join(runtimeDir, 'supplied-fonts', `${chatId}.json`);
}

export function saveSuppliedFont({ runtimeDir, chatId, filename, bytes, rightsAsserted }) {
  if (rightsAsserted !== true) throw new Error('Font usage rights must be asserted');
  if (typeof filename !== 'string' || !/\.ttf$/i.test(filename) || filename.length > 255) throw new Error('Only .ttf fonts are supported');
  validateSuppliedTtf(bytes);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const record = { filename: filename.replace(/.*[/\\]/, '').replace(/[\x00-\x1f\x7f]/g, ''), sha256, bytes: bytes.length, rightsAsserted: true, data: bytes.toString('base64') };
  const path = filePath(runtimeDir, chatId);
  mkdirSync(join(runtimeDir, 'supplied-fonts'), { recursive: true, mode: 0o700 });
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temp, JSON.stringify(record), { mode: 0o600 });
  renameSync(temp, path);
  return publicRecord(record);
}

function publicRecord(record) {
  return { filename: record.filename, sha256: record.sha256, bytes: record.bytes, rightsAsserted: true };
}

function load(runtimeDir, chatId) {
  let record;
  try { record = JSON.parse(readFileSync(filePath(runtimeDir, chatId), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  if (record.rightsAsserted !== true || !/^[0-9a-f]{64}$/.test(record.sha256) || typeof record.data !== 'string' || record.data.length > Math.ceil(MAX_FONT_BYTES / 3) * 4) throw new Error('Invalid stored font');
  const bytes = Buffer.from(record.data, 'base64');
  validateSuppliedTtf(bytes);
  if (record.bytes !== bytes.length || createHash('sha256').update(bytes).digest('hex') !== record.sha256) throw new Error('Stored font hash mismatch');
  return { record, bytes };
}

export function adoptSuppliedFont({ runtimeDir, conversationId, package: pkg, assetsDir }) {
  const stored = load(runtimeDir, conversationId);
  if (!stored) return pkg;
  const { record, bytes } = stored;
  const filename = `font_${record.sha256}.ttf`;
  mkdirSync(assetsDir, { recursive: true });
  writeFileSync(join(assetsDir, filename), bytes);
  const font = { family: `UploadedFont${record.sha256.slice(0, 16)}`, file: `assets/${filename}`, weight: 400, license: { id: 'User-Upload', approved_by_user: true, attribution: record.filename } };
  return { ...pkg, theme: { ...pkg.theme, fonts: [font, ...(pkg.theme?.fonts ?? []).filter(item => item.file !== font.file)].slice(0, 8) } };
}

export async function handleSuppliedFont(request, response, url, runtimeDir) {
  const match = /^\/api\/chat\/(chat_[A-Za-z0-9_-]{8,80})\/supplied-font$/.exec(url.pathname);
  if (!match) return false;
  const send = (status, body) => { response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff' }); response.end(JSON.stringify(body)); };
  try {
    const chatId = match[1];
    if (request.method === 'GET') { const value = load(runtimeDir, chatId); send(200, { font: value ? publicRecord(value.record) : null }); }
    else if (request.method === 'DELETE') { rmSync(filePath(runtimeDir, chatId), { force: true }); send(200, { font: null }); }
    else if (request.method === 'POST') {
      if (request.headers['x-rights-asserted'] !== 'true') throw new Error('Font usage rights must be asserted');
      if (!['font/ttf', 'application/octet-stream', 'application/x-font-ttf'].includes(String(request.headers['content-type'] ?? '').split(';')[0].toLowerCase())) throw new Error('Only TrueType font uploads are supported');
      const chunks = []; let size = 0;
      for await (const chunk of request) { size += chunk.length; if (size > MAX_FONT_BYTES) { send(413, { error: 'Font exceeds 5 MiB' }); return true; } chunks.push(chunk); }
      const filename = decodeURIComponent(String(request.headers['x-filename'] ?? ''));
      send(201, { font: saveSuppliedFont({ runtimeDir, chatId, filename, bytes: Buffer.concat(chunks), rightsAsserted: true }) });
    } else send(405, { error: 'Method not allowed' });
  } catch (error) { send(400, { error: error.message }); }
  return true;
}
