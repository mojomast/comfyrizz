import { closeSync, openSync, readSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cpuCommand } from './cpu-render.mjs';
import { decodeRgb } from './title-measurement.mjs';

// Post-export observation only. Never mutates the package or spends a repair.
// This catches disappearing frames that four lossless stills cannot establish.
export async function auditExport({ dir, pkg, brief, findings, signal }) {
  const path = join(dir, 'export.mp4');
  const probe = JSON.parse((await cpuCommand('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', path], signal)).stdout);
  const video = probe.streams.find(stream => stream.codec_type === 'video');
  if (!video) throw new Error('Export has no video stream');
  const width = Math.round(pkg.format.width / 2), height = Math.round(pkg.format.height / 2), frameBytes = width * height * 3;
  const raw = join(dir, 'export-audit.rgb');
  let fd;
  try {
    await cpuCommand('ffmpeg', ['-v', 'error', '-y', '-i', path, '-vf', `scale=${width}:${height}`, '-vsync', '0', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-threads', '1', raw], signal);
    const count = statSync(raw).size / frameBytes;
    if (!Number.isInteger(count)) throw new Error('Incomplete decoded export frame');
    fd = openSync(raw, 'r');
    const holdStart = Math.round(brief.revealSeconds * pkg.format.fps), finalStart = Math.max(holdStart, count - 3 * pkg.format.fps);
    const reference = Buffer.alloc(frameBytes), frame = Buffer.alloc(frameBytes);
    if (readSync(fd, reference, 0, frameBytes, holdStart * frameBytes) !== frameBytes) throw new Error('Missing hold reference');
    const measurements = [];
    for (let index = holdStart; index < count; index++) {
      signal?.throwIfAborted();
      if (readSync(fd, frame, 0, frameBytes, index * frameBytes) !== frameBytes) throw new Error('Missing decoded frame');
      let sum = 0, maxChannelDelta = 0, changedPixels = 0;
      for (let p = 0; p < frameBytes; p += 3) {
        let delta = 0;
        for (let c = 0; c < 3; c++) { const d = Math.abs(frame[p + c] - reference[p + c]); sum += d; delta = Math.max(delta, d); }
        maxChannelDelta = Math.max(maxChannelDelta, delta); if (delta > 8) changedPixels++;
      }
      const meanChannelDelta = sum / frameBytes, changedPixelFraction = changedPixels / (width * height);
      measurements.push({ frame: index, meanChannelDelta, maxChannelDelta, changedPixelFraction, pass: meanChannelDelta <= 0.15 && changedPixelFraction <= 0.001 });
    }
    const finalSample = findings.samples.at(-1);
    const lossless = await decodeRgb(join(dir, finalSample.file), signal);
    if (lossless.width !== width || lossless.height !== height) throw new Error('Lossless/export audit dimensions differ');
    let imageDelta = 0, differingPixels = 0;
    for (let p = 0; p < frameBytes; p += 3) {
      let delta = 0;
      for (let c = 0; c < 3; c++) { const d = Math.abs(frame[p + c] - lossless.data[p + c]); imageDelta += d; delta = Math.max(delta, d); }
      if (delta > 16) differingPixels++;
    }
    const meanChannelDelta = imageDelta / frameBytes, changedPixelFraction = differingPixels / (width * height);
    const finalFrameAgreement = { losslessSample: finalSample.file, frame: count - 1, meanChannelDelta, changedPixelFraction,
      tolerance: { meanChannelDelta: 2, maximumFractionPixelsAbove16: 0.02 }, pass: meanChannelDelta <= 2 && changedPixelFraction <= 0.02,
      interpretation: 'Decoded final MP4 frame agrees with measured composited lossless preview within codec/resampling tolerance; not exact MP4 glyph segmentation' };
    const result = { provenance: 'All decoded MP4 hold frames at half resolution; separate from four lossless preview samples. Not full-resolution correctness or perceptual review.',
      probe, duration: { expected: brief.durationSeconds, actual: Number(video.duration), pass: Math.abs(Number(video.duration) - brief.durationSeconds) < 1 / pkg.format.fps },
      silent: !probe.streams.some(stream => stream.codec_type === 'audio'), decodedFrames: count, dimensions: { width, height },
      tolerance: { meanChannelDelta: 0.15, maximumFractionPixelsAbove8: 0.001 }, referenceFrame: holdStart,
      allHold: { frames: measurements.length, pass: measurements.every(m => m.pass), outliers: measurements.filter(m => !m.pass).map(m => m.frame) },
      finalThreeSeconds: { frames: measurements.filter(m => m.frame >= finalStart).length, pass: measurements.filter(m => m.frame >= finalStart).every(m => m.pass) }, finalFrameAgreement, measurements };
    writeFileSync(join(dir, 'export-audit.json'), JSON.stringify(result, null, 2), { mode: 0o600 });
    return { file: 'export-audit.json', duration: result.duration, silent: result.silent, allHold: result.allHold, finalThreeSeconds: result.finalThreeSeconds, finalFrameAgreement, resolution: 'half-resolution decoded MP4' };
  } finally { if (fd !== undefined) closeSync(fd); rmSync(raw, { force: true }); }
}
