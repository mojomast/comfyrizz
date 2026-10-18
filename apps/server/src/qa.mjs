/**
 * MS4 step 3: the frame QA gate as the render path uses it.
 *
 * After a render, the same MP4 and the compiled timeline the renderer used are
 * fed through the CPU QA pass: findings go to a `qa.json` sidecar and a
 * contact-sheet PNG, and the last result is kept per render id and per package
 * so the web can ask for it. No network, no GPU, no model.
 */
import { writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { checkVideo, qaJson } from '../../renderer/scripts/frame-qa.mjs';
import { buildSheet } from '../../renderer/scripts/contact-sheet.mjs';

/**
 * Run the gate over a rendered file. Never throws for a QA finding — only an
 * ffmpeg/ffprobe failure does, and the caller decides whether that is fatal.
 */
export function runFrameQa({ mp4, timeline, pkg, outDir, sheet = true, onLog = () => {} }) {
  const report = checkVideo({ mp4, timeline, pkg, onLog });
  const json = qaJson({ mp4, timeline, report });
  let sheetPath = null;
  if (sheet) {
    try {
      sheetPath = join(outDir, `${basename(mp4, '.mp4')}.sheet.png`);
      buildSheet({ mp4, timeline, out: sheetPath, onLog });
      json.sheet = sheetPath;
    } catch (error) {
      onLog(`sheet skipped: ${error.message}`);
    }
  }
  json.qaPath = join(outDir, `${basename(mp4, '.mp4')}.qa.json`);
  writeFileSync(json.qaPath, `${JSON.stringify(json, null, 2)}\n`);
  return json;
}

/** Keeps the latest QA result by render id and by package id. */
export function createQaRegistry() {
  const byRender = new Map();
  const byPackage = new Map();
  return {
    record(renderId, packageId, result) {
      if (renderId) byRender.set(renderId, result);
      if (packageId) byPackage.set(packageId, result);
    },
    lookup({ renderId, packageId } = {}) {
      if (renderId) return byRender.get(renderId) ?? null;
      if (packageId) return byPackage.get(packageId) ?? null;
      return null;
    },
  };
}
