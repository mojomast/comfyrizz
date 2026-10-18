// MS3 step 3: kinetic type + SVG draw-on are pure functions of the frame.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  canDrawOn,
  drawOnSvg,
  highlightSweep,
  isAnchorWord,
  splitHighlight,
  waterfallEntry,
  waterfallPlan,
} from '../src/motion/kinetic.js';

const SAFE_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">\n'
  + '  <path d="M4 4h40" fill="none" stroke="#fff" stroke-width="4"/>\n'
  + '  <path data-draw-order="0" d="M8 40l10 10 20-24" fill="#6d8cff" stroke="#fff" stroke-width="4"/>\n'
  + '</svg>\n';

test('isAnchorWord marks the first, last, shouted and numeric words', () => {
  assert.equal(isAnchorWord('Growth', 0, 4), true);
  assert.equal(isAnchorWord('now', 3, 4), true);
  assert.equal(isAnchorWord('HUGE', 1, 4), true);
  assert.equal(isAnchorWord('37%', 1, 4), true);
  assert.equal(isAnchorWord('and', 1, 4), false);
});

test('waterfallPlan tags anchors and the highlighted phrase', () => {
  const plan = waterfallPlan('Ship faster with 3x results', 'faster');
  assert.deepEqual(plan.map(w => w.word), ['Ship', 'faster', 'with', '3x', 'results']);
  assert.deepEqual(plan.map(w => w.anchor), [true, false, false, true, true]);
  assert.deepEqual(plan.map(w => w.highlight), [false, true, false, false, false]);
});

test('waterfallPlan with no phrase (or a missing one) highlights nothing', () => {
  assert.deepEqual(waterfallPlan('one two', '').map(w => w.highlight), [false, false]);
  assert.deepEqual(waterfallPlan('one two', 'absent').map(w => w.highlight), [false, false]);
});

test('waterfallEntry anchors travel further and the cascade stays deterministic', () => {
  const anchor = waterfallEntry({ frame: 4, fps: 30, index: 1, anchor: true, delay: 2 });
  const plain = waterfallEntry({ frame: 4, fps: 30, index: 1, anchor: false, delay: 2 });
  assert.ok(anchor.translateY > plain.translateY, 'anchors travel further');
  assert.deepEqual(anchor, waterfallEntry({ frame: 4, fps: 30, index: 1, anchor: true, delay: 2 }));
  const atRest = waterfallEntry({ frame: 120, fps: 30, index: 5, anchor: true });
  assert.equal(atRest.translateY, 0);
  assert.equal(atRest.opacity, 1);
});

test('highlightSweep is one pass: sweeps to 1 then fades out', () => {
  const start = highlightSweep({ frame: 8, fps: 30, at: 8 });
  assert.equal(start.progress, 0);
  const mid = highlightSweep({ frame: 8 + 9, fps: 30, at: 8 });
  assert.ok(mid.progress > 0 && mid.progress < 1);
  const done = highlightSweep({ frame: 8 + 18, fps: 30, at: 8 });
  assert.equal(done.progress, 1);
  const gone = highlightSweep({ frame: 8 + 18 + 20, fps: 30, at: 8 });
  assert.equal(gone.opacity, 0, 'the band leaves after one pass');
});

test('splitHighlight finds a phrase or leaves the copy alone', () => {
  assert.deepEqual(splitHighlight('Ship faster now', 'faster'), { before: 'Ship ', match: 'faster', after: ' now', found: true });
  assert.deepEqual(splitHighlight('Ship faster now', 'absent'), { before: 'Ship faster now', match: '', after: '', found: false });
  assert.equal(splitHighlight('Ship', undefined).found, false);
});

test('canDrawOn accepts only stroked paths and rejects unsafe mark-up', () => {
  assert.equal(canDrawOn(SAFE_SVG), true);
  assert.equal(canDrawOn('<svg><rect width="4" height="4" stroke="#fff"/></svg>'), false, 'stroked rect');
  assert.equal(canDrawOn('<svg><circle r="4" stroke="#fff"/></svg>'), false, 'stroked circle');
  assert.equal(canDrawOn('<svg><path d="M0 0"/></svg>'), false, 'no stroke to draw');
  assert.equal(canDrawOn('<svg><script>x()</script><path d="M0 0" stroke="#fff"/></svg>'), false, 'script');
  assert.equal(canDrawOn('<svg><path d="M0 0" stroke="#fff"><animate/></path></svg>'), false, 'SMIL');
  assert.equal(canDrawOn(null), false);
});

test('drawOnSvg sets pathLength and animates stroke-dashoffset 1 -> 0 in draw order', () => {
  const first = drawOnSvg(SAFE_SVG, { frame: 0, fps: 30, delay: 4, duration: 30 });
  assert.match(first, /pathLength="1"/);
  assert.match(first, /stroke-dasharray="1"/);
  assert.match(first, /data-draw-rank="0"/);
  assert.match(first, /data-draw-rank="1"/);
  // frame 0: every stroke is still undrawn.
  assert.equal((first.match(/stroke-dashoffset="1"/g) ?? []).length, 2);
  // The path with data-draw-order="0" is rank 0, so it finishes first.
  const early = drawOnSvg(SAFE_SVG, { frame: 20, fps: 30, delay: 4, duration: 30 });
  const byRank = Object.fromEntries([...early.matchAll(/data-draw-rank="(\d+)"[^>]*stroke-dashoffset="([\d.]+)"/g)].map(m => [Number(m[1]), Number(m[2])]));
  assert.ok(byRank[0] < byRank[1], 'lower draw-order finishes before the document-order path');
  const late = drawOnSvg(SAFE_SVG, { frame: 400, fps: 30, delay: 4, duration: 30 });
  assert.equal((late.match(/stroke-dashoffset="0"/g) ?? []).length, 2, 'all strokes land');
  assert.equal((late.match(/fill-opacity="1"/g) ?? []).length, 1, 'the filled path fades in');
  assert.equal(drawOnSvg(SAFE_SVG, { frame: 0 }), drawOnSvg(SAFE_SVG, { frame: 0 }), 'deterministic');
});

test('drawOnSvg returns unsafe or non-path mark-up unchanged', () => {
  const unsafe = '<svg><rect stroke="#fff"/><path d="M0 0" stroke="#fff"/></svg>';
  assert.equal(drawOnSvg(unsafe, { frame: 10 }), unsafe);
});
