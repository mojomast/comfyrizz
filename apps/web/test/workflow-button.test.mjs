// W1: the asset view offers Open in ComfyUI for generated stills and plates.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const main = readFileSync(fileURLToPath(new URL('../src/main.ts', import.meta.url)), 'utf8');
const css = readFileSync(fileURLToPath(new URL('../src/style.css', import.meta.url)), 'utf8');

test('the asset view downloads the API workflow and says drag-and-drop is not included', () => {
  assert.match(main, /Open in ComfyUI/);
  assert.match(main, /data-asset-action="workflow"/);
  assert.match(main, /data-workflow-format="api"/);
  assert.match(main, /data-workflow-format="readme"/);
  assert.match(main, /How to open/);
  assert.match(main, /\/workflow/);
  assert.match(main, /drag-and-drop needs a UI workflow, which is not reliable to convert/);
  assert.match(main, /flux3-klein/);
  assert.match(main, /ltx25/);
  assert.match(css, /\.asset-end/);
  assert.doesNotMatch(main, /(?<!Google )Colab/);
});
