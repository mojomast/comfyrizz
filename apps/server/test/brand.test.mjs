import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { prepareBrand, mergeBrandIntoPackage } from '../src/brand.mjs';
import { validatePackage } from '../../../packages/schema/src/index.mjs';

const repo = new URL('../../..', import.meta.url).pathname;
const readJson = path => JSON.parse(readFileSync(join(repo, path), 'utf8'));

test('B1: prepareBrand normalises the example kit', () => {
  const { kit, theme, warnings, assets } = prepareBrand(readJson('examples/brand-kit/brand.json'));
  assert.deepEqual(kit.palette, ['#0b1020', '#1b2a4a', '#f2b134', '#f4f6fb']);
  assert.equal(kit.fonts[0].family, 'Orbit Grotesk');
  assert.equal(kit.logo_asset, 'a_brandlogo0001');
  assert.equal(theme.font, 'Orbit Grotesk');
  assert.equal(theme.logo_asset, 'a_brandlogo0001');
  assert.deepEqual(warnings, []);
  assert.deepEqual(assets, {});
});

test('B1: unsafe brand input is dropped, not thrown', () => {
  const { kit, warnings } = prepareBrand({
    palette: ['nope', '#123456'],
    fonts: [{ family: 'X', file: 'assets/x.woff2', license: 'CC-BY-NC' }],
    logo: { filename: 'x.gif', dataBase64: 'AAAA' },
  });
  assert.deepEqual(kit.palette, ['#123456']);
  assert.equal(kit.fonts.length, 0);
  assert.equal(kit.logo_asset, undefined);
  const codes = warnings.map(warning => warning.code);
  assert.ok(codes.includes('BRAND_PALETTE_INVALID'));
  assert.ok(codes.includes('BRAND_FONT_UNSAFE_LICENSE'));
  assert.ok(codes.includes('BRAND_LOGO_INVALID'));
});

test('B1: the example package validates and points logo_asset at the SVG', () => {
  const pkg = readJson('examples/brand-kit/package.json');
  const validation = validatePackage(pkg);
  assert.equal(validation.valid, true, JSON.stringify(validation.errors));
  assert.deepEqual(pkg.theme.palette, ['#0b1020', '#1b2a4a', '#f2b134', '#f4f6fb']);
  assert.equal(pkg.assets[pkg.theme.logo_asset].file, 'assets/brand/logo.svg');
});

test('B1: mergeBrandIntoPackage writes the theme and uploaded logo asset', () => {
  const pkg = { id: 'p', theme: {}, assets: {}, scenes: [] };
  const prepared = prepareBrand({
    palette: ['#111111'],
    logo: { filename: 'l.png', dataBase64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==' },
  });
  const merged = mergeBrandIntoPackage(pkg, prepared);
  assert.deepEqual(merged.theme.palette, ['#111111']);
  assert.ok(merged.assets[prepared.kit.logo_asset]);
});
