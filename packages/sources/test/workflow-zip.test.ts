import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { buildPackageZip, OPEN_IN_COMFYUI_MARKDOWN, redactSecrets, redactWorkflowDocument } from '../src/index.js';
import type { PackageLike } from '../src/types.js';

const TOKEN = 'hf_TESTTOKENTESTTOKEN';
const SECRET_VALUE = 'super-secret-value';

const graph = {
  '1': { class_type: 'UNETLoader', inputs: { unet_name: 'flux-3-image-klein-bf16.safetensors' } },
  '4': { class_type: 'CLIPTextEncode', inputs: { text: `a paper boat and a subway token, ${TOKEN}`, clip: ['2', 0] } },
  '7': {
    class_type: 'KSampler',
    inputs: {
      seed: 7,
      api_key: SECRET_VALUE,
      note: 'https://user:s3cret-pass@example.com/x?token=abcdef123456',
    },
  },
};

test('redactSecrets keeps the seed, prompt words and model name', () => {
  const cleaned = redactSecrets(graph);
  const blob = JSON.stringify(cleaned.value);
  assert.ok(cleaned.redactions >= 3);
  assert.equal(blob.includes(TOKEN), false);
  assert.equal(blob.includes(SECRET_VALUE), false);
  assert.equal(blob.includes('s3cret-pass'), false);
  assert.equal(blob.includes('abcdef123456'), false);
  const value = cleaned.value as typeof graph;
  assert.equal(value['7'].inputs.seed, 7);
  assert.equal(value['7'].inputs.api_key, '[redacted]');
  assert.match(value['4'].inputs.text, /subway token/);
  assert.equal(value['1'].inputs.unet_name, 'flux-3-image-klein-bf16.safetensors');
  assert.deepEqual(value['4'].inputs.clip, ['2', 0]);
  assert.equal(redactWorkflowDocument(JSON.stringify(graph)).includes(TOKEN), false);
});

test('package.zip ships the captured API workflow and no secrets', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'comfyrizz-w1-'));
  try {
    const packageDoc: PackageLike = {
      id: 'pkg_w1',
      title: 'Workflow capture',
      revision: 1,
      assets: {
        a_still: {
          kind: 'image',
          origin: 'generated',
          status: 'ready',
          file: 'assets/a_still.png',
          license: { id: 'CC0-1.0' },
          redistributable: true,
        },
      },
    };
    const readme = `# Open a_still in ComfyUI\n\nPrompt was a paper boat, ${TOKEN}.\n\nDrag-and-drop is not used. API format only. No Google Colab token is stored.\n`;
    const result = buildPackageZip({
      package: packageDoc,
      timeline: { fps: 30, scenes: [] },
      assets: {},
      capturedWorkflows: {
        'assets/a_still.workflow.api.json': JSON.stringify(graph),
        'assets/a_still.workflow.md': readme,
      },
      generatedAt: '2026-10-18T00:00:00.000Z',
    });
    assert.ok(result.entries.includes('assets/a_still.workflow.api.json'));
    assert.ok(result.entries.includes('assets/a_still.workflow.md'));
    assert.ok(result.entries.includes('OPEN-IN-COMFYUI.md'));
    assert.equal(result.entries.some(entry => entry.endsWith('.workflow.json') && !entry.endsWith('.workflow.api.json')), false);
    assert.match(String(result.manifest.workflowNote), /API-format/);
    assert.match(OPEN_IN_COMFYUI_MARKDOWN, /drag-and-drop/i);
    assert.doesNotMatch(OPEN_IN_COMFYUI_MARKDOWN, /(?<!Google )Colab/);

    const zipPath = join(dir, 'package.zip');
    await writeFile(zipPath, result.bytes);
    const api = execFileSync('unzip', ['-p', zipPath, 'assets/a_still.workflow.api.json']).toString();
    const note = execFileSync('unzip', ['-p', zipPath, 'assets/a_still.workflow.md']).toString();
    const instructions = execFileSync('unzip', ['-p', zipPath, 'OPEN-IN-COMFYUI.md']).toString();
    for (const text of [api, note, instructions, result.bytes.toString('utf8')]) {
      assert.equal(text.includes(TOKEN), false, 'token leaked into the bundle');
      assert.equal(text.includes(SECRET_VALUE), false, 'api key leaked into the bundle');
      assert.equal(text.includes('s3cret-pass'), false);
    }
    const parsed = JSON.parse(api);
    assert.equal(parsed['7'].inputs.seed, 7);
    assert.match(parsed['4'].inputs.text, /subway token/);
    assert.match(note, /subway token|paper boat/);
    assert.match(instructions, /widget order/);
    assert.throws(() => buildPackageZip({ package: packageDoc, capturedWorkflows: { '../evil.json': '{}' }, generatedAt: '2026-10-18T00:00:00.000Z' }), /unsafe zip path|unexpected captured workflow path/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
