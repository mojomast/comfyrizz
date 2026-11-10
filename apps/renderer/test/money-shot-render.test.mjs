// Frame 0 of the default render is a finished hero, not a fade from black.
// CPU stills only: no Google Colab, no GPU, no paid generation.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderPackage } from '../scripts/render-package-lib.mjs';
import { BLACK_EDGES_MAX, BLACK_MEAN_MAX, lumaStats, rgbToGray } from '../scripts/frame-qa.mjs';

const width = 640;
const height = 360;

function rgb(file) {
  const result = spawnSync('ffmpeg', ['-v', 'error', '-i', file, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: width * height * 4 });
  assert.equal(result.status, 0, String(result.stderr));
  assert.equal(result.stdout.length, width * height * 3);
  return result.stdout;
}

function stats(file) {
  const bytes = rgb(file);
  return lumaStats(rgbToGray(bytes), width, height);
}

/** Dark headline ink on the bright plate. The hook has to be painted, not hidden. */
function darkPixels(file) {
  const bytes = rgb(file);
  let count = 0;
  for (let i = 0; i < bytes.length; i += 3) {
    if (bytes[i] < 40 && bytes[i + 1] < 40 && bytes[i + 2] < 40) count += 1;
  }
  return count;
}

test('default frame 0 is a bright finished hero, and the off switch restores the black fade', { timeout: 300_000 }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'comfyrizz-money-shot-'));
  try {
    mkdirSync(join(dir, 'assets'), { recursive: true });
    const plate = join(dir, 'assets', 'hero.png');
    const made = spawnSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', `color=c=0xfff4d6:s=${width}x${height}`, '-frames:v', '1', plate], { encoding: 'utf8' });
    assert.equal(made.status, 0, made.stderr);
    const bytes = readFileSync(plate);
    const pkg = {
      $schema: 'https://comfyrizz.example/schema/package-v1.json',
      schemaVersion: 1,
      revision: 1,
      id: 'pkg_moneyshot0001',
      title: 'Money shot',
      format: { width, height, fps: 30 },
      duration: { mode: 'flexible', flexibleCeilingFrames: 2700 },
      theme: { palette: ['#000000', '#1f4fd8', '#333333', '#ffffff'], text: '#111111', font: 'Inter' },
      voice: { enabled: false, engine: 'none' },
      scenes: [{
        id: 's_title',
        layout: 'title',
        variant: 'centered',
        preferredFrames: 90,
        copy: { headline: 'Money shot' },
        foreground: [{ asset: 'a_hero', x: 0.5, y: 0.5, w: 0.92, anim: 'fade-in' }],
      }],
      assets: {
        a_hero: {
          kind: 'image',
          origin: 'upload',
          status: 'ready',
          file: 'assets/hero.png',
          sha256: createHash('sha256').update(bytes).digest('hex'),
          bytes: bytes.length,
          license: { id: 'CC0-1.0' },
          redistributable: true,
        },
      },
      compliance: { open_weights_only: true, backends_used: [], closed_apis_used: [], warnings: [] },
    };
    const packagePath = join(dir, 'package.json');
    writeFileSync(packagePath, JSON.stringify(pkg));
    const onPath = join(dir, 'frame0.png');
    const offPath = join(dir, 'frame0-off.png');
    const opened = renderPackage(packagePath, onPath, { still: true, frame: 0, normalizeLoudness: false });
    renderPackage(packagePath, offPath, { still: true, frame: 0, moneyShot: false, normalizeLoudness: false });
    assert.equal(opened.frames, 1);
    const on = stats(onPath);
    const off = stats(offPath);
    assert.ok(off.mean <= BLACK_MEAN_MAX && off.edges <= BLACK_EDGES_MAX, `off switch should fade from black, luma ${off.mean.toFixed(1)} edges ${off.edges.toFixed(2)}`);
    assert.ok(on.mean > 80, `frame 0 should be a bright hero, luma ${on.mean.toFixed(1)}`);
    assert.ok(!(on.mean <= BLACK_MEAN_MAX && on.edges <= BLACK_EDGES_MAX), 'frame 0 is not a blank or near-black thumbnail');
    assert.ok(darkPixels(onPath) > 400, 'the headline is readable on the hero');
    mkdirSync('/opt/cursor/artifacts', { recursive: true });
    copyFileSync(onPath, '/opt/cursor/artifacts/money-shot-frame-0.png');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
