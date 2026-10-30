import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { renderPackage } from '../scripts/render-package-lib.mjs';
import { adoptSuppliedFont, saveSuppliedFont } from '../../server/src/supplied-font.mjs';

const enabled = Boolean(process.env.COMFYRIZZ_NATIVE_TEXT_FONT);
const work = process.env.COMFYRIZZ_NATIVE_TEXT_PROOF ?? '/tmp/opencode/native-text-fidelity';
function pixels(path) {
  const result = spawnSync('ffmpeg', ['-v', 'error', '-i', path, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-threads', '1', '-'], { maxBuffer: 16 * 1024 * 1024 });
  assert.equal(result.status, 0, String(result.stderr));
  assert.equal(result.stdout.length, 1920 * 1080 * 3);
  return result.stdout;
}
function measure(bytes) {
  const rows = new Set();
  let minX = 1920, maxX = -1, dark = 0;
  for (let offset = 0; offset < bytes.length; offset += 3) {
    if (bytes[offset] >= 70 || bytes[offset + 1] >= 70 || bytes[offset + 2] >= 70) continue;
    dark++;
    const pixel = offset / 3;
    rows.add(Math.floor(pixel / 1920));
    minX = Math.min(minX, pixel % 1920); maxX = Math.max(maxX, pixel % 1920);
  }
  const bands = [];
  for (const row of rows) {
    if (!bands.length || row > bands.at(-1)[1] + 1) bands.push([row, row]);
    else bands.at(-1)[1] = row;
  }
  return { corner: [...bytes.subarray(0, 3)], dark, bands, minX, maxX, width: maxX - minX + 1, widthFraction: (maxX - minX + 1) / 1920 };
}

test('CPU proof: tool-authored title reaches about 60% width with admitted Anton; omitted sizing retains default pixels', { skip: !enabled, timeout: 600_000 }, async () => {
  mkdirSync(work, { recursive: true });
  const { createToolset } = await import(pathToFileURL(resolve(process.env.COMFYRIZZ_TEST_AGENT_MODULE ?? 'packages/agent/dist/src/tools.js')).href);
  const bytes = readFileSync(process.env.COMFYRIZZ_NATIVE_TEXT_FONT);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  assert.equal(sha256, 'a4ba3a92350ebb031da0cb47630ac49eb265082ca1bc0450442f4a83ab947cab');
  const chatId = 'chat_nativetextproof';
  saveSuppliedFont({ runtimeDir: work, chatId, filename: 'Anton-Regular.ttf', bytes, rightsAsserted: true });
  const initialPackage = adoptSuppliedFont({ runtimeDir: work, conversationId: chatId, package: {}, assetsDir: join(work, 'assets') });
  const font = initialPackage.theme.fonts[0];
  const report = { font, sha256, cases: {} };
  for (const [name, size, entry] of [['default', undefined, 'none'], ['sized', 440, 'none'], ['sized-maskRise', 440, 'maskRise']]) {
    const tools = createToolset({ initialPackage, now: () => '2026-10-29T00:00:00.000Z' });
    const tool = tools['storyboard.propose'];
    const args = {
      brief: 'A silent native title at 1920x1080, 30 fps', title: 'Native title fidelity proof',
      theme: { palette: ['#f4efe6', '#111111', '#1f4fd8', '#111111'], text: '#111111', text_muted: '#333333', font: font.family },
      scenes: [{ id: 's1', layout: 'title', preferredFrames: 150, ...(size ? { headline_size: size } : {}), copy: { headline: 'PLEASE\nHOLD' }, motion: { entry } }],
    };
    const result = await tool.run(tool.schema.parse(args));
    assert.deepEqual(result.package.theme.fonts[0], font);
    assert.equal(result.package.scenes[0].headline_size, size);
    writeFileSync(join(work, `${name}.tool-call.json`), JSON.stringify(args, null, 2));
    writeFileSync(join(work, `${name}.model-result.json`), JSON.stringify(tool.modelResult(result), null, 2));
    const packagePath = join(work, `${name}.package.json`);
    writeFileSync(packagePath, JSON.stringify(result.package, null, 2));
    const output = join(work, `${name}.png`);
    renderPackage(packagePath, output, { still: true, frame: entry === 'none' ? 0 : 120, normalizeLoudness: false });
    const rendered = pixels(output);
    const stats = measure(rendered);
    report.cases[name] = stats;
    assert.deepEqual(stats.corner, [244, 239, 230]);
    assert.equal(stats.bands.length, 2, JSON.stringify(stats));
    assert.ok(stats.bands[0][0] > 0 && stats.bands[1][1] < 1079, 'both lines stay inside the frame');
    if (size) assert.ok(Math.abs(stats.widthFraction - 0.6) < 0.025, JSON.stringify(stats));
    else {
      assert.ok(Math.abs(stats.widthFraction - 0.1365) < 0.002, JSON.stringify(stats));
      const prior = process.env.COMFYRIZZ_NATIVE_TEXT_DEFAULT_BASELINE;
      if (prior && existsSync(prior)) {
        report.defaultPixelIdenticalToPrior = rendered.equals(pixels(prior));
        assert.equal(report.defaultPixelIdenticalToPrior, true);
      }
    }
    writeFileSync(join(work, 'proof.json'), JSON.stringify(report, null, 2));
    writeFileSync(join(work, 'tool-schemas.json'), JSON.stringify(Object.fromEntries(['storyboard.propose', 'storyboard.edit', 'storyboard.add_scene'].map(name => [name, tools[name].definition])), null, 2));
  }
});
