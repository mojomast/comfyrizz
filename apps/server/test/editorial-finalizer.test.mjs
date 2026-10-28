import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { classifyProductionIntent } from '../../../packages/agent/dist/src/index.js';
import { finalizeGeneratedFilmEditorial } from '../src/editorial-finalizer.mjs';
import { generatedFilmCompletionProblems } from '../src/agent-runner.mjs';

function fixture(t) {
  const assetsDir = mkdtempSync(join(new URL('../../../.tmp/', import.meta.url).pathname, 'editorial-finalizer-'));
  t.after(() => rmSync(assetsDir, { recursive: true, force: true }));
  return {
    assetsDir,
    pkg: {
      title: 'A Harder Landing',
      proposal: { logline: 'A skater gets back up.', look: 'Photorealistic live action.', soundtrack: 'Warm felt piano and skateboard foley.' },
      format: { fps: 30 },
      voice: { enabled: false, engine: 'none' },
      scenes: [
        { id: 's1', layout: 'list', preferredFrames: 180, narration: 'The stairs are only the beginning.', media_only: true, copy: { headline: 'ATTEMPT' }, background: { asset: 'a_h3' }, media: [{ asset: 'a_h3' }] },
        { id: 's2', layout: 'list', preferredFrames: 180, narration: 'Getting up is the trick.', media_only: true, copy: { headline: 'RETURN' }, background: { asset: 'a_h3' }, media: [{ asset: 'a_h3' }] },
      ],
      assets: {
        a_h3: { kind: 'video', status: 'pending', gen: { generator: 'fasth3-omni', direction: { soundscape: 'Wheels and impact.' } } },
      },
    },
  };
}

test('editorial finalizer adds Kokoro, composed music, H3 ambience and visible bookends without GPU work', async t => {
  const { pkg, assetsDir } = fixture(t);
  const brief = 'Create a 12-second narrated live-action generated film in 2 shots. Narration: Kokoro voiceover. Music: instrumental bed. Use Remotion title opener and end card.';
  const intent = classifyProductionIntent(brief);
  const result = finalizeGeneratedFilmEditorial(pkg, { intent, brief, assetsDir });
  assert.equal(result.musicAdded, true);
  assert.equal(result.narrationEnabled, true);
  assert.equal(result.ambienceEnabled, true);
  assert.equal(result.package.voice.engine, 'kokoro');
  assert.equal(result.package.voice.voice, 'af_heart');
  assert.equal(result.package.scenes[0].layout, 'title');
  assert.equal(result.package.scenes[0].variant, 'centered');
  assert.equal(result.package.scenes[0].media_only, undefined);
  assert.equal(result.package.scenes.at(-1).variant, 'outro');
  assert.equal(result.package.audio.ambience.gain_db, -8);
  const music = result.package.assets[result.package.audio.music.asset];
  assert.equal(music.status, 'ready');
  assert.equal(music.gen.generator, 'procedural-audio');
  assert.match(music.gen.inputs.plan, /felt piano|instrumental bed/);
  const musicId = result.package.audio.music.asset;
  assert.match(musicId, /^a_finishing_[a-f0-9]{12}$/);
  const wav = readFileSync(join(assetsDir, `${musicId}.wav`));
  assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
  assert.ok(wav.length > 44);
  assert.equal(existsSync(join(assetsDir, `${musicId}.wav`)), true);
  const problems = generatedFilmCompletionProblems(result.package, intent, 'h3', brief);
  assert.equal(problems.some(problem => /music|voiceover|narrated film|opening title|closing title|ambience bus|hidden by media_only/.test(problem)), false, problems.join('\n'));
});

test('wordless no-music no-text intent never gains narration, a score or editorial copy', t => {
  const { pkg, assetsDir } = fixture(t);
  const brief = 'Create a 12-second wordless generated film in 2 shots with native soundscape, no dialogue or music and no captions.';
  const intent = classifyProductionIntent(brief);
  const result = finalizeGeneratedFilmEditorial(pkg, { intent, brief, assetsDir });
  assert.equal(intent.musicRequested, false);
  assert.equal(intent.noCaptions, true);
  assert.equal(result.musicAdded, false);
  assert.equal(result.narrationEnabled, false);
  assert.equal(result.package.voice.enabled, false);
  assert.equal(result.package.audio.music, undefined);
  assert.equal(result.package.audio.ambience.gain_db, -8);
  assert.equal(result.package.scenes.every(scene => !scene.narration && !scene.copy), true);
});
