import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { narrationAudio } from '../src/audio-model.js';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..', '..');
const read = name => JSON.parse(readFileSync(join(repoRoot, 'examples', name, 'package.json'), 'utf8'));

test('the measured narration asset is found from scene references', () => {
  const audio = narrationAudio(read('showcase-gpu3'));
  assert.equal(audio.assetId, 'a_narration');
  assert.equal(audio.file, 'audio/narration.norm.wav');
});

test('unready or missing audio is not played', () => {
  assert.equal(narrationAudio({ assets: {}, scenes: [] }), null);
  assert.equal(
    narrationAudio({ assets: { a_narration: { kind: 'audio', status: 'pending', file: 'audio/x.wav' } }, scenes: [{ id: 's1', narration_asset: 'a_narration' }] }),
    null,
  );
  assert.equal(narrationAudio({ assets: { a_narration: { kind: 'audio', status: 'ready' } }, scenes: [] }), null);
  assert.equal(narrationAudio({ assets: { a_narration: { kind: 'audio', status: 'ready', file: '' } }, scenes: [] }), null);
});

test('a ready audio asset is used even when scenes do not reference it', () => {
  const audio = narrationAudio({ assets: { a_music: { kind: 'audio', status: 'ready', file: 'audio/music.wav' } }, scenes: [] });
  assert.equal(audio.assetId, 'a_music');
});

test('scene narration_asset references win over other ready audio assets', () => {
  const audio = narrationAudio({
    assets: {
      a_music: { kind: 'audio', status: 'ready', file: 'audio/music.wav' },
      a_narration: { kind: 'audio', status: 'ready', file: 'audio/narration.norm.wav' },
    },
    scenes: [{ id: 's1', narration_asset: 'a_narration' }],
  });
  assert.equal(audio.assetId, 'a_narration');
});

test('a package with an audio mix never treats an unreferenced bus as narration', () => {
  const audio = narrationAudio({
    audio: { music: { asset: 'a_music' } },
    assets: {
      a_music: { kind: 'audio', status: 'ready', file: 'audio/music.wav' },
      a_narration: { kind: 'audio', status: 'pending', file: 'audio/narration.norm.wav' },
    },
    scenes: [{ id: 's1', narration_asset: 'a_narration' }],
  });
  assert.equal(audio, null);
});
