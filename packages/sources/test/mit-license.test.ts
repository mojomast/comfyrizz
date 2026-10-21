import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { buildCredits, buildPackageZip, canonicalLicenseId, DEFAULT_LICENSE_POLICY, evaluateLicense, isAssetRedistributable, licenseFamily } from '../src/index.js';
import type { PackageAssetLike, PackageLike } from '../src/index.js';

const attribution = 'Copyright (c) 2026 Kyle Durepos. Original Comfyrizz curated template geometry; supplied text/data retain their source rights.';
const asset: PackageAssetLike = {
  origin: 'generated', kind: 'video', file: 'assets/composition.mp4',
  license: { id: 'MIT', attribution }, redistributable: true,
};
const denyMIT = { ...DEFAULT_LICENSE_POLICY, allow: DEFAULT_LICENSE_POLICY.allow.filter(id => id !== 'MIT') };

test('MIT requires stored notices and policy permission, without an approval flow', () => {
  assert.equal(canonicalLicenseId('  mit '), 'MIT');
  assert.equal(licenseFamily('MIT'), 'MIT');
  for (const origin of ['generated', 'stock', 'native']) {
    const decision = evaluateLicense('MIT', { origin, attribution, approvedByUser: false });
    assert.equal(decision.allowed, true);
    assert.equal(decision.redistributable, true);
    assert.equal(decision.requiresAttribution, true);
    assert.equal(isAssetRedistributable({ ...asset, origin }), true);
    assert.equal(evaluateLicense('MIT', { origin }).redistributable, false);
    assert.equal(evaluateLicense('MIT', { origin, attribution: '   ', approvedByUser: true }).redistributable, false);
  }
  assert.equal(evaluateLicense('MIT', { attribution, policy: denyMIT }).allowed, false);
  assert.equal(isAssetRedistributable(asset, denyMIT), false);
  assert.equal(isAssetRedistributable({ ...asset, redistributable: false }), false);
  assert.equal(isAssetRedistributable({ ...asset, license: { ...asset.license, blocked: true } }), false);
  assert.equal(isAssetRedistributable({ ...asset, license: { id: 'MIT-like', attribution } }), false);
  // Stock assets still need the existing explicit redistribution marker.
  assert.equal(isAssetRedistributable({ ...asset, origin: 'stock', redistributable: undefined }), false);
});

test('real ZIP includes complete MIT terms and exact supplied notices for shipped assets only', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'comfyrizz-mit-'));
  try {
    const externalNotice = 'Copyright (c) 2025 External Artist\nAdditional supplied notice.';
    const pkg: PackageLike = { id: 'mit-assets', assets: {
      composition: asset,
      external: { ...asset, origin: 'stock', file: 'assets/external.svg', license: { id: 'mit', attribution: externalNotice } },
    } };
    const input = { package: pkg, assets: { composition: 'video', external: '<svg/>' }, generatedAt: '2026-10-20T00:00:00Z' };
    const result = buildPackageZip(input);
    assert.equal(result.complete, true);
    assert.deepEqual(result.included, ['composition', 'external']);
    const zip = join(dir, 'package.zip');
    await writeFile(zip, result.bytes);
    const notice = execFileSync('unzip', ['-p', zip, 'licenses/MIT.txt']).toString();
    assert.ok(notice.includes(attribution));
    assert.ok(notice.includes(externalNotice));
    assert.match(notice, /Asset: composition\nFile: assets\/composition.mp4/);
    assert.match(notice, /Asset: external\nFile: assets\/external.svg/);
    assert.match(notice, /Permission is hereby granted, free of charge/);
    assert.match(notice, /use, copy, modify, merge, publish, distribute, sublicense, and\/or sell/);
    assert.match(notice, /The above copyright notice and this permission notice shall be included in all/);
    assert.match(notice, /THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND/);
    assert.match(notice, /FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT/);
    assert.match(notice, /LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE/);
    assert.match(notice, /SOFTWARE\.\n$/);
    const credits = execFileSync('unzip', ['-p', zip, 'CREDITS.md']).toString();
    assert.match(credits, /MIT/);
    assert.match(credits, /licenses\/MIT.txt/);
    const json = JSON.parse(execFileSync('unzip', ['-p', zip, 'credits.json']).toString());
    assert.ok(json.entries.every((entry: { licenseNotice: string }) => entry.licenseNotice === 'licenses/MIT.txt'));
    assert.equal(json.requiresEndCard, false);
    assert.equal(buildCredits(pkg).requiresEndCard, false);
    const customCredits = buildPackageZip({ ...input, credits: { ...buildCredits(pkg), markdown: '# Custom credits\n' } });
    await writeFile(zip, customCredits.bytes);
    assert.match(execFileSync('unzip', ['-p', zip, 'CREDITS.md']).toString(), /MIT permission.*licenses\/MIT.txt/);
    const mixed = buildPackageZip({ ...input, package: { ...pkg, assets: { ...pkg.assets,
      blocked: { ...asset, file: 'assets/blocked.mp4', license: { id: 'MIT', attribution: 'DO NOT SHIP BLOCKED NOTICE', blocked: true } },
      missing: { ...asset, file: 'assets/missing.mp4', license: { id: 'MIT', attribution: 'DO NOT SHIP MISSING NOTICE' } },
    } } });
    await writeFile(zip, mixed.bytes);
    const mixedNotice = execFileSync('unzip', ['-p', zip, 'licenses/MIT.txt']).toString();
    assert.ok(mixedNotice.includes(attribution));
    assert.ok(!mixedNotice.includes('DO NOT SHIP'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('excluded MIT assets produce no MIT notice, including missing bytes and bad hashes', () => {
  const cases: PackageAssetLike[] = [
    { ...asset, license: { id: 'MIT' } },
    { ...asset, license: { id: 'MIT', attribution: '  ' } },
    { ...asset, license: { id: 'MIT-like', attribution } },
    { ...asset, license: { ...asset.license, blocked: true } },
    { ...asset, redistributable: false },
    { ...asset, sha256: 'incorrect' },
  ];
  for (const excludedAsset of cases) {
    const result = buildPackageZip({ package: { assets: { a: excludedAsset } }, assets: { a: 'bytes' } });
    assert.equal(result.complete, false);
    assert.deepEqual(result.included, []);
    assert.ok(!result.entries.includes('licenses/MIT.txt'));
  }
  for (const input of [
    { package: { assets: { a: asset } } },
    { package: { assets: { a: asset } }, assets: { a: 'bytes' }, licensePolicy: denyMIT },
  ]) {
    const result = buildPackageZip(input);
    assert.equal(result.complete, false);
    assert.ok(!result.entries.includes('licenses/MIT.txt'));
  }
});
