import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { saveSuppliedFont, adoptSuppliedFont, validateSuppliedTtf, handleSuppliedFont } from '../src/supplied-font.mjs';
import { preparePublicDir, renderPackage } from '../../renderer/scripts/render-package-lib.mjs';
import { brandFontFamily } from '../../renderer/src/theme-model.js';
import { validatePackage } from '../../../packages/schema/src/index.mjs';

test('authorized real TTF survives package adoption and export staging byte-for-byte', () => {
  const root = mkdtempSync(join(tmpdir(), 'font-roundtrip-'));
  let publicDir;
  try {
    const bytes = readFileSync(new URL('../../renderer/public/fonts/Inter-Variable.ttf', import.meta.url));
    const chatId = 'chat_12345678';
    const result = saveSuppliedFont({ runtimeDir: root, chatId, filename: 'Anton.ttf', bytes, rightsAsserted: true });
    assert.equal(result.sha256, createHash('sha256').update(bytes).digest('hex'));
    assert.equal('data' in result, false);
    const input = JSON.parse(readFileSync(new URL('../../../packages/schema/fixtures/valid/minimal.json', import.meta.url)));
    const pkg = adoptSuppliedFont({ runtimeDir: root, conversationId: chatId, package: input, assetsDir: join(root, 'packages', 'assets') });
    assert.equal(validatePackage(pkg).valid, true, JSON.stringify(validatePackage(pkg).errors));
    const font = pkg.theme.fonts[0];
    assert.equal(font.license.approved_by_user, true);
    assert.equal(font.license.attribution, 'Anton.ttf');
    assert.equal(brandFontFamily(pkg), font.family);
    assert.deepEqual(readFileSync(join(root, 'packages', font.file)), bytes);
    publicDir = preparePublicDir(pkg, join(root, 'packages'));
    assert.deepEqual(readFileSync(join(publicDir, font.file)), bytes);
  } finally {
    if (publicDir) rmSync(publicDir, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test('rejects unauthorized, executable, malformed and incorrectly named uploads', () => {
  const bytes = readFileSync(new URL('../../renderer/public/fonts/Inter-Variable.ttf', import.meta.url));
  const root = mkdtempSync(join(tmpdir(), 'font-validation-'));
  try {
    const base = { runtimeDir: root, chatId: 'chat_12345678', filename: 'font.ttf', bytes };
    assert.throws(() => saveSuppliedFont(base), /rights/);
    assert.throws(() => saveSuppliedFont({ ...base, rightsAsserted: true, filename: 'weights.safetensors' }), /ttf/);
    assert.throws(() => validateSuppliedTtf(Buffer.from('#!/bin/sh\necho bad')));
    const broken = Buffer.from(bytes); broken.writeUInt32BE(0xffffffff, 20);
    assert.throws(() => validateSuppliedTtf(broken), /bounds/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('font HTTP upload requires explicit rights and returns metadata only', async () => {
  const root = mkdtempSync(join(tmpdir(), 'font-http-'));
  const server = createServer((req, res) => { void handleSuppliedFont(req, res, new URL(req.url, 'http://localhost'), root); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const url = `http://127.0.0.1:${server.address().port}/api/chat/chat_12345678/supplied-font`;
    const bytes = readFileSync(new URL('../../renderer/public/fonts/JetBrainsMono-Regular.ttf', import.meta.url));
    const headers = { 'content-type': 'font/ttf', 'x-filename': 'Anton.ttf' };
    assert.equal((await fetch(url, { method: 'POST', headers, body: bytes })).status, 400);
    const uploaded = await fetch(url, { method: 'POST', headers: { ...headers, 'x-rights-asserted': 'true' }, body: bytes });
    assert.equal(uploaded.status, 201);
    const body = await uploaded.json();
    assert.equal(body.font.filename, 'Anton.ttf');
    assert.equal(body.font.data, undefined);
    assert.deepEqual(await (await fetch(url)).json(), body);
    assert.equal((await fetch(url, { method: 'DELETE' })).status, 200);
    assert.deepEqual(await (await fetch(url)).json(), { font: null });
  } finally { await new Promise(resolve => server.close(resolve)); rmSync(root, { recursive: true, force: true }); }
});

test('title-only still render changes when a supplied font is adopted', { skip: !process.env.TEST_FONT_RENDER }, () => {
  const root = mkdtempSync(join(tmpdir(), 'font-render-'));
  try {
    const bytes = readFileSync(new URL('../../renderer/public/fonts/JetBrainsMono-Regular.ttf', import.meta.url));
    const chatId = 'chat_12345678';
    saveSuppliedFont({ runtimeDir: root, chatId, filename: 'mono.ttf', bytes, rightsAsserted: true });
    const pkg = JSON.parse(readFileSync(new URL('../../../packages/schema/fixtures/valid/minimal.json', import.meta.url)));
    pkg.assets = {}; delete pkg.theme.logo_asset; delete pkg.scenes[0].transitionOut;
    const withFont = adoptSuppliedFont({ runtimeDir: root, conversationId: chatId, package: pkg, assetsDir: join(root, 'assets') });
    const first = join(root, 'base.json'); const second = join(root, 'font.json');
    writeFileSync(first, JSON.stringify(pkg)); writeFileSync(second, JSON.stringify(withFont));
    renderPackage(first, join(root, 'base.png'), { still: true, frame: 60, scale: 0.5 });
    renderPackage(second, join(root, 'font.png'), { still: true, frame: 60, scale: 0.5 });
    assert.notDeepEqual(readFileSync(join(root, 'base.png')), readFileSync(join(root, 'font.png')));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
