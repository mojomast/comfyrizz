// C5 acceptance: a recorded/stub LLM (no network) turns a chat brief into a
// valid comfyrizz.package/v1 package with >=4 llm-svg assets, then a real CPU
// Remotion render produces an ffprobe-checked MP4.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCpuSlice } from '../../../packages/agent/dist/src/index.js';
import { autoFix, renderCheck } from '../../../packages/vector/dist/src/index.js';
import { validatePackage } from '../../../packages/schema/src/index.mjs';
import { renderPackage } from '../../renderer/scripts/render-package-lib.mjs';

const BRIEF = 'Make a CPU launch video with an icon, a diagram, a dot pattern and an animated bar motif, plus one nebula illustration to plan for GPU later.';

test('CPU agent slice -> valid package -> ffprobe-checked MP4', { timeout: 600_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'comfyrizz-agent-e2e-'));
  try {
    const persistSvg = (assetId, svg) => {
      mkdirSync(join(dir, 'assets'), { recursive: true });
      const relative = `assets/${assetId}.svg`;
      writeFileSync(join(dir, relative), svg);
      return relative;
    };
    const generateSvg = async intent => {
      const result = await autoFix(async () => '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><rect x="48" y="48" width="416" height="416" rx="32" fill="#6d8cff"/><path d="M128 272 L224 368 L384 160" fill="none" stroke="#e6e8ee" stroke-width="24"/></svg>', intent, 2, { width: 512 });
      if (!result.ok) throw new Error(result.errors.map(error => `${error.code}: ${error.message}`).join('; '));
      const check = renderCheck(result.svg, { width: 512, palette: intent.palette });
      return {
        svg: result.svg,
        attempts: result.attempts,
        repairs: result.repairs,
        sanitizerVersion: result.sanitizerVersion,
        renderCheck: {
          ok: check.ok,
          version: result.sanitizerVersion,
          width: check.width,
          height: check.height,
          opaqueFraction: check.opaqueFraction,
          outOfPaletteFraction: check.outOfPaletteFraction,
        },
      };
    };

    const slice = await runCpuSlice({ brief: BRIEF, generateSvg, persistSvg, now: () => '2026-10-18T00:00:00.000Z' });
    assert.equal(slice.live, false);
    assert.ok(slice.svgAssets.length >= 4, `expected >=4 llm-svg assets, got ${slice.svgAssets.length}`);
    assert.ok(slice.pendingGpu.length >= 1, 'expected at least one pending-GPU plan');
    assert.ok(slice.routes.some(route => route.tool === 'assets.generate_svg'));
    assert.ok(slice.routes.some(route => route.tool === 'assets.generate_image'));

    const validation = validatePackage(slice.package);
    assert.equal(validation.valid, true, JSON.stringify(validation.errors.slice(0, 6)));
    const svgCount = Object.values(slice.package.assets).filter(asset => asset.gen?.generator === 'llm-svg' && asset.status === 'ready').length;
    assert.ok(svgCount >= 4, `package should carry >=4 ready llm-svg assets, got ${svgCount}`);

    const packagePath = join(dir, 'package.json');
    writeFileSync(packagePath, JSON.stringify(slice.package, null, 2));
    const output = join(dir, 'agent-slice.mp4');
    const rendered = renderPackage(packagePath, output, { onLog: () => {}, intent: 'draft' });
    assert.ok(rendered.bytes > 100_000, `expected a real MP4, got ${rendered.bytes} bytes`);

    const probe = JSON.parse(
      execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_name,width,height,nb_frames', '-show_entries', 'format=duration', '-of', 'json', output]).toString(),
    );
    const video = probe.streams.find(stream => stream.codec_name === 'h264');
    assert.ok(video, 'ffprobe should report an H.264 video stream');
    assert.equal(video.width, 1920);
    assert.equal(video.height, 1080);
    assert.equal(Number(video.nb_frames), rendered.frames);
    assert.ok(Number(probe.format.duration) > 30, 'expected a >30 s CPU slice');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
