import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { validatePackage } from '../src/index.mjs';
import { VOICE_PRESETS } from '../../tts/voices.mjs';

const fixture = JSON.parse(readFileSync(new URL('../fixtures/valid/minimal.json', import.meta.url)));
test('every selectable voice preset is valid production input', () => {
  for (const preset of VOICE_PRESETS) {
    const pkg = structuredClone(fixture);
    pkg.voice = preset.voice;
    const result = validatePackage(pkg);
    assert.equal(result.valid, true, `${preset.id}: ${JSON.stringify(result.errors)}`);
  }
});
test('Qwen speaker, speed and unsupported blend fail before compute allocation', () => {
  const voice = VOICE_PRESETS.find(p => p.id === 'ryan-curious').voice;
  for (const change of [{ voice: 'not-a-speaker' }, { speed: .93 }, { blend: [{ voice: 'am_michael', weight: .7 }, { voice: 'am_fenrir', weight: .3 }] }]) {
    const pkg = { ...structuredClone(fixture), voice: { ...voice, ...change } };
    assert.equal(validatePackage(pkg).valid, false);
  }
});

test('Python and JavaScript agree on new voice settings, including malformed blends', () => {
  const custom = VOICE_PRESETS.find(p => p.id === 'ryan-curious').voice;
  const voices = [...VOICE_PRESETS.map(p => p.voice), { ...custom, speed: .93 }, { ...custom, voice: 'unknown' },
    { enabled: true, engine: 'kokoro', voice: 'am_michael', blend: [null, { voice: 'am_michael', weight: .7 }] },
    { enabled: true, engine: 'kokoro', voice: 'am_michael', blend: [{ voice: 'am_michael', weight: .7 }, { voice: 'bf_emma', weight: .3 }] }];
  const docs = voices.map(voice => ({ ...structuredClone(fixture), voice }));
  const root = fileURLToPath(new URL('../../../', import.meta.url));
  const result = spawnSync(`${root}.venv/bin/python`, ['-c', 'import sys,json;from comfyrizz_pipeline.schema import validate_package;print(json.dumps([validate_package(p) for p in json.load(sys.stdin)]))'], {
    input: JSON.stringify(docs), encoding: 'utf8', env: { ...process.env, PYTHONPATH: `${root}pipeline-py` },
  });
  assert.equal(result.status, 0, result.stderr);
  JSON.parse(result.stdout).forEach((py, i) => {
    const js = validatePackage(docs[i]);
    assert.equal(py.valid, js.valid, `voice case ${i}`);
    const semantic = report => report.errors.filter(e => e.source === 'semantic').map(e => e.code + e.path).sort();
    assert.deepEqual(semantic(py), semantic(js), `voice case ${i}`);
  });
});
