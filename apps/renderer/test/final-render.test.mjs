// A9 (M7): the final export renders at 1920×1080 and prefers an asset's x2 upscaled variant when
// the package declares one, otherwise it scales the base media with A8's real-size handling.
// The variant field is `assets[<id>].variants.upscaled = { file, width, height }`, agreed with
// H12; the fixture builds it here so the test works before H12 lands its schema field.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { renderPackage, upscaledVariant, preferUpscaledAssets } from '../scripts/render-package-lib.mjs';
import { compileTimeline } from '../../../packages/planner/dist/src/index.js';
import { collectMockContribution } from '../../server/test/helpers/comfy-contribution.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const tiny = JSON.parse(readFileSync(join(here, 'fixtures', 'tiny', 'package.json'), 'utf8'));
const scratch = [];

after(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

function solidPng(file, color, width, height) {
  const result = spawnSync('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', `color=c=${color}:s=${width}x${height}`, '-frames:v', '1', file], { encoding: 'utf8' });
  assert.equal(result.status, 0, `ffmpeg could not write ${file}: ${result.stderr}`);
}

/** Two-second media-only package, including one second of stable contribution visibility. */
function buildFixture() {
  const dir = mkdtempSync(join(tmpdir(), 'comfyrizz-a9-'));
  scratch.push(dir);
  mkdirSync(join(dir, 'assets'), { recursive: true });
  solidPng(join(dir, 'assets', 'base.png'), 'red', 960, 544);
  solidPng(join(dir, 'assets', 'up.png'), 'lime', 1920, 1080);
  const pkg = structuredClone(tiny);
  pkg.id = 'pkg_a9final0001';
  pkg.title = 'A9 final render';
  pkg.format = { width: 960, height: 544, fps: 30 };
  delete pkg.datasets;
  pkg.scenes = [
    {
      id: 's_media',
      layout: 'hero',
      variant: 'full-bleed',
      media_only: true,
      preferredFrames: 60,
      copy: { headline: 'Final render' },
      background: { asset: 'a_bg', fit: 'cover' },
    },
  ];
  pkg.assets = {
    a_bg: {
      kind: 'image',
      origin: 'generated',
      status: 'ready',
      file: 'assets/base.png',
      license: { id: 'CC0-1.0' },
      redistributable: true,
      gen: { generator: 'flux3-klein' },
      model_license: { id: 'apache-2.0', url: 'https://example.test/apache-2.0' },
      sha256: 'a'.repeat(64),
      bytes: 10,
    },
  };
  pkg.compliance.backends_used = ['colab:G4'];
  // Keep the base/variant bytes intact; the separate synthetic inset supplies
  // receipt-backed admission for this resolution/variant contract test only.
  collectMockContribution(pkg, dir);
  const withVariant = structuredClone(pkg);
  withVariant.id = 'pkg_a9final0002';
  withVariant.assets.a_bg.variants = { upscaled: { file: 'assets/up.png', width: 1920, height: 1080 } };
  writeFileSync(join(dir, 'base.json'), JSON.stringify(pkg, null, 2));
  writeFileSync(join(dir, 'variant.json'), JSON.stringify(withVariant, null, 2));
  return { dir, pkg, withVariant };
}

function probe(file) {
  const result = spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-count_frames', '-show_entries', 'stream=width,height,nb_read_frames,pix_fmt,color_range,color_space', '-of', 'json', file], { encoding: 'utf8' });
  assert.equal(result.status, 0, `ffprobe failed: ${result.stderr}`);
  const stream = JSON.parse(result.stdout).streams[0];
  return { width: stream.width, height: stream.height, frames: Number(stream.nb_read_frames), pixFmt: stream.pix_fmt, colorRange: stream.color_range, colorSpace: stream.color_space };
}

/** Centre pixel of the frame at `seconds`, as [r, g, b]. Crops 2×2 because 1×1 rawvideo is rejected. */
function centerPixel(file, seconds = 0.2) {
  const result = spawnSync('ffmpeg', ['-v', 'error', '-ss', String(seconds), '-i', file, '-frames:v', '1', '-vf', 'crop=2:2:iw/2:ih/2', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: 1024 * 64 });
  assert.equal(result.status, 0, `ffmpeg pixel failed: ${result.stderr}`);
  return [result.stdout[0], result.stdout[1], result.stdout[2]];
}

test('upscaledVariant / preferUpscaledAssets choose only existing media variants', () => {
  const { dir } = buildFixture();
  assert.equal(upscaledVariant({ kind: 'svg', variants: { upscaled: { file: 'x' } } }), null, 'only image/video assets have upscaled variants');
  assert.equal(upscaledVariant({ kind: 'image' }), null);
  assert.equal(upscaledVariant({ kind: 'image', variants: { upscaled: 'assets/x.png' } }), null, 'a bare string is not a variant object');
  assert.equal(upscaledVariant({ kind: 'image', variants: { upscaled: { file: '' } } }), null);
  const pkg = { assets: { a_bg: { kind: 'image', file: 'assets/base.png', variants: { upscaled: { file: 'assets/up.png', width: 1920, height: 1080 } } }, a_gone: { kind: 'image', file: 'assets/base.png', variants: { upscaled: { file: 'assets/missing.png', width: 1920, height: 1080 } } } } };
  const { pkg: resolved, used } = preferUpscaledAssets(pkg, dir);
  assert.deepEqual(used, [{ id: 'a_bg', file: 'assets/up.png', base: 'assets/base.png', width: 1920, height: 1080 }]);
  assert.equal(resolved.assets.a_bg.file, 'assets/up.png');
  assert.equal(resolved.assets.a_gone.file, 'assets/base.png', 'a variant this clone does not have is ignored');
  assert.equal(pkg.assets.a_bg.file, 'assets/base.png', 'the input package is not mutated');
});

test('preview keeps the working resolution and does not use the variant', { timeout: 300_000 }, () => {
  const { dir } = buildFixture();
  const rendered = renderPackage(join(dir, 'variant.json'), join(dir, 'preview.mp4'), { intent: 'draft' });
  assert.equal(rendered.final, undefined, 'no final option means no 1080p override');
  const probe0 = probe(join(dir, 'preview.mp4'));
  assert.equal(probe0.width, 960);
  assert.equal(probe0.height, 544);
  assert.equal(probe0.frames, compileTimeline(rendered.package).durationInFrames);
  // A10 nit: the CPU export is limited-range yuv420p, not full-range yuvj420p.
  assert.equal(probe0.pixFmt, 'yuv420p', 'CPU export pixel format');
  assert.equal(probe0.colorRange, 'tv', 'limited range');
  assert.equal(probe0.colorSpace, 'bt709', 'bt709 tags limited range');
  const [r, g] = centerPixel(join(dir, 'preview.mp4'));
  assert.ok(r > 200 && g < 60, `preview should draw the red base file, got rgb(${r},${g})`);
});

test('final render is 1920×1080 and uses the upscaled variant when present', { timeout: 600_000 }, () => {
  const { dir, pkg, withVariant } = buildFixture();
  const frames = compileTimeline(pkg).durationInFrames;

  // Without a variant: 1920×1080, media scaled by A8 (no stretching), base file used.
  const base = renderPackage(join(dir, 'base.json'), join(dir, 'final-base.mp4'), { final: true });
  assert.equal(base.final.width, 1920);
  assert.equal(base.final.height, 1080);
  assert.deepEqual(base.final.upscaled, []);
  const baseProbe = probe(join(dir, 'final-base.mp4'));
  assert.equal(baseProbe.width, 1920);
  assert.equal(baseProbe.height, 1080);
  assert.equal(baseProbe.frames, frames);
  const [br, bg] = centerPixel(join(dir, 'final-base.mp4'));
  assert.ok(br > 200 && bg < 60, `no variant should scale the red base file, got rgb(${br},${bg})`);

  // With a variant: same 1080p output, but the lime upscaled file is the one on screen.
  const up = renderPackage(join(dir, 'variant.json'), join(dir, 'final-up.mp4'), { final: true });
  assert.equal(up.final.width, 1920);
  assert.equal(up.final.height, 1080);
  assert.deepEqual(up.final.upscaled, [{ id: 'a_bg', file: 'assets/up.png', base: 'assets/base.png', width: 1920, height: 1080 }]);
  const upProbe = probe(join(dir, 'final-up.mp4'));
  assert.equal(upProbe.width, 1920);
  assert.equal(upProbe.height, 1080);
  assert.equal(upProbe.frames, frames);
  const [ur, ug] = centerPixel(join(dir, 'final-up.mp4'));
  assert.ok(ug > 200 && ur < 60, `the upscaled lime file should be used, got rgb(${ur},${ug})`);
  assert.equal(withVariant.assets.a_bg.file, 'assets/base.png', 'the stored package keeps its base file');
});
