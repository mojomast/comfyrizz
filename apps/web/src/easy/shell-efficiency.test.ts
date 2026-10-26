// @ts-nocheck
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = relative => readFileSync(new URL(relative, import.meta.url), 'utf8');
const stripComments = css => css.replace(/\/\*[\s\S]*?\*\//g, '');

function ruleBodies(css, selector) {
  const source = stripComments(css);
  const matcher = /([^{}]+)\{([^{}]*)\}/g;
  const bodies = [];
  let match;
  while ((match = matcher.exec(source)) !== null) {
    if (match[1].trim() === selector) bodies.push(match[2]);
  }
  return bodies;
}

function declarations(css, selector) {
  return ruleBodies(css, selector).join('\n');
}

function atRuleBodies(css, header) {
  const source = stripComments(css);
  const bodies = [];
  let index = 0;
  while ((index = source.indexOf(header, index)) !== -1) {
    const open = source.indexOf('{', index);
    if (open === -1) break;
    let depth = 0;
    let end = open;
    for (; end < source.length; end += 1) {
      if (source[end] === '{') depth += 1;
      else if (source[end] === '}') {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    bodies.push(source.slice(open + 1, end));
    index = end + 1;
  }
  return bodies;
}

function selectorsIn(block) {
  const selectors = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < block.length; index += 1) {
    const char = block[index];
    if (char === '{') {
      if (depth === 0) selectors.push(block.slice(start, index).trim());
      depth += 1;
    } else if (char === '}') {
      depth -= 1;
      if (depth === 0) start = index + 1;
    }
  }
  return selectors.filter(Boolean);
}

test('the Easy action footer is in flow, safe-area aware and never fixed over controls', () => {
  const easy = read('./easy.css');
  const mobile = read('./easy-mobile.css');

  for (const [name, css] of [['easy.css', easy], ['easy-mobile.css', mobile]]) {
    const actions = declarations(css, '.easy-actions');
    assert.ok(actions.length > 0, `${name} styles the action footer`);
    assert.doesNotMatch(actions, /position:\s*fixed/u, `${name} keeps the footer in flow`);
    assert.match(actions, /env\(safe-area-inset-bottom/u, `${name} respects the bottom safe area`);
    assert.match(actions, /flex-wrap:\s*wrap/u, `${name} lets the footer wrap`);
  }

  const base = declarations(easy, '.easy-actions');
  assert.match(base, /position:\s*static/u);
  assert.match(base, /margin-block-start:\s*auto/u);
  assert.match(base, /padding-inline:\s*max\(/u);
});

test('long errors and last focused controls stay reachable at 320px and zoom', () => {
  const easy = read('./easy.css');
  const mobile = read('./easy-mobile.css');

  const main = declarations(easy, '.easy-main');
  assert.match(main, /scroll-padding-block-end:\s*calc\(/u);
  assert.match(main, /env\(safe-area-inset-bottom/u);

  const focus = declarations(easy, '.easy-shell :focus-visible');
  assert.match(focus, /scroll-margin-block:\s*/u);

  for (const selector of ['.easy-status', '.easy-reason']) {
    const text = declarations(easy, selector);
    assert.match(text, /min-width:\s*0/u, `${selector} can shrink`);
    assert.match(text, /overflow-wrap:\s*anywhere/u, `${selector} wraps long errors`);
  }
  assert.match(declarations(easy, '.easy-reason'), /max-width:\s*min\(34ch,\s*100%\)/u);
  assert.match(declarations(easy, '.easy-primary'), /max-width:\s*100%/u);
  assert.match(declarations(easy, '.easy-step-body'), /order:\s*2/u);

  assert.match(mobile, /@media \(max-width: 30rem\)/u);
  assert.match(mobile, /@media \(max-width: 20rem\)/u);
  assert.match(declarations(mobile, '.easy-reason'), /flex:\s*1 1 100%/u);
  assert.match(declarations(mobile, '.easy-primary'), /white-space:\s*normal/u);
});

test('reduced UI motion stays on shell chrome and never selects authored video', () => {
  const files = [
    ['easy.css', read('./easy.css')],
    ['easy-mobile.css', read('./easy-mobile.css')],
    ['toast.css', read('../shell/toast.css')],
  ];
  const reduced = [];

  for (const [name, css] of files) {
    const blocks = atRuleBodies(css, '@media (prefers-reduced-motion: reduce)');
    assert.ok(blocks.length > 0, `${name} honours reduced motion`);
    for (const block of blocks) {
      assert.match(block, /scroll-behavior:\s*auto/u, `${name} disables smooth scrolling`);
      for (const selector of selectorsIn(block)) {
        assert.doesNotMatch(selector, /(?:video|canvas|iframe|#player|data-easy-player|remotion)/iu,
          `${name} reduced motion must not select authored media: ${selector}`);
        assert.match(selector, /^\.(?:easy-shell|shell-toast)/u,
          `${name} reduced motion is scoped to shell chrome: ${selector}`);
      }
      reduced.push(...selectorsIn(block));
    }
  }

  assert.ok(reduced.some(selector => selector.startsWith('.easy-shell')));
  assert.ok(reduced.some(selector => selector.startsWith('.shell-toast')));
});

test('toast chrome is safe-area aware and wraps messages and actions', () => {
  const css = read('../shell/toast.css');
  const region = declarations(css, '.shell-toast-region');
  assert.match(region, /position:\s*fixed/u);
  assert.match(region, /env\(safe-area-inset-bottom/u);
  assert.match(region, /env\(safe-area-inset-left/u);
  assert.match(region, /env\(safe-area-inset-right/u);
  assert.match(region, /max-width:\s*min\(420px,\s*100%\)/u);
  assert.match(region, /pointer-events:\s*none/u);

  const toast = declarations(css, '.shell-toast');
  assert.match(toast, /pointer-events:\s*auto/u);
  assert.match(toast, /flex-wrap:\s*wrap/u);
  assert.match(toast, /max-width:\s*100%/u);
  assert.match(toast, /overflow-wrap:\s*anywhere/u);

  const message = declarations(css, '.shell-toast-message');
  assert.match(message, /min-width:\s*0/u);
  assert.match(message, /overflow-wrap:\s*anywhere/u);

  assert.match(declarations(css, '.shell-toast-actions'), /flex-wrap:\s*wrap/u);
  assert.match(declarations(css, '.shell-toast .btn:focus-visible'), /outline:\s*var\(--focus-ring/u);
});
