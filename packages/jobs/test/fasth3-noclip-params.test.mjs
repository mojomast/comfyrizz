// VX04: FastH3 Omni reference-to-video without a voice clip.
//
// The no-clip variant drops the optional LoadAudio input (node 7) so the graph takes two
// reference pictures only. Node ids are otherwise unchanged, so the seed keeps landing on the
// RandomNoise node (13) and every remaining link resolves. The audio-conditioned originals must
// stay byte-identical: they are the recipe of record until VX01 clears R2V-without-audio.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const graphUrl = (name) => new URL(`../../../workflows/${name}`, import.meta.url);
const read = (name) => JSON.parse(readFileSync(graphUrl(name), 'utf8'));
const graph = () => read('fasth3_omni_ref2v_noclip.api.json');
const params = () => read('fasth3_omni_ref2v_noclip.api.params.json');

const ORIGINALS = {
  'fasth3_omni_ref2va.api.json': '8e6038252666a21233cb947bd43dc52b2a8eb1ceb18e995bd2ce1f79e6690b3f',
  'fasth3_omni_ref2va.api.params.json': 'a1e49ee9191de8708743a88ecbfd12c5d27819a4d889c853859d1081bbcee8bc',
};

function links(node) {
  return Object.entries(node.inputs)
    .filter(([, value]) => Array.isArray(value))
    .map(([field, value]) => ({ field, target: String(value[0]), slot: value[1] }));
}

test('no-clip params map only the two reference images, never audio', () => {
  const p = params();
  assert.equal(p.v, 1);
  assert.equal(p.generator, 'fasth3-omni');
  assert.equal(p.kind, 'plate');
  assert.deepEqual(p.files, ['image', 'reference']);
  assert.equal('audio' in p.map, false, 'params.map must not carry an audio key');
  assert.equal(p.files.includes('audio'), false);
  assert.deepEqual(p.map.image, ['5', 'image']);
  assert.deepEqual(p.map.reference, ['6', 'image']);
  assert.equal(Object.values(p.map).some((t) => t[0] === '7'), false, 'nothing may point at the removed LoadAudio node');
});

test('seed still maps to node 13 noise_seed', () => {
  const p = params();
  const g = graph();
  assert.deepEqual(p.map.seed, ['13', 'noise_seed']);
  assert.equal(g['13'].class_type, 'RandomNoise');
  assert.equal(typeof g['13'].inputs.noise_seed, 'number');
});

test('every params target is a real input of the no-clip graph', () => {
  const p = params();
  const g = graph();
  for (const [name, target] of Object.entries(p.map)) {
    const targets = Array.isArray(target[0]) ? target : [target];
    for (const [nodeId, field] of targets) {
      assert.ok(g[nodeId], `${name} -> missing node ${nodeId}`);
      assert.ok(field in g[nodeId].inputs, `${name} -> ${nodeId}.${field} is not an input`);
    }
  }
});

test('the no-clip graph has no LoadAudio node and no audio reference link', () => {
  const g = graph();
  assert.equal(g['7'], undefined, 'node 7 (LoadAudio) must be removed');
  for (const [id, node] of Object.entries(g)) {
    assert.notEqual(node.class_type, 'LoadAudio', `node ${id} is a LoadAudio`);
  }
  const ref2v = g['8'];
  assert.equal(ref2v.class_type, 'MiniMaxH3ReferenceToVideo');
  assert.equal('ref_audios.ref_audio_0' in ref2v.inputs, false, 'audio conditioning link must be removed');
  assert.equal(JSON.stringify(ref2v.inputs).includes('"7"'), false, 'ref2v must not link to node 7');
  assert.doesNotMatch(ref2v.inputs.prompt, /<Audio 1>/);
  assert.deepEqual(ref2v.inputs['ref_images.ref_image_0'], ['5', 0]);
  assert.deepEqual(ref2v.inputs['ref_images.ref_image_1'], ['6', 0]);
});

test('every link target exists in the no-clip graph', () => {
  const g = graph();
  for (const [id, node] of Object.entries(g)) {
    for (const { field, target, slot } of links(node)) {
      assert.ok(g[target], `node ${id}.${field} -> missing node ${target}`);
      assert.equal(Number.isInteger(slot), true, `node ${id}.${field} has a non-integer output slot`);
    }
  }
});

test('node ids are the original set minus the removed LoadAudio node', () => {
  const original = read('fasth3_omni_ref2va.api.json');
  const g = graph();
  const expected = Object.keys(original).filter((id) => id !== '7').sort((a, b) => Number(a) - Number(b));
  assert.deepEqual(Object.keys(g).sort((a, b) => Number(a) - Number(b)), expected);
});

test('the no-clip graph keeps the published Omni recipe', () => {
  const g = graph();
  assert.equal(g['15'].inputs.steps, 8);
  assert.equal(g['15'].inputs.scheduler, 'simple');
  assert.equal(g['14'].inputs.sampler_name, 'euler');
  assert.equal(g['12'].class_type, 'BasicGuider');
  assert.equal(g['11'].inputs.selection, 'vsa');
  assert.equal(g['11'].inputs['selection.keep_percent'], 10);
  assert.equal(g['9'].inputs.shift_video, 12);
  assert.equal(g['9'].inputs.shift_audio, 3);
  assert.equal(g['19'].inputs.fps, 24);
});

test('the audio-conditioned originals are byte-identical', () => {
  for (const [name, hash] of Object.entries(ORIGINALS)) {
    const bytes = readFileSync(graphUrl(name));
    assert.equal(createHash('sha256').update(bytes).digest('hex'), hash, `${name} changed`);
  }
});
