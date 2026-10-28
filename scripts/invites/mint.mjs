#!/usr/bin/env node
/**
 * Mint a hosted Google Colab invite against a running local Comfyrizz server.
 *
 * Usage:
 *   COMFYRIZZ_TOKEN=... node scripts/invites/mint.mjs --cu 2 --ttlDays 7 --label friend
 *   node scripts/invites/mint.mjs --cu 1.5 --ttlSeconds 3600 --base http://127.0.0.1:4319
 *
 * Public URL shape: https://comfy.rizz.click/secretfriendsdemo/<token>
 * (server returns that URL; local redeem works at http://127.0.0.1:<port>/secretfriendsdemo/<token>)
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

function arg(name, fallback = undefined) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  return process.argv[i + 1] ?? fallback;
}

const base = (arg('base') || process.env.COMFYRIZZ_BASE || 'http://127.0.0.1:4319').replace(/\/$/, '');
const cu = Number(arg('cu'));
const ttlSeconds = arg('ttlSeconds') != null ? Number(arg('ttlSeconds')) : undefined;
const ttlDays = arg('ttlDays') != null ? Number(arg('ttlDays')) : undefined;
const label = arg('label', '');
const tokenPath = arg('tokenFile') || join(process.cwd(), 'apps/server/.runtime/server-token');
let token = process.env.COMFYRIZZ_TOKEN || arg('token');
if (!token && existsSync(tokenPath)) token = readFileSync(tokenPath, 'utf8').trim();
if (!token) {
  console.error('Need COMFYRIZZ_TOKEN or apps/server/.runtime/server-token');
  process.exit(1);
}
if (!Number.isFinite(cu) || cu <= 0) {
  console.error('Required: --cu <positive number>');
  process.exit(1);
}
if (ttlSeconds == null && ttlDays == null) {
  console.error('Required: --ttlSeconds <n> or --ttlDays <n>');
  process.exit(1);
}

const body = { cu, label };
if (ttlSeconds != null) body.ttlSeconds = ttlSeconds;
if (ttlDays != null) body.ttlDays = ttlDays;

const res = await fetch(`${base}/api/invites/mint`, {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    origin: base,
    'x-comfyrizz-token': token,
  },
  body: JSON.stringify(body),
});
const data = await res.json();
if (!res.ok) {
  console.error(data);
  process.exit(1);
}
console.log(JSON.stringify(data, null, 2));
console.log(`\nLocal redeem: ${base}${data.path}`);
console.log(`Public shape: ${data.url}`);
