import { spawn } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { compileTimeline } from '../../../packages/planner/dist/src/index.js';
import { narrationOptions, repoRoot } from '../../renderer/scripts/render-package-lib.mjs';

function execute(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', chunk => { stderr = `${stderr}${chunk}`.slice(-6000); });
    child.once('error', reject);
    child.once('close', code => {
      if (code === 0) resolve();
      else reject(new Error(`${command} exited ${code}: ${stderr.trim()}`));
    });
  });
}

export function runNeedsNarration(pkg) {
  return pkg?.voice?.enabled === true && pkg.voice?.engine !== 'none'
    && (pkg.scenes ?? []).some(scene => typeof scene?.narration === 'string' && scene.narration.trim());
}

/**
 * Add measured narration to a final legacy media run before its GPU planner runs.
 * The full-pipeline worker already has equivalent stages; Super Easy uses this path.
 */
export async function prepareRunNarration({ pkg, workDir, outputDir, packageDir, runCommand = execute }) {
  if (!runNeedsNarration(pkg)) return { voiced: false };
  const workAudio = join(workDir, 'audio');
  const durationsPath = join(workAudio, 'durations.json');
  const narrationPath = join(workAudio, 'narration.norm.wav');
  const packageAudio = join(packageDir, 'audio');
  const alreadyMeasured = pkg.assets?.a_narration?.status === 'ready'
    && existsSync(join(packageAudio, 'durations.json')) && existsSync(join(packageAudio, 'narration.norm.wav'));

  if (alreadyMeasured) {
    cpSync(packageAudio, workAudio, { recursive: true });
  } else {
    const qwen = pkg.voice.engine === 'qwen3-tts';
    const python = qwen
      ? process.env.COMFYRIZZ_QWEN_TTS_PYTHON || process.env.COMFYRIZZ_PYTHON || 'python3'
      : process.env.COMFYRIZZ_PYTHON || 'python3';
    await runCommand(python, [join(repoRoot, 'packages/tts/py/synth.py'), '--package', join(workDir, 'package.json'), '--out', workAudio, '--padding', '0.5']);
    if (qwen) {
      await runCommand(process.env.COMFYRIZZ_QWEN_ASR_PYTHON || python, [join(repoRoot, 'packages/tts/py/qa_qwen.py'), '--package', join(workDir, 'package.json'), '--out', workAudio]);
    }
    await runCommand(process.execPath, [join(repoRoot, 'packages/tts/scripts/narrate.mjs'), '--example', workDir]);
    const prepared = JSON.parse(readFileSync(join(workDir, 'package.json'), 'utf8'));
    if (prepared.id !== pkg.id) throw new Error('Narration preparation changed the package identity');
    Object.assign(pkg, prepared);
  }

  if (!existsSync(durationsPath) || !existsSync(narrationPath)) throw new Error('Narration preparation did not produce measured audio and durations');
  const durations = JSON.parse(readFileSync(durationsPath, 'utf8'));
  const fps = Number(pkg.format?.fps) > 0 ? Number(pkg.format.fps) : 30;
  // Check the authored shot length, not the already-expanded measured timeline.
  // Silent expansion would change the requested film duration after GPU planning.
  for (const scene of pkg.scenes ?? []) {
    const measured = durations.scenes?.[scene.id]?.seconds;
    const preferredFrames = Number(scene.preferredFrames);
    if (Number.isFinite(measured) && Number.isFinite(preferredFrames) && preferredFrames > 0 && measured > preferredFrames / fps + 0.001) {
      throw new Error(`${scene.id}: narration exceeds the authored ${(preferredFrames / fps).toFixed(2)}s shot duration; shorten the line before media generation`);
    }
  }
  const timeline = compileTimeline(pkg, narrationOptions(workDir));
  mkdirSync(outputDir, { recursive: true });
  cpSync(workAudio, join(outputDir, 'audio'), { recursive: true });
  cpSync(workAudio, packageAudio, { recursive: true });
  return { voiced: true, timelineHash: timeline.hash, durationInFrames: timeline.durationInFrames };
}
