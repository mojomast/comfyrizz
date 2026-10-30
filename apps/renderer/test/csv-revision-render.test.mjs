import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createToolset } from '../../../packages/agent/dist/src/index.js';
import { applyProposalRevision } from '../../server/src/proposal-revision.mjs';
import { renderPackage } from '../scripts/render-package-lib.mjs';

test('CPU render displays the source-bound revised winning tile color', { timeout: 180000 }, async t => {
  const text = readFileSync(new URL('../../server/test/fixtures/data-story-190.csv', import.meta.url), 'utf8');
  const attachment = { id: 'ctx_0123456789abcdef', label: 'campaign.csv', text, contentHash: createHash('sha256').update(text).digest('hex') };
  const tools = createToolset({ csvAttachments: [attachment] });
  const pkg = (await tools['storyboard.propose'].run({ brief: 'Data story 1280x720 at 30 fps.', scenes: [{ id: 's1', layout: 'hero', preferredFrames: 90 }] })).package;
  const revised = applyProposalRevision(pkg, { edits: [], csvWallCreates: [{ scene_id: 's1', id: attachment.id, filters: [], category_column: 'classification', colors: [{ value: '1', color: '#ff00aa' }], rules: [], require_categories: ['1'], default_color: '#222222', background: '#000000', columns: 19 }] }, 'Create the tile wall.', [attachment]);
  const dir = mkdtempSync('/tmp/opencode/csv-revision-render-');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'package.json'), image = join(dir, 'frame.png');
  writeFileSync(path, JSON.stringify(revised));
  renderPackage(path, image, { still: true, frame: 30 });
  const pixels = spawnSync('ffmpeg', ['-v', 'error', '-i', image, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: 1280 * 720 * 4 });
  assert.equal(pixels.status, 0, String(pixels.stderr));
  const tile = revised.scenes[0].drawing.elements[189];
  const x = Math.floor((tile.x + tile.width / 2) * 1280 / 1000), y = Math.floor((tile.y + tile.height / 2) * 720 / 1000);
  assert.deepEqual([...pixels.stdout.subarray((y * 1280 + x) * 3, (y * 1280 + x) * 3 + 3)], [255, 0, 170]);
});
