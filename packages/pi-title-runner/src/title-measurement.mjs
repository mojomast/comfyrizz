import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { textColors, palette } from '../../../apps/renderer/src/theme-model.js';
import { cpuCommand, cpuRender } from './cpu-render.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const rgb = hex => [1, 3, 5].map(start => parseInt(hex.slice(start, start + 2), 16));
const json = (file, data) => writeFileSync(file, JSON.stringify(data, null, 2), { mode: 0o600 });
export const WIDTH_TARGET = { fraction: 0.60, tolerance: 0.025, expectedLines: 2 };

export async function decodeRgb(file, signal) {
  const header = readFileSync(file);
  if (header.subarray(1, 4).toString() !== 'PNG') throw new Error('Measurement requires a real PNG');
  const width = header.readUInt32BE(16), height = header.readUInt32BE(20);
  if (width * height > 7680 * 4320) throw new Error('Measurement image too large');
  const raw = `${file}.rgb`;
  try {
    await cpuCommand('ffmpeg', ['-v', 'error', '-y', '-i', file, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-threads', '1', raw], signal);
    const data = readFileSync(raw);
    if (data.length !== width * height * 3) throw new Error('RGB dimensions mismatch');
    return { width, height, data };
  } finally { rmSync(raw, { force: true }); }
}

// A paired intervention on ONLY theme.text identifies the raster contribution
// of the actual headline. No replacement text, layout, font or timing is used.
// This deliberately supports only a plain, headline-only native Title; it is
// not a color detector for arbitrary images and cannot mistake a blue rule for
// a headline. Unsupported scenes return unverified before diagnostic rendering.
export function measurementScope(pkg, fonts) {
  const scene = pkg.scenes?.[0];
  if (pkg.scenes?.length !== 1 || scene.layout !== 'title') return 'Requires one native Title';
  if (Object.entries(scene.copy ?? {}).some(([key, value]) => key !== 'headline' && value)) return 'Additional copy makes headline-only isolation ambiguous';
  if (!scene.copy?.headline?.trim()) return 'No headline';
  if (scene.background || scene.lower_third || scene.variant === 'outro' || Object.keys(pkg.assets ?? {}).length || pkg.captions?.enabled || pkg.theme.logo_asset) return 'Requires plain background without overlays';
  if (scene.motion?.recipe || scene.motion?.highlight || (scene.motion?.emphasis && scene.motion.emphasis !== 'none')) return 'Highlighted/recipe text is outside calibrated measurement scope';
  if (pkg.theme.font !== (fonts[0]?.family ?? 'Inter') || JSON.stringify(pkg.theme.fonts ?? []) !== JSON.stringify(fonts)) return 'Font identity differs from frozen admission';
  return null;
}

export function analyzeTitlePixels({ original, black, white, textRgb, backgroundRgb, compositionWidth, compositionHeight, expectedLines }) {
  const { width, height } = original;
  if ([black, white].some(image => image.width !== width || image.height !== height)) throw new Error('Diagnostic dimensions differ');
  const mask = Buffer.alloc(width * height);
  const rows = new Set();
  let minX = width, maxX = -1, minY = height, maxY = -1, inkPixels = 0, corePixels = 0, visibleCore = 0, maxReconstructionError = 0, maxOutsideError = 0, inconsistentAlpha = 0;
  for (let pixel = 0; pixel < mask.length; pixel++) {
    const at = pixel * 3;
    const deltas = [0, 1, 2].map(c => white.data[at + c] - black.data[at + c]);
    const coverage = Math.max(...deltas);
    if (Math.max(...deltas) - Math.min(...deltas) > 3 || Math.min(...deltas) < -3) inconsistentAlpha++;
    mask[pixel] = Math.max(0, Math.min(255, coverage));
    for (let c = 0; c < 3; c++) {
      const reconstructed = black.data[at + c] + deltas[c] * textRgb[c] / 255;
      maxReconstructionError = Math.max(maxReconstructionError, Math.abs(original.data[at + c] - reconstructed));
      if (coverage < 16) maxOutsideError = Math.max(maxOutsideError, Math.abs(original.data[at + c] - black.data[at + c]));
    }
    if (coverage >= 16) {
      const x = pixel % width, y = Math.floor(pixel / width);
      minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y); rows.add(y); inkPixels++;
    }
    if (coverage >= 240) {
      corePixels++;
      if (Math.max(...[0, 1, 2].map(c => Math.abs(original.data[at + c] - backgroundRgb[c]))) >= 32) visibleCore++;
    }
  }
  const bands = [];
  for (const row of rows) {
    if (!bands.length || row > bands.at(-1)[1] + 1) bands.push([row, row]);
    else bands.at(-1)[1] = row;
  }
  const bbox = inkPixels ? { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 } : null;
  const scaleX = width / compositionWidth, scaleY = height / compositionHeight;
  const clipped = Boolean(bbox && (minX <= 1 || minY <= 1 || maxX >= width - 2 || maxY >= height - 2));
  const agreement = maxReconstructionError <= 3 && inconsistentAlpha === 0;
  const visible = corePixels >= 16 && visibleCore / corePixels >= 0.99;
  return { mask, metrics: { image: { width, height, scaleX, scaleY }, bbox,
    compositionBbox: bbox && { x: bbox.x / scaleX, y: bbox.y / scaleY, width: bbox.width / scaleX, height: bbox.height / scaleY },
    widthFraction: bbox ? bbox.width / width : null, bands, expectedLines, inkPixels, corePixels, visibleCore, clipped,
    lineCountMatches: expectedLines == null ? null : bands.length === expectedLines,
    compositedAgreement: { pass: agreement, maxReconstructionError, maxOutsideError, inconsistentAlpha, tolerance: 3 }, visible } };
}

export async function measureTitle({ state, dir, sample, render = cpuRender, signal }) {
  const target = state.brief.titleWidth;
  const unsupported = measurementScope(state.package, state.fonts);
  if (!target || unsupported) return { code: 'rendered-title-width', status: 'unverified', evidence: unsupported ?? 'No explicit structured width acceptance target' };
  const pkg = state.package;
  for (const font of state.fontHashes ?? []) {
    if (sha(readFileSync(join(dir, font.file))) !== font.sha256) return { code: 'rendered-title-width', status: 'unverified', evidence: 'Admitted font bytes changed' };
  }
  const stem = `title-mask-r${pkg.revision}-${sha(Buffer.from(JSON.stringify(pkg))).slice(0, 10)}-f${sample.frame}`;
  const artifacts = [];
  const images = {};
  for (const [name, color] of [['black', '#000000'], ['white', '#ffffff']]) {
    const diagnostic = structuredClone(pkg); diagnostic.theme.text = color;
    const packageFile = `${stem}-${name}.diagnostic.json`, file = `${stem}-${name}.png`;
    json(join(dir, packageFile), diagnostic);
    await render(join(dir, packageFile), join(dir, file), { still: true, frame: sample.frame, scale: sample.scale, signal });
    images[name] = await decodeRgb(join(dir, file), signal);
    artifacts.push({ file, sha256: sha(readFileSync(join(dir, file))), purpose: 'diagnostic-only; NEVER final film' });
  }
  const original = await decodeRgb(join(dir, sample.file), signal);
  const { mask, metrics } = analyzeTitlePixels({ original, ...images, textRgb: rgb(textColors(pkg).primary), backgroundRgb: rgb(palette(pkg)[0]),
    compositionWidth: pkg.format.width, compositionHeight: pkg.format.height, expectedLines: target.expectedLines });
  const pgm = join(dir, `${stem}.pgm`), maskFile = `${stem}.png`;
  try {
    writeFileSync(pgm, Buffer.concat([Buffer.from(`P5\n${original.width} ${original.height}\n255\n`), mask]), { mode: 0o600 });
    await cpuCommand('ffmpeg', ['-v', 'error', '-y', '-i', pgm, '-frames:v', '1', '-threads', '1', join(dir, maskFile)], signal);
  } finally { rmSync(pgm, { force: true }); }
  artifacts.push({ file: maskFile, sha256: sha(readFileSync(join(dir, maskFile))), purpose: 'isolated differential headline coverage mask' });
  const geometricallyValid = metrics.compositedAgreement.pass && metrics.visible && !metrics.clipped && metrics.lineCountMatches !== false;
  const withinTarget = metrics.widthFraction !== null && Math.abs(metrics.widthFraction - target.fraction) <= target.tolerance;
  const currentSize = pkg.scenes[0].headline_size ?? 104;
  const recommendedSize = geometricallyValid && !withinTarget ? Math.max(24, Math.min(512, Math.round(currentSize * target.fraction / metrics.widthFraction))) : null;
  const result = { code: 'rendered-title-width', status: !metrics.compositedAgreement.pass ? 'unverified' : !metrics.visible || metrics.clipped || metrics.lineCountMatches === false ? 'fail' : withinTarget ? 'pass' : 'fail',
    evidence: 'Paired black/white theme.text interventions through the SAME native renderer/font/layout/frame, reconstructed against original composited PNG. Not OCR, not Canvas advance-width estimation.',
    packageKey: { id: pkg.id, revision: pkg.revision, hash: sha(Buffer.from(JSON.stringify(pkg))) }, sourceHash: state.sourceHash, briefHash: state.briefHash,
    frame: sample.frame, sample: sample.file, target, metrics, font: { family: pkg.theme.font, files: state.fontHashes },
    thresholds: { coverage: 16, opaqueCore: 240, minimumVisibleContrast: 32, minimumVisibleCoreFraction: 0.99, reconstructionError: 3, clippingGuardPixels: 1 },
    currentSize, recommendedSize, repairFields: geometricallyValid && !withinTarget ? ['headline_size'] : [], artifacts };
  const reportFile = `${stem}.measurement.json`;
  json(join(dir, reportFile), result);
  return { ...result, reportFile };
}
