import { requestKey } from './format.mjs';

export class CassetteMiss extends Error {
  constructor(closestPreviews) {
    super('Cassette miss');
    this.name = 'CassetteMiss';
    this.closestPreviews = closestPreviews;
  }
}

function hashDistanceHex(a, b) {
  const bigA = BigInt('0x' + a);
  const bigB = BigInt('0x' + b);
  return Math.abs(Number(bigA - bigB));
}

function extractFirstUserMessagePreview(request) {
  const messages = request.messages || [];
  const firstUser = messages.find(m => m.role === 'user');
  if (!firstUser || !firstUser.content) return '';
  const content = String(firstUser.content).trim();
  const cleaned = content
    .replace(/\bsk-[A-Za-z0-9_-]{6,}\b/g, '[redacted]')
    .replace(/\bhf_[A-Za-z0-9]{6,}\b/g, '[redacted]')
    .replace(/\bghp_[A-Za-z0-9]{6,}\b/g, '[redacted]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/=]+\b/g, 'Bearer [redacted]');
  return cleaned.substring(0, 80);
}

function findClosestKeys(requestKey, entries, limit = 3) {
  if (entries.length === 0) return [];
  const withDistance = entries.map(entry => ({
    key: entry.key,
    distance: hashDistanceHex(requestKey, entry.key),
    entry,
  }));
  withDistance.sort((a, b) => a.distance - b.distance);
  return withDistance.slice(0, limit).map(d => ({
    key: d.key,
    preview: extractFirstUserMessagePreview(d.entry.request),
  }));
}

export function createPlayer(cassette, { mode = 'strict' } = {}) {
  let seqIndex = 0;
  let served = 0;
  let misses = 0;

  const player = async function playerFetch(request) {
    const key = requestKey(request);

    if (mode === 'strict') {
      const entry = cassette.entries.find(e => e.key === key);

      if (entry) {
        served++;
        const body = entry.response.body;
        const content = typeof body === 'string' ? body : JSON.stringify(body);
        return new Response(content, {
          status: entry.response.status,
          headers: { 'Content-Type': 'application/json' },
        });
      } else {
        misses++;
        const closest = findClosestKeys(key, cassette.entries, 3);
        throw new CassetteMiss(closest);
      }
    } else if (mode === 'sequential') {
      if (seqIndex >= cassette.entries.length) {
        throw new Error('Cassette entry exhausted');
      }
      const entry = cassette.entries[seqIndex++];
      served++;
      const body = entry.response.body;
      const content = typeof body === 'string' ? body : JSON.stringify(body);
      return new Response(content, {
        status: entry.response.status,
        headers: { 'Content-Type': 'application/json' },
      });
    }
  };

  player.stats = () => ({ served, misses });

  return player;
}