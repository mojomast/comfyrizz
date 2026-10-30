import { spawn } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { compileTimeline } from '../../../packages/planner/dist/src/index.js';
import { narrationOptions, repoRoot } from '../../renderer/scripts/render-package-lib.mjs';
import { durationRangeText, durationWithinTarget } from './duration-policy.mjs';
import { remoteNarrationPlan } from './pipeline-contract.mjs';

function execute(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    let stdout = '';
    child.stdout.on('data', chunk => { stdout = `${stdout}${chunk}`.slice(-6000); });
    child.stderr.on('data', chunk => { stderr = `${stderr}${chunk}`.slice(-6000); });
    child.once('error', reject);
    child.once('close', code => {
      if (code === 0) resolve();
      else reject(new Error(`${command} exited ${code}: ${stderr.trim()}${stdout.trim() ? `\n${stdout.trim()}` : ''}`));
    });
  });
}

export function runNeedsNarration(pkg) {
  // An explicit master-song source window is the music-video audio contract.
  // Stale voice/scene fields must never turn its lyrics into a TTS workload.
  const masterSong = Boolean(pkg?.audio?.music?.trim);
  return !masterSong && pkg?.voice?.enabled === true && pkg.voice?.engine !== 'none'
    && (pkg.scenes ?? []).some(scene => typeof scene?.narration === 'string' && scene.narration.trim());
}

function assertChatterboxReports(workAudio) {
  const reportPath = join(workAudio, 'take_report.json');
  if (!existsSync(reportPath)) {
    throw Object.assign(new Error('Chatterbox narration from Google Colab did not produce take_report.json; no Kokoro fallback is used.'), {
      code: 'CHATTERBOX_NARRATION_INCOMPLETE', status: 502,
    });
  }
  const durationsPath = join(workAudio, 'durations.json');
  if (!existsSync(durationsPath)) {
    throw Object.assign(new Error('Chatterbox narration from Google Colab did not produce durations.json; no Kokoro fallback is used.'), {
      code: 'CHATTERBOX_NARRATION_INCOMPLETE', status: 502,
    });
  }
  let report;
  try {
    report = JSON.parse(readFileSync(durationsPath, 'utf8'));
  } catch (error) {
    throw Object.assign(new Error(`Chatterbox narration from Google Colab produced unreadable durations.json; no Kokoro fallback is used. ${error.message}`), {
      code: 'CHATTERBOX_NARRATION_INCOMPLETE', status: 502, cause: error,
    });
  }
  if (report.engine !== 'chatterbox') {
    throw Object.assign(new Error(`Chatterbox narration from Google Colab produced engine "${report.engine}"; no Kokoro fallback is allowed.`), {
      code: 'CHATTERBOX_NARRATION_ENGINE_MISMATCH', status: 502,
    });
  }
}

/**
 * Add measured narration to a final legacy media run before its GPU planner runs.
 * The full-pipeline worker already has equivalent stages; Super Easy uses this path.
 */
export async function prepareRunNarration({ pkg, workDir, outputDir, packageDir, narrationRuntime = 'local', runCommand = execute }) {
  if (!runNeedsNarration(pkg)) return { voiced: false };
  const authoredTimeline = compileTimeline(pkg);
  const authoredFrames = Number(authoredTimeline.durationInFrames);
  const workAudio = join(workDir, 'audio');
  const durationsPath = join(workAudio, 'durations.json');
  const narrationPath = join(workAudio, 'narration.norm.wav');
  const packageAudio = join(packageDir, 'audio');
  const alreadyMeasured = pkg.assets?.a_narration?.status === 'ready'
    && existsSync(join(packageAudio, 'durations.json')) && existsSync(join(packageAudio, 'narration.norm.wav'));

  if (alreadyMeasured) {
    cpSync(packageAudio, workAudio, { recursive: true });
  } else {
    const localPython = join(repoRoot, '.venv', 'bin', 'python');
    const defaultPython = existsSync(localPython) ? localPython : 'python3';
    if (pkg.voice.engine === 'chatterbox') {
      const route = remoteNarrationPlan(pkg, { narrationRuntime });
      if (!route.remoteVoice) {
        throw Object.assign(new Error('Chatterbox narration requires narrationRuntime "colab" so the worker runs on Google Colab; no Kokoro fallback is used.'), {
          code: 'CHATTERBOX_NARRATION_REQUIRES_COLAB', status: 422,
        });
      }
      const python = process.env.COMFYRIZZ_PYTHON || defaultPython;
      try {
        await runCommand(python, [join(repoRoot, route.path), '--package', join(workDir, 'package.json'), '--out', workAudio]);
      } catch (error) {
        throw Object.assign(new Error(`Chatterbox narration failed in the Google Colab worker (${route.path}); no Kokoro fallback is used. ${error?.message ?? error}`), {
          code: 'CHATTERBOX_NARRATION_FAILED', status: 502, cause: error,
        });
      }
    } else {
      const qwen = pkg.voice.engine === 'qwen3-tts';
      const python = qwen
        ? process.env.COMFYRIZZ_QWEN_TTS_PYTHON || process.env.COMFYRIZZ_PYTHON || defaultPython
        : process.env.COMFYRIZZ_PYTHON || defaultPython;
      await runCommand(python, [join(repoRoot, 'packages/tts/py/synth.py'), '--package', join(workDir, 'package.json'), '--out', workAudio, '--padding', '0.5']);
      if (qwen) {
        await runCommand(process.env.COMFYRIZZ_QWEN_ASR_PYTHON || python, [join(repoRoot, 'packages/tts/py/qa_qwen.py'), '--package', join(workDir, 'package.json'), '--out', workAudio]);
      }
    }
  }

  if (pkg.voice.engine === 'chatterbox') assertChatterboxReports(workAudio);
  if (!existsSync(durationsPath)) throw new Error('Narration preparation did not produce measured durations');
  const durations = JSON.parse(readFileSync(durationsPath, 'utf8'));
  const fps = Number(pkg.format?.fps) > 0 ? Number(pkg.format.fps) : 30;
  // Check the authored shot length, not the already-expanded measured timeline.
  // Silent expansion would change the requested film duration after GPU planning.
  const extendedScenes = [];
  for (const scene of pkg.scenes ?? []) {
    const measured = durations.scenes?.[scene.id]?.seconds;
    const preferredFrames = Number(scene.preferredFrames);
    if (Number.isFinite(measured) && Number.isFinite(preferredFrames) && preferredFrames > 0 && measured > preferredFrames / fps + 0.001) {
      extendedScenes.push({ id: scene.id, authoredSeconds: preferredFrames / fps, narrationSeconds: measured });
    }
  }
  const options = narrationOptions(workDir);
  let timeline;
  try {
    timeline = compileTimeline(pkg, options);
  } catch (error) {
    // Exact retiming fails before it can return a timeline. Recover only a genuine
    // lower-bound overflow; other constraint failures need their original error.
    const bounds = error.code === 'exact-duration-impossible' && /available (\d+)–(\d+) frames/.exec(error.message);
    const minimum = bounds && Number(bounds[1]);
    if (!bounds || minimum <= authoredFrames) throw error;
    const scenes = (pkg.scenes ?? []).flatMap(scene => {
      const text = typeof scene.narration === 'string' ? scene.narration.trim() : '';
      const slot = authoredTimeline.scenes.find(item => item.id === scene.id);
      const chunks = options.narration?.[scene.id];
      if (!text || !slot || !chunks?.length) return [];
      const speechFrames = chunks.reduce((sum, chunk) => sum + Math.ceil(Math.max(0, chunk.seconds) * fps), 0);
      const gapFrames = Math.ceil((options.narrationGapSeconds ?? 0.15) * fps) * (chunks.length - 1);
      const paddingFrames = Math.ceil((options.narrationPaddingSeconds ?? 0.25) * fps);
      const measuredFrames = Math.max(speechFrames + gapFrames + paddingFrames, scene.narration_duration_frames ?? 0);
      const availableFrames = Math.max(0, slot.durationInFrames - slot.transitionOutFrames);
      const words = text.split(/\s+/u).length;
      const targetWords = Math.max(0, Math.min(words, Math.floor(words * Math.max(0, availableFrames - gapFrames - paddingFrames) / Math.max(1, speechFrames) * 0.9)));
      return [{ sceneId: scene.id, fromFrame: slot.from, sceneFrames: slot.durationInFrames,
        transitionOutFrames: slot.transitionOutFrames, measuredFrames, availableFrames,
        excessFrames: Math.max(0, measuredFrames - availableFrames),
        measuredSeconds: measuredFrames / fps, availableSeconds: availableFrames / fps, words, targetWords }];
    });
    throw Object.assign(new Error(`Measured narration cannot fit: minimum ${minimum} frames exceeds the exact ${authoredFrames}-frame target by ${minimum - authoredFrames} frames. Shorten narration and review the revised story.`), {
      code: 'NARRATION_TOO_LONG', status: 422,
      details: { fps, minimumFrames: minimum, targetFrames: authoredFrames, excessFrames: minimum - authoredFrames,
        measuredSeconds: minimum / fps, authoredSeconds: authoredFrames / fps, scenes },
    });
  }
  if (Number.isFinite(authoredFrames) && !durationWithinTarget(timeline.durationInFrames / fps, authoredFrames / fps)) {
    const message = `Narration changed the compiled film to ${(timeline.durationInFrames / fps).toFixed(2)}s; acceptable range is ${durationRangeText(authoredFrames / fps)}; shorten or rebalance the lines before media generation`;
    if (timeline.durationInFrames > authoredFrames) {
      const scenes = (pkg.scenes ?? []).flatMap(scene => {
        const text = typeof scene.narration === 'string' ? scene.narration.trim() : '';
        const measured = durations.scenes?.[scene.id]?.seconds;
        const slot = authoredTimeline.scenes.find(item => item.id === scene.id);
        if (!text || !Number.isFinite(measured) || !slot) return [];
        const words = text.split(/\s+/u).length;
        const preferred = Number(scene.preferredFrames);
        const frames = Number.isFinite(preferred) && preferred > 0 ? Math.min(preferred, slot.durationInFrames) : slot.durationInFrames;
        const available = Math.max(0, (frames - (slot.transitionOutFrames ?? 0)) / fps);
        // The measured report includes synthesis padding; this is a planning estimate,
        // not a promise that a rewritten sentence will take exactly this long.
        const padding = Number.isFinite(durations.paddingSeconds) ? Math.max(0, durations.paddingSeconds) : 0.5;
        const speech = Math.max(0.1, measured - padding);
        const targetWords = Math.max(0, Math.min(words, Math.floor(words * Math.max(0, available - padding) / speech * 0.9)));
        return [{ sceneId: scene.id, measuredSeconds: measured, availableSeconds: Number(available.toFixed(2)), words, targetWords }];
      });
      throw Object.assign(new Error(message), { code: 'NARRATION_TOO_LONG', status: 422,
        details: { measuredSeconds: timeline.durationInFrames / fps, authoredSeconds: authoredFrames / fps, scenes } });
    }
    throw new Error(message);
  }
  // The narration script also compiles the timeline. Check measured fit first so
  // an exact-duration failure retains its structured, actionable diagnostics.
  if (!alreadyMeasured) {
    await runCommand(process.execPath, [join(repoRoot, 'packages/tts/scripts/narrate.mjs'), '--example', workDir]);
    const prepared = JSON.parse(readFileSync(join(workDir, 'package.json'), 'utf8'));
    if (prepared.id !== pkg.id) throw new Error('Narration preparation changed the package identity');
    Object.assign(pkg, prepared);
  }
  if (!existsSync(narrationPath)) throw new Error('Narration preparation did not produce measured audio');
  mkdirSync(outputDir, { recursive: true });
  cpSync(workAudio, join(outputDir, 'audio'), { recursive: true });
  cpSync(workAudio, packageAudio, { recursive: true });
  return { voiced: true, timelineHash: timeline.hash, durationInFrames: timeline.durationInFrames, extendedScenes };
}
