import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  buildCredits,
  downloadOpenverseCandidate,
  buildPackageZip,
  canonicalLicenseId,
  createZip,
  DEFAULT_LICENSE_POLICY,
  evaluateLicense,
  inspectUpload,
  isAssetRedistributable,
  licenseFamily,
  searchOpenverse,
  sha256Hex,
} from '../src/index.js';
import type { PackageLike } from '../src/index.js';

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('fake-png-body')]);

test('licence canonicalisation and v0.1 policy', () => {
  assert.equal(canonicalLicenseId('cc0'), 'CC0-1.0');
  assert.equal(canonicalLicenseId('pdm'), 'PDM-1.0');
  assert.equal(canonicalLicenseId('by', '4.0'), 'CC-BY-4.0');
  assert.equal(canonicalLicenseId('by-sa', '3.0'), 'CC-BY-SA-3.0');
  assert.equal(licenseFamily('CC-BY-NC-4.0'), 'CC-BY-NC');
  assert.equal(evaluateLicense('CC0-1.0').redistributable, true);
  assert.equal(evaluateLicense('PDM-1.0').redistributable, true);
  const approvedBy = evaluateLicense('CC-BY-4.0', { approvedByUser: true, attribution: '“X” by Y, CC BY 4.0' });
  assert.equal(approvedBy.allowed, true);
  assert.equal(approvedBy.redistributable, true);
  assert.equal(approvedBy.requiresAttribution, true);
  assert.equal(evaluateLicense('CC-BY-4.0', { approvedByUser: true }).redistributable, false);
  assert.equal(evaluateLicense('CC-BY-4.0', { attribution: 'x' }).redistributable, false);
  assert.equal(evaluateLicense('CC-BY-SA-4.0').allowed, false);
  assert.equal(evaluateLicense('CC-BY-NC-4.0').allowed, false);
  assert.equal(evaluateLicense('CC-BY-ND-4.0').allowed, false);
  assert.equal(evaluateLicense('all-rights-reserved').allowed, false);
  assert.equal(evaluateLicense(undefined, { origin: 'generated' }).redistributable, true);
  assert.equal(DEFAULT_LICENSE_POLICY.blockShareAlike, true);
});

test('asset redistributability covers generated, approved CC BY and shareable uploads', () => {
  assert.equal(isAssetRedistributable({ origin: 'generated', license: { id: 'CC0-1.0' } }), true);
  assert.equal(isAssetRedistributable({ origin: 'stock', license: { id: 'CC-BY-4.0', approved_by_user: true, attribution: 'a' }, redistributable: true }), true);
  assert.equal(isAssetRedistributable({ origin: 'stock', license: { id: 'CC-BY-4.0' }, redistributable: true }), false);
  assert.equal(isAssetRedistributable({ origin: 'upload', license: { id: 'User-Upload', approved_by_user: true }, redistributable: true }), true);
  assert.equal(isAssetRedistributable({ origin: 'upload', license: { id: 'User-Upload', approved_by_user: false }, redistributable: false }), false);
  assert.equal(isAssetRedistributable({ origin: 'stock', license: { id: 'CC-BY-SA-4.0' }, redistributable: true }), false);
});

test('Openverse search sends the policy filter and maps licences and attribution', async () => {
  let seen: { url: string; headers: Record<string, string> } | undefined;
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    seen = { url: String(url), headers: (init?.headers ?? {}) as Record<string, string> };
    return new Response(JSON.stringify({
      result_count: 3,
      page_count: 1,
      results: [
        { id: '1', title: 'Rocket', creator: 'Ada', url: 'https://example/1.jpg', foreign_landing_url: 'https://example/1', license: 'cc0', width: 100, height: 50 },
        { id: '2', title: 'Nebula', creator: 'Bo', url: 'https://example/2.jpg', license: 'by', license_version: '4.0', license_url: 'https://creativecommons.org/licenses/by/4.0/' },
        { id: '3', title: 'Share-alike', creator: 'Cy', url: 'https://example/3.jpg', license: 'by-sa' },
        { id: '4', title: 'No file', creator: 'Di', license: 'cc0' },
      ],
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  const result = await searchOpenverse({ query: 'rocket', orientation: 'landscape', fetchImpl, apiToken: 'token-123' });
  const url = new URL(seen!.url);
  assert.equal(url.origin + url.pathname, 'https://api.openverse.org/v1/images/');
  assert.equal(url.searchParams.get('license'), 'cc0,pdm,by');
  assert.equal(url.searchParams.get('orientation'), 'landscape');
  assert.equal(url.searchParams.get('mature'), 'false');
  assert.equal(seen!.headers.authorization, 'Bearer token-123');
  assert.equal(result.candidates.length, 3);
  assert.equal(result.resultCount, 3);
  const [cc0, by, sa] = result.candidates;
  assert.equal(cc0.license.id, 'CC0-1.0');
  assert.equal(cc0.redistributable, true);
  assert.match(cc0.license.attribution, /“Rocket” by Ada, CC0 1.0/);
  assert.equal(by.license.id, 'CC-BY-4.0');
  assert.equal(by.allowed, true);
  assert.equal(by.redistributable, false);
  assert.equal(by.requiresAttribution, true);
  assert.equal(sa.blocked, true);
  assert.match(sa.blockedReason ?? '', /share-alike/);
});

test('downloads a candidate over public https, hashes it and keeps it unapproved', async () => {
  const candidate = {
    assetId: 'openverse_1', provider: 'openverse' as const, id: '1', title: 'Rocket', creator: 'Ada', fileUrl: 'https://cdn.example/rocket.png',
    license: { id: 'CC-BY-4.0', attribution: '“Rocket” by Ada, CC BY 4.0' }, allowed: true, redistributable: false, blocked: false, requiresAttribution: true,
  };
  const fetchImpl = (async () => new Response(PNG, { status: 200, headers: { 'content-type': 'image/png', 'content-length': String(PNG.length) } })) as typeof fetch;
  const result = await downloadOpenverseCandidate(candidate, { fetchImpl });
  assert.equal(result.sha256, sha256Hex(PNG));
  assert.equal(result.mime, 'image/png');
  assert.equal(result.asset.file, 'assets/openverse_1.png');
  assert.equal(result.asset.status, 'candidate');
  assert.equal(result.asset.license?.approved_by_user, false);
  assert.equal(result.asset.redistributable, false);
  await assert.rejects(() => downloadOpenverseCandidate({ ...candidate, fileUrl: 'http://cdn.example/rocket.png' }, { fetchImpl }), /must be https/);
  await assert.rejects(() => downloadOpenverseCandidate({ ...candidate, fileUrl: 'https://127.0.0.1/rocket.png' }, { fetchImpl }), /private or loopback/);
});

test('Openverse HTTP errors are structured', async () => {
  const fetchImpl = (async () => new Response('rate limited', { status: 429 })) as typeof fetch;
  await assert.rejects(() => searchOpenverse({ query: 'x', fetchImpl }), (error: any) => error.status === 429 && /Openverse HTTP 429/.test(error.message));
});

test('uploads require asserted rights, are hashed and stay under assets/', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'comfyrizz-upload-'));
  try {
    const png = join(dir, 'shot.png');
    await writeFile(png, PNG);
    await assert.rejects(() => inspectUpload({ filePath: png, rightsAsserted: false, shareable: true }), /rights must be asserted/);
    const result = await inspectUpload({ filePath: png, rightsAsserted: true, shareable: true, title: 'My shot', creator: 'Kyle', retrievedAt: '2026-10-17T00:00:00.000Z' });
    assert.equal(result.mime, 'image/png');
    assert.equal(result.sha256, sha256Hex(PNG));
    assert.equal(result.asset.file, `assets/${result.asset.source?.id}.png`);
    assert.equal(result.asset.origin, 'upload');
    assert.equal(result.asset.redistributable, true);
    assert.equal(result.asset.license?.approved_by_user, true);
    const privateUpload = await inspectUpload({ filePath: png, rightsAsserted: true, shareable: false });
    assert.equal(privateUpload.asset.redistributable, false);
    const text = join(dir, 'notes.txt');
    await writeFile(text, 'hello');
    await assert.rejects(() => inspectUpload({ filePath: text, rightsAsserted: true, shareable: false }), /unsupported upload type/);
    await assert.rejects(() => inspectUpload({ filePath: png, rightsAsserted: true, shareable: true, maxBytes: 4 }), /exceeds/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('credits mark CC BY assets for an end card and list excluded assets', () => {
  const pkg: PackageLike = {
    id: 'pkg_test',
    title: 'Test',
    revision: 3,
    assets: {
      a_gen: { origin: 'generated', license: { id: 'CC0-1.0' }, file: 'assets/a_gen.svg', redistributable: true },
      a_by: { origin: 'stock', license: { id: 'CC-BY-4.0', approved_by_user: true, attribution: '“Photo” by Ada, CC BY 4.0' }, source: { provider: 'openverse', title: 'Photo', creator: 'Ada', landing_url: 'https://example/photo' }, file: 'assets/a_by.jpg', redistributable: true },
      a_sa: { origin: 'stock', license: { id: 'CC-BY-SA-4.0' }, file: 'assets/a_sa.jpg', redistributable: false },
    },
  };
  const credits = buildCredits(pkg, { generatedAt: '2026-10-17T00:00:00.000Z', excluded: [{ assetId: 'a_sa', file: 'assets/a_sa.jpg', sha256: 'abc', reason: 'share-alike', sourceUrl: 'https://example/sa' }] });
  assert.equal(credits.requiresEndCard, true);
  assert.equal(credits.entries.length, 3);
  assert.match(credits.markdown, /# Credits — Test/);
  assert.match(credits.markdown, /Ada/);
  assert.match(credits.markdown, /credits end card/);
  assert.match(credits.markdown, /fetch it yourself/i);
  assert.match(credits.markdown, /a_sa/);
  const noBy = buildCredits({ id: 'p', assets: { a: { origin: 'generated', license: { id: 'CC0-1.0' } } } });
  assert.equal(noBy.requiresEndCard, false);
});

test('package.zip includes only redistributable assets and marks the rest incomplete', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'comfyrizz-zip-'));
  try {
    const genBytes = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10"/></svg>');
    const byBytes = Buffer.from('jpeg-bytes');
    const packageDoc: PackageLike = {
      id: 'pkg_zip',
      title: 'Zip test',
      revision: 2,
      assets: {
        a_gen: { kind: 'svg', origin: 'generated', status: 'ready', file: 'assets/a_gen.svg', sha256: sha256Hex(genBytes), license: { id: 'CC0-1.0' }, redistributable: true },
        a_by: { kind: 'image', origin: 'stock', status: 'ready', file: 'assets/a_by.jpg', sha256: sha256Hex(byBytes), source: { provider: 'openverse', landing_url: 'https://example/by' }, license: { id: 'CC-BY-4.0', approved_by_user: true, attribution: '“Photo” by Ada, CC BY 4.0' }, redistributable: true },
        a_sa: { kind: 'image', origin: 'stock', status: 'ready', file: 'assets/a_sa.jpg', source: { provider: 'openverse', landing_url: 'https://example/sa' }, license: { id: 'CC-BY-SA-4.0', blocked: true, blocked_reason: 'share-alike' }, redistributable: false },
        a_private: { kind: 'image', origin: 'upload', status: 'ready', file: 'assets/a_private.png', license: { id: 'User-Upload', approved_by_user: false }, redistributable: false },
        a_missing: { kind: 'image', origin: 'generated', status: 'ready', file: 'assets/a_missing.png', license: { id: 'CC0-1.0' }, redistributable: true },
      },
    };
    const result = buildPackageZip({
      package: packageDoc,
      timeline: { fps: 30, scenes: [] },
      assets: { a_gen: genBytes, a_by: byBytes },
      workflows: { 'flux3_klein_t2i.api.json': '{"1":{}}' },
      generatedAt: '2026-10-17T00:00:00.000Z',
    });
    assert.equal(result.complete, false);
    assert.deepEqual(result.included.sort(), ['a_by', 'a_gen']);
    assert.deepEqual(result.excluded.map(item => item.assetId).sort(), ['a_missing', 'a_private', 'a_sa']);
    assert.equal(result.manifest.complete, false);
    assert.match(String(result.manifest.note), /No keys/);
    assert.equal(result.bytes.subarray(0, 2).toString('ascii'), 'PK');

    const zipPath = join(dir, 'package.zip');
    await writeFile(zipPath, result.bytes);
    const listed = execFileSync('unzip', ['-Z1', zipPath]).toString().split('\n').filter(Boolean);
    assert.ok(listed.includes('package.json'));
    assert.ok(listed.includes('timeline.json'));
    assert.ok(listed.includes('workflows/flux3_klein_t2i.api.json'));
    assert.ok(listed.includes('assets/a_gen.svg'));
    assert.ok(listed.includes('assets/a_by.jpg'));
    assert.ok(listed.includes('credits.json'));
    assert.ok(listed.includes('CREDITS.md'));
    assert.ok(listed.includes('manifest.json'));
    assert.ok(listed.includes('INCOMPLETE.md'));
    assert.ok(!listed.includes('assets/a_sa.jpg'));
    assert.ok(!listed.includes('assets/a_private.png'));
    const manifest = JSON.parse(execFileSync('unzip', ['-p', zipPath, 'manifest.json']).toString());
    assert.deepEqual(manifest.included.sort(), ['a_by', 'a_gen']);
    assert.equal(manifest.excluded.length, 3);
    const packageOut = JSON.parse(execFileSync('unzip', ['-p', zipPath, 'package.json']).toString());
    assert.equal(packageOut.id, 'pkg_zip');
    const rebuilt = buildPackageZip({ package: packageDoc, timeline: { fps: 30, scenes: [] }, assets: { a_gen: genBytes, a_by: byBytes }, workflows: { 'flux3_klein_t2i.api.json': '{"1":{}}' }, generatedAt: '2026-10-17T00:00:00.000Z' });
    assert.equal(rebuilt.bytes.equals(result.bytes), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('package.zip refuses a hash mismatch and unsafe/duplicate paths', () => {
  const bytes = Buffer.from('actual');
  const packageDoc: PackageLike = { id: 'p', assets: { a: { origin: 'generated', license: { id: 'CC0-1.0' }, file: 'assets/a.svg', sha256: 'deadbeef', redistributable: true } } };
  const result = buildPackageZip({ package: packageDoc, assets: { a: bytes }, generatedAt: '2026-10-17T00:00:00.000Z' });
  assert.equal(result.complete, false);
  assert.match(result.excluded[0].reason, /sha256 mismatch/);
  assert.throws(() => createZip([{ path: '../evil', data: 'x' }]), /unsafe zip path/);
  assert.throws(() => createZip([{ path: 'a', data: 'x' }, { path: 'a', data: 'y' }]), /duplicate zip entry/);
});
