// W1: GET the captured workflow, and the export bundle contains it with no secrets.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { collectMockContribution } from './helpers/comfy-contribution.mjs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer, request as httpRequest } from 'node:http';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createApp } from '../src/app.mjs';

const TOKEN = 'test-token-0123456789abcdef';
const SECRET = 'hf_TESTTOKENTESTTOKEN';
const API_KEY = 'super-secret-value';
const repo = new URL('../../..', import.meta.url).pathname;
const seed = JSON.parse(readFileSync(new URL('../../../examples/launch-demo/package.json', import.meta.url), 'utf8'));

let runtime;
let app;
let server;
let port;

const graph = {
  '4': {
    class_type: 'CLIPTextEncode',
    inputs: { text: `a paper boat and a subway token, ${SECRET}`, clip: ['2', 0] },
  },
  '7': {
    class_type: 'KSampler',
    inputs: {
      seed: 11,
      api_key: API_KEY,
      note: 'https://user:s3cret-pass@example.com/x?token=abcdef123456',
      unet_name: 'flux-3-image-klein-bf16.safetensors',
    },
  },
};

const upscaleGraph = {
  '9': { class_type: 'SaveVideo', inputs: { seed: 22, text: `upscale ${SECRET}` } },
};

function request({ method = 'GET', path = '/', token = TOKEN, body } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const headers = { host: `127.0.0.1:${port}`, origin: `http://127.0.0.1:${port}` };
    if (token) headers['x-comfyrizz-token'] = token;
    if (payload !== undefined) {
      headers['content-type'] = 'application/json';
      headers['content-length'] = Buffer.byteLength(payload);
    }
    const req = httpRequest({ hostname: '127.0.0.1', port, path, method, headers });
    req.on('response', response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json;
        try {
          json = JSON.parse(text);
        } catch {
          json = undefined;
        }
        resolve({ status: response.statusCode, headers: response.headers, text, json });
      });
    });
    req.on('error', reject);
    req.end(payload);
  });
}

before(async () => {
  runtime = mkdtempSync(join(tmpdir(), 'comfyrizz-w1-'));
  const bytes = Buffer.from('still-bytes');
  const upBytes = Buffer.from('upscale-bytes');
  const pkg = structuredClone(seed);
  pkg.id = 'pkg_w1workflow';
  pkg.revision = 1;
  pkg.assets.a_w1still = {
    kind: 'image',
    origin: 'generated',
    status: 'ready',
    file: 'assets/a_w1still.png',
    sha256: createHash('sha256').update(bytes).digest('hex'),
    license: { id: 'CC0-1.0' },
    model_license: { id: 'LicenseRef-FLUX.3-Image-Klein', url: 'https://huggingface.co/black-forest-labs/flux-3-image-klein' },
    redistributable: true,
    media: { width: 64, height: 64 },
    gen: { generator: 'flux3-klein', model: 'flux-3-image-klein' },
    variants: {
      upscaled: { file: 'assets/a_w1still@2x.png', width: 128, height: 128 },
    },
  };
  pkg.assets.a_w1pending = {
    kind: 'image',
    origin: 'generated',
    status: 'pending',
    license: { id: 'CC0-1.0' },
    gen: { generator: 'flux3-klein', model: 'flux-3-image-klein' },
  };
  app = createApp({
    root: repo,
    token: TOKEN,
    runtimeDir: runtime,
    render: async (_packagePath, output) => {
      const fake = Buffer.from('fake mp4');
      writeFileSync(output, fake);
      return { output, bytes: fake.length, frames: 12, hash: 'abc' };
    },
  });
  collectMockContribution(pkg, app.store.dir);
  app.store.write(pkg);
  const packageDir = dirname(app.store.path(pkg.id));
  cpSync(join(repo, 'examples/launch-demo/assets'), join(packageDir, 'assets'), { recursive: true });
  mkdirSync(join(packageDir, 'assets'), { recursive: true });
  writeFileSync(join(packageDir, 'assets', 'a_w1still.png'), bytes);
  writeFileSync(join(packageDir, 'assets', 'a_w1still@2x.png'), upBytes);
  writeFileSync(join(packageDir, 'assets', 'a_w1still.workflow.api.json'), `${JSON.stringify(graph, null, 2)}\n`);
  writeFileSync(
    join(packageDir, 'assets', 'a_w1still.workflow.md'),
    `# Open a_w1still in ComfyUI\n\nPrompt: a paper boat, ${SECRET}.\n\nDrag-and-drop is not used. This is API format. Widget order is not in the graph. No Google Colab token is stored.\n`,
  );
  writeFileSync(join(packageDir, 'assets', 'a_w1still@2x.workflow.api.json'), `${JSON.stringify(upscaleGraph, null, 2)}\n`);
  server = createServer(app.handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  port = server.address().port;
});

after(async () => {
  app.close();
  await new Promise(resolve => server.close(resolve));
  rmSync(runtime, { recursive: true, force: true });
});

function assertClean(text) {
  assert.equal(text.includes(SECRET), false);
  assert.equal(text.includes(API_KEY), false);
  assert.equal(text.includes('s3cret-pass'), false);
  assert.equal(text.includes('abcdef123456'), false);
}

test('GET workflow requires the token', async () => {
  const response = await request({ path: '/api/package/pkg_w1workflow/assets/a_w1still/workflow', token: null });
  assert.equal(response.status, 401);
});

test('GET workflow returns the API graph with secrets removed', async () => {
  const response = await request({ path: '/api/package/pkg_w1workflow/assets/a_w1still/workflow' });
  assert.equal(response.status, 200);
  assert.equal(response.headers['x-comfyrizz-workflow-format'], 'api');
  assert.equal(response.headers['x-comfyrizz-ui-format'], 'unavailable');
  assert.match(response.headers['content-disposition'], /a_w1still\.workflow\.api\.json/);
  assertClean(response.text);
  assert.equal(response.json['7'].inputs.seed, 11);
  assert.match(response.json['4'].inputs.text, /subway token/);
  assert.equal(response.json['7'].inputs.unet_name, 'flux-3-image-klein-bf16.safetensors');
  assert.equal(response.json['7'].inputs.api_key, '[redacted]');
});

test('GET workflow readme explains that drag-and-drop UI format is not included', async () => {
  const response = await request({ path: '/api/package/pkg_w1workflow/assets/a_w1still/workflow?format=readme' });
  assert.equal(response.status, 200);
  assert.equal(response.headers['content-type'].startsWith('text/markdown'), true);
  assertClean(response.text);
  assert.match(response.text, /drag-and-drop/i);
  assert.match(response.text, /API format/);
  assert.match(response.text, /widget order/i);
  assert.doesNotMatch(response.text, /(?<!Google )Colab/);
});

test('GET the upscale variant workflow is a different graph', async () => {
  const response = await request({ path: '/api/package/pkg_w1workflow/assets/a_w1still/workflow?variant=upscaled' });
  assert.equal(response.status, 200);
  assertClean(response.text);
  assert.equal(response.json['9'].inputs.seed, 22);
  assert.match(response.headers['content-disposition'], /@2x\.workflow\.api\.json/);
});

test('SVG assets and pending stills have no workflow yet', async () => {
  const svg = await request({ path: '/api/package/pkg_w1workflow/assets/a_icon_check/workflow' });
  assert.equal(svg.status, 404);
  const pending = await request({ path: '/api/package/pkg_w1workflow/assets/a_w1pending/workflow' });
  assert.equal(pending.status, 404);
  assert.match(pending.json.reason, /succeeds/);
  const missing = await request({ path: '/api/package/pkg_w1workflow/assets/a_not_here/workflow' });
  assert.equal(missing.status, 404);
});

test('POST /api/export puts the captured workflow in package.zip without secrets', async () => {
  const response = await request({ method: 'POST', path: '/api/export', body: { packageId: 'pkg_w1workflow', force: true } });
  assert.equal(response.status, 200, response.text);
  const zipPath = join(response.json.dir, 'package.zip');
  const listed = execFileSync('unzip', ['-Z1', zipPath]).toString().split('\n').filter(Boolean);
  assert.ok(listed.includes('assets/a_w1still.workflow.api.json'));
  assert.ok(listed.includes('assets/a_w1still.workflow.md'));
  assert.ok(listed.includes('OPEN-IN-COMFYUI.md'));
  assert.equal(listed.some(name => name.endsWith('.workflow.json') && !name.endsWith('.workflow.api.json')), false);
  const api = execFileSync('unzip', ['-p', zipPath, 'assets/a_w1still.workflow.api.json']).toString();
  const note = execFileSync('unzip', ['-p', zipPath, 'OPEN-IN-COMFYUI.md']).toString();
  const bundle = readFileSync(zipPath);
  assertClean(api);
  assertClean(note);
  assert.equal(bundle.includes(Buffer.from(SECRET)), false);
  assert.equal(bundle.includes(Buffer.from(API_KEY)), false);
  const parsed = JSON.parse(api);
  assert.equal(parsed['7'].inputs.seed, 11);
  assert.match(note, /widget order/);
});
