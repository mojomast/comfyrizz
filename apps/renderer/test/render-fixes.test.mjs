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
