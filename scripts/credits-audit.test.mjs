import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { auditPackage, buildReport, canonicalLicenseId, licenseFamily, renderCredits } from './credits-audit.mjs';

function fixture(t, pkg, files = []) {
  const dir = mkdtempSync(join(tmpdir(), 'credits-audit-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const file of files) {
    const target = join(dir, file);
    mkdirSync(join(target, '..'), { recursive: true });
    writeFileSync(target, 'fixture');
  }
  return { dir, pkg };
}

function packageWith(asset, extra = {}) {
  return {
    schemaVersion: 1,
    revision: 1,
    id: 'pkg_fixture',
    title: 'Fixture',
    format: { width: 1280, height: 720, fps: 30 },
    duration: { mode: 'flexible' },
    scenes: [
      {
        id: 's_one',
        layout: 'hero',
        background: { asset: 'a_photo', fit: 'cover' },
      },
    ],
    assets: { a_photo: asset },
    compliance: { open_weights_only: true },
    ...extra,
  };
}

test('CC BY approved asset is credited with creator, licence and attribution', (t) => {
  const pkg = packageWith({
    kind: 'image',
    origin: 'stock',
    status: 'ready',
    file: 'assets/photo.jpg',
    source: {
      provider: 'openverse',
      id: 'ov-1',
      landing_url: 'https://openverse.org/image/1',
      creator: 'Marta Rivera',
      title: 'Morning Fog',
    },
    license: {
      id: 'CC-BY-4.0',
      url: 'https://creativecommons.org/licenses/by/4.0/',
      attribution: '“Morning Fog” by Marta Rivera, CC BY 4.0',
      approved_by_user: true,
    },
    redistributable: true,
  });
  const { dir } = fixture(t, pkg, ['assets/photo.jpg']);
  const rows = auditPackage(pkg, dir);

  assert.equal(rows.length, 1);
  assert.equal(rows[0].creator, 'Marta Rivera');
  assert.equal(rows[0].licenseId, 'CC-BY-4.0');
  assert.equal(rows[0].approval, 'approved');
  assert.equal(rows[0].redistributable, true);
  assert.equal(rows[0].wouldShip, true);
  assert.deepEqual(rows[0].problems, []);

  const markdown = renderCredits(rows);
  assert.match(markdown, /Morning Fog/);
  assert.match(markdown, /Marta Rivera/);
  assert.match(markdown, /CC-BY-4\.0/);
  assert.match(markdown, /No problems found/);
});

test('CC BY-NC is flagged when it would ship', (t) => {
  const pkg = packageWith({
    kind: 'image',
    origin: 'stock',
    status: 'ready',
    file: 'assets/photo.jpg',
    source: { provider: 'openverse', creator: 'Leo Fischer', title: 'City Lights' },
    license: { id: 'CC-BY-NC-4.0', approved_by_user: false },
    redistributable: false,
  });
  const { dir } = fixture(t, pkg, ['assets/photo.jpg']);
  const rows = auditPackage(pkg, dir);

  assert.equal(rows[0].wouldShip, true);
  assert.equal(rows[0].redistributable, false);
  assert.ok(rows[0].problems.includes('non-redistributable-would-ship'));
});

test('CC BY-NC is not flagged when it is a candidate, explicitly non-shipping or unused', (t) => {
  const absent = packageWith({
    kind: 'image',
    origin: 'stock',
    status: 'candidate',
    file: 'assets/photo.jpg',
    license: { id: 'CC-BY-NC-4.0' },
    redistributable: false,
  });
  const absentDir = fixture(t, absent).dir;
  assert.deepEqual(auditPackage(absent, absentDir)[0].problems, []);

  const unusedPkg = packageWith({
    kind: 'image',
    origin: 'stock',
    status: 'ready',
    file: 'assets/photo.jpg',
    license: { id: 'CC-BY-NC-4.0' },
    redistributable: false,
  });
  unusedPkg.scenes = [{ id: 's_one', layout: 'title' }];
  const unusedDir = fixture(t, unusedPkg, ['assets/photo.jpg']).dir;
  assert.equal(auditPackage(unusedPkg, unusedDir)[0].wouldShip, false);
  assert.deepEqual(auditPackage(unusedPkg, unusedDir)[0].problems, []);

  const privatePkg = packageWith({
    kind: 'image',
    origin: 'stock',
    status: 'ready',
    file: 'assets/photo.jpg',
    license: { id: 'CC-BY-NC-4.0' },
    redistributable: false,
  });
  const privateDir = fixture(t, privatePkg).dir;
  assert.equal(auditPackage(privatePkg, privateDir)[0].wouldShip, false);
  assert.deepEqual(auditPackage(privatePkg, privateDir)[0].problems, []);

  const readyPkg = packageWith({
    kind: 'image',
    origin: 'stock',
    status: 'ready',
    file: 'assets/photo.jpg',
    license: { id: 'CC-BY-NC-4.0' },
  });
  const readyDir = fixture(t, readyPkg).dir;
  assert.equal(auditPackage(readyPkg, readyDir)[0].wouldShip, true);
  assert.ok(auditPackage(readyPkg, readyDir)[0].problems.includes('non-redistributable-would-ship'));
});

test('unknown licence is flagged', (t) => {
  const pkg = packageWith({
    kind: 'image',
    origin: 'stock',
    status: 'ready',
    file: 'assets/photo.jpg',
    license: { id: 'Totally-Not-A-Licence' },
    redistributable: true,
  });
  const { dir } = fixture(t, pkg, ['assets/photo.jpg']);
  const rows = auditPackage(pkg, dir);

  assert.ok(rows[0].problems.includes('unknown-license'));
  assert.equal(rows[0].licenseFamily, 'UNKNOWN');
});

test('CC BY without attribution is flagged when it would ship', (t) => {
  const pkg = packageWith({
    kind: 'image',
    origin: 'stock',
    status: 'ready',
    file: 'assets/photo.jpg',
    source: { provider: 'openverse' },
    license: { id: 'CC-BY-4.0', approved_by_user: true },
    redistributable: true,
  });
  const { dir } = fixture(t, pkg, ['assets/photo.jpg']);
  const rows = auditPackage(pkg, dir);

  assert.ok(rows[0].problems.includes('missing-attribution'));
  assert.ok(!rows[0].problems.includes('non-redistributable-would-ship'));
});

test('markdown output never contains absolute fixture paths', (t) => {
  const pkg = packageWith({
    kind: 'image',
    origin: 'generated',
    status: 'ready',
    file: 'assets/a.svg',
    license: { id: 'CC0-1.0' },
    redistributable: true,
  });
  const { dir } = fixture(t, pkg, ['assets/a.svg']);
  const markdown = renderCredits(auditPackage(pkg, dir));

  assert.ok(!markdown.includes(dir));
  assert.ok(!markdown.includes(tmpdir()));
  assert.ok(!markdown.includes('/tmp/'));
  assert.equal(auditPackage(pkg, dir)[0].package, dir.split('/').pop());
});

test('licence ids canonicalise and expose a family', () => {
  assert.equal(canonicalLicenseId('cc-by'), 'CC-BY-4.0');
  assert.equal(canonicalLicenseId('cc0'), 'CC0-1.0');
  assert.equal(canonicalLicenseId('CC-BY-NC-4.0'), 'CC-BY-NC-4.0');
  assert.equal(licenseFamily('CC-BY-NC-4.0'), 'CC-BY-NC');
  assert.equal(licenseFamily('LicenseRef-private-family'), 'CUSTOM');
  assert.equal(licenseFamily('Totally-Not-A-Licence'), 'UNKNOWN');
});

test('report summary counts packages, shipping assets and problems', (t) => {
  const pkg = packageWith({
    kind: 'image',
    origin: 'stock',
    status: 'ready',
    file: 'assets/photo.jpg',
    license: { id: 'CC-BY-NC-4.0' },
    redistributable: false,
  });
  const { dir } = fixture(t, pkg, ['assets/photo.jpg']);
  const report = buildReport(auditPackage(pkg, dir));

  assert.equal(report.summary.packages, 1);
  assert.equal(report.summary.assets, 1);
  assert.equal(report.summary.wouldShip, 1);
  assert.equal(report.summary.problems, 1);
  assert.equal(report.problems[0].code, 'non-redistributable-would-ship');
});

test('--check exits 1 on a problem and 0 when the package is clean', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'credits-audit-cli-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, 'scripts'), { recursive: true });
  mkdirSync(join(dir, 'examples', 'fixture', 'assets'), { recursive: true });
  copyFileSync(fileURLToPath(new URL('./credits-audit.mjs', import.meta.url)), join(dir, 'scripts', 'credits-audit.mjs'));
  writeFileSync(join(dir, 'examples', 'fixture', 'assets', 'photo.jpg'), 'fixture');

  const pkg = packageWith({
    kind: 'image',
    origin: 'stock',
    status: 'ready',
    file: 'assets/photo.jpg',
    license: { id: 'CC-BY-NC-4.0' },
    redistributable: false,
  });
  writeFileSync(join(dir, 'examples', 'fixture', 'package.json'), JSON.stringify(pkg));
  const failing = spawnSync(process.execPath, [join(dir, 'scripts', 'credits-audit.mjs'), '--check'], { cwd: dir, encoding: 'utf8' });
  assert.equal(failing.status, 1);
  assert.match(failing.stdout, /non-redistributable-would-ship/);
  assert.ok(!failing.stdout.includes(dir));

  pkg.assets.a_photo.license = { id: 'CC0-1.0' };
  pkg.assets.a_photo.origin = 'generated';
  pkg.assets.a_photo.redistributable = true;
  writeFileSync(join(dir, 'examples', 'fixture', 'package.json'), JSON.stringify(pkg));
  const passing = spawnSync(process.execPath, [join(dir, 'scripts', 'credits-audit.mjs'), '--check'], { cwd: dir, encoding: 'utf8' });
  assert.equal(passing.status, 0);
});
