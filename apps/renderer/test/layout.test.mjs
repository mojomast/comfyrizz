/**
 * A6 layout check: a foreground asset must never intersect the box where a
 * layout draws text. Added after review found a foreground card covering body
 * copy and a caption in the data story (DOLAN 12:50).
 *
 * The model is intentionally conservative: TEXT_ZONES are the safe zones the
 * renderer's layouts can draw into, and foreground boxes are derived from the
 * item's x/y/w and the asset aspect ratio. A violation here means the export
 * would show text under a card, so the check gates every bundled example.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findLayoutOverlaps, foregroundBox, textZones } from '../src/layout-model.js';

const here = dirname(fileURLToPath(import.meta.url));
const rendererDir = join(here, '..');
const repoRoot = join(rendererDir, '..', '..');
const examplesDir = join(repoRoot, 'examples');

function loadPackage(packagePath) {
  return JSON.parse(readFileSync(packagePath, 'utf8'));
}

function examplePackages() {
  return readdirSync(examplesDir)
    .map(name => join(examplesDir, name, 'package.json'))
    .filter(path => {
      try {
        return statSync(path).isFile();
      } catch {
        return false;
      }
    });
}

test('the detector flags a foreground card that covers split-hero body copy', () => {
  // The exact shape of the bug: a 16:9 card at x 0.72 with w 0.46 reaches into
  // the left text column of a split hero.
  const pkg = {
    scenes: [
      {
        id: 's_hero',
        layout: 'hero',
        variant: 'split',
        foreground: [{ asset: 'a_card', x: 0.72, y: 0.5, w: 0.46 }],
      },
    ],
    assets: { a_card: { kind: 'svg', status: 'ready', gen: { render_check: { width: 512, height: 288 } } } },
  };
  const overlaps = findLayoutOverlaps(pkg);
  assert.equal(overlaps.length, 1);
  assert.equal(overlaps[0].scene, 's_hero');
  assert.equal(overlaps[0].asset, 'a_card');
});

test('hero text zones are narrower when the layout is split', () => {
  const split = textZones({ layout: 'hero', variant: 'split' });
  const full = textZones({ layout: 'hero', variant: 'full-bleed' });
  assert.ok(split[0].x1 < full[0].x1, 'split hero reserves the right side for the asset');
});

test('pending GPU foreground slots are not drawn and cannot overlap text', () => {
  const pkg = {
    scenes: [
      {
        id: 's_title',
        layout: 'title',
        foreground: [{ asset: 'a_pending_still', x: 0.5, y: 0.5, w: 0.8 }],
      },
    ],
    assets: { a_pending_still: { kind: 'image', status: 'pending' } },
  };
  assert.deepEqual(findLayoutOverlaps(pkg), []);
});

test('the aspect ratio drives the foreground box height', () => {
  const square = foregroundBox({ x: 0.5, y: 0.5, w: 0.1 }, { gen: { render_check: { width: 512, height: 512 } } });
  const wide = foregroundBox({ x: 0.5, y: 0.5, w: 0.1 }, { gen: { render_check: { width: 512, height: 288 } } });
  assert.ok(square.y1 - square.y0 > wide.y1 - wide.y0, 'a square asset is taller than a 16:9 asset at the same width');
});

test('every bundled example keeps text and foreground assets apart', () => {
  const packages = [...examplePackages(), join(rendererDir, 'test', 'fixtures', 'tiny', 'package.json')];
  assert.ok(packages.length >= 5, 'expected the bundled examples to be discoverable');
  for (const packagePath of packages) {
    const pkg = loadPackage(packagePath);
    const overlaps = findLayoutOverlaps(pkg);
    const describe = overlaps.map(item => `${item.scene}/${item.asset}`).join(', ');
    assert.deepEqual(overlaps, [], `${packagePath} has layout overlaps: ${describe}`);
  }
});
