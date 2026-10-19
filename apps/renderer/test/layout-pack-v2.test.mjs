// LP2 stills: split, compare, inset and code, in 16:9, 9:16 and 1:1.
// One Remotion render per aspect (scale 0.5), then frame extracts. A second
// still of the same code frame must match the first, pixel for pixel.
// The code clip is checked with frame QA. No GPU and no Google Colab.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { presenterBox } from '../src/presenter-model.js';
import { renderPackage } from '../scripts/render-package-lib.mjs';
import { checkVideo } from '../scripts/frame-qa.mjs';

const CODE = "export function hello() {\n  return 'ok';\n}\n";
const ASPECTS = {
  '16:9': { width: 1920, height: 1080 },
  '9:16': { width: 1080, height: 1920 },
  '1:1': { width: 1080, height: 1080 },
};

function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

function run(cmd, args, opts = {}) {
  const result = spawnSync(cmd, args, { encoding: opts.buffer ? 'buffer' : 'utf8', maxBuffer: opts.maxBuffer ?? 64 * 1024 * 1024 });
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || '').toString().slice(-800);
    throw new Error(`${cmd} ${args.join(' ')} failed: ${detail}`);
  }
  return result;
}

function writePlate(dir) {
  const assets = join(dir, 'assets');
  mkdirSync(assets, { recursive: true });
  const file = join(assets, 'a_pip.png');
  run('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=0xff5a3c:s=512x512', '-frames:v', '1', file]);
  return { file: 'assets/a_pip.png', sha256: sha256(file), bytes: statSync(file).size };
}

function sceneBase(id, layout, extra) {
  return {
    id,
    layout,
    preferredFrames: 48,
    transitionOut: { type: 'none', frames: 0 },
    ...extra,
  };
}

function packageFor(aspect, plate) {
  const format = ASPECTS[aspect];
  const scenes = [
    sceneBase('s_split', 'split', {
      copy: { headline: 'Side by side' },
      media: [
        { label: 'Left', procedural: { pattern: 'gradient', palette: ['#1b2440', '#6d8cff'] } },
        { label: 'Right', procedural: { pattern: 'dots', palette: ['#243056', '#e6e8ee'] } },
      ],
    }),
    sceneBase('s_compare', 'compare', {
      copy: { headline: 'Before and after' },
      media: [
        { label: 'Before', procedural: { pattern: 'grid', seed: 2 } },
        { label: 'After', procedural: { pattern: 'mesh', seed: 3, palette: ['#1b2440', '#6d8cff'] } },
      ],
    }),
    sceneBase('s_inset', 'hero', {
      variant: 'full-bleed',
      copy: { headline: 'A framed inset' },
      background: { procedural: { pattern: 'gradient', palette: ['#1b2440', '#6d8cff'] } },
      foreground: [{ asset: 'a_pip', frame: 'pip', placement: 'pip-br', mask: 'rounded-rect', size: 0.24 }],
    }),
    sceneBase('s_code', 'code', {
      preferredFrames: 54,
      code: { language: 'typescript', code: CODE, highlights: [1], typing: { charsPerSecond: 28.57 } },
      background: { procedural: { pattern: 'gradient', palette: ['#243056', '#6d8cff'] } },
    }),
  ];
  return {
    $schema: 'https://comfyrizz.example/schema/package-v1.json',
    schemaVersion: 1,
    revision: 1,
    id: 'pkg_lp2stills01',
    title: `Layout pack v2 ${aspect}`,
    createdAt: '2026-10-18T12:00:00-04:00',
    format: { ...format, fps: 30 },
    duration: { mode: 'flexible', flexibleCeilingFrames: 2700 },
    theme: { palette: ['#1b2440', '#6d8cff', '#e6e8ee'], font: 'Inter' },
    voice: { enabled: false, engine: 'none' },
    scenes,
    assets: {
      a_pip: {
        kind: 'image',
        origin: 'generated',
        status: 'ready',
        file: plate.file,
        sha256: plate.sha256,
        bytes: plate.bytes,
        license: { id: 'CC0-1.0' },
        redistributable: true,
        model_license: { id: 'LicenseRef-FLUX.3-Image-Klein' },
        gen: {
          generator: 'flux3-klein',
          caption: 'A flat coral square on a plain background, no text and no people.',
          inputs: { width: 512, height: 512, seed: 7, steps: 4 },
        },
      },
    },
    compliance: { open_weights_only: true },
  };
}

function codePackage() {
  return {
    $schema: 'https://comfyrizz.example/schema/package-v1.json',
    schemaVersion: 1,
    revision: 1,
    id: 'pkg_lp2code01',
    title: 'Code still',
    createdAt: '2026-10-18T12:00:00-04:00',
    format: { width: 1920, height: 1080, fps: 30 },
    duration: { mode: 'flexible', flexibleCeilingFrames: 2700 },
    theme: { palette: ['#243056', '#6d8cff', '#e6e8ee'], font: 'Inter' },
    voice: { enabled: false, engine: 'none' },
    scenes: [
      sceneBase('s_code', 'code', {
        preferredFrames: 90,
        code: { language: 'typescript', code: CODE, highlights: [1], typing: { charsPerSecond: 28.57 } },
        background: { procedural: { pattern: 'gradient', palette: ['#243056', '#6d8cff'] } },
      }),
    ],
    assets: {},
    compliance: { open_weights_only: true },
  };
}

function rawFrame(png) {
  const result = run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', png, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { buffer: true });
  return result.stdout;
}

function meanRegion(rgb, width, height, box) {
  const x0 = Math.max(0, Math.floor(box.x0 * width));
  const y0 = Math.max(0, Math.floor(box.y0 * height));
  const x1 = Math.min(width, Math.ceil(box.x1 * width));
  const y1 = Math.min(height, Math.ceil(box.y1 * height));
  let r = 0;
  let g = 0;
  let b = 0;
  let n = 0;
  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      const i = (y * width + x) * 3;
      r += rgb[i];
      g += rgb[i + 1];
      b += rgb[i + 2];
      n += 1;
    }
  }
  return { r: r / n, g: g / n, b: b / n, n };
}

function luma(mean) {
  return 0.299 * mean.r + 0.587 * mean.g + 0.114 * mean.b;
}

function extractFrame(mp4, frame, out) {
  run('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', '-i', mp4, '-vf', `select=eq(n\\,${frame})`, '-vsync', 'vfr', '-frames:v', '1', out]);
  assert.ok(existsSync(out) && statSync(out).size > 1000, `${out} was not written`);
}

function pngSize(png) {
  const probe = run('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'json', png]);
  const stream = JSON.parse(probe.stdout).streams[0];
  return { width: stream.width, height: stream.height };
}

test('split, compare and inset render in 16:9, 9:16 and 1:1, and the code scene types without a black first frame', () => {
  const dir = mkdtempSync(join(tmpdir(), 'comfyrizz-lp2-'));
  try {
    const plate = writePlate(dir);
    let landscape = null;
    for (const aspect of Object.keys(ASPECTS)) {
      const pkg = packageFor(aspect, plate);
      const packagePath = join(dir, `package-${aspect.replace(':', '')}.json`);
      const mp4 = join(dir, `${aspect.replace(':', '')}.mp4`);
      writeFileSync(packagePath, JSON.stringify(pkg));
      const rendered = renderPackage(packagePath, mp4, { scale: 0.5 });
      assert.equal(rendered.frames, rendered.timeline.durationInFrames);
      assert.ok(rendered.frames > 48 * 3, `expected four scenes, got ${rendered.frames} frames`);
      const byId = Object.fromEntries(rendered.timeline.scenes.map(scene => [scene.id, scene]));
      for (const id of ['s_split', 's_compare', 's_inset', 's_code']) {
        assert.ok(byId[id], `timeline missing ${id}`);
      }
      const format = ASPECTS[aspect];
      const stacked = format.height > format.width * 1.2;

      for (const id of ['s_split', 's_compare']) {
        const png = join(dir, `${aspect.replace(':', '')}-${id}.png`);
        extractFrame(mp4, byId[id].from + 8, png);
        const size = pngSize(png);
        const rgb = rawFrame(png);
        const half = stacked
          ? [meanRegion(rgb, size.width, size.height, { x0: 0.1, y0: 0.05, x1: 0.9, y1: 0.4 }), meanRegion(rgb, size.width, size.height, { x0: 0.1, y0: 0.6, x1: 0.9, y1: 0.95 })]
          : [meanRegion(rgb, size.width, size.height, { x0: 0.05, y0: 0.2, x1: 0.45, y1: 0.8 }), meanRegion(rgb, size.width, size.height, { x0: 0.55, y0: 0.2, x1: 0.95, y1: 0.8 })];
        assert.ok(Math.abs(luma(half[0]) - luma(half[1])) > 4, `${aspect} ${id} plates look the same`);
        assert.ok(luma(half[0]) > 12 && luma(half[1]) > 12, `${aspect} ${id} plate is empty`);
      }

      const insetPng = join(dir, `${aspect.replace(':', '')}-inset.png`);
      extractFrame(mp4, byId.s_inset.from + 24, insetPng);
      const insetSize = pngSize(insetPng);
      const insetRgb = rawFrame(insetPng);
      const pip = presenterBox({ placement: 'pip-br', shape: 'rounded-rect', size: 0.24, width: format.width, height: format.height });
      const pipMean = meanRegion(insetRgb, insetSize.width, insetSize.height, {
        x0: (pip.left + pip.width * 0.3) / format.width,
        y0: (pip.top + pip.height * 0.3) / format.height,
        x1: (pip.left + pip.width * 0.7) / format.width,
        y1: (pip.top + pip.height * 0.7) / format.height,
      });
      const backdrop = meanRegion(insetRgb, insetSize.width, insetSize.height, { x0: 0.05, y0: 0.05, x1: 0.3, y1: 0.25 });
      assert.ok(pipMean.r > 160 && pipMean.r > pipMean.b + 40, `${aspect} inset is not the coral plate (r ${pipMean.r.toFixed(0)})`);
      assert.ok(pipMean.r > backdrop.r + 40, `${aspect} inset does not sit above the background`);

      const early = join(dir, `${aspect.replace(':', '')}-code-early.png`);
      const late = join(dir, `${aspect.replace(':', '')}-code-late.png`);
      extractFrame(mp4, byId.s_code.from + 2, early);
      extractFrame(mp4, byId.s_code.from + 40, late);
      const earlyHash = createHash('sha256').update(rawFrame(early)).digest('hex');
      const lateHash = createHash('sha256').update(rawFrame(late)).digest('hex');
      assert.notEqual(earlyHash, lateHash, `${aspect} code scene did not change while typing`);
      const lateMean = meanRegion(rawFrame(late), pngSize(late).width, pngSize(late).height, { x0: 0, y0: 0, x1: 1, y1: 1 });
      assert.ok(luma(lateMean) > 16, `${aspect} code frame is black`);

      if (aspect === '16:9') landscape = { mp4, timeline: rendered.timeline, pkg };
    }

    const report = checkVideo({ mp4: landscape.mp4, timeline: landscape.timeline, pkg: landscape.pkg });
    const errors = report.findings.filter(item => item.severity === 'error');
    assert.deepEqual(errors, [], `frame QA errors: ${JSON.stringify(errors)}`);
    assert.equal(report.ok, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the same code frame renders to the same pixels twice', () => {
  const dir = mkdtempSync(join(tmpdir(), 'comfyrizz-lp2-code-'));
  try {
    const packagePath = join(dir, 'package.json');
    writeFileSync(packagePath, JSON.stringify(codePackage()));
    const first = join(dir, 'a.png');
    const second = join(dir, 'b.png');
    renderPackage(packagePath, first, { still: true, frame: 30, scale: 0.5 });
    renderPackage(packagePath, second, { still: true, frame: 30, scale: 0.5 });
    const a = rawFrame(first);
    const b = rawFrame(second);
    assert.equal(a.length, b.length);
    assert.equal(createHash('sha256').update(a).digest('hex'), createHash('sha256').update(b).digest('hex'));
    const size = pngSize(first);
    const mean = meanRegion(a, size.width, size.height, { x0: 0, y0: 0, x1: 1, y1: 1 });
    assert.ok(luma(mean) > 16, 'code still is black');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
