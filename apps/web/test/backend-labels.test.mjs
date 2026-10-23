// P-fix5: the backend picker must describe the backends the server actually
// runs. The old labels ended in `· fake` from the pre-integration demo, which
// made real My ComfyUI / Google Colab runs look like stubs. The picker lives
// in the settings dialog.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const html = readFileSync(fileURLToPath(new URL('../src/settings/sections.ts', import.meta.url)), 'utf8');

function optionValues(id) {
  const select = new RegExp(`<select id="${id}">([\\s\\S]*?)</select>`).exec(html);
  assert.ok(select, `#${id} select is present`);
  return [...select[1].matchAll(/<option value="([^"]+)">([^<]*)<\/option>/g)].map(match => ({
    value: match[1],
    label: match[2],
  }));
}

test('P-fix5: the backend picker labels the real backends, not fakes', () => {
  const backends = optionValues('backend');
  assert.deepEqual(backends.map(option => option.value), ['cpu', 'byo-comfyui', 'colab']);
  for (const option of backends) {
    assert.doesNotMatch(option.label, /\bfake\b/i, `${option.value} must not be labelled a fake`);
    assert.doesNotMatch(option.label, /\bstub\b/i, `${option.value} must not be labelled a stub`);
  }
  const byLabel = Object.fromEntries(backends.map(option => [option.value, option.label]));
  assert.equal(byLabel['byo-comfyui'], 'My ComfyUI');
  assert.equal(byLabel.colab, 'Google Colab');
});
