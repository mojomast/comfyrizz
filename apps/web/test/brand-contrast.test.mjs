import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));
const tokensCss = readFileSync(new URL('../src/ui/tokens.css', import.meta.url), 'utf8');
const brandCss = readFileSync(new URL('../src/ui/brand.css', import.meta.url), 'utf8');

function parseVars(text) {
  const vars = {};
  for (const m of text.matchAll(/--([\w-]+)\s*:\s*([^;]+);/g)) {
    vars[`--${m[1]}`] = m[2].trim();
  }
  return vars;
}

const vars = { ...parseVars(tokensCss), ...parseVars(brandCss) };

function resolve(value, seen = new Set()) {
  const m = value.trim().match(/^var\((--[\w-]+)\)$/);
  if (m) {
    if (seen.has(m[1])) return value.trim();
    seen.add(m[1]);
    if (vars[m[1]] === undefined) return value.trim();
    return resolve(vars[m[1]], seen);
  }
  return value.trim();
}

function hexToRgb(hex) {
  const h = hex.replace('#', '');
  const full = h.length === 3 ? h.split('').map(c => c + c).join('') : h;
  return {
    r: parseInt(full.slice(0, 2), 16),
    g: parseInt(full.slice(2, 4), 16),
    b: parseInt(full.slice(4, 6), 16),
  };
}

function channel(c) {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
}

function luminance(hex) {
  const { r, g, b } = hexToRgb(hex);
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function contrast(fg, bg) {
  const l1 = luminance(fg);
  const l2 = luminance(bg);
  const hi = Math.max(l1, l2);
  const lo = Math.min(l1, l2);
  return (hi + 0.05) / (lo + 0.05);
}

function color(name) {
  return resolve(vars[name]);
}

const surfaces = ['--bg-0', '--bg-1', '--bg-2', '--bg-3'];

test('BR03: body text contrast >= 4.5:1 on every surface', () => {
  for (const text of ['--text-1', '--text-2', '--text-3']) {
    for (const surf of surfaces) {
      const ratio = contrast(color(text), color(surf));
      console.log(`body text ${text} on ${surf}: ${ratio.toFixed(2)}:1`);
      assert.ok(ratio >= 4.5, `${text} on ${surf} is ${ratio.toFixed(2)}:1 (< 4.5)`);
    }
  }
});

test('BR03: UI borders >= 3:1 on every surface', () => {
  for (const border of ['--border', '--border-subtle', '--border-strong', '--accent-border']) {
    for (const surf of surfaces) {
      const ratio = contrast(color(border), color(surf));
      console.log(`border ${border} on ${surf}: ${ratio.toFixed(2)}:1`);
      assert.ok(ratio >= 3, `${border} on ${surf} is ${ratio.toFixed(2)}:1 (< 3)`);
    }
  }
});

test('BR03: UI accent foregrounds >= 3:1', () => {
  const violetOnInk = contrast(color('--brand-violet'), color('--brand-ink'));
  console.log(`violet on ink (not small text): ${violetOnInk.toFixed(2)}:1`);
  const paperOnViolet = contrast(color('--accent-fg'), color('--accent'));
  console.log(`accent-fg on accent: ${paperOnViolet.toFixed(2)}:1`);
  assert.ok(paperOnViolet >= 3, `accent-fg on accent is ${paperOnViolet.toFixed(2)}:1 (< 3)`);
  const inkOnMint = contrast(color('--highlight-fg'), color('--highlight'));
  console.log(`highlight-fg on highlight (mint): ${inkOnMint.toFixed(2)}:1`);
  assert.ok(inkOnMint >= 3, `highlight-fg on highlight is ${inkOnMint.toFixed(2)}:1 (< 3)`);
});

test('BR03: focus ring >= 3:1 against its surface', () => {
  for (const surf of surfaces) {
    const ratio = contrast(color('--focus-ring-color'), color(surf));
    console.log(`focus-ring on ${surf}: ${ratio.toFixed(2)}:1`);
    assert.ok(ratio >= 3, `focus-ring on ${surf} is ${ratio.toFixed(2)}:1 (< 3)`);
  }
});

test('BR03: violet is not used as body text on ink', () => {
  assert.notEqual(color('--text-1').toLowerCase(), color('--brand-violet').toLowerCase());
  assert.notEqual(color('--text-2').toLowerCase(), color('--brand-violet').toLowerCase());
  assert.notEqual(color('--text-3').toLowerCase(), color('--brand-violet').toLowerCase());
});
