// IL21: contrast, focus, and live announcements for the iteration surfaces.
//
// New and changed foreground/background pairs from the Easy picker, the
// Advanced grid, compare, and voice A/B must be at least 4.5:1. Focus is
// visible, and choosing a level or keeping a take is announced. Colour is
// never the only signal. tokens.css changes only when a pair fails.
// @ts-nocheck
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  iterationLevelAnnouncement,
  iterationCardOnKey,
  iterationPresets,
  readIterationCard,
  renderIterationCard,
} from '../src/productions/cards/iteration-card.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const tokensCss = readFileSync(join(root, 'src/ui/tokens.css'), 'utf8');
const cardCss = readFileSync(join(root, 'src/productions/cards/iteration-card.css'), 'utf8');
const advancedCss = readFileSync(join(root, 'src/productions/cards/iteration-advanced.css'), 'utf8');
const panelCss = readFileSync(join(root, 'src/takes/panel.css'), 'utf8');
const charactersCss = readFileSync(join(root, 'src/characters/characters.css'), 'utf8');
const compareSource = readFileSync(join(root, 'src/takes/compare.ts'), 'utf8');
const auditionSource = readFileSync(join(root, 'src/characters/audition-panel.ts'), 'utf8');

const MIN_CONTRAST = 4.5;

function tokenColors(css) {
  const colors = new Map();
  const pattern = /--([a-z0-9-]+):\s*(#[0-9a-fA-F]{6})\b/g;
  for (const match of css.matchAll(pattern)) colors.set(match[1], match[2].toLowerCase());
  return colors;
}

function channel(hex, offset) {
  const value = Number.parseInt(hex.slice(offset, offset + 2), 16) / 255;
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}

function contrast(foreground, background) {
  const luminance = (hex) => (
    0.2126 * channel(hex, 1) + 0.7152 * channel(hex, 3) + 0.0722 * channel(hex, 5)
  );
  const lighter = Math.max(luminance(foreground), luminance(background));
  const darker = Math.min(luminance(foreground), luminance(background));
  return (lighter + 0.05) / (darker + 0.05);
}

function sameRulePairs(css) {
  const pairs = [];
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const rules = withoutComments.matchAll(/([^{}]+)\{([^{}]+)\}/g);
  for (const rule of rules) {
    const body = rule[2];
    const color = body.match(/(?<![\w-])color:\s*var\(--([a-z0-9-]+)/);
    const background = body.match(/(?<![\w-])background:\s*var\(--([a-z0-9-]+)/);
    if (!color || !background) continue;
    pairs.push({
      selector: rule[1].trim().replace(/\s+/g, ' '),
      foreground: color[1],
      background: background[1],
    });
  }
  return pairs;
}

const COLORS = tokenColors(tokensCss);

function requirePair(pairs, foreground, background, label) {
  const found = pairs.some((pair) => pair.foreground === foreground && pair.background === background);
  assert.equal(found, true, `${label} should declare ${foreground} on ${background}`);
}

test('new iteration, compare, and audition pairs are at least 4.5:1', () => {
  const cardPairs = sameRulePairs(cardCss);
  const advancedPairs = sameRulePairs(advancedCss);
  const compareStart = panelCss.indexOf('IL19: compare takes');
  assert.ok(compareStart > 0, 'compare section should be marked');
  const comparePairs = sameRulePairs(panelCss.slice(compareStart));
  const auditionStart = charactersCss.indexOf('IL20: A/B voice comparison');
  assert.ok(auditionStart > 0, 'audition A/B section should be marked');
  const auditionPairs = sameRulePairs(charactersCss.slice(auditionStart));

  requirePair(cardPairs, 'text-1', 'bg-1', 'iteration card');
  requirePair(cardPairs, 'text-1', 'bg-2', 'iteration choice');
  requirePair(cardPairs, 'danger', 'danger-bg', 'exceeds badge');
  requirePair(advancedPairs, 'text-1', 'bg-0', 'advanced field');
  requirePair(advancedPairs, 'text-1', 'warn-bg', 'locked shot');
  requirePair(comparePairs, 'text-1', 'bg-1', 'compare view');
  requirePair(comparePairs, 'accent-fg', 'accent', 'pressed compare control');
  requirePair(comparePairs, 'text-1', 'bg-2', 'compare state');

  const inherited = [
    { label: 'highlighted choice', foreground: 'text-1', background: 'accent-bg', evidence: '.iteration-choice.is-highlighted' },
    { label: 'disabled choice', foreground: 'text-2', background: 'bg-2', evidence: '.iteration-choice[aria-disabled="true"]' },
    { label: 'compare secondary text', foreground: 'text-2', background: 'bg-1', evidence: '.compare-shot' },
    { label: 'compare error', foreground: 'danger', background: 'bg-1', evidence: '.compare-error' },
    { label: 'audition name', foreground: 'text-1', background: 'bg-1', evidence: '.chr-audition-name' },
    { label: 'audition slot', foreground: 'text-2', background: 'bg-1', evidence: '.chr-audition-row[data-ab-slot]::before' },
  ];
  for (const pair of inherited) {
    const haystack = `${cardCss}\n${advancedCss}\n${panelCss}\n${charactersCss}`;
    assert.ok(haystack.includes(pair.evidence), `${pair.label} selector should exist`);
  }

  const pairs = [...cardPairs, ...advancedPairs, ...comparePairs, ...auditionPairs, ...inherited];
  assert.ok(pairs.length >= 8, 'the surfaces should contribute several pairs');
  for (const pair of pairs) {
    const foreground = COLORS.get(pair.foreground);
    const background = COLORS.get(pair.background);
    assert.ok(foreground, `missing token --${pair.foreground}`);
    assert.ok(background, `missing token --${pair.background}`);
    const ratio = contrast(foreground, background);
    assert.ok(
      ratio >= MIN_CONTRAST,
      `${pair.selector ?? pair.label}: ${pair.foreground} ${foreground} on ${pair.background} ${background} is ${ratio.toFixed(2)}:1`,
    );
  }
});

test('focus is visible and motion can be reduced', () => {
  assert.match(cardCss, /\.iteration-choice:focus-visible/);
  assert.match(cardCss, /outline:\s*var\(--focus-ring\)/);
  assert.match(cardCss, /outline-offset:\s*var\(--focus-offset\)/);
  assert.match(advancedCss, /\.iteration-advanced button:focus-visible/);
  assert.match(advancedCss, /\.iteration-advanced input:focus-visible/);
  assert.match(advancedCss, /\.iteration-advanced select:focus-visible/);
  assert.match(panelCss, /\.compare-take:focus-visible/);
  assert.match(charactersCss, /\.chr-btn:focus-visible/);
  assert.match(auditionSource, /data-focus-ring="visible"/);
  assert.match(cardCss, /@media \(prefers-reduced-motion:\s*reduce\)/);
  assert.match(advancedCss, /@media \(prefers-reduced-motion:\s*reduce\)/);
  assert.match(panelCss, /@media \(prefers-reduced-motion:\s*reduce\)/);
});

test('choosing a level and keeping a take is announced', () => {
  for (const choice of ['draft', 'balanced', 'director', 'custom', 'recommended']) {
    const announcement = iterationLevelAnnouncement(choice);
    const label = choice === 'recommended' ? 'Recommended' : choice[0].toUpperCase() + choice.slice(1);
    assert.match(announcement, new RegExp(`^${label} selected\\.`));
    assert.match(announcement, /You still approve each spend/);
    assert.equal(announcement.includes('plan.approve'), false);
  }

  const preset = iterationPresets().balanced;
  const read = {
    policy: null,
    level: null,
    estimates: {
      draft: estimate(),
      balanced: estimate(),
      director: estimate(),
    },
    recommendation: { level: 'balanced', policy: preset, reasons: ['no history: balanced'] },
    prefill: null,
    lockedShotIds: [],
    revision: 1,
  };
  const model = readIterationCard(read);
  assert.equal(model.selected, null);
  const keyed = iterationCardOnKey(model, 'ArrowLeft');
  assert.equal(keyed.choice, 'director');
  assert.match(keyed.model.live, /Director selected/);
  assert.match(keyed.model.live, /You still approve each spend/);
  const html = renderIterationCard(keyed.model);
  assert.match(html, /role="status"/);
  assert.match(html, /aria-live="polite"/);
  assert.match(html, /Director selected/);

  assert.match(compareSource, /role="status"/);
  assert.match(compareSource, /aria-live="polite"/);
  assert.match(compareSource, /Kept \$\{label\}\./);
  assert.match(auditionSource, /role="status"/);
  assert.match(auditionSource, /Voice selected\./);
});

function estimate() {
  return {
    gpuMinutes: { low: 1, expected: 2, high: 3 },
    units: { low: 1, expected: 2, high: 3 },
    wallMinutes: { low: 5, expected: 6, high: 8 },
    voiceSamples: 0,
    vsCap: { ceiling: null, fraction: null, status: 'no_cap' },
    labels: ['estimate; other sessions may be running'],
  };
}
