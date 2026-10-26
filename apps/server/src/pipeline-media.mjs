import { copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { namedAssetFiles, isInside, copyNamedAssets } from './run-assets.mjs';
import { collectNarrationExtras } from './export.mjs';
import { compileTimeline } from '../../../packages/planner/dist/src/index.js';
import { narrationOptions, repoRoot } from '../../renderer/scripts/render-package-lib.mjs';
import { pipelineCommand } from './pipeline-process.mjs';
import { selectedPresenterScenes, presenterPortrait } from './pipeline-contract.mjs';
import { collectCompositionExtras } from '../../../packages/compositions/src/index.mjs';
import { collectCompositionCacheExtras } from '../../renderer/scripts/composition-worker.mjs';

export const json = path => JSON.parse(readFileSync(path));
export const writeJson = (path, value) => {
  writeFileSync(`${path}.tmp`, JSON.stringify(value, null, 2));
  renameSync(`${path}.tmp`, path);
};
export function assetMetadata(file) {
  const data = readFileSync(file);
  return { bytes: data.length, sha256: createHash('sha256').update(data).digest('hex') };
}
export async function stagePipelineInputs(pkg, sourceDir, workDir) {
  const files = [...namedAssetFiles(pkg), ...(pkg.theme?.fonts ?? []).map(f => f.file)];
  for (const file of files) {
    if (!isInside(sourceDir, file)) throw new Error('Asset path escapes the project');
    const source = join(sourceDir, file);
    if (!existsSync(source)) {
      const pending = Object.values(pkg.assets ?? {}).some(a => a.file === file && a.status === 'pending');
      if (pending) continue;
      throw new Error(`Project input is missing: ${file}`);
    }
    if (!realpathSync(source).startsWith(realpathSync(sourceDir) + sep)) throw new Error('Asset symlink escapes project directory');
    const asset = Object.values(pkg.assets ?? {}).find(a => a.file === file);
    if (asset?.sha256 && assetMetadata(source).sha256 !== asset.sha256) throw new Error(`Project input hash changed: ${file}`);
  }
  copyNamedAssets({ pkg, outputDir: sourceDir, packageDir: workDir });
  for (const font of pkg.theme?.fonts ?? []) {
    mkdirSync(dirname(join(workDir, font.file)), { recursive: true });
    copyFileSync(join(sourceDir, font.file), join(workDir, font.file));
  }
  // Export's validated sidecar collector also protects recovery/import paths.
  for (const extra of [...collectNarrationExtras(pkg, sourceDir), ...collectCompositionExtras(pkg, sourceDir), ...await collectCompositionCacheExtras(pkg, sourceDir)]) {
    mkdirSync(dirname(join(workDir, extra.path)), { recursive: true });
    writeFileSync(join(workDir, extra.path), extra.data);
  }
}

export function presenterScenes(pkg) {
  return selectedPresenterScenes(pkg);
}
export async function preparePresenterInputs(workDir, { signal, onEvent = () => {} } = {}) {
  const packagePath = join(workDir, 'package.json'), pkg = json(packagePath);
  const timeline = compileTimeline(pkg, narrationOptions(workDir));
  for (const scene of presenterScenes(pkg)) {
    if (!scene.narration?.trim()) throw new Error(`${scene.id}: presenter scene has no narration`);
    const timing = timeline.scenes.find(s => s.id === scene.id);
    const assetId = scene.presenter_asset ?? `a_presenter_${scene.id}`;
    const original = pkg.assets[assetId];
    const fps = Number(original?.gen?.inputs?.fps ?? 24);
    const frames = Math.max(9, Math.ceil((timing.durationInFrames / timeline.fps * fps - 1) / 8) * 8 + 1);
    const file = `audio/presenter-${scene.id}.wav`, voiceId = `a_voice_${scene.id}`;
    await pipelineCommand('ffmpeg', ['-y', '-v', 'error', '-ss', String(timing.from / timeline.fps), '-i', join(workDir, 'audio/narration.norm.wav'), '-af', `apad,atrim=duration=${frames / fps}`, '-ar', '24000', '-ac', '1', '-c:a', 'pcm_s16le', join(workDir, file)], { signal });
    pkg.assets[voiceId] = {
      kind: 'audio', origin: 'generated', status: 'ready', file, ...assetMetadata(join(workDir, file)),
      license: { id: 'CC0-1.0' }, redistributable: true,
      model_license: { id: 'Apache-2.0', url: 'https://huggingface.co/hexgrad/Kokoro-82M' },
      media: { durationSeconds: frames / fps, audio: 'present', codec: 'pcm_s16le' },
      gen: {
        generator: 'kokoro', model: 'kokoro-v1.0.onnx',
        inputs: { source: 'a_narration', scene: scene.id, sample_rate: 24000 },
        caption: 'Presenter narration excerpt cut from the measured narration track.',
      },
    };
    // New narration invalidates every audio-conditioned presenter; never reuse by ID alone.
    pkg.assets[assetId] = {
      kind: 'video', origin: 'generated', status: 'pending', license: { id: 'CC0-1.0' }, redistributable: true,
      model_license: { id: 'LTX-2.x-Community', url: 'https://huggingface.co/Lightricks/LTX-2.5' },
      gen: { generator: 'ltx25-a2v', model: 'ltx-2.5', workflow: 'workflows/ltx25_a2v_2stage.api.json', workflow_sha256: assetMetadata(join(repoRoot, 'workflows/ltx25_a2v_2stage.api.json')).sha256, inputs: {
        width: 768, height: 768, seed: 42, strength: 0.9, stage2_strength: 1,
        prompt: 'Locked studio head-and-shoulders portrait. Speak the provided audio naturally. Clear unobstructed mouth, subtle blinks, small head movements, no camera motion, no cuts, no text.',
        ...original?.gen?.inputs, image: presenterPortrait(pkg), audio: voiceId, fps, frames,
      } },
    };
    scene.presenter_asset = assetId;
    onEvent({ sceneId: scene.id, frames, fps });
  }
  writeJson(packagePath, pkg);
}

export function correctionFor(report, fps, maxCorrectionMs = 400) {
  if (report.passed) return 0;
  if (!Number.isFinite(report.confidence) || report.confidence < 3 || !Number.isFinite(report.offsetMs) || Math.abs(report.offsetMs) > maxCorrectionMs) throw new Error('Presenter sync is unreliable or outside the bounded correction range. Regenerate this presenter.');
  // SyncNet offset has the opposite sign to the picture delay.
  return Math.round(-report.offsetMs * fps / 1000);
}

export async function correctPresenters(workDir, runDir, { signal, onEvent = () => {}, env = process.env } = {}) {
  const packagePath = join(workDir, 'package.json'), pkg = json(packagePath), results = [];
  for (const scene of presenterScenes(pkg)) {
    const asset = pkg.assets[scene.presenter_asset], originalFile = asset.file;
    const audio = join(workDir, `audio/presenter-${scene.id}.wav`);
    const output = join(runDir, 'sync', scene.id); mkdirSync(output, { recursive: true });
    const evaluate = async (video, out) => {
      await pipelineCommand(env.COMFYRIZZ_SYNCNET_PYTHON, [join(repoRoot, 'scripts/tts/check_lipsync.py'), '--video', video, '--audio', audio, '--out', out, '--syncnet-dir', env.COMFYRIZZ_SYNCNET_DIR], { signal, allowedCodes: [0, 2] });
      return json(join(out, 'report.json'));
    };
    onEvent({ sceneId: scene.id, phase: 'measuring' });
    const before = await evaluate(join(workDir, originalFile), join(output, 'before'));
    const probe = JSON.parse((await pipelineCommand('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=r_frame_rate,nb_frames', '-of', 'json', join(workDir, originalFile)], { signal })).stdout).streams[0];
    const [num, den] = probe.r_frame_rate.split('/').map(Number), fps = num / den;
    const frames = Number(probe.nb_frames);
    if (!Number.isFinite(fps) || fps <= 0 || !Number.isInteger(frames) || frames <= 0) throw new Error('Cannot determine presenter source frame grid');
    const shift = correctionFor(before, fps);
    let after = before;
    if (shift) {
      onEvent({ sceneId: scene.id, phase: 'correcting', shiftFrames: shift, fps });
      const file = `assets/${scene.presenter_asset}-synced.mp4`;
      const filter = shift > 0 ? `tpad=start_mode=clone:start_duration=${shift / fps}` : `trim=start_frame=${-shift},setpts=PTS-STARTPTS,tpad=stop_mode=clone:stop_duration=${-shift / fps}`;
      await pipelineCommand('ffmpeg', ['-y', '-v', 'error', '-i', join(workDir, originalFile), '-vf', filter, '-frames:v', String(frames), '-an', '-c:v', 'libx264', '-crf', '17', '-pix_fmt', 'yuv420p', join(workDir, file)], { signal });
      after = await evaluate(join(workDir, file), join(output, 'after'));
      if (!after.passed) throw new Error(`${scene.id}: presenter still fails sync after correction`);
      asset.file = file; Object.assign(asset, assetMetadata(join(workDir, file)));
    }
    results.push({ sceneId: scene.id, originalFile, file: asset.file, shiftFrames: shift, fps, before, after });
    onEvent({ sceneId: scene.id, phase: 'verified', completed: results.length, total: presenterScenes(pkg).length, confidence: after.confidence, offsetMs: after.offsetMs });
  }
  writeJson(packagePath, pkg);
  writeJson(join(runDir, 'presenter-sync.json'), results);
  return results;
}
