import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const LOCK_PATH = resolve(ROOT, 'colab/models.lock.json');
const GRAPH_PATH = resolve(ROOT, 'workflows/qwen_edit_2511_instruct.api.json');

const lock = JSON.parse(readFileSync(LOCK_PATH, 'utf8'));
const graph = JSON.parse(readFileSync(GRAPH_PATH, 'utf8'));

const REVISION = /^[0-9a-f]{40}$/;

// The Qwen Edit 2511 graph names its three weights through loader inputs. The
// lock target has to expose exactly those names under ComfyUI/models.
function loaderNames(apiGraph) {
  const names = new Set();
  for (const node of Object.values(apiGraph)) {
    for (const field of ['unet_name', 'clip_name', 'vae_name']) {
      const value = node.inputs?.[field];
      if (typeof value === 'string' && value.endsWith('.safetensors')) names.add(value);
    }
  }
  return [...names].sort();
}

// Resolved with the read-only Hugging Face tree API on 2026-10-30; no token.
const QWEN_FILES = {
  'qwen_image_edit_2511_fp8mixed.safetensors': {
    host: 'qwenedit',
    repo: 'Comfy-Org/Qwen-Image-Edit_ComfyUI',
    path: 'split_files/diffusion_models/qwen_image_edit_2511_fp8mixed.safetensors',
    target: 'diffusion_models/qwen_image_edit_2511_fp8mixed.safetensors',
    bytes: 20533762817,
  },
  'qwen_2.5_vl_7b_fp8_scaled.safetensors': {
    host: 'qwenimage',
    repo: 'Comfy-Org/Qwen-Image_ComfyUI',
    path: 'split_files/text_encoders/qwen_2.5_vl_7b_fp8_scaled.safetensors',
    target: 'text_encoders/qwen_2.5_vl_7b_fp8_scaled.safetensors',
    bytes: 9384670680,
  },
  'qwen_image_vae.safetensors': {
    host: 'qwenimage',
    repo: 'Comfy-Org/Qwen-Image_ComfyUI',
    path: 'split_files/vae/qwen_image_vae.safetensors',
    target: 'vae/qwen_image_vae.safetensors',
    bytes: 253806246,
  },
};

const QWEN_HOSTS = {
  qwenedit: {
    repo: 'Comfy-Org/Qwen-Image-Edit_ComfyUI',
    revision: 'f68ace85e60b4a02a323e394253731947657b7d2',
    gated: false,
  },
  qwenimage: {
    repo: 'Comfy-Org/Qwen-Image_ComfyUI',
    revision: '1f12b17be14c89b026c51a91d67c32f84bb047bc',
    gated: false,
  },
};

// The measured GPU-test-3 pin must not move when the Qwen host is added.
const BASE_HOSTS = {
  klein: {
    repo: 'black-forest-labs/flux-3-image-klein',
    revision: '337337621b8526e120f2275d250242f4a6bedd75',
    revisionLastModified: '2026-10-16T04:58:03.000Z',
    gated: 'auto',
    localDir: '/content/hf/klein',
    measuredSeconds: 121.1,
  },
  ltx: {
    repo: 'Lightricks/LTX-2.5',
    revision: '49b093a39c19169a8a81721dcc541e07e945232f',
    revisionLastModified: '2026-10-11T07:00:53.000Z',
    gated: 'auto',
    localDir: '/content/hf/ltx',
    measuredSeconds: 166.5,
  },
};

const BASE_FILES = [
  {
    host: 'klein',
    path: 'model.safetensors',
    bytes: 11097404512,
    target: 'diffusion_models/flux-3-image-klein-bf16.safetensors',
  },
  {
    host: 'klein',
    path: 'ae.safetensors',
    bytes: 336211292,
    target: 'vae/flux2-vae.safetensors',
  },
  {
    host: 'klein',
    path: 'text_encoder/model-00001-of-00002.safetensors',
    bytes: 4967229296,
    mergedInto: 'klein-text-encoder',
  },
  {
    host: 'klein',
    path: 'text_encoder/model-00002-of-00002.safetensors',
    bytes: 3908490048,
    mergedInto: 'klein-text-encoder',
  },
  {
    host: 'ltx',
    path: 'diffusion_models/ltx-2.5-22b-distilled-transformer-comfy-int8-convrot.safetensors',
    bytes: 21504034224,
    target: 'diffusion_models/ltx-2.5-22b-distilled-transformer-comfy-int8-convrot.safetensors',
  },
  {
    host: 'ltx',
    path: 'text_encoders/gemma4-12b-with-proj-ltx-2.5-comfy-int8-convrot.safetensors',
    bytes: 15372969374,
    target: 'text_encoders/gemma4-12b-with-proj-ltx-2.5-comfy-int8-convrot.safetensors',
  },
  {
    host: 'ltx',
    path: 'vae/ltx-2.5-video-vae-bf16.safetensors',
    bytes: 1472223346,
    target: 'vae/ltx-2.5-video-vae-bf16.safetensors',
  },
  {
    host: 'ltx',
    path: 'vae/ltx-2.5-audio-vae-bf16.safetensors',
    bytes: 364866540,
    target: 'vae/ltx-2.5-audio-vae-bf16.safetensors',
  },
  {
    host: 'ltx',
    path: 'latent_upscale_models/ltx-2.5-latent-spatial-upscaler-x2-bf16-1.0.safetensors',
    bytes: 995778752,
    target: 'latent_upscale_models/ltx-2.5-latent-spatial-upscaler-x2-bf16-1.0.safetensors',
  },
];

test('every qwen graph loader name resolves to one lock target', () => {
  const names = loaderNames(graph);
  assert.deepEqual(names, Object.keys(QWEN_FILES).sort());
  for (const name of names) {
    const matches = lock.files.filter(entry => basename(entry.target ?? entry.path) === name);
    assert.equal(matches.length, 1, `${name} must resolve to exactly one lock file, got ${matches.length}`);
    const [entry] = matches;
    assert.equal(entry.target, QWEN_FILES[name].target, `${name}: target differs from the graph loader name`);
    assert.equal(entry.path, QWEN_FILES[name].path, `${name}: source path is not the pinned HF path`);
    assert.equal(entry.host, QWEN_FILES[name].host, `${name}: wrong host`);
    assert.ok(lock.hosts[entry.host], `${name}: host ${entry.host} is not declared`);
  }
});

test('the qwen hosts pin an ungated repo at a 40-hex revision', () => {
  for (const [name, expected] of Object.entries(QWEN_HOSTS)) {
    const host = lock.hosts[name];
    assert.ok(host, `missing host ${name}`);
    assert.equal(host.repo, expected.repo);
    assert.match(host.revision, REVISION, `${name}: revision is not a 40-hex commit`);
    assert.equal(host.revision, expected.revision, `${name}: revision moved`);
    assert.equal(host.gated, false, `${name}: the host must stay ungated`);
  }
  for (const [name, host] of Object.entries(lock.hosts)) {
    assert.match(host.revision, REVISION, `${name}: revision is not a 40-hex commit`);
  }
});

test('the qwen file sizes are the exact Hugging Face tree API bytes', () => {
  for (const [name, expected] of Object.entries(QWEN_FILES)) {
    const entry = lock.files.find(file => basename(file.target ?? file.path) === name);
    assert.ok(entry, `missing lock entry for ${name}`);
    assert.ok(Number.isSafeInteger(entry.bytes) && entry.bytes > 0, `${name}: bytes must be a positive integer`);
    assert.equal(entry.bytes, expected.bytes, `${name}: size differs from the HF API`);
  }
  for (const entry of lock.files) {
    assert.ok(Number.isSafeInteger(entry.bytes) && entry.bytes > 0, `${entry.path}: bytes must be a positive integer`);
  }
  const targets = lock.files.map(entry => entry.target).filter(Boolean);
  assert.equal(new Set(targets).size, targets.length, 'two files cannot claim one ComfyUI path');
});

test('the measured GPU-test-3 hosts, files and merge stay byte-identical', () => {
  assert.deepEqual(lock.hosts.klein, BASE_HOSTS.klein);
  assert.deepEqual(lock.hosts.ltx, BASE_HOSTS.ltx);
  assert.deepEqual(lock.files.slice(0, BASE_FILES.length), BASE_FILES);
  assert.deepEqual(lock.merge, [
    {
      id: 'klein-text-encoder',
      shards: [
        'text_encoder/model-00001-of-00002.safetensors',
        'text_encoder/model-00002-of-00002.safetensors',
      ],
      host: 'klein',
      target: 'text_encoders/qwen3vl_4b_bf16.safetensors',
      bytes: 8875719384,
      operation: 'safetensors load_file/save_file, shards deleted after',
    },
  ]);
});

test('the lock names the Chatterbox custom node with its pinned revision and licence', () => {
  assert.ok(Array.isArray(lock.customNodes), 'customNodes must be a top-level array');
  const chatterbox = lock.customNodes.find(node => node.name === 'ComfyUI_Fill-ChatterBox');
  assert.deepEqual(chatterbox, {
    name: 'ComfyUI_Fill-ChatterBox',
    repo: 'https://github.com/filliptm/ComfyUI_Fill-ChatterBox.git',
    revision: 'f7d7a161',
    licence: 'MIT (README; Kyle accepted 2026-10-30)',
  });
});
