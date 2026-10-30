import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { planPipeline, remoteNarrationPlan } from '../src/pipeline-contract.mjs';
import { prepareRunNarration } from '../src/run-narration.mjs';
import { repoRoot } from '../../renderer/scripts/render-package-lib.mjs';

const fixture = JSON.parse(readFileSync(join(repoRoot, 'examples', 'launch-demo', 'package.json'), 'utf8'));

function voicedPackage(engine, voice) {
  const pkg = structuredClone(fixture);
  pkg.voice = { enabled: true, engine, voice };
  pkg.scenes[0].narration = 'A measured sentence.';
  pkg.scenes[0].preferredFrames = 180;
  delete pkg.assets.a_narration;
  return pkg;
}

function chatterboxPackage() {
  return voicedPackage('chatterbox', 'en');
}

function reportFor(engine, sceneId, seconds = 2) {
  return {
    version: 1,
    engine,
    gapSeconds: 0.2,
    paddingSeconds: 0.5,
    sampleRate: 24000,
    scenes: {
      [sceneId]: {
        chunks: [{
          text: 'A measured sentence.',
          spoken: 'A measured sentence.',
          seconds,
          samples: seconds * 24000,
          words: [
            { text: 'A', start: 0, end: 0.2 },
            { text: 'measured', start: 0.2, end: 1 },
            { text: 'sentence.', start: 1, end: seconds },
          ],
        }],
        gapSeconds: 0.2,
        paddingSeconds: 0.5,
        seconds,
        file: `audio/narration/${sceneId}.wav`,
      },
    },
  };
}

function harness(t, pkg) {
  const root = mkdtempSync(join(tmpdir(), 'comfyrizz-chatterbox-route-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const workDir = join(root, 'work');
  const outputDir = join(root, 'out');
  const packageDir = join(root, 'package');
  for (const dir of [workDir, outputDir, packageDir]) mkdirSync(dir, { recursive: true });
  writeFileSync(join(workDir, 'package.json'), JSON.stringify(pkg));
  return { root, workDir, outputDir, packageDir, sceneId: pkg.scenes[0].id };
}

function prepareScripts(workDir, packageDir, pkg, sceneId, engine) {
  const audio = join(workDir, 'audio');
  return async (command, args) => {
    if (args.some(arg => arg.endsWith('chatterbox_narrate.py'))) {
      mkdirSync(join(audio, 'narration'), { recursive: true });
      writeFileSync(join(audio, 'durations.json'), JSON.stringify(reportFor('chatterbox', sceneId)));
      writeFileSync(join(audio, 'take_report.json'), JSON.stringify({
        version: 1,
        engine: 'chatterbox',
        takes: [{ line: `${sceneId}_line_001`, status: 'accepted' }],
        lines: {},
        flagged: [],
      }));
      writeFileSync(join(audio, 'narration', `${sceneId}_line_001.wav`), 'wav');
      return;
    }
    if (args.some(arg => arg.endsWith('synth.py'))) {
      mkdirSync(join(audio, 'narration'), { recursive: true });
      writeFileSync(join(audio, 'durations.json'), JSON.stringify(reportFor(engine, sceneId)));
      writeFileSync(join(audio, 'narration', `${sceneId}.wav`), 'wav');
      return;
    }
    if (args.some(arg => arg.endsWith('narrate.mjs'))) {
      writeFileSync(join(audio, 'narration.norm.wav'), 'normalized wav');
      const prepared = structuredClone(pkg);
      prepared.assets.a_narration = { kind: 'audio', status: 'ready', file: 'audio/narration.norm.wav' };
      prepared.scenes[0].narration_asset = 'a_narration';
      prepared.scenes[0].narration_duration_frames = 60;
      writeFileSync(join(workDir, 'package.json'), JSON.stringify(prepared));
    }
  };
}

test('SPW07: Chatterbox selects the remote narration worker when narration runs on Google Colab', () => {
  const route = remoteNarrationPlan(chatterboxPackage(), { narrationRuntime: 'colab' });
  assert.equal(route.remoteVoice, true);
  assert.equal(route.engine, 'chatterbox');
  assert.equal(route.script, 'chatterbox_narrate.py');
  assert.equal(route.path, 'colab/chatterbox_narrate.py');
});

test('SPW07: Qwen keeps its remote worker and Kokoro stays local', () => {
  const qwen = remoteNarrationPlan(voicedPackage('qwen3-tts', 'test-narrator'), { narrationRuntime: 'colab' });
  assert.equal(qwen.remoteVoice, true);
  assert.equal(qwen.script, 'qwen_narrate.py');
  assert.equal(qwen.path, 'colab/qwen_narrate.py');
  const kokoro = remoteNarrationPlan(voicedPackage('kokoro', 'af_heart'), { narrationRuntime: 'colab' });
  assert.equal(kokoro.remoteVoice, false);
  assert.equal(kokoro.script, null);
  assert.equal(kokoro.path, null);
});

test('SPW07: a Chatterbox package reaches the remote narration plan', () => {
  const pkg = chatterboxPackage();
  const remote = planPipeline(pkg, { backendId: 'colab', budgetUnits: 4, narrationUnits: 2 });
  assert.equal(remote.remoteVoice, true);
  assert.equal(remote.narrationWorker.engine, 'chatterbox');
  assert.equal(remote.narrationWorker.script, 'chatterbox_narrate.py');
  assert.equal(remote.narrationWorker.path, 'colab/chatterbox_narrate.py');
  assert.equal(remote.issues.some(issue => issue.code === 'STRICT_QWEN_REQUIRED'), false);
  const local = planPipeline(pkg, { backendId: 'cpu', narrationRuntime: 'local' });
  assert.equal(local.remoteVoice, false);
  assert.equal(local.narrationWorker, null);
});

test('SPW07: pipeline plans keep Qwen and Kokoro routing unchanged', () => {
  const qwen = voicedPackage('qwen3-tts', 'test-narrator');
  qwen.voice.strict = true;
  const remoteQwen = planPipeline(qwen, { backendId: 'colab', budgetUnits: 4, narrationUnits: 2 });
  assert.equal(remoteQwen.remoteVoice, true);
  assert.equal(remoteQwen.narrationWorker.script, 'qwen_narrate.py');
  assert.equal(remoteQwen.narrationWorker.path, 'colab/qwen_narrate.py');
  const localQwen = planPipeline(qwen, { backendId: 'cpu', narrationRuntime: 'local' });
  assert.equal(localQwen.remoteVoice, false);
  assert.equal(localQwen.narrationWorker, null);
  const kokoro = planPipeline(voicedPackage('kokoro', 'af_heart'), { backendId: 'cpu', narrationRuntime: 'colab' });
  assert.equal(kokoro.remoteVoice, false);
  assert.equal(kokoro.narrationWorker, null);
});

test('SPW07: run narration executes colab/chatterbox_narrate.py and collects both reports', async t => {
  const pkg = chatterboxPackage();
  const { workDir, outputDir, packageDir, sceneId } = harness(t, pkg);
  const calls = [];
  const runCommand = prepareScripts(workDir, packageDir, pkg, sceneId, 'chatterbox');
  const result = await prepareRunNarration({
    pkg, workDir, outputDir, packageDir, narrationRuntime: 'colab',
    runCommand: async (command, args) => { calls.push([command, args]); return runCommand(command, args); },
  });
  assert.equal(result.voiced, true);
  assert.equal(calls.some(([, args]) => args.some(arg => arg.endsWith('synth.py'))), false);
  assert.equal(calls.some(([, args]) => args.some(arg => arg.endsWith('qwen_narrate.py'))), false);
  const worker = calls.find(([, args]) => args.some(arg => arg.endsWith('chatterbox_narrate.py')));
  assert.ok(worker);
  assert.equal(worker[1][0], join(repoRoot, 'colab', 'chatterbox_narrate.py'));
  for (const dir of [outputDir, packageDir]) {
    assert.equal(existsSync(join(dir, 'audio', 'durations.json')), true);
    assert.equal(existsSync(join(dir, 'audio', 'take_report.json')), true);
    assert.equal(existsSync(join(dir, 'audio', 'narration.norm.wav')), true);
  }
  assert.equal(JSON.parse(readFileSync(join(outputDir, 'audio', 'durations.json'), 'utf8')).engine, 'chatterbox');
});

test('SPW07: a failed remote Chatterbox step surfaces and never falls back to Kokoro', async t => {
  const pkg = chatterboxPackage();
  const { workDir, outputDir, packageDir } = harness(t, pkg);
  const calls = [];
  await assert.rejects(
    () => prepareRunNarration({
      pkg, workDir, outputDir, packageDir, narrationRuntime: 'colab',
      runCommand: async (command, args) => {
        calls.push([command, args]);
        if (args.some(arg => arg.endsWith('chatterbox_narrate.py'))) throw new Error('worker exited 9');
        throw new Error('Kokoro must not run');
      },
    }),
    error => {
      assert.equal(error.code, 'CHATTERBOX_NARRATION_FAILED');
      assert.match(error.message, /Chatterbox/);
      assert.match(error.message, /Google Colab/);
      assert.match(error.message, /Kokoro/);
      assert.match(error.message, /worker exited 9/);
      return true;
    },
  );
  assert.equal(calls.length, 1);
  assert.equal(calls.some(([, args]) => args.some(arg => arg.endsWith('synth.py'))), false);
  assert.equal(existsSync(join(outputDir, 'audio')), false);
});

test('SPW07: missing take_report.json is an explicit Chatterbox failure', async t => {
  const pkg = chatterboxPackage();
  const { workDir, outputDir, packageDir, sceneId } = harness(t, pkg);
  await assert.rejects(
    () => prepareRunNarration({
      pkg, workDir, outputDir, packageDir, narrationRuntime: 'colab',
      runCommand: async (_command, args) => {
        if (args.some(arg => arg.endsWith('chatterbox_narrate.py'))) {
          mkdirSync(join(workDir, 'audio'), { recursive: true });
          writeFileSync(join(workDir, 'audio', 'durations.json'), JSON.stringify(reportFor('chatterbox', sceneId)));
          return;
        }
        throw new Error('Kokoro must not run');
      },
    }),
    error => {
      assert.equal(error.code, 'CHATTERBOX_NARRATION_INCOMPLETE');
      assert.match(error.message, /take_report\.json/);
      assert.match(error.message, /Kokoro/);
      return true;
    },
  );
  assert.equal(existsSync(join(outputDir, 'audio')), false);
});

test('SPW07: a worker report claiming another engine is rejected', async t => {
  const pkg = chatterboxPackage();
  const { workDir, outputDir, packageDir, sceneId } = harness(t, pkg);
  await assert.rejects(
    () => prepareRunNarration({
      pkg, workDir, outputDir, packageDir, narrationRuntime: 'colab',
      runCommand: async (_command, args) => {
        if (args.some(arg => arg.endsWith('chatterbox_narrate.py'))) {
          mkdirSync(join(workDir, 'audio'), { recursive: true });
          writeFileSync(join(workDir, 'audio', 'durations.json'), JSON.stringify(reportFor('kokoro-onnx', sceneId)));
          writeFileSync(join(workDir, 'audio', 'take_report.json'), JSON.stringify({ version: 1, engine: 'chatterbox' }));
          return;
        }
        throw new Error('Kokoro must not run');
      },
    }),
    error => {
      assert.equal(error.code, 'CHATTERBOX_NARRATION_ENGINE_MISMATCH');
      assert.match(error.message, /kokoro-onnx/);
      assert.match(error.message, /Kokoro/);
      return true;
    },
  );
  assert.equal(existsSync(join(outputDir, 'audio')), false);
});

test('SPW07: Chatterbox refuses a local runtime instead of silently using Kokoro', async t => {
  const pkg = chatterboxPackage();
  const { workDir, outputDir, packageDir } = harness(t, pkg);
  const calls = [];
  await assert.rejects(
    () => prepareRunNarration({
      pkg, workDir, outputDir, packageDir, runCommand: async (command, args) => { calls.push([command, args]); },
    }),
    error => {
      assert.equal(error.code, 'CHATTERBOX_NARRATION_REQUIRES_COLAB');
      assert.match(error.message, /Google Colab/);
      assert.match(error.message, /Kokoro/);
      return true;
    },
  );
  assert.equal(calls.length, 0);
  assert.equal(existsSync(join(outputDir, 'audio')), false);
});

test('SPW07: Qwen local narration still runs synth.py then qa_qwen.py', async t => {
  const pkg = voicedPackage('qwen3-tts', 'test-narrator');
  pkg.voice.strict = true;
  const { workDir, outputDir, packageDir, sceneId } = harness(t, pkg);
  const calls = [];
  const runCommand = prepareScripts(workDir, packageDir, pkg, sceneId, 'qwen3-tts');
  await prepareRunNarration({
    pkg, workDir, outputDir, packageDir,
    runCommand: async (command, args) => { calls.push([command, args]); return runCommand(command, args); },
  });
  assert.equal(calls[0][1].some(arg => arg.endsWith('synth.py')), true);
  assert.equal(calls[1][1].some(arg => arg.endsWith('qa_qwen.py')), true);
  assert.equal(calls[2][1].some(arg => arg.endsWith('narrate.mjs')), true);
  assert.equal(calls.some(([, args]) => args.some(arg => arg.endsWith('qwen_narrate.py'))), false);
});
