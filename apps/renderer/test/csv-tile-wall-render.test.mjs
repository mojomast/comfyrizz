import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createToolset } from '../../../packages/agent/dist/src/index.js';
import { renderPackage } from '../scripts/render-package-lib.mjs';

const width = 1280, height = 720;
const fixture = 'start,date,race,classification,retirement_reason\n' + Array.from({ length: 190 }, (_, i) => `${i + 1},2011-01-01,Race ${i + 1},${i < 9 ? '1' : i < 27 ? 'DNF' : '17'},`).join('\n');
const args = { scene_id: 's1', id: 'ctx_0123456789abcdef', filters: [], category_column: 'classification', colors: [{ value: '1', color: '#00ff00' }, { value: '2', color: '#00ff00' }, { value: '3', color: '#00ff00' }, { value: 'DNF', color: '#ff0000' }], default_color: '#ffffff', background: '#000000', columns: 19, reveal_frames: 30 };

async function makePackage(text, overrides = {}) {
  const attachment = { id: args.id, label: 'events.csv', text, contentHash: createHash('sha256').update(text).digest('hex') };
  const tools = createToolset({ csvAttachments: [attachment] });
  await tools['storyboard.propose'].run({ brief: 'Data story 1280x720 at 30 fps.', scenes: [{ id: 's1', layout: 'hero', preferredFrames: 90 }] });
  return tools['storyboard.csv_tile_wall'].run(tools['storyboard.csv_tile_wall'].schema.parse({ ...args, ...overrides })).package;
}

function pixels(file) {
  const result = spawnSync('ffmpeg', ['-v', 'error', '-i', file, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: width * height * 4 });
  assert.equal(result.status, 0, String(result.stderr));
  assert.equal(result.stdout.length, width * height * 3);
  return result.stdout;
}

// Count real connected, bright pixel islands rather than drawing elements.
function components(bytes) {
  const seen = new Uint8Array(width * height), result = [];
  const bright = i => bytes[i * 3] > 128 || bytes[i * 3 + 1] > 128 || bytes[i * 3 + 2] > 128;
  for (let i = 0; i < seen.length; i++) {
    if (seen[i] || !bright(i)) continue;
    const queue = [i]; seen[i] = 1;
    let minX = width, minY = height, maxX = 0, maxY = 0;
    for (let q = 0; q < queue.length; q++) {
      const p = queue[q], x = p % width, y = Math.floor(p / width);
      minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y);
      for (const n of [x > 0 ? p - 1 : -1, x + 1 < width ? p + 1 : -1, y > 0 ? p - width : -1, y + 1 < height ? p + width : -1]) {
        if (n >= 0 && !seen[n] && bright(n)) { seen[n] = 1; queue.push(n); }
      }
    }
    result.push({ minX, maxX, minY, maxY });
  }
  return result;
}

test('CPU Remotion pixels contain 190 separate square source-backed tiles and reflect a source change', { timeout: 180000 }, async t => {
  const dir = mkdtempSync(join(existsSync('/tmp/opencode') ? '/tmp/opencode' : tmpdir(), 'csv-wall-render-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  // DATA_STORY_CSV permits running exactly the captured source through the same pipeline.
  const source = process.env.DATA_STORY_CSV ? readFileSync(process.env.DATA_STORY_CSV, 'utf8') : fixture;
  const pkg = await makePackage(source);
  assert.equal(pkg.scenes[0].drawing.elements.length, 190);
  const path = join(dir, 'package.json');
  writeFileSync(path, JSON.stringify(pkg));
  const early = join(dir, 'early.png'), a = join(dir, 'a.png'), later = join(dir, 'later.png');
  renderPackage(path, early, { still: true, frame: 0 });
  renderPackage(path, a, { still: true, frame: 30 });
  renderPackage(path, later, { still: true, frame: 60 });
  const initial = pixels(early), first = pixels(a), second = pixels(later);
  assert.ok(components(initial).length > 0 && components(initial).length < 190, 'the first frame should show a partial wall');
  assert.notDeepEqual(initial, first, 'the wall must visibly build across frames');
  assert.deepEqual(second, first, 'the completed wall should hold');
  const boxes = components(first);
  assert.equal(boxes.length, 190, 'each source row must be a separate pixel island');
  for (const box of boxes) {
    const w = box.maxX - box.minX + 1, h = box.maxY - box.minY + 1;
    assert.ok(w >= 12 && h >= 12, `tile too small: ${w}x${h}`);
    assert.ok(Math.abs(w - h) <= 1, `tile not square: ${w}x${h}`);
  }
  for (const tile of pkg.scenes[0].drawing.elements) {
    const x = Math.floor((tile.x + tile.width / 2) * width / 1000);
    const y = Math.floor((tile.y + tile.height / 2) * height / 1000);
    const index = (y * width + x) * 3;
    const expected = [1, 3, 5].map(offset => parseInt(tile.color.slice(offset, offset + 2), 16));
    assert.deepEqual([...first.subarray(index, index + 3)], expected, `incorrect rendered category at ${x},${y}`);
  }
  const lines = source.trimEnd().split(/\r?\n/);
  const cells = lines[1].split(',');
  assert.equal(cells.length, 5, 'fixture first row must have simple CSV cells');
  cells[3] = cells[3] === 'DNF' ? '1' : 'DNF';
  lines[1] = cells.join(',');
  const changed = await makePackage(lines.join('\n'));
  writeFileSync(path, JSON.stringify(changed));
  const changedFile = join(dir, 'changed.png');
  renderPackage(path, changedFile, { still: true, frame: 30 });
  const altered = pixels(changedFile);
  const firstTile = pkg.scenes[0].drawing.elements[0];
  const minX = Math.floor(firstTile.x * width / 1000) - 1, maxX = Math.ceil((firstTile.x + firstTile.width) * width / 1000) + 1;
  const minY = Math.floor(firstTile.y * height / 1000) - 1, maxY = Math.ceil((firstTile.y + firstTile.height) * height / 1000) + 1;
  let differences = 0;
  for (let i = 0; i < first.length; i += 3) {
    if (first[i] === altered[i] && first[i + 1] === altered[i + 1] && first[i + 2] === altered[i + 2]) continue;
    differences++;
    const x = (i / 3) % width, y = Math.floor(i / 3 / width);
    assert.ok(x >= minX && x <= maxX && y >= minY && y <= maxY, `unexpected change at ${x},${y}`);
  }
  assert.ok(differences >= 100, `only ${differences} pixels changed`);
});

test('a final scene renders its own source-bound wall, including the last winning tile', { timeout: 180000 }, async t => {
  const dir = mkdtempSync(join(existsSync('/tmp/opencode') ? '/tmp/opencode' : tmpdir(), 'csv-wall-ending-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const source = readFileSync(new URL('../../server/test/fixtures/data-story-190.csv', import.meta.url), 'utf8');
  const attachment = { id: args.id, label: 'events.csv', text: source, contentHash: createHash('sha256').update(source).digest('hex') };
  const tools = createToolset({ csvAttachments: [attachment] });
  tools['storyboard.propose'].run({ brief: 'Data story 1280x720 at 30 fps.', scenes: [{ id: 's1', layout: 'hero', preferredFrames: 90 }, { id: 's2', layout: 'hero', preferredFrames: 90 }] });
  const wallArgs = { ...args, colors: [{ value: '1', color: '#ff00aa' }], default_color: '#ffffff', reveal_frames: 30 };
  tools['storyboard.csv_tile_wall'].run(wallArgs);
  const pkg = tools['storyboard.csv_tile_wall'].run({ ...wallArgs, scene_id: 's2' }).package;
  const path = join(dir, 'package.json'), image = join(dir, 'ending.png');
  writeFileSync(path, JSON.stringify(pkg));
  renderPackage(path, image, { still: true, frame: 150 });
  const frame = pixels(image);
  assert.equal(components(frame).length, 190);
  const tiles = pkg.scenes[1].drawing.elements.filter(e => e.type === 'rect');
  assert.equal(tiles.length, 190);
  assert.equal(tiles[189].color, '#ff00aa');
  const tile = tiles[189];
  const x = Math.floor((tile.x + tile.width / 2) * width / 1000), y = Math.floor((tile.y + tile.height / 2) * height / 1000);
  assert.deepEqual([...frame.subarray((y * width + x) * 3, (y * width + x) * 3 + 3)], [255, 0, 170]);
});

test('CPU title is visible on a dark wall even when default tiles are dark', { timeout: 180000 }, async t => {
  const dir = mkdtempSync(join(existsSync('/tmp/opencode') ? '/tmp/opencode' : tmpdir(), 'csv-wall-title-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const pkg = await makePackage(fixture, { title: 'A long source-backed sequence of events', default_color: '#1d2230', background: '#000000' });
  assert.equal(pkg.scenes[0].drawing.elements[0].color, '#ffffff');
  const path = join(dir, 'package.json'), image = join(dir, 'title.png');
  writeFileSync(path, JSON.stringify(pkg));
  renderPackage(path, image, { still: true, frame: 30 });
  const bytes = pixels(image);
  let bright = 0;
  for (let y = 20; y < 90; y++) for (let x = 30; x < width - 30; x++) {
    const i = (y * width + x) * 3;
    if (bytes[i] > 200 && bytes[i + 1] > 200 && bytes[i + 2] > 200) bright++;
  }
  assert.ok(bright > 100, `title has only ${bright} bright pixels`);
});

test('CPU frames render source-derived per-tile labels and update when the source changes', { timeout: 180000 }, async t => {
  const dir = mkdtempSync(join(existsSync('/tmp/opencode') ? '/tmp/opencode' : tmpdir(), 'csv-wall-labels-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const pkg = await makePackage(fixture, { label_column: 'start' });
  const labels = pkg.scenes[0].drawing.elements.filter(e => e.type === 'text');
  assert.equal(labels.length, 190);
  assert.equal(labels[0].text, '1');
  const path = join(dir, 'package.json'), a = join(dir, 'a.png'), b = join(dir, 'b.png');
  writeFileSync(path, JSON.stringify(pkg));
  renderPackage(path, a, { still: true, frame: 60 });
  const changed = await makePackage(fixture.replace('1,2011-01-01', '8,2011-01-01'), { label_column: 'start' });
  writeFileSync(path, JSON.stringify(changed));
  renderPackage(path, b, { still: true, frame: 60 });
  const first = pixels(a), second = pixels(b);
  let differences = 0;
  for (let i = 0; i < first.length; i += 3) if (first[i] !== second[i] || first[i + 1] !== second[i + 1] || first[i + 2] !== second[i + 2]) differences++;
  assert.ok(differences > 5, `source label change affected only ${differences} pixels`);
});

test('CPU stat fallback visibly renders the first value category', { timeout: 180000 }, async t => {
  const dir = mkdtempSync(join(existsSync('/tmp/opencode') ? '/tmp/opencode' : tmpdir(), 'csv-stat-label-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const pkg = await makePackage(fixture);
  pkg.datasets = { d: { unit: 'events', source: 'user', values: [{ label: 'Alpha', value: 7 }, { label: 'Beta', value: 3 }] } };
  const { drawing, ...scene } = pkg.scenes[0];
  pkg.scenes[0] = { ...scene, layout: 'stat', copy: { headline: 'Results' }, data: { dataset: 'd', display: 'number' } };
  const path = join(dir, 'package.json'), a = join(dir, 'a.png'), b = join(dir, 'b.png');
  writeFileSync(path, JSON.stringify(pkg));
  renderPackage(path, a, { still: true, frame: 60 });
  pkg.datasets.d.values[0].label = 'Omega';
  writeFileSync(path, JSON.stringify(pkg));
  renderPackage(path, b, { still: true, frame: 60 });
  const first = pixels(a), second = pixels(b);
  let changed = 0;
  for (let i = 0; i < first.length; i += 3) if (first[i] !== second[i] || first[i + 1] !== second[i + 1] || first[i + 2] !== second[i + 2]) changed++;
  assert.ok(changed > 100, `changing the category changed only ${changed} pixels`);
});
