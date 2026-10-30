import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = path => readFileSync(new URL(`../src/${path}`, import.meta.url), 'utf8');

test('procedural textures stay subordinate to text', () => {
  const background = read('background-model.js');
  assert.match(background, /\$\{accent\}26/);
  assert.match(background, /\$\{soft\}14/);
  const components = read('components.tsx');
  assert.match(components, /size: 22 \+ random\[\(index \+ 3\) % 12\] \* 18/);
  assert.match(components, /\$\{blob\.tone\}24/);
});

test('lower-thirds clear wrapped headlines and future flow nodes remain readable', () => {
  const media = read('media.tsx');
  assert.match(media, /top: 200/);
  const flow = read('recipes/TechnicalFlow.tsx');
  assert.match(flow, /opacity: 0\.38 \+ reveal \* 0\.62/);
});

test('full-bleed foreground media is scrimmed below copy, not below the media', () => {
  const components = read('components.tsx');
  assert.match(components, /fullBleedMedia/);
  assert.match(components, /<Scrim opacity=\{readableMediaScrim\(scene, scene\.background\?\.scrim \?\? 0\)\} zIndex=\{6\}/);
});
