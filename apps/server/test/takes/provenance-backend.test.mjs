import test from 'node:test';
import assert from 'node:assert/strict';

import { provenanceBackend, PROVENANCE_BACKEND_RE } from '../../src/takes/provenance-backend.mjs';

test('provenanceBackend keeps schema-valid tags', () => {
  assert.equal(provenanceBackend('colab:G4'), 'colab:G4');
  assert.equal(provenanceBackend('byo-comfyui'), 'byo-comfyui');
  assert.equal(provenanceBackend('byo-comfyui:v2'), 'byo-comfyui:v2');
  assert.equal(provenanceBackend('cpu'), 'cpu');
  assert.equal(PROVENANCE_BACKEND_RE.test('colab'), false);
});

test('provenanceBackend maps bare colab and skips ComfyUI URLs', () => {
  assert.equal(provenanceBackend('colab'), 'colab:G4');
  assert.equal(provenanceBackend('http://127.0.0.1:8189', 'colab'), 'colab:G4');
  assert.equal(provenanceBackend('colab:G4', 'colab'), 'colab:G4');
  assert.equal(provenanceBackend(undefined, null, ''), undefined);
});
