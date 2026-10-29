import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { renderPackage } from '../scripts/render-package-lib.mjs';
import { adoptSuppliedFont, saveSuppliedFont } from '../../server/src/supplied-font.mjs';
import { brandFontFamily } from '../src/theme-model.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
// An isolated build can verify source while another session runs frozen builds.
const agentModule = process.env.COMFYRIZZ_TEST_AGENT_MODULE ?? join(root, 'packages/agent/dist/src/tools.js');
const { createToolset } = await import(pathToFileURL(agentModule).href);

function pixels(path) {
  const result = spawnSync('ffmpeg', ['-v', 'error', '-i', path, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-threads', '1', '-'], { maxBuffer: 16 * 1024 * 1024 });
  assert.equal(result.status, 0, String(result.stderr));
  assert.equal(result.stdout.length, 1920 * 1080 * 3);
  return result.stdout;
}

function inspect(bytes) {
  const rows = new Set();
  let dark = 0, blue = 0, minX = 1920, maxX = -1;
  for (let offset = 0; offset < bytes.length; offset += 3) {
    const [r, g, b] = bytes.subarray(offset, offset + 3);
    const isDark = r < 70 && g < 70 && b < 70;
    const isBlue = b > 140 && r < 90 && g < 130;
    if (!isDark && !isBlue) continue;
    dark += Number(isDark); blue += Number(isBlue);
    const pixel = offset / 3;
    rows.add(Math.floor(pixel / 1920));
    minX = Math.min(minX, pixel % 1920); maxX = Math.max(maxX, pixel % 1920);
  }
  const bands = [];
  for (const row of rows) {
    if (!bands.length || row > bands.at(-1)[1] + 1) bands.push([row, row]);
    else bands.at(-1)[1] = row;
  }
  return { corner: [...bytes.subarray(0, 3)], dark, blue, bands, minX, maxX, widthFraction: (maxX - minX + 1) / 1920 };
}

test('CPU frames honor authored theme, explicit newlines in native/kinetic entries, and admitted font identity', { timeout: 600_000 }, async t => {
  mkdirSync('/tmp/opencode', { recursive: true });
  const work = process.env.COMFYRIZZ_THEME_PROOF_DIR ?? mkdtempSync('/tmp/opencode/authored-theme-render-');
  mkdirSync(work, { recursive: true });
  if (!process.env.COMFYRIZZ_THEME_PROOF_DIR) t.after(() => rmSync(work, { recursive: true, force: true }));
  const fontPath = process.env.COMFYRIZZ_THEME_FONT_FILE ?? join(root, 'apps/renderer/public/fonts/Inter-Variable.ttf');
  const bytes = readFileSync(fontPath);
  const chatId = 'chat_themeproof123';
  saveSuppliedFont({ runtimeDir: work, chatId, filename: 'proof-font.ttf', bytes, rightsAsserted: true });
  const initialPackage = adoptSuppliedFont({ runtimeDir: work, conversationId: chatId, package: {}, assetsDir: join(work, 'assets') });
  const font = initialPackage.theme.fonts[0];
  assert.equal(createHash('sha256').update(readFileSync(join(work, font.file))).digest('hex'), createHash('sha256').update(bytes).digest('hex'));
  const report = { font, fontSha256: createHash('sha256').update(bytes).digest('hex'), cases: {} };
  for (const entry of ['none', 'maskRise', 'waterfall', 'kinetic']) {
    const tools = createToolset({ initialPackage, now: () => '2026-10-29T00:00:00.000Z' });
    const args = {
      brief: 'A silent native title at 1920x1080, 30 fps', title: 'Native title theme proof',
      theme: { palette: ['#f4efe6', '#111111', '#1f4fd8', '#111111'], text: '#111111', text_muted: '#333333', font: font.family },
      scenes: [{ id: 's1', layout: 'title', preferredFrames: 150, copy: { headline: 'PLEASE\nHOLD' }, motion: entry === 'kinetic' ? { recipe: 'kinetic', entry: 'maskRise' } : { entry } }],
    };
    const tool = tools['storyboard.propose'];
    const result = await tool.run(tool.schema.parse(args));
    assert.equal(result.package.theme.font, font.family);
    assert.equal(brandFontFamily(result.package), font.family);
    assert.deepEqual(result.package.theme.fonts[0], font);
    const packagePath = join(work, `${entry}.package.json`);
    writeFileSync(join(work, `${entry}.tool-call.json`), JSON.stringify(args, null, 2));
    writeFileSync(packagePath, JSON.stringify(result.package, null, 2));
    const output = join(work, `${entry}.png`);
    renderPackage(packagePath, output, { still: true, frame: entry === 'none' ? 0 : 120, normalizeLoudness: false });
    const stats = inspect(pixels(output));
    assert.deepEqual(stats.corner, [244, 239, 230], 'authored warm-white reaches actual pixels');
    assert.equal(stats.bands.length, 2, `${entry} keeps two explicit lines: ${JSON.stringify(stats)}`);
    assert.ok((entry === 'kinetic' ? stats.blue : stats.dark) > 500, `${entry} paints theme text/accent`);
    report.cases[entry] = stats;
  }
  // Independent tool-authored Inter control: a different image demonstrates that
  // the uploaded face affects rasterization, not just package metadata.
  const controlTools = createToolset();
  const args = JSON.parse(readFileSync(join(work, 'none.tool-call.json'), 'utf8'));
  args.theme.font = 'Inter';
  const control = await controlTools['storyboard.propose'].run(args);
  const controlPath = join(work, 'inter-control.package.json');
  writeFileSync(controlPath, JSON.stringify(control.package, null, 2));
  renderPackage(controlPath, join(work, 'inter-control.png'), { still: true, frame: 0, normalizeLoudness: false });
  const supplied = pixels(join(work, 'none.png'));
  const bundled = pixels(join(work, 'inter-control.png'));
  report.uploadedDiffersFromInter = !supplied.equals(bundled);
  if (process.env.COMFYRIZZ_THEME_FONT_FILE) assert.equal(report.uploadedDiffersFromInter, true);
  report.cases.inter = inspect(bundled);
  writeFileSync(join(work, 'proof.json'), JSON.stringify(report, null, 2));
});
