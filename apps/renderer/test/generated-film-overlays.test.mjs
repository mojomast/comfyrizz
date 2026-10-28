import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderPackage } from '../scripts/render-package-lib.mjs';
import { checkVideo } from '../scripts/frame-qa.mjs';

function fixture(work, width, height) {
  const assets = join(work, 'assets');
  mkdirSync(assets, { recursive: true });
  const footage = join(assets, 'footage.mp4');
  const boxes = `drawbox=x=${Math.round(width / 16)}:y=${Math.round(height / 6.75)}:w=${Math.round(width * 0.1875)}:h=${Math.round(height / 3)}:color=0x2f6f8f:t=fill,drawbox=x=${Math.round(width * 0.729)}:y=${Math.round(height * 0.519)}:w=${Math.round(width * 0.125)}:h=${Math.round(height * 0.222)}:color=0xb08050:t=fill`;
  const made = spawnSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', `color=c=0x142536:s=${width}x${height}:r=30:d=5`, '-vf', boxes, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', footage], { encoding: 'utf8' });
  assert.equal(made.status, 0, made.stderr);
  const media = [{ asset: 'a_footage' }, { asset: 'a_footage' }];
  return {
    $schema: 'https://comfyrizz.example/schema/package-v1.json', schemaVersion: 1, revision: 1,
    id: `pkg_hybrid_${width}x${height}`, title: 'The Atlas', createdAt: '2026-10-28T00:00:00.000Z',
    format: { width, height, fps: 30 }, duration: { mode: 'flexible', flexibleCeilingFrames: 2700 },
    theme: { palette: ['#0d0f14', '#1b2440', '#6d8cff', '#e6e8ee'], font: 'Inter' },
    voice: { enabled: false, engine: 'none' }, datasets: {},
    scenes: [
      { id: 's1', layout: 'title', variant: 'centered', preferredFrames: 45, copy: { kicker: 'A GENERATED FILM', headline: 'THE ATLAS', sub: 'A river remembered.' }, background: { asset: 'a_footage' }, media, media_only: false, motion: { recipe: 'kinetic', entry: 'maskRise' } },
      { id: 's2', layout: 'list', preferredFrames: 45, background: { asset: 'a_footage' }, media, media_only: true },
      { id: 's3', layout: 'title', variant: 'outro', preferredFrames: 45, copy: { kicker: 'THE ATLAS', headline: 'The End', sub: 'Every river leaves a line.' }, background: { asset: 'a_footage' }, media, media_only: false, motion: { recipe: 'kinetic', entry: 'fadeUp' } },
    ],
    assets: {
      a_footage: {
        kind: 'video', origin: 'upload', status: 'ready', file: 'assets/footage.mp4',
        sha256: createHash('sha256').update(readFileSync(footage)).digest('hex'),
        license: { id: 'CC0-1.0' }, redistributable: true,
        media: { width, height, fps: 30, frames: 150, durationSeconds: 5, audio: 'none' },
      },
    },
    compliance: { open_weights_only: true }, renders: [],
  };
}

function rawFrame(file, frame) {
  const result = spawnSync('ffmpeg', ['-v', 'error', '-i', file, '-vf', `select=eq(n\\,${frame}),format=rgb24`, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: 64 * 1024 * 1024 });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

function accentInk(file, frame) {
  const bytes = rawFrame(file, frame);
  let count = 0;
  for (let index = 0; index < bytes.length; index += 3) {
    const red = bytes[index];
    const green = bytes[index + 1];
    const blue = bytes[index + 2];
    if (blue > 160 && blue > red + 45 && blue > green + 20) count += 1;
  }
  return count;
}

for (const [label, width, height] of [['landscape', 960, 540], ['portrait', 540, 960]]) {
  test(`hybrid generated footage and native Remotion bookends: ${label}`, { timeout: 300_000 }, () => {
    const work = mkdtempSync(join(tmpdir(), `comfyrizz-hybrid-${label}-`));
    try {
      const packagePath = join(work, 'package.json');
      writeFileSync(packagePath, JSON.stringify(fixture(work, width, height), null, 2));
      const output = join(work, 'hybrid.mp4');
      const rendered = renderPackage(packagePath, output);
      const pkg = rendered.package;
      const timeline = rendered.timeline;

      assert.equal(timeline.durationInFrames, 135);
      assert.deepEqual(pkg.scenes.map(scene => [scene.layout, scene.variant ?? null, scene.media_only ?? null]), [
        ['title', 'centered', false], ['list', null, true], ['title', 'outro', false],
      ]);
      assert.ok(pkg.scenes.every(scene => scene.background.asset === 'a_footage'));
      assert.ok(accentInk(output, 22) > 1000, 'the opener contains native accent title ink');
      assert.equal(accentInk(output, 67), 0, 'the footage-only middle shot has no title overlay');
      assert.ok(accentInk(output, 134) > 1000, 'the outro contains native accent title ink');

      const penultimate = rawFrame(output, 133);
      const final = rawFrame(output, 134);
      assert.ok(penultimate.equals(final), 'the outro is fully settled on the final visible frame');
      const qa = checkVideo({ mp4: output, timeline, pkg });
      assert.deepEqual(qa.findings, [], JSON.stringify(qa.findings, null, 2));
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });
}
