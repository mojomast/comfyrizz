// SP04: Chatterbox Multilingual voiceover graph.
//
// Ported from mojomast/open-higgsfield-skills @5a1a2d4
// skills/voiceover/workflows/voice_chatterbox_multilingual.api.json. The source
// shipped a LoadAudio "Voice to clone" node wired into audio_prompt and saved
// MP3. The default here uses the model's built-in voice (no audio_prompt and no
// LoadAudio node) and writes lossless audio through core SaveAudio so the ASR
// take check reads an unquantised file.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const workflowUrl = (name) => new URL(`../../../workflows/${name}`, import.meta.url);
const read = (name) => JSON.parse(readFileSync(workflowUrl(name), 'utf8'));
const graph = () => read('chatterbox_multilingual_tts.api.json');
const params = () => read('chatterbox_multilingual_tts.api.params.json');

function links(node) {
  return Object.entries(node.inputs)
    .filter(([, value]) => Array.isArray(value))
    .map(([field, value]) => ({ field, target: String(value[0]), slot: value[1] }));
}

test('the multilingual graph uses the built-in voice, never a clone', () => {
  const g = graph();
  for (const [id, node] of Object.entries(g)) {
    assert.notEqual(node.class_type, 'LoadAudio', `node ${id} is a LoadAudio`);
  }
  const tts = g['1'];
  assert.equal(tts.class_type, 'FL_ChatterboxMultilingualTTS');
  assert.equal('audio_prompt' in tts.inputs, false, 'audio_prompt must be unset');
  assert.equal(JSON.stringify(g).includes('audio_prompt'), false, 'the graph must not mention audio_prompt');
  assert.equal(JSON.stringify(g).includes('Voice to clone'), false, 'the clone source node must be gone');
});

test('the multilingual TTS node keeps the natural defaults', () => {
  const { inputs } = graph()['1'];
  assert.equal(inputs.text, '');
  assert.equal(inputs.language, 'English (en)');
  assert.equal(inputs.exaggeration, 0.5);
  assert.equal(inputs.cfg_weight, 0.5);
  assert.equal(inputs.temperature, 0.8);
  assert.equal(inputs.repetition_penalty, 2);
  assert.equal(inputs.min_p, 0.05);
  assert.equal(inputs.top_p, 1);
  assert.equal(inputs.seed, 0);
  assert.equal(inputs.use_cpu, false);
  assert.equal(inputs.keep_model_loaded, false);
});

test('the output is lossless core SaveAudio, never SaveAudioMP3', () => {
  const g = graph();
  const savers = Object.entries(g).filter(([, node]) => node.class_type.startsWith('SaveAudio'));
  assert.equal(savers.length, 1);
  const [id, node] = savers[0];
  assert.equal(node.class_type, 'SaveAudio', `node ${id} must write lossless audio`);
  assert.equal('quality' in node.inputs, false, 'SaveAudio has no MP3 quality input');
  assert.equal(node.inputs.filename_prefix, 'audio/chatterbox_multilingual');
  assert.deepEqual(node.inputs.audio, ['5', 0]);
});

test('the 40 second trim keeps the source recipe and feeds SaveAudio', () => {
  const g = graph();
  assert.equal(g['5'].class_type, 'TrimAudioDuration');
  assert.deepEqual(g['5'].inputs.audio, ['1', 0]);
  assert.equal(g['5'].inputs.start_index, 0);
  assert.equal(g['5'].inputs.duration, 40);
});

test('every link target exists in the graph', () => {
  const g = graph();
  for (const [id, node] of Object.entries(g)) {
    for (const { field, target, slot } of links(node)) {
      assert.ok(g[target], `node ${id}.${field} -> missing node ${target}`);
      assert.equal(Number.isInteger(slot), true, `node ${id}.${field} has a non-integer output slot`);
    }
  }
});

test('params resolve to real inputs and expose only the SP04 knobs', () => {
  const p = params();
  const g = graph();
  assert.equal(p.v, 1);
  assert.equal(p.generator, 'chatterbox');
  assert.equal(p.kind, 'audio');
  assert.equal('files' in p, false, 'this graph consumes no uploaded files');
  assert.deepEqual(
    Object.keys(p.map).sort(),
    ['cfg_weight', 'exaggeration', 'language', 'seed', 'text'],
  );
  assert.equal('audio_prompt' in p.map, false, 'params must not map a clone prompt');
  for (const [name, target] of Object.entries(p.map)) {
    assert.equal(Array.isArray(target), true, `${name} must map to one [node, field]`);
    const [nodeId, field] = target;
    assert.ok(g[nodeId], `${name} -> missing node ${nodeId}`);
    assert.ok(field in g[nodeId].inputs, `${name} -> ${nodeId}.${field} is not an input`);
  }
  assert.deepEqual(p.map.text, ['1', 'text']);
  assert.deepEqual(p.map.language, ['1', 'language']);
  assert.deepEqual(p.map.seed, ['1', 'seed']);
  assert.deepEqual(p.map.exaggeration, ['1', 'exaggeration']);
  assert.deepEqual(p.map.cfg_weight, ['1', 'cfg_weight']);
});
