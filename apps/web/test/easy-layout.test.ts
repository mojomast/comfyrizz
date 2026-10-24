// @ts-nocheck
// UI2-11: Early studio steps (Idea and Characters) wide layout testing.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { defaultEasyState } from '../src/easy/store.ts';
import { step as ideaStep } from '../src/easy/steps/idea.ts';
import { renderCharacters } from '../src/easy/steps/characters.ts';

const easyCss = readFileSync(new URL('../src/easy/easy.css', import.meta.url), 'utf8');
const ideaCss = readFileSync(new URL('../src/easy/steps/idea.css', import.meta.url), 'utf8');
const charactersCss = readFileSync(new URL('../src/easy/steps/characters.css', import.meta.url), 'utf8');

function extractMediaBlock(css, query) {
  const queryIndex = css.indexOf(query);
  if (queryIndex === -1) return null;
  const start = css.indexOf('{', queryIndex);
  if (start === -1) return null;
  let depth = 1;
  let end = start + 1;
  while (depth > 0 && end < css.length) {
    if (css[end] === '{') depth++;
    else if (css[end] === '}') depth--;
    end++;
  }
  return css.slice(start + 1, end - 1);
}

function parseRuleProperties(block, selector) {
  const selIndex = block.indexOf(selector);
  if (selIndex === -1) return null;
  const start = block.indexOf('{', selIndex);
  if (start === -1) return null;
  const end = block.indexOf('}', start);
  if (end === -1) return null;
  const body = block.slice(start + 1, end);
  const props = {};
  for (const decl of body.split(';')) {
    const colon = decl.indexOf(':');
    if (colon === -1) continue;
    const prop = decl.slice(0, colon).trim();
    const val = decl.slice(colon + 1).trim();
    if (prop) props[prop] = val;
  }
  return props;
}

test('easy-main has a base max-width of 880px for standard/tablet viewports', () => {
  // Before any wide breakpoint, easy-main must maintain its baseline max-width
  const baseBlock = easyCss.slice(0, easyCss.indexOf('@media'));
  const baseProps = parseRuleProperties(baseBlock, '.easy-main');
  assert.ok(baseProps, '.easy-main should be defined before media queries');
  assert.equal(baseProps['max-width'], '880px');
});

test('easy.css expands easy-main to at least 1000px at >=1024px (UI2-11)', () => {
  const media1024 = extractMediaBlock(easyCss, '@media (min-width: 1024px)');
  assert.ok(media1024, '@media (min-width: 1024px) block should exist in easy.css');

  const mainProps = parseRuleProperties(media1024, '.easy-main');
  assert.ok(mainProps, '.easy-main should be styled in @media (min-width: 1024px)');
  assert.ok(mainProps['max-width'], '.easy-main must have max-width in @media (min-width: 1024px)');

  const match = mainProps['max-width'].match(/^(\d+)px$/);
  assert.ok(match, `.easy-main max-width (${mainProps['max-width']}) should be in px format`);

  const width = parseInt(match[1], 10);
  assert.ok(
    width >= 1000,
    `Expected easy-main max-width at >=1024px to be ~1000px or wider, but was ${width}px`,
  );
  assert.ok(
    width <= 1120,
    `Expected easy-main max-width at >=1024px not to exceed the 1440px max-width (1120px), but was ${width}px`,
  );
});

test('easy.css maintains progressive wide screen max-width at >=1440px', () => {
  const media1440 = extractMediaBlock(easyCss, '@media (min-width: 1440px)');
  assert.ok(media1440, '@media (min-width: 1440px) block should exist in easy.css');

  const mainProps = parseRuleProperties(media1440, '.easy-main');
  assert.ok(mainProps, '.easy-main should be styled in @media (min-width: 1440px)');
  assert.equal(mainProps['max-width'], '1120px');
});

test('idea and characters steps render inside container without restrictive max-width', () => {
  const state = defaultEasyState();
  const facts = {
    hasPackage: false,
    planApproved: false,
    actionsActive: false,
    allShotsKept: false,
    exportCurrent: false,
  };

  const ideaHtml = ideaStep.render(state, facts);
  assert.match(ideaHtml, /class="[^"]*\beasy-idea\b/);

  // idea.css should not restrict the whole idea container to a narrow fixed max-width
  const ideaContainerProps = parseRuleProperties(ideaCss, '.easy-idea');
  if (ideaContainerProps && ideaContainerProps['max-width']) {
    const w = parseInt(ideaContainerProps['max-width'], 10);
    assert.ok(w >= 1000, `If .easy-idea sets max-width, it should be >= 1000px, but was ${w}px`);
  }

  const charactersHtml = renderCharacters(state);
  assert.match(charactersHtml, /class="[^"]*\beasy-characters\b/);

  // characters.css should not restrict the whole characters container to a narrow fixed max-width
  const charContainerProps = parseRuleProperties(charactersCss, '.easy-characters');
  if (charContainerProps && charContainerProps['max-width']) {
    const w = parseInt(charContainerProps['max-width'], 10);
    assert.ok(w >= 1000, `If .easy-characters sets max-width, it should be >= 1000px, but was ${w}px`);
  }
});

test('easy-main opts out of the global main grid (UI2-11 root cause)', () => {
  const baseBlock = easyCss.slice(0, easyCss.indexOf('@media'));
  const baseProps = parseRuleProperties(baseBlock, '.easy-main');
  assert.ok(baseProps, '.easy-main should be defined before media queries');
  assert.equal(baseProps['display'], 'block');
});
