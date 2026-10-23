// IP64F: WCAG 1.4.3 contrast for the take review filter chips.
//
// Brand tokens win over base tokens, exactly as they do in the app (brand.css
// is imported after tokens.css). The active chip must meet 4.5:1 for its text
// and its count (the count inherits colour), and must stay visually distinct
// from the inactive chip without raw colour literals.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

const tokensCss = readFileSync(new URL('../src/ui/tokens.css', import.meta.url), 'utf8');
const brandCss = readFileSync(new URL('../src/ui/brand.css', import.meta.url), 'utf8');
const panelCss = readFileSync(new URL('../src/takes/panel.css', import.meta.url), 'utf8');

function parseVars(text) {
  const vars = {};
  for (const m of text.matchAll(/--([\w-]+)\s*:\s*([^;]+);/g)) {
    vars[`--${m[1]}`] = m[2].trim();
  }
  return vars;
}

const vars = { ...parseVars(tokensCss), ...parseVars(brandCss) };

function resolve(value, seen = new Set()) {
  return value.replace(/var\(\s*(--[\w-]+)\s*\)/g, (whole, name) => {
    if (seen.has(name) || vars[name] === undefined) return whole;
    return resolve(vars[name], new Set([...seen, name]));
  }).trim();
}

function parseDeclarations(body) {
  const declarations = {};
  for (const m of body.matchAll(/([-\w]+)\s*:\s*([^;]+);?/g)) {
    declarations[m[1]] = m[2].trim();
  }
  return declarations;
}

function findRule(css, selector) {
  for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selectors = m[1].split(',').map(part => part.trim());
    if (selectors.includes(selector)) {
      return { selectors, body: m[2], declarations: parseDeclarations(m[2]) };
    }
  }
  return null;
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
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}

function colour(declarations, property) {
  assert.ok(declarations[property], `missing ${property} declaration`);
  const resolved = resolve(declarations[property]);
  assert.match(resolved, /^#[0-9a-f]{3,8}$/i, `${property} resolves to a hex colour, got "${resolved}"`);
  return resolved;
}

function borderColour(declarations) {
  if (declarations['border-color']) return colour(declarations, 'border-color');
  assert.ok(declarations.border, 'missing border declaration');
  const resolved = resolve(declarations.border);
  const hex = resolved.match(/#[0-9a-f]{3,8}\b/i);
  assert.ok(hex, `border resolves to a colour, got "${resolved}"`);
  return hex[0];
}

const active = findRule(panelCss, '.review-chip[aria-pressed="true"]');
const inactive = findRule(panelCss, '.review-chip');

test('IP64F: the active review chip text meets 4.5:1', () => {
  assert.ok(active, 'panel.css defines the active review chip rule');
  const foreground = colour(active.declarations, 'color');
  const background = colour(active.declarations, 'background');
  const ratio = contrast(foreground, background);
  console.log(`active review chip ${foreground} on ${background}: ${ratio.toFixed(2)}:1`);
  assert.ok(ratio >= 4.5, `active review chip is ${ratio.toFixed(2)}:1 (< 4.5)`);
});

test('IP64F: the inactive review chip text still meets 4.5:1', () => {
  assert.ok(inactive, 'panel.css defines the inactive review chip rule');
  const foreground = colour(inactive.declarations, 'color');
  const background = colour(inactive.declarations, 'background');
  const ratio = contrast(foreground, background);
  console.log(`inactive review chip ${foreground} on ${background}: ${ratio.toFixed(2)}:1`);
  assert.ok(ratio >= 4.5, `inactive review chip is ${ratio.toFixed(2)}:1 (< 4.5)`);
});

test('IP64F: the active review chip stays visually distinct from the inactive chip', () => {
  const activeBackground = colour(active.declarations, 'background');
  const inactiveBackground = colour(inactive.declarations, 'background');
  const activeBorder = borderColour(active.declarations);
  const inactiveBorder = borderColour(inactive.declarations);
  assert.ok(
    activeBackground !== inactiveBackground || activeBorder !== inactiveBorder,
    `active chip (${activeBackground}, ${activeBorder}) must differ from inactive (${inactiveBackground}, ${inactiveBorder})`,
  );
});

test('IP64F: the active review chip uses tokens, not raw colour literals', () => {
  assert.doesNotMatch(active.body, /#[0-9a-f]{3,8}\b/i, 'no raw hex literal');
  assert.doesNotMatch(active.body, /\brgba?\s*\(/i, 'no raw rgb/rgba literal');
});
