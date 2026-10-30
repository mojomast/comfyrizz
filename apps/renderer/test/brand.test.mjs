import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { DEFAULT_FONT_FAMILY, brandFontEntries, brandFontFamily } from '../src/theme-model.js';

const here = dirname(fileURLToPath(import.meta.url));
const rendererDir = join(here, '..');
const read = file => readFileSync(join(rendererDir, 'src', file), 'utf8');

test('B1: brandFontEntries keeps only family+file and brandFontFamily falls back to Inter', () => {
  assert.deepEqual(brandFontEntries(undefined), []);
  assert.deepEqual(
    brandFontEntries({
      theme: {
        font: 'Inter',
        fonts: [{ family: '  Söhne ', file: ' assets/s.woff2 ', weight: 700 }, { family: 'NoFile' }, { file: 'x' }],
      },
    }),
    [{ family: 'Söhne', file: 'assets/s.woff2', weight: 700 }],
  );
  assert.equal(brandFontFamily({ theme: { fonts: [{ family: 'Söhne', file: 'assets/s.woff2' }] } }), 'Söhne');
  assert.equal(brandFontFamily({ theme: { font: 'Inter' } }), 'Inter');
  assert.equal(brandFontFamily({}), DEFAULT_FONT_FAMILY);
});

test('B1: the renderer loads the brand fonts and typesets with the brand family', () => {
  const theme = read('theme.ts');
  assert.match(theme, /export function ensureBrandFonts/);
  assert.match(theme, /const url = previewSources == null \? staticFile\(font\.file\) : previewSources\[font\.file\]/);
  assert.match(theme, /if \(!url\) continue/);
  assert.match(theme, /FontFamilyContext\.Provider|FontFamilyContext = createContext/);
  const player = read('player.tsx');
  assert.match(player, /ensureBrandFonts\(pkg, fontSources\)/);
  assert.match(player, /FontFamilyContext\.Provider/);
  assert.match(player, /brandFontFamily\(pkg\)/);
});

test('B1: a title/outro logo comes from theme.logo_asset and hides when broken', () => {
  const components = read('components.tsx');
  assert.match(components, /function BrandLogo\(/);
  assert.match(components, /pkg\.theme\?\.logo_asset/);
  assert.match(components, /staticFile\(asset\.file\)/);
  assert.match(components, /<BrandLogo pkg=\{pkg\} \/>/);
  assert.match(components, /onError=\{\(\) => setFailed\(true\)\}/);
});
