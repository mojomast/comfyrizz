// CCL4a: scene.speaker plus a per-character cast voice are optional package-v1 fields.
// Old packages keep validating, and both language bindings read the same structural schema.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { validatePackage } from '../src/index.mjs';

const minimal = JSON.parse(readFileSync(new URL('../fixtures/valid/minimal.json', import.meta.url)));
const mascot = JSON.parse(readFileSync(new URL('../fixtures/valid/cast-mascot.json', import.meta.url)));

const clone = (doc) => structuredClone(doc);

test('old packages without a speaker or cast voice stay valid', () => {
  for (const doc of [minimal, mascot]) {
    const result = validatePackage(clone(doc));
    assert.equal(result.valid, true, JSON.stringify(result.errors));
  }
});

test('scene.speaker is optional and accepts a cast id', () => {
  const pkg = clone(mascot);
  assert.equal(pkg.scenes[0].speaker, undefined);
  pkg.scenes[0].speaker = 'c_pip';
  const result = validatePackage(pkg);
  assert.equal(result.valid, true, JSON.stringify(result.errors));

  const bare = clone(mascot);
  delete bare.scenes[0].speaker;
  assert.equal(validatePackage(bare).valid, true);
});

test('scene.speaker must look like a cast id', () => {
  const pkg = clone(mascot);
  pkg.scenes[0].speaker = 'pip';
  const result = validatePackage(pkg);
  assert.equal(result.valid, false);
  assert.equal(result.schemaOk, false);
  assert.ok(result.errors.some((entry) => entry.source === 'schema' && entry.path === '/scenes/0/speaker'));
});

test('cast[].voice is optional and accepts a package-shaped voice', () => {
  const withEnabled = clone(mascot);
  withEnabled.cast[0].voice = {
    enabled: true,
    engine: 'kokoro',
    voice: 'am_michael',
    speed: 1.05,
  };
  assert.equal(validatePackage(withEnabled).valid, true, JSON.stringify(validatePackage(withEnabled).errors));

  const withoutEnabled = clone(mascot);
  withoutEnabled.cast[0].voice = { engine: 'kokoro', voice: 'af_heart', chunking: 'paragraph' };
  assert.equal(validatePackage(withoutEnabled).valid, true, JSON.stringify(validatePackage(withoutEnabled).errors));

  const noVoice = clone(mascot);
  delete noVoice.cast[0].voice;
  assert.equal(validatePackage(noVoice).valid, true);
});

test('a cast voice is a closed voice object', () => {
  const pkg = clone(mascot);
  pkg.cast[0].voice = { engine: 'kokoro', voice: 'af_heart', mystery: true };
  const result = validatePackage(pkg);
  assert.equal(result.valid, false);
  assert.equal(result.schemaOk, false);

  const unknownEngine = clone(mascot);
  unknownEngine.cast[0].voice = { engine: 'not-an-engine', voice: 'af_heart' };
  assert.equal(validatePackage(unknownEngine).valid, false);
});

test('a speaker and a cast voice can be combined on one package', () => {
  const pkg = clone(mascot);
  pkg.scenes[0].speaker = 'c_pip';
  pkg.scenes[0].narration = 'Fresh is best.';
  pkg.cast[0].voice = { engine: 'qwen3-tts', voice: 'Ryan', speed: 1, qwen_mode: 'custom', delivery: 'bright and friendly' };
  const result = validatePackage(pkg);
  assert.equal(result.valid, true, JSON.stringify(result.errors));
});

function findPython() {
  const root = fileURLToPath(new URL('../../../', import.meta.url));
  const candidates = [process.env.COMFYRIZZ_PYTHON, `${root}.venv/bin/python`, 'python3'].filter(Boolean);
  for (const candidate of candidates) {
    const probe = spawnSync(candidate, ['-c', 'import jsonschema'], { encoding: 'utf8' });
    if (probe.status === 0) return { candidate, root };
  }
  return null;
}

test('JavaScript and Python validators agree on speaker and cast-voice packages', {
  skip: findPython() ? false : 'no python with jsonschema found (set COMFYRIZZ_PYTHON)',
}, () => {
  const { candidate, root } = findPython();
  const docs = [];

  const speaker = clone(mascot);
  speaker.scenes[0].speaker = 'c_pip';
  docs.push(speaker);

  const badSpeaker = clone(mascot);
  badSpeaker.scenes[0].speaker = 'pip';
  docs.push(badSpeaker);

  const castVoice = clone(mascot);
  castVoice.cast[0].voice = { engine: 'kokoro', voice: 'am_michael', speed: 1.1 };
  docs.push(castVoice);

  const badCastVoice = clone(mascot);
  badCastVoice.cast[0].voice = { engine: 'not-an-engine', voice: 'af_heart' };
  docs.push(badCastVoice);

  const oldPackage = clone(minimal);
  docs.push(oldPackage);

  const run = spawnSync(
    candidate,
    ['-c', 'import sys,json;from comfyrizz_pipeline.schema import validate_package;print(json.dumps([validate_package(p) for p in json.load(sys.stdin)]))'],
    {
      input: JSON.stringify(docs),
      encoding: 'utf8',
      env: { ...process.env, PYTHONPATH: `${root}pipeline-py` },
    },
  );
  assert.equal(run.status, 0, run.stderr);

  JSON.parse(run.stdout).forEach((py, index) => {
    const js = validatePackage(docs[index]);
    assert.equal(py.valid, js.valid, `case ${index} valid`);
    assert.equal(py.schemaOk, js.schemaOk, `case ${index} schemaOk`);
    const semantic = (report) => report.errors.filter((entry) => entry.source === 'semantic').map((entry) => entry.code + entry.path).sort();
    assert.deepEqual(semantic(py), semantic(js), `case ${index} semantic`);
  });
});
