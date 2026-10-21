import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { buildCredits, buildPackageZip, evaluateLicense } from '../src/index.js';
import type { Credits, PackageLike } from '../src/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixturePath = resolve(here, '../../../../examples/licensing-demo/package.json');

function zipEntry(bytes: Buffer, name: string): string | undefined {
  let offset = 0;
  while (offset + 30 <= bytes.length && bytes.readUInt32LE(offset) === 0x04034b50) {
    assert.equal(bytes.readUInt16LE(offset + 8), 0, 'expected the deterministic store-only zip');
    const size = bytes.readUInt32LE(offset + 18);
    const nameLength = bytes.readUInt16LE(offset + 26);
    const extraLength = bytes.readUInt16LE(offset + 28);
    const entryName = bytes.subarray(offset + 30, offset + 30 + nameLength).toString('utf8');
    const dataStart = offset + 30 + nameLength + extraLength;
    if (entryName === name) return bytes.subarray(dataStart, dataStart + size).toString('utf8');
    offset = dataStart + size;
  }
  return undefined;
}

test('licensing demo: CC BY ships with attribution, CC BY-NC is refused', async () => {
  const pkg = JSON.parse(await readFile(fixturePath, 'utf8')) as PackageLike;
  const approved = pkg.assets!['openverse-approved'];
  const refused = pkg.assets!['openverse-refused'];

  const approvedDecision = evaluateLicense(approved.license?.id, {
    approvedByUser: approved.license?.approved_by_user,
    attribution: approved.license?.attribution,
  });
  assert.equal(approvedDecision.allowed, true);
  assert.equal(approvedDecision.redistributable, true);
  assert.match(approvedDecision.reason, /approved with attribution/);

  const refusedDecision = evaluateLicense(refused.license?.id, {
    approvedByUser: refused.license?.approved_by_user,
    attribution: refused.license?.attribution,
  });
  assert.equal(refusedDecision.allowed, false);
  assert.match(refusedDecision.reason, /non-commercial/);

  const approvedBytes = Buffer.from('approved-jpeg-bytes');
  const refusedBytes = Buffer.from('refused-jpeg-bytes');
  const zip = buildPackageZip({
    package: pkg,
    assets: { 'openverse-approved': approvedBytes, 'openverse-refused': refusedBytes },
    generatedAt: '2026-10-20T00:00:00.000Z',
  });

  assert.ok(zip.included.includes('openverse-approved'));
  assert.ok(zip.entries.includes('assets/openverse-approved.jpg'));
  assert.ok(!zip.entries.includes('assets/openverse-refused.jpg'));
  const refusedExclusion = zip.excluded.find(item => item.assetId === 'openverse-refused');
  assert.ok(refusedExclusion);
  assert.ok(refusedExclusion.reason.length > 0);

  const credits = buildCredits(pkg, { generatedAt: '2026-10-20T00:00:00.000Z', excluded: zip.excluded });
  const approvedCredit = credits.entries.find(entry => entry.assetId === 'openverse-approved');
  assert.ok(approvedCredit);
  assert.equal(approvedCredit.creator, 'Marta Rivera');
  assert.match(approvedCredit.attribution, /CC BY 4\.0/);
  assert.equal(approvedCredit.redistributable, true);
  const refusedCredit = credits.entries.find(entry => entry.assetId === 'openverse-refused');
  assert.equal(refusedCredit?.redistributable, false);
  assert.match(credits.markdown, /Marta Rivera/);
  assert.match(credits.markdown, /CC-BY-4\.0/);
  assert.match(credits.markdown, /\| openverse-refused \|.*\| no \|/);

  const creditsInZip = zipEntry(zip.bytes, 'CREDITS.md');
  assert.ok(creditsInZip);
  assert.match(creditsInZip, /Marta Rivera/);
  assert.match(creditsInZip, /CC-BY-4\.0/);
  assert.match(creditsInZip, /\| openverse-refused \|.*\| no \|/);
  const creditsJson = JSON.parse(zipEntry(zip.bytes, 'credits.json') ?? '{}') as Credits;
  assert.equal(creditsJson.entries.find(entry => entry.assetId === 'openverse-refused')?.redistributable, false);
});
