// X1: one package exports 6/15/30 s cutdowns within ±0.5 s, and the bundle zip
// carries thumb.jpg, preview.gif, card.png (1200×630) and chapters.txt.
// The scripted model + stub voice build the cut; the CPU renderer makes the
// MP4. No LLM, no Google Colab, no GPU.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createScriptedModel, createToolset, stubVoice } from '../../../packages/agent/dist/src/index.js';
import { runAgent } from '../../../packages/agent/dist/src/agent.js';
import { compileTimeline } from '../../../packages/planner/dist/src/index.js';
import { createExporter } from '../src/export.mjs';
import { buildVariants } from '../src/variant.mjs';
import { renderPackage } from '../../renderer/scripts/render-package-lib.mjs';
import { collectMockContribution } from './helpers/comfy-contribution.mjs';

const repo = new URL('../../..', import.meta.url).pathname;
const seed = JSON.parse(readFileSync(join(repo, 'examples', 'launch-demo', 'package.json'), 'utf8'));

function ffprobe(file, entries) {
  return JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_entries', entries, '-of', 'json', file]).toString());
}

function zipEntries(bytes, dir) {
  const file = join(dir, 'probe.zip');
  writeFileSync(file, bytes);
  return execFileSync('unzip', ['-Z1', file]).toString().split('\n').filter(Boolean);
}

function unzipEntry(bytes, name, dir) {
  const file = join(dir, 'probe-extract.zip');
  writeFileSync(file, bytes);
  return execFileSync('unzip', ['-p', file, name]);
}

function chapterSeconds(stamp) {
  const [clock, fraction = '0'] = stamp.split('.');
  const parts = clock.split(':').map(Number);
  const base = parts.length === 3 ? parts[0] * 3600 + parts[1] * 60 + parts[2] : parts[0] * 60 + parts[1];
  return base + Number(`0.${fraction}`);
}

test('X1: duration axis is listed beside language and aspect', () => {
  const variants = buildVariants(seed, { languages: ['en'], aspects: ['16:9'], durations: [6, 15, 30] });
  assert.deepEqual(variants.map(variant => variant.slug), ['en-16x9-6s', 'en-16x9-15s', 'en-16x9-30s']);
  assert.deepEqual(variants.map(variant => variant.durationSeconds), [6, 15, 30]);
  for (const variant of variants) {
    assert.equal(variant.isBase, false);
    assert.equal(variant.package.duration.mode, 'target');
    assert.notEqual(variant.package.id, seed.id);
    const timeline = compileTimeline(variant.package, variant.narration);
    const seconds = timeline.durationInFrames / timeline.fps;
    assert.ok(Math.abs(seconds - variant.durationSeconds) <= 0.5, `${variant.slug} compiled to ${seconds}s`);
    assert.ok(variant.voiced.every(line => line.engine === 'stub'));
    assert.equal(variant.presenter.ran, false);
  }
});

test('X1: scripted model cutdown, CPU render, social pack, and the rights filter', { timeout: 900_000 }, async () => {
  const heard = [];
  const voice = input => {
    heard.push(input.text);
    return stubVoice(input);
  };
  const scripted = await runAgent({
    model: createScriptedModel([{ name: 'variant.cutdown', args: { target_s: 15 } }]),
    brief: 'Export a 15 second cutdown of the launch demo.',
    tools: createToolset({ initialPackage: structuredClone(seed), voice }),
    maxSteps: 4,
  });
  assert.equal(scripted.ok, true);
  assert.equal(scripted.toolCalls[0].name, 'variant.cutdown');
  assert.equal(scripted.toolCalls[0].result.presenter.ran, false);
  assert.ok(heard.length >= 1);

  const dir = mkdtempSync(join(tmpdir(), 'comfyrizz-x1-'));
  const packageDir = join(dir, 'package');
  mkdirSync(packageDir, { recursive: true });
  cpSync(join(repo, 'examples', 'launch-demo', 'assets'), join(packageDir, 'assets'), { recursive: true });
  const exportsDir = join(dir, 'out', 'export');
  try {
    collectMockContribution(seed, packageDir);
    writeFileSync(join(packageDir, 'package.json'), `${JSON.stringify(seed, null, 2)}\n`);
    const variants = buildVariants(seed, { durations: [6, 15, 30], voice });
    const exporter = createExporter({
      exportsDir,
      render: (packagePath, outputPath, opts) => renderPackage(packagePath, outputPath, { ...opts, final: true }),
    });
    const result = await exporter.variants({ pkg: seed, packagePath: join(packageDir, 'package.json'), variants });

    assert.deepEqual(result.manifest.variants.map(entry => entry.durationSeconds), [6, 15, 30]);
    assert.ok(result.manifest.variants.every(entry => entry.social.includes('thumb.jpg')));
    assert.ok(result.manifest.variants.every(entry => entry.social.includes('chapters.txt')));

    for (const entry of result.manifest.variants) {
      const video = join(entry.dir, 'video.mp4');
      const probe = ffprobe(video, 'format=duration:stream=codec_name,nb_frames');
      const seconds = Number(probe.format.duration);
      assert.ok(Math.abs(seconds - entry.durationSeconds) <= 0.5, `${entry.slug} rendered ${seconds}s`);
      const frames = Number(probe.streams.find(stream => stream.codec_name === 'h264')?.nb_frames);
      assert.equal(frames, entry.frames);

      const zip = readFileSync(join(entry.dir, 'package.zip'));
      const names = zipEntries(zip, dir);
      for (const name of ['thumb.jpg', 'preview.gif', 'card.png', 'chapters.txt']) {
        assert.ok(names.includes(name), `${entry.slug} zip missing ${name}`);
      }
      const card = unzipEntry(zip, 'card.png', dir);
      const cardFile = join(dir, `${entry.slug}-card.png`);
      writeFileSync(cardFile, card);
      const cardProbe = ffprobe(cardFile, 'stream=width,height');
      const image = cardProbe.streams[0];
      assert.equal(image.width, 1200);
      assert.equal(image.height, 630);
      assert.equal(unzipEntry(zip, 'preview.gif', dir).subarray(0, 3).toString('ascii'), 'GIF');

      const chapters = unzipEntry(zip, 'chapters.txt', dir).toString('utf8').trim().split('\n');
      const timeline = compileTimeline(
        variants.find(variant => variant.slug === entry.slug).package,
        variants.find(variant => variant.slug === entry.slug).narration,
      );
      assert.equal(chapters.length, timeline.scenes.length);
      timeline.scenes.forEach((scene, index) => {
        const [stamp, ...title] = chapters[index].split(' ');
        assert.ok(Math.abs(chapterSeconds(stamp) - scene.from / timeline.fps) < 0.001, chapters[index]);
        assert.equal(title.join(' '), scene.copy.headline);
      });
    }

    // A scene that shows a non-redistributable asset must not ship the derived pixels.
    const blocked = {
      id: 'pkg_x1rights0001',
      title: 'Rights',
      schemaVersion: 1,
      revision: 1,
      format: { width: 1920, height: 1080, fps: 30 },
      duration: { mode: 'flexible' },
      voice: { enabled: false, engine: 'none' },
      scenes: [{
        id: 's1',
        layout: 'title',
        preferredFrames: 60,
        copy: { headline: 'Blocked frame' },
        foreground: [{ asset: 'a_nc_photo', x: 0.5, y: 0.5, w: 0.2 }],
      }],
      assets: {
        a_nc_photo: {
          kind: 'image',
          origin: 'stock',
          status: 'ready',
          file: 'assets/a_nc_photo.png',
          sha256: 'b'.repeat(64),
          redistributable: false,
          source: { provider: 'openverse', landing_url: 'https://example.test/photo', title: 'A photo', creator: 'Someone' },
          license: { id: 'CC-BY-NC-4.0', blocked: true, blocked_reason: 'non-commercial licence is outside the v0.1 policy' },
        },
      },
      compliance: { open_weights_only: true, backends_used: [], closed_apis_used: [], warnings: [] },
    };
    const rightsDir = join(dir, 'rights');
    mkdirSync(rightsDir, { recursive: true });
    const rightsExporter = createExporter({
      exportsDir: rightsDir,
      render: (_packagePath, outputPath) => {
        const made = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=0x2244aa:s=640x360:r=30', '-frames:v', '60', '-y', outputPath], { encoding: 'utf8' });
        if (made.status !== 0) throw new Error(made.stderr || 'ffmpeg color source failed');
        return { output: outputPath, frames: 60, hash: 'rights', bytes: 8 };
      },
    });
    const rightsPackagePath = join(dir, 'rights-package.json');
    collectMockContribution(blocked, dir);
    // The rights filter must handle real source bytes, not fail earlier because
    // an actively displayed fixture asset is missing.
    const photo = readFileSync(join(dir, blocked.assets.a_mock_comfy.file));
    writeFileSync(join(dir, blocked.assets.a_nc_photo.file), photo);
    blocked.assets.a_nc_photo.sha256 = createHash('sha256').update(photo).digest('hex');
    writeFileSync(rightsPackagePath, `${JSON.stringify(blocked, null, 2)}\n`);
    const rights = await rightsExporter({ pkg: blocked, packagePath: rightsPackagePath });
    const rightsZip = zipEntries(readFileSync(join(rights.dir, 'package.zip')), dir);
    assert.ok(rightsZip.includes('chapters.txt'));
    for (const name of ['thumb.jpg', 'preview.gif', 'card.png']) {
      assert.ok(!rightsZip.includes(name), `${name} must not ship`);
      assert.ok(rights.excluded.some(item => item.assetId === name), `${name} should be listed as refused`);
    }
    assert.equal(rights.social.map(file => file.name).includes('thumb.jpg'), false);
    assert.ok(rights.social.some(file => file.name === 'chapters.txt'));
    assert.ok(rights.excluded.some(item => item.assetId === 'a_nc_photo'));
    assert.ok(!rights.included.includes('a_nc_photo'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
