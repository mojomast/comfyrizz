import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareRunNarration, runNeedsNarration } from '../src/run-narration.mjs';
import { repoRoot } from '../../renderer/scripts/render-package-lib.mjs';

const fixture = JSON.parse(readFileSync(join(repoRoot, 'examples', 'launch-demo', 'package.json'), 'utf8'));

function narratedPackage() {
  const pkg = structuredClone(fixture);
  pkg.voice = { enabled: true, engine: 'kokoro', voice: 'af_heart', language: 'en-us', speed: 1 };
  for (const scene of pkg.scenes) delete scene.narration;
  pkg.scenes[0].narration = 'A measured sentence.';
  pkg.scenes[0].preferredFrames = 180;
  delete pkg.assets.a_narration;
  return pkg;
}

test('final-run narration is measured, attached and staged before media', async t => {
  const root = mkdtempSync(join(tmpdir(), 'comfyrizz-run-narration-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const workDir = join(root, 'work');
  const outputDir = join(root, 'out');
  const packageDir = join(root, 'package');
  for (const dir of [workDir, outputDir, packageDir]) mkdirSync(dir, { recursive: true });
  const pkg = narratedPackage();
  writeFileSync(join(workDir, 'package.json'), JSON.stringify(pkg));
  const sceneId = pkg.scenes[0].id;
  const commands = [];
  const runCommand = async (command, args) => {
    commands.push([command, args]);
    const audio = join(workDir, 'audio');
    mkdirSync(join(audio, 'narration'), { recursive: true });
    if (args.some(arg => arg.endsWith('synth.py'))) {
      writeFileSync(join(audio, 'durations.json'), JSON.stringify({
        version: 1, engine: 'kokoro-onnx', model: 'kokoro-v1.0.onnx', voices: 'voices-v1.0.bin',
        voice: 'af_heart', language: 'en-us', speed: 1, sampleRate: 24000,
        scenes: { [sceneId]: {
          chunks: [{ text: 'A measured sentence.', spoken: 'A measured sentence.', seconds: 2, samples: 48000, words: [
            { text: 'A', start: 0, end: 0.2 }, { text: 'measured', start: 0.2, end: 1 }, { text: 'sentence.', start: 1, end: 2 },
          ] }],
          gapSeconds: 0.2, paddingSeconds: 0.5, seconds: 2, file: `audio/narration/${sceneId}.wav`,
        } },
      }));
      writeFileSync(join(audio, 'narration', `${sceneId}.wav`), 'wav');
    } else if (args.some(arg => arg.endsWith('narrate.mjs'))) {
      writeFileSync(join(audio, 'narration.norm.wav'), 'normalized wav');
      const prepared = structuredClone(pkg);
      prepared.assets.a_narration = { kind: 'audio', status: 'ready', file: 'audio/narration.norm.wav' };
      prepared.scenes[0].narration_asset = 'a_narration';
      prepared.scenes[0].narration_duration_frames = 60;
      writeFileSync(join(workDir, 'package.json'), JSON.stringify(prepared));
    }
  };
  const result = await prepareRunNarration({ pkg, workDir, outputDir, packageDir, runCommand });
  assert.equal(result.voiced, true);
  assert.equal(result.durationInFrames > 0, true);
  assert.equal(commands.length, 2);
  assert.equal(pkg.assets.a_narration.status, 'ready');
  assert.equal(pkg.scenes[0].narration_asset, 'a_narration');
  assert.equal(pkg.scenes[0].narration_duration_frames, 60);
  for (const dir of [outputDir, packageDir]) {
    assert.equal(existsSync(join(dir, 'audio', 'durations.json')), true);
    assert.equal(existsSync(join(dir, 'audio', 'narration.norm.wav')), true);
  }
});

test('narration is required only for enabled voice with scene text', () => {
  const pkg = narratedPackage();
  assert.equal(runNeedsNarration(pkg), true);
  pkg.voice.enabled = false;
  assert.equal(runNeedsNarration(pkg), false);
  pkg.voice.enabled = true;
  for (const scene of pkg.scenes) delete scene.narration;
  assert.equal(runNeedsNarration(pkg), false);
});
