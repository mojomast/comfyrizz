// @ts-nocheck
// UR27: Review step shot strip, status and export gate.
//
// The render functions are pure, so these tests never need a DOM, a network or
// a server. The fixture uses asset ids in the package on purpose: none of them
// may leak into the Review HTML.

import test from 'node:test';
import assert from 'node:assert/strict';

import { COPY } from '../src/easy/copy.ts';
import { renderShotStrip } from '../src/easy/shot-strip.ts';
import {
  renderReview,
  reviewPrimary,
  reviewShotsFromPackage,
} from '../src/easy/steps/review.ts';
import { renderPrimary, PRIMARY_REASON_ID } from '../src/easy/shell.ts';

const shots = [
  { id: 'scene-1', sceneId: 'scene-1', title: 'Open', thumbnailUrl: '/api/thumbs/scene-1', state: 'kept' },
  { id: 'scene-2', sceneId: 'scene-2', title: 'Hands knead dough', thumbnailUrl: null, state: 'needsChoice' },
  { id: 'scene-3', sceneId: 'scene-3', title: 'Bake', thumbnailUrl: '/api/thumbs/scene-3', state: 'kept' },
  { id: 'scene-4', sceneId: 'scene-4', title: 'Share', thumbnailUrl: null, state: 'kept' },
];

const blockedGate = {
  ok: false,
  approved: 3,
  total: 4,
  blocking: [{ clipId: 'scene-2:a_svg_dough', sceneId: 'scene-2', state: 'review' }],
};

test('the strip is a listbox with four options and an active option', () => {
  const html = renderShotStrip(shots, 'scene-2');
  assert.match(html, /role="listbox"/);
  assert.match(html, /aria-label="Shots"/);
  assert.equal((html.match(/role="option"/g) || []).length, 4);
  assert.match(html, /aria-activedescendant="shot-scene-2"/);
  assert.match(html, /id="shot-scene-2"/);
  assert.match(html, /aria-selected="true"/);
  assert.equal((html.match(/aria-selected="false"/g) || []).length, 3);
});

test('the status for three of four kept names the first shot that needs a choice', () => {
  const html = renderReview({ shots, selectedId: 'scene-1', gate: blockedGate });
  assert.match(html, /3 of 4 shots kept · Shot 2 needs a choice/);
  assert.match(html, /data-easy-review-status/);
});

test('the primary is disabled with the blocked reason when the gate is not satisfied', () => {
  const primary = reviewPrimary(blockedGate);
  assert.equal(primary.label, COPY.review.export);
  assert.equal(primary.disabled, true);
  assert.equal(primary.reason, COPY.review.blocked);

  const html = renderPrimary(primary);
  assert.match(html, / disabled/);
  assert.match(html, new RegExp(`aria-describedby="${PRIMARY_REASON_ID}"`));

  const ready = reviewPrimary({ ok: true, approved: 4, total: 4, blocking: [] });
  assert.equal(ready.disabled, false);
  assert.equal(ready.reason, null);
  assert.doesNotMatch(renderPrimary(ready), / disabled/);
});

test('asset ids never appear in Review HTML', () => {
  const pkg = {
    id: 'pkg_review_fixture',
    title: 'Review fixture',
    revision: 3,
    scenes: [
      {
        id: 'scene-1',
        layout: 'hero',
        copy: { headline: 'Fresh every morning' },
        background: { asset: 'a_svg_hero_01' },
        preferredFrames: 90,
      },
      {
        id: 'scene-2',
        layout: 'hero',
        copy: { headline: 'Hands knead dough' },
        background: { asset: 'a_svg_dough_02' },
        transitionOut: { type: 'fade', frames: 15 },
      },
      {
        id: 'scene-3',
        layout: 'stat',
        copy: { headline: 'Baked at five' },
        foreground: [{ asset: 'a_svg_loaf_03' }],
        motion: { recipe: 'rise' },
      },
      {
        id: 'scene-4',
        layout: 'title',
        copy: { headline: 'Share the loaf' },
        narration: 'Come by before nine.',
      },
    ],
    assets: {
      a_svg_hero_01: { kind: 'svg', file: 'a_svg_hero_01.svg' },
      a_svg_dough_02: { kind: 'svg', file: 'a_svg_dough_02.svg' },
      a_svg_loaf_03: { kind: 'svg', file: 'a_svg_loaf_03.svg' },
    },
  };

  const fixtureShots = reviewShotsFromPackage(pkg, { ok: true, approved: 4, total: 4, blocking: [] });
  const html = renderReview({
    shots: fixtureShots,
    selectedId: fixtureShots[0].id,
    gate: { ok: true, approved: 4, total: 4, blocking: [] },
    package: pkg,
  });

  assert.equal(fixtureShots.length, 4);
  assert.doesNotMatch(html, /a_svg_/);
  assert.match(html, /Edited in the editor: timing, transitions, motion/);
  assert.match(html, /Open in editor/);
});
