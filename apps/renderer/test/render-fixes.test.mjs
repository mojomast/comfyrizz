/**
 * Regression tests for the five bugs the overnight example run found (DOLAN
 * 23:55, reproduced in /workspace/comfy-hackathon/overnight/EXAMPLES.md).
 *
 * The renderer's layers are React components and the suite has no DOM, so each
 * test asserts the exact structure the fix relies on in the shipped source.
 * The StatLayout case also exercises the extracted `stat-model.js` directly.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { statLines } from '../src/stat-model.js';

const here = dirname(fileURLToPath(import.meta.url));
const srcDir = join(here, '..', 'src');
const source = name => readFileSync(join(srcDir, name), 'utf8');

/** Grab a top-level function by name, balanced on braces. */
function functionBody(text, name) {
  const start = text.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `function ${name} not found`);
  // Skip the parameter list first: a destructured `{ ... }` param must not be
  // mistaken for the function body.
  let depth = 0;
  let i = text.indexOf('(', start);
  for (; i < text.length; i += 1) {
    if (text[i] === '(') depth += 1;
    else if (text[i] === ')') {
      depth -= 1;
      if (depth === 0) break;
    }
  }
  depth = 0;
  for (let j = text.indexOf('{', i); j < text.length; j += 1) {
    if (text[j] === '{') depth += 1;
    else if (text[j] === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(start, j + 1);
    }
  }
  assert.fail(`unbalanced braces in ${name}`);
}

test('N10: an image background is wrapped so it cannot push layout copy out of frame', () => {
  const body = functionBody(source('media.tsx'), 'MediaFill');
  const imageLine = body.split('\n').find(line => line.includes("asset.kind === 'image'"));
  assert.ok(imageLine, 'MediaFill must branch on image assets');
  assert.match(imageLine, /<AbsoluteFill>/, 'the <Img> must sit inside an AbsoluteFill so it leaves the layout flex flow');
  assert.match(imageLine, /<Img\b/, 'the image branch must still render <Img>');
  assert.doesNotMatch(imageLine, /OffthreadVideo/, 'the video path must stay separate');
});

test('N11: captions sit above scene scrims and foreground panels', () => {
  const body = functionBody(source('captions.tsx'), 'CaptionOverlay');
  assert.match(body, /zIndex:\s*100/, 'the caption overlay needs zIndex 100 to clear scrims (z 2) and panels (z 5-8)');
  assert.doesNotMatch(body, /zIndex:\s*(?:[0-9]|[1-9][0-9])\b(?!\d)/, 'no caption z-index below 100');
});

test('N12: the stat layout tags only example datasets and keeps kicker and footnote', () => {
  const example = statLines({ headline: 'Placeholder' }, { label: 'Solar', source: 'example' });
  assert.equal(example.kicker, 'Placeholder');
  assert.equal(example.sourceLine, 'Solar · example data');
  assert.equal(example.footnote, undefined);

  const real = statLines({ kicker: 'Measured', footnote: 'Box, no GPU' }, { label: 'CPU time', source: 'user' });
  assert.equal(real.kicker, 'Measured');
  assert.equal(real.sourceLine, 'CPU time', 'a real dataset keeps its label with no example tag');
  assert.equal(real.footnote, 'Box, no GPU');

  // An explicit kicker wins over the headline; no dataset means no source line.
  const both = statLines({ kicker: 'K', headline: 'H' }, undefined);
  assert.equal(both.kicker, 'K');
  assert.equal(both.sourceLine, undefined);

  // The shipped StatLayout draws all three pieces from the helper.
  const body = functionBody(source('components.tsx'), 'StatLayout');
  assert.match(body, /statLines\(copy, dataset\)/);
  assert.match(body, /lines\.sourceLine/);
  assert.match(body, /lines\.footnote/);
  assert.doesNotMatch(body, /· example data/);
});

test('N13: the lower third uses light text on its fixed dark box', () => {
  const body = functionBody(source('media.tsx'), 'LowerThird');
  assert.match(body, /color:\s*'#f4f6fb'/, 'the text on the always-dark box must be light');
  assert.doesNotMatch(body, /colors\.primary/, 'the theme primary is dark on light themes (clay, editorial) and must not be used here');
});
