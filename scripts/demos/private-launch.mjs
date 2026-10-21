/** Single-use browser sign-in for the private origin adapter. No token in chat/logs.
 * Issue: node private-launch.mjs TOKEN_FILE GRANT_FILE PRIVATE_ORIGIN
 * Mount createPrivateLaunchHandler() before forwarding to the authenticated app.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const hash = value => createHash('sha256').update(value).digest('hex');
const equal = (a, b) => typeof a === 'string' && typeof b === 'string' && a.length === b.length
  && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const readToken = file => readFileSync(file, 'utf8').trim();

export function issuePrivateLaunch({ tokenFile, grantFile, origin, now = Date.now() }) {
  const base = new URL(origin);
  if (base.protocol !== 'https:' || base.username || base.password || base.pathname !== '/' || base.search || base.hash) throw Error('Expected a private HTTPS origin');
  const token = readToken(tokenFile);
  if (!token) throw Error('Missing server token');
  const nonce = randomBytes(32).toString('hex');
  writeFileSync(grantFile, JSON.stringify({ nonceHash: hash(nonce), tokenHash: hash(token), expiresAt: now + 60 * 60 * 1000 }), { mode: 0o600 });
  return base.origin + '/connect/' + nonce;
}

export function createPrivateLaunchHandler({ tokenFile, grantFile, origin, now = Date.now }) {
  const base = new URL(origin);
  return (req, res) => {
    const path = new URL(req.url, base.origin).pathname;
    if (!path.startsWith('/connect/')) return false;
    const respond = (status, body = '', extra = {}) => {
      // no-referrer makes Chromium send Origin: null on the form POST. Keep
      // the real origin for the CSRF check, while omitting the nonce path.
      res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store',
        'Referrer-Policy': 'strict-origin', 'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'none'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'", ...extra });
      res.end(req.method === 'HEAD' ? undefined : body);
      return true;
    };
    if (req.headers.host !== base.host || (req.headers.origin && req.headers.origin !== base.origin)) return respond(403);
    if (!['GET', 'HEAD', 'POST'].includes(req.method)) return respond(405);
    const match = /^\/connect\/([0-9a-f]{64})$/.exec(path);
    if (!match) return respond(404);
    let grant, token;
    try { grant = JSON.parse(readFileSync(grantFile, 'utf8')); token = readToken(tokenFile); }
    catch { return respond(404, 'This sign-in link has expired or was already used.'); }
    if (!equal(grant.nonceHash, hash(match[1])) || !equal(grant.tokenHash, hash(token)) || !(grant.expiresAt > now())) {
      return respond(404, 'This sign-in link has expired or was already used.');
    }
    // Preview fetches and HEAD requests never consume a grant or reveal the token.
    if (req.method !== 'POST') return respond(200, '<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Open ComfyRizz</title><h1>Open ComfyRizz</h1><p>Sign in to your private workspace, then select Characters to see the Nous universe cast.</p><form method="post"><button type="submit">Open my workspace</button></form></html>');
    if (req.headers.origin !== base.origin) return respond(403);
    unlinkSync(grantFile);
    return respond(303, '', { Location: '/#token=' + encodeURIComponent(token) });
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.length !== 5) throw Error('Usage: private-launch.mjs TOKEN_FILE GRANT_FILE PRIVATE_ORIGIN');
  console.log(issuePrivateLaunch({ tokenFile: process.argv[2], grantFile: process.argv[3], origin: process.argv[4] }));
}
