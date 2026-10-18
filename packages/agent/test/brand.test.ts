import assert from 'node:assert/strict';
import test from 'node:test';
import {
  BRAND_FALLBACK_FONT,
  applyBrandKit,
  brandBriefStyle,
  brandStyleBlock,
  brandTheme,
  completeBrief,
  createToolset,
  effectiveFont,
  isSafeFontLicense,
  normalizeBrandKit,
} from '../src/index.js';

const safeFont = { family: 'Söhne', file: 'brand/soehne.woff2', license: 'OFL-1.1' };

test('B1: a palette is normalised to lowercase hexes, deduped and capped', () => {
  const { kit, warnings } = normalizeBrandKit({
    palette: ['#AABBCC', '#aabbcc', 'not-a-colour', '#112233', '#112234', '#112235', '#112236', '#112237', '#112238', '#112239', '#112240'],
  });
  assert.deepEqual(kit.palette, ['#aabbcc', '#112233', '#112234', '#112235', '#112236', '#112237', '#112238', '#112239']);
  assert.equal(kit.palette.length, 8);
  assert.ok(warnings.some(warning => warning.code === 'BRAND_PALETTE_INVALID' && warning.field === 'palette[2]'));
  assert.ok(warnings.some(warning => warning.code === 'BRAND_PALETTE_TRUNCATED'));
});

test('B1: only fonts with a file and a safe licence are kept; everything else falls back to Inter', () => {
  const { kit, warnings } = normalizeBrandKit({
    fonts: [
      safeFont,
      { family: 'NoFile', license: 'OFL-1.1' },
      { family: 'Unsafe', file: 'brand/unsafe.woff2', license: 'CC-BY-NC-4.0' },
      { family: 'NoLicence', file: 'brand/x.woff2' },
      { family: 'söhne', file: 'brand/soehne-bold.woff2', license: 'Apache-2.0' },
      { family: 'Arial' },
    ],
  });
  assert.deepEqual(kit.fonts, [{ family: 'Söhne', file: 'brand/soehne.woff2', license: 'OFL-1.1' }]);
  const codes = warnings.map(warning => warning.code);
  assert.ok(codes.includes('BRAND_FONT_INVALID'));
  assert.ok(codes.includes('BRAND_FONT_UNSAFE_LICENSE'));
  assert.ok(codes.includes('BRAND_FONT_DUPLICATE'));
  assert.equal(effectiveFont(kit), 'Söhne');
  assert.equal(effectiveFont(normalizeBrandKit({ fonts: [{ family: 'Unsafe', file: 'x', license: 'CC-BY-NC-4.0' }] }).kit), BRAND_FALLBACK_FONT);
  assert.equal(isSafeFontLicense('OFL-1.1'), true);
  assert.equal(isSafeFontLicense('CC-BY-NC-4.0'), false);
  assert.equal(isSafeFontLicense(undefined), false);
});

test('B1: a kit maps to a package theme and an uploaded logo must be a valid asset id', () => {
  const { kit, warnings } = normalizeBrandKit({ palette: ['#0d0f14'], fonts: [safeFont], logo_asset: 'brand-logo' });
  assert.equal(kit.logo_asset, undefined);
  assert.ok(warnings.some(warning => warning.code === 'BRAND_LOGO_INVALID'));

  const { kit: ok } = normalizeBrandKit({ palette: ['#0d0f14'], fonts: [safeFont], logo_asset: 'a_logo' });
  assert.deepEqual(brandTheme(ok), {
    palette: ['#0d0f14'],
    font: 'Söhne',
    fonts: [{ family: 'Söhne', file: 'brand/soehne.woff2', license: { id: 'OFL-1.1' } }],
    logo_asset: 'a_logo',
  });
  // No safe fonts → no font/fonts keys, so an existing theme keeps its own font.
  assert.deepEqual(brandTheme(normalizeBrandKit({ palette: ['#0d0f14'] }).kit), { palette: ['#0d0f14'] });
});

test('B1: applying a kit merges into the theme without mutating the package', () => {
  const pkg: { id: string; theme: Record<string, unknown>; scenes: unknown[] } = { id: 'p', theme: { font: 'Inter', text: '#ffffff' }, scenes: [] };
  const { kit } = normalizeBrandKit({ palette: ['#112233'], fonts: [safeFont], logo_asset: 'a_logo' });
  const next = applyBrandKit(pkg, kit);
  assert.deepEqual(pkg.theme, { font: 'Inter', text: '#ffffff' });
  assert.equal(next.theme.font, 'Söhne');
  assert.deepEqual(next.theme.palette, ['#112233']);
  assert.equal(next.theme.logo_asset, 'a_logo');
  assert.equal(next.theme.text, '#ffffff');
});

test('B1: the brand palette and font override the preset, but an explicit draft style wins', () => {
  const { kit } = normalizeBrandKit({ palette: ['#112233'], fonts: [safeFont] });
  const fromBrand = brandBriefStyle({ preset: 'clay' }, kit);
  assert.deepEqual(fromBrand.palette, ['#112233']);
  assert.equal(fromBrand.font, 'Söhne');

  const explicit = brandBriefStyle({ preset: 'clay', palette: ['#abcdef'], font: 'Georgia' }, kit);
  assert.deepEqual(explicit.palette, ['#abcdef']);
  assert.equal(explicit.font, 'Georgia');

  const presetOnly = brandBriefStyle({ preset: 'clay' });
  assert.equal(presetOnly.font, 'Inter');
  assert.ok((presetOnly.palette ?? []).length > 0);
});

test('B1: the generation style block is deterministic and follows the kit palette', () => {
  const { kit } = normalizeBrandKit({ palette: ['#112233', '#445566'], attributes: 'flat print look' });
  const block = brandStyleBlock('editorial-flat', kit);
  assert.equal(block, brandStyleBlock('editorial-flat', kit));
  assert.match(block, /^Flat print look;/);
  assert.match(block, /palette #112233, #445566/);
  assert.match(block, /every surface is blank and unmarked\.$/);

  const presetBlock = brandStyleBlock('clay');
  assert.match(presetBlock, /palette #f4e9dd, #c98a6b, #6d4b3a, #2b2320/);
});

test('B1: a completed brief and a proposed package both take the brand theme', () => {
  const { kit } = normalizeBrandKit({ palette: ['#112233', '#445566'], fonts: [safeFont], logo_asset: 'a_logo' });

  const brief = completeBrief({}, brandBriefStyle({ preset: 'editorial-flat' }, kit));
  assert.deepEqual(brief.style.palette, ['#112233', '#445566']);
  assert.equal(brief.style.font, 'Söhne');

  const tools = createToolset({ brand: kit, now: () => '2026-01-01T00:00:00.000Z' });
  const result = tools['storyboard.propose']!.run({ brief: 'Launch the brand kit' }) as { package: Record<string, any> };
  assert.deepEqual(result.package.theme.palette, ['#112233', '#445566']);
  assert.equal(result.package.theme.font, 'Söhne');
  assert.equal(result.package.theme.logo_asset, 'a_logo');
  assert.deepEqual(result.package.theme.fonts, [{ family: 'Söhne', file: 'brand/soehne.woff2', license: { id: 'OFL-1.1' } }]);
});
