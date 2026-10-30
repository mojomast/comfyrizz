// AI2: pure math, geometry and determinism for the six renderer recipes.
// No browser, no Remotion component, no wall clock.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MORPH_SHAPES,
  RECIPE_IDS,
  normalizeCuePhrases,
  normalizeCueSeconds,
  normalizeFocus,
  normalizeSeed,
  recipeWindow,
  resolveRecipe,
  seededRandom,
} from '../src/recipes/model.js';
import { ANIMATION_RECIPE_IDS, ANIMATION_REVEAL_TRANSITIONS } from '../../../packages/schema/src/animation.mjs';
import { cueDiagnostic, resetCueWarnings, sceneCuePlan } from '../src/recipes/cues.js';
import { centeredSquare, focusRect, listRowBoxes, visualArea, ellipsePoints, arrowPoints } from '../src/recipes/geometry.js';
import { paperPlan, paperSettle, polygonPoints, tornRect } from '../src/recipes/paper.js';
import { sketchAnnotations, sketchCacheSize, sketchPaths, strokeOutlinePath } from '../src/recipes/sketch.js';
import { MORPH_MAX_SEGMENT_LENGTH, morphAt, morphCacheSize, morphInterpolator, morphTimeline, pathBounds, shapePath } from '../src/recipes/morph.js';
import { flowCacheSize, flowState, packetProgress, pointOnPolyline, polylineLength, technicalFlowPlan } from '../src/recipes/technical-flow.js';
import { activeGroupAt, kineticPlan, kineticWordState, phraseGroups } from '../src/recipes/kinetic.js';
import { focusEntry, focusGeometry, cornerBrackets } from '../src/recipes/focus.js';
import {
  REVEAL_TYPES,
  drawRevealGeometry,
  paperRevealGeometry,
  revealGeometry,
  shapeRevealGeometry,
  transitionStyle,
} from '../src/motion/transitions.js';

const WIDTH = 1920;
const HEIGHT = 1080;

const finite = value => typeof value === 'number' && Number.isFinite(value);
const finitePoints = points => points.every(([x, y]) => finite(x) && finite(y));

test('AI2: recipe ids and morph shapes match the agreed contract', () => {
  assert.deepEqual(RECIPE_IDS, ['sketch', 'paper-cut', 'morph', 'technical-flow', 'focus', 'kinetic']);
  assert.deepEqual(MORPH_SHAPES, ['circle', 'square', 'triangle', 'blob']);
  assert.deepEqual(REVEAL_TYPES, ['paper-reveal', 'draw-reveal', 'shape-reveal']);
  assert.equal(resolveRecipe({ id: 's1' }).recipe, null, 'omission keeps the old render path');
  assert.equal(resolveRecipe({ id: 's1', motion: { recipe: 'nope' } }).recipe, null);
});

test('AI2: renderer recipe/transition ids are derived from the shared catalogue', () => {
  assert.deepEqual(RECIPE_IDS, [...ANIMATION_RECIPE_IDS]);
  assert.deepEqual(REVEAL_TYPES, [...ANIMATION_REVEAL_TRANSITIONS]);
});

test('AI2: planner motionCues drive scene-local recipe timing (explicit cue_seconds win)', () => {
  const cued = sceneCuePlan({
    scene: {
      id: 's_cues',
      from: 300,
      motion: { cue_phrases: ['Request', 'Worker'] },
      motionCues: [
        { phrase: 'Request', frame: 330, seconds: 1, source: 'word-cues', estimated: false },
        { phrase: 'Worker', frame: 450, seconds: 5, source: 'measured-caption', estimated: false },
      ],
    },
    fps: 30,
    count: 2,
    sceneFrames: 300,
  });
  assert.equal(cued.source, 'planner-word-cues');
  assert.equal(cued.fallback, false);
  assert.deepEqual(cued.seconds, [1, 5]);
  assert.deepEqual(cued.frames, [30, 150]);
  assert.deepEqual(cued.phrases, ['Request', 'Worker']);

  const explicitWins = sceneCuePlan({
    scene: {
      id: 's_explicit',
      from: 100,
      motion: { cue_seconds: [0.5, 2], cue_phrases: ['A', 'B'] },
      motionCues: [
        { phrase: 'A', frame: 999, seconds: 9, source: 'word-cues', estimated: false },
        { phrase: 'B', frame: 999, seconds: 9, source: 'word-cues', estimated: false },
      ],
    },
    fps: 30,
    count: 2,
    sceneFrames: 180,
  });
  assert.deepEqual(explicitWins.seconds, [0.5, 2], 'explicit motion.cue_seconds priority');
  assert.equal(explicitWins.source, 'explicit-seconds');
});

test('AI2: unresolved planner cues fall back deterministically and are surfaced', () => {
  resetCueWarnings();
  const scene = {
    id: 's_missing_cue',
    from: 60,
    motion: { cue_phrases: ['Known', 'Missing'] },
    motionCues: [
      { phrase: 'Known', frame: 90, seconds: 1, source: 'word-cues', estimated: false },
      { phrase: 'Missing', frame: null, seconds: null, source: 'unresolved', estimated: false },
    ],
  };
  const plan = sceneCuePlan({ scene, fps: 30, count: 2, sceneFrames: 180 });
  assert.equal(plan.fallback, true);
  assert.deepEqual(plan.unresolved, [1]);
  assert.deepEqual(plan.missing, ['Missing']);
  assert.equal(plan.source, 'mixed');
  assert.equal(plan.seconds[0], 1);
  assert.ok(plan.seconds[1] > plan.seconds[0] && plan.seconds[1] < 6);
  assert.deepEqual(plan, sceneCuePlan({ scene, fps: 30, count: 2, sceneFrames: 180 }), 'fallback is deterministic');
  const diagnostic = cueDiagnostic(scene, plan);
  assert.deepEqual(diagnostic?.missing, ['Missing']);
  assert.equal(cueDiagnostic(scene, plan)?.fallback, true);

  const raw = sceneCuePlan({ scene: { id: 's_raw', motion: { cue_phrases: ['Never compiled'] } }, fps: 30, count: 1, sceneFrames: 90 });
  assert.equal(raw.fallback, true);
  assert.deepEqual(raw.missing, ['Never compiled']);
  assert.equal(raw.source, 'fallback');
});

test('AI2: seeds are normalized into 1..2147483647 and stay deterministic', () => {
  assert.equal(normalizeSeed(42), 42);
  assert.equal(normalizeSeed(42.9), 42);
  const derived = normalizeSeed(undefined, 'scene-a');
  assert.ok(derived >= 1 && derived <= 2147483647);
  assert.equal(derived, normalizeSeed(undefined, 'scene-a'));
  assert.notEqual(derived, normalizeSeed(undefined, 'scene-b'));
  assert.ok(normalizeSeed(-9) >= 1);
  assert.ok(normalizeSeed(999999999999) >= 1);
  const a = seededRandom(17, 3);
  const b = seededRandom(17, 3);
  assert.deepEqual([a(), a(), a()], [b(), b(), b()]);
});

test('AI2: focus rects clamp to the native frame and reject nonsense', () => {
  assert.equal(normalizeFocus(null), null);
  assert.equal(normalizeFocus({ x: 0, y: 0, width: 0, height: 0.2 }), null);
  const rect = normalizeFocus({ x: 0.8, y: 0.8, width: 0.5, height: 0.4 });
  assert.ok(rect.x + rect.width <= 1.0000001);
  assert.ok(rect.y + rect.height <= 1.0000001);
  const px = focusRect(rect, 1080, 1920);
  assert.ok(px.x >= 0 && px.y >= 0 && px.x + px.w <= 1080.001 && px.y + px.h <= 1920.001);
  // Native dimensions, not a 1080-only canvas.
  const big = focusRect({ x: 0.25, y: 0.25, width: 0.5, height: 0.5 }, 3840, 2160);
  assert.deepEqual(big, { x: 960, y: 540, w: 1920, h: 1080 });
});

test('AI2: cue parameters are bounded and nondecreasing', () => {
  assert.deepEqual(normalizeCueSeconds([0, 1.5, 3]), [0, 1.5, 3]);
  assert.deepEqual(normalizeCueSeconds([0, -1]), []);
  assert.deepEqual(normalizeCueSeconds([2, 1]), []);
  assert.deepEqual(normalizeCuePhrases([' one ', '', 3, 'two']), ['one', 'two']);
  assert.ok(normalizeCuePhrases(Array.from({ length: 30 }, (_, i) => `p${i}`)).length <= 6);
});

test('AI2: recipe windows are bounded and use speech cues when present', () => {
  const plain = recipeWindow({ frame: 0, fps: 30, sceneFrames: 300 });
  assert.ok(plain.start >= 0 && plain.end <= 300 && plain.duration >= 1);
  const cued = recipeWindow({ frame: 45, fps: 30, sceneFrames: 300, cues: [1, 3] });
  assert.equal(cued.start, 30);
  assert.equal(cued.end, 90);
  assert.equal(cued.progress, 0.25);
  assert.ok(recipeWindow({ frame: 999, fps: 30, sceneFrames: 10, cues: [50, 90] }).end <= 10);
});

test('AI2: visual areas and list rows stay inside the native frame', () => {
  for (const [width, height] of [[1920, 1080], [1080, 1920], [1080, 1080], [3840, 2160]]) {
    for (const layout of ['title', 'hero', 'stat', 'chart', 'list', 'split', 'compare', 'code']) {
      for (const variant of [undefined, 'full-bleed']) {
        const area = visualArea({ layout, variant }, width, height);
        assert.ok(finite(area.x) && finite(area.y) && area.w > 0 && area.h > 0, `${layout} ${width}x${height}`);
        assert.ok(area.x >= 0 && area.y >= 0 && area.x + area.w <= width + 0.01 && area.y + area.h <= height + 0.01);
      }
    }
    const rows = listRowBoxes({ scene: { layout: 'list', variant: 'bullets' }, width, height, count: 4 });
    assert.equal(rows.length, 4);
    assert.equal(rows[0].y, 198, 'rows start below the 96 px safe area + 72 px headline + 30 px gap');
    for (const row of rows) {
      assert.ok(row.x >= 0 && row.y >= 0 && row.x + row.w <= width + 0.01 && row.y + row.h <= height + 0.01);
    }
    const six = listRowBoxes({ scene: { layout: 'list', variant: 'bullets' }, width, height, count: 6 });
    assert.ok(six[5].y + six[5].h < height * 0.78, 'six rows stay above the caption band');
    const wrapped = listRowBoxes({ scene: { layout: 'list', variant: 'bullets', copy: { headline: 'A headline long enough to wrap onto a second line in a narrow portrait frame for testing' } }, width, height, count: 3 });
    assert.ok(wrapped[0].y >= 198, 'a wrapped headline pushes rows down instead of overlapping them');
  }
});

test('AI2: a square morph stage never stretches with the free area', () => {
  for (const area of [
    { x: 100, y: 50, w: 400, h: 700 },
    { x: 0, y: 0, w: 900, h: 200 },
    { x: 10, y: 10, w: 300, h: 300 },
  ]) {
    const square = centeredSquare(area);
    assert.equal(square.size, Math.min(area.w, area.h) * 0.92);
    assert.ok(square.x >= area.x && square.y >= area.y);
    assert.ok(square.x + square.size <= area.x + area.w + 0.001);
    assert.ok(square.y + square.size <= area.y + area.h + 0.001);
    assert.ok(square.size > 0, 'one scalar size drives both axes');
  }
});

test('AI2: sketch annotations are seeded, bounded and cache frame-independent paths', () => {
  const scene = {
    id: 's_sketch',
    layout: 'list',
    variant: 'bullets',
    copy: { headline: 'Three editable steps', items: ['One', 'Two', 'Three'] },
  };
  const a = sketchAnnotations(scene, WIDTH, HEIGHT, 41, 0.7, [8, 32, 70]);
  const b = sketchAnnotations(scene, WIDTH, HEIGHT, 41, 0.7, [8, 32, 70]);
  assert.deepEqual(a, b, 'same seed, same annotations');
  const rects = a.filter(item => item.shape === 'rect');
  assert.deepEqual(rects.map(item => item.startFrame), [8, 32, 70], 'list cards reveal on planner cue frames');
  const rows = listRowBoxes({ scene, width: WIDTH, height: HEIGHT, count: 3 });
  rects.forEach((rect, index) => {
    assert.equal(rect.y, rows[index].y - 8, 'card starts 8 px above its real row');
    assert.equal(rect.h, rows[index].h + 12);
    const center = rows[index].y + rows[index].h / 2;
    assert.ok(center > rect.y && center < rect.y + rect.h, `card ${index} contains its row centre`);
  });
  const c = sketchAnnotations(scene, WIDTH, HEIGHT, 42, 0.7);
  assert.notDeepEqual(a, c, 'different seed, different jitter');
  assert.ok(a.some(item => item.shape === 'rect'));
  assert.ok(a.some(item => item.shape === 'check'));
  for (const item of a) {
    if (item.points) assert.ok(finitePoints(item.points), `${item.shape} points are finite`);
    for (const key of ['cx', 'cy', 'rx', 'ry', 'x', 'y', 'w', 'h', 'x1', 'y1', 'x2', 'y2']) {
      if (item[key] !== undefined) assert.ok(finite(item[key]), `${item.shape}.${key}`);
    }
  }
  const colors = { stroke: '#ffffff', accent: '#6d8cff', fill: '#1b2440' };
  const first = sketchPaths(a, colors);
  const second = sketchPaths(a, colors);
  assert.equal(first, second, 'path arrays are cached');
  assert.ok(first.length > 0);
  assert.ok(first.every(path => path.d.startsWith('M') && !path.d.includes('NaN')));
  assert.deepEqual([...new Set(first.filter(path => path.shape === 'rect').map(path => path.startFrame))], [8, 32, 70]);
  assert.ok(sketchCacheSize() >= 1);
  assert.match(strokeOutlinePath([[0, 0], [2, 2], [4, 0]]), /^M0,0 L2,2 L4,0 Z$/);
  assert.equal(strokeOutlinePath([]), '');
  assert.ok(ellipsePoints({ cx: 10, cy: 10, rx: 5, ry: 5, count: 12 }).length === 12);
  assert.ok(arrowPoints({ x0: 0, y0: 0, x1: 100, y1: 0, count: 9 }).length === 9);
});

test('AI2: paper layers are deterministic and keep text sheets in the safe zone', () => {
  const scene = { id: 's_paper', layout: 'title', variant: 'centered', copy: { headline: 'A paper story' } };
  const one = paperPlan({ scene, width: WIDTH, height: HEIGHT, seed: 12, intensity: 0.6 });
  const two = paperPlan({ scene, width: WIDTH, height: HEIGHT, seed: 12, intensity: 0.6 });
  assert.deepEqual(one, two);
  assert.ok(one.sheets.length >= 2, 'title gets a layered sheet');
  assert.ok(one.pieces.length >= 3, 'collage pieces are present');
  for (const shape of [...one.sheets, ...one.pieces]) {
    assert.ok(finitePoints(shape.points));
    assert.ok(Number.isFinite(shape.opacity) && shape.opacity >= 0 && shape.opacity <= 1);
    assert.ok(Number.isFinite(shape.rotate));
  }
  assert.ok(polygonPoints(one.pieces[0].points).split(' ').length >= 3);
  const settle = paperSettle(10, 2);
  assert.ok(settle.opacity >= 0 && settle.opacity <= 1 && finite(settle.dx) && finite(settle.dy));
  assert.deepEqual(settle, paperSettle(10, 2));
  assert.deepEqual(tornRect({ x: 0, y: 0, w: 10, h: 10, jitter: 2, random: seededRandom(2) }), tornRect({ x: 0, y: 0, w: 10, h: 10, jitter: 2, random: seededRandom(2) }));
});

test('AI2: morph paths endpoints, bounds and interpolator cache are deterministic', () => {
  for (const from of MORPH_SHAPES) {
    for (const to of MORPH_SHAPES) {
      const start = morphAt({ from, to, seed: 5, progress: 0 });
      const end = morphAt({ from, to, seed: 5, progress: 1 });
      assert.equal(start.d, morphAt({ from, to, seed: 5, progress: 0 }).d, `${from}->${to} p0 deterministic`);
      assert.equal(end.d, morphAt({ from, to, seed: 5, progress: 1 }).d, `${from}->${to} p1 deterministic`);
      assert.ok(start.d.startsWith('M') && !start.d.includes('NaN'));
      const bounds = pathBounds(start.d);
      assert.ok(bounds.minX >= -5 && bounds.maxX <= 105 && bounds.minY >= -5 && bounds.maxY <= 105, `${from}->${to} bounded`);
    }
  }
  const first = morphInterpolator({ from: 'circle', to: 'blob', seed: 5 });
  const second = morphInterpolator({ from: 'circle', to: 'blob', seed: 5 });
  assert.equal(first, second, 'same interpolator instance from the cache');
  assert.notEqual(shapePath('circle', 1), shapePath('blob', 1));
  assert.equal(MORPH_MAX_SEGMENT_LENGTH, 2.5);
  assert.ok(morphCacheSize() >= 1);
  const timeline = morphTimeline({ frame: 45, fps: 30, sceneFrames: 300, cues: [1, 3] });
  assert.equal(timeline.start, 30);
  assert.equal(timeline.end, 90);
  assert.ok(timeline.progress >= 0 && timeline.progress <= 1);
});

test('AI2: technical-flow layout is deterministic, aspect-aware and bounded', () => {
  const items = ['Receive', 'Plan', 'Execute', 'Review'];
  const landscape = technicalFlowPlan({ items, width: WIDTH, height: HEIGHT, scene: { layout: 'list' }, seed: 9, cues: [0.7, 2, 4, 6], fps: 30 });
  const again = technicalFlowPlan({ items, width: WIDTH, height: HEIGHT, scene: { layout: 'list' }, seed: 9, cues: [0.7, 2, 4, 6], fps: 30 });
  assert.equal(landscape, again, 'plan is cached');
  assert.equal(landscape.nodes.length, 4);
  assert.equal(landscape.edges.length, 3);
  assert.equal(landscape.portrait, false);
  assert.deepEqual(landscape.edges.map(edge => edge.start), [21, 60, 120, 180].slice(0, 3), 'edge packets start on the supplied planner cue frames');
  assert.ok(landscape.nodes.every((node, index) => index === 0 || node.x > landscape.nodes[index - 1].x), 'landscape ranks left to right');
  const portrait = technicalFlowPlan({ items, width: 1080, height: 1920, scene: { layout: 'list' }, seed: 9, cues: [0.7, 2, 4, 6], fps: 30 });
  assert.equal(portrait.portrait, true);
  assert.ok(portrait.nodes.every((node, index) => index === 0 || node.y > portrait.nodes[index - 1].y), 'portrait ranks top to bottom');
  for (const plan of [landscape, portrait]) {
    const graphCenter = (Math.min(...plan.nodes.map(node => node.y)) + Math.max(...plan.nodes.map(node => node.y + node.h))) / 2;
    const areaCenter = plan.area.y + plan.area.h / 2;
    assert.ok(Math.abs(graphCenter - areaCenter) < 0.01, `${plan.portrait ? 'portrait' : 'landscape'} graph is vertically centered`);
    for (const node of plan.nodes) {
      assert.ok(node.x >= plan.area.x - 0.5 && node.y >= plan.area.y - 0.5);
      assert.ok(node.x + node.w <= plan.area.x + plan.area.w + 0.5 && node.y + node.h <= plan.area.y + plan.area.h + 0.5);
    }
    for (const edge of plan.edges) {
      assert.ok(edge.points.length >= 2);
      assert.ok(edge.path.startsWith('M') && !edge.path.includes('NaN'));
      assert.ok(edge.duration >= 1);
    }
  }
  const state = flowState({ frame: 150, fps: 30, sceneFrames: 600, count: 4, cues: [0.7, 2, 4, 6] });
  assert.equal(state.active, 2);
  assert.equal(flowCacheSize() >= 2, true);
});

test('AI2: packets follow the routed polyline and have exact endpoints', () => {
  const points = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }];
  assert.equal(polylineLength(points), 200);
  assert.deepEqual(pointOnPolyline(points, 0), { x: 0, y: 0 });
  assert.deepEqual(pointOnPolyline(points, 0.5), { x: 100, y: 0 });
  assert.deepEqual(pointOnPolyline(points, 1), { x: 100, y: 100 });
  assert.deepEqual(pointOnPolyline([], 0.5), { x: 0, y: 0 });
  assert.equal(packetProgress({ frame: 0, start: 10, duration: 20 }), null);
  assert.equal(packetProgress({ frame: 10, start: 10, duration: 20 }), 0);
  assert.equal(packetProgress({ frame: 20, start: 10, duration: 20 }), 0.5);
  assert.equal(packetProgress({ frame: 20, start: 10, duration: 20 }), packetProgress({ frame: 20, start: 10, duration: 20 }));
});

test('AI2: kinetic phrases preserve copy and follow planner cues', () => {
  const headline = 'Make the invisible visible';
  const groups = phraseGroups(headline, ['Make the invisible', 'visible']);
  assert.equal(groups.length, 2);
  assert.deepEqual(groups[0].words, [0, 1, 2]);
  assert.deepEqual(groups[1].words, [3]);
  const plan = kineticPlan({ headline, phrases: ['Make the invisible', 'visible'], cues: [1, 2], fps: 30, sceneFrames: 150 });
  assert.equal(plan.words.map(word => word.text).join(' '), headline);
  assert.equal(plan.groups[0].start, 30);
  assert.equal(plan.groups[1].start, 60);
  assert.equal(activeGroupAt(plan.groups, 29), -1);
  assert.equal(activeGroupAt(plan.groups, 60), 1);
  const before = kineticWordState({ word: plan.words[3], frame: 0, fps: 30, activeGroup: -1 });
  assert.equal(before.opacity, 0);
  const after = kineticWordState({ word: plan.words[3], frame: 90, fps: 30, activeGroup: 1 });
  assert.equal(after.opacity, 1);
  assert.equal(after.active, true);
  // An unmatched phrase must not delete copy.
  const fallback = kineticPlan({ headline, phrases: ['not in the copy'], fps: 30, sceneFrames: 150 });
  assert.equal(fallback.words.map(word => word.text).join(' '), headline);
});

test('AI2: focus geometry uses native dimensions and bounded brackets', () => {
  for (const [width, height] of [[1920, 1080], [1080, 1920], [1080, 1080], [3840, 2160]]) {
    const focus = focusGeometry({ focus: { x: 0.2, y: 0.2, width: 0.5, height: 0.4 }, width, height, intensity: 0.8, seed: 4 });
    assert.ok(focus.rect.x >= 0 && focus.rect.y >= 0);
    assert.ok(focus.rect.x + focus.rect.w <= width && focus.rect.y + focus.rect.h <= height);
    assert.ok(focus.corner > 0 && focus.strokeWidth > 0);
    assert.ok(focus.path.startsWith('M0,0') && focus.path.includes('M'), 'even-odd donut path');
    assert.equal(cornerBrackets(focus).length, 4);
    assert.ok(cornerBrackets(focus).every(path => !path.includes('NaN')));
    const entry = focusEntry({ frame: 30, fps: 30 });
    assert.ok(entry.opacity >= 0 && entry.opacity <= 1 && entry.scale >= 1 && entry.scale <= 1.12);
  }
});

test('AI2: reveal transitions have no axis direction and exact bounded endpoints', () => {
  for (const type of REVEAL_TYPES) {
    const atStart = revealGeometry(type, 0, WIDTH, HEIGHT);
    const atEnd = revealGeometry(type, 1, WIDTH, HEIGHT);
    assert.equal(atStart.coverage, 0, `${type} starts hidden`);
    assert.equal(atEnd.coverage, 1, `${type} ends visible`);
    assert.ok(atStart.path.startsWith('M') && !atStart.path.includes('NaN'));
    assert.ok(atEnd.path.startsWith('M') && !atEnd.path.includes('NaN'));
    const before = transitionStyle(type, 0, { width: WIDTH, height: HEIGHT });
    const after = transitionStyle(type, 1, { width: WIDTH, height: HEIGHT });
    assert.equal(before.kind, type);
    assert.equal(before.direction, null, `${type} emits no axis direction`);
    assert.deepEqual(before.outgoing, {});
    assert.match(before.entering.clipPath, /^path\('/, `${type} maps to a path clip`);
    assert.match(after.entering.clipPath, /^path\('/);
    assert.deepEqual(transitionStyle(type, 0.5, { width: WIDTH, height: HEIGHT }), transitionStyle(type, 0.5, { width: WIDTH, height: HEIGHT }));
  }
  const paper = paperRevealGeometry(0, WIDTH, HEIGHT);
  assert.equal(paper.path, 'M0,0 Z');
  const paperEnd = paperRevealGeometry(1, WIDTH, HEIGHT);
  assert.equal(paperEnd.coverage, 1);
  assert.equal((paperEnd.path.match(/M/g) ?? []).length, 7);
  const drawStart = drawRevealGeometry(0, WIDTH, HEIGHT);
  const drawEnd = drawRevealGeometry(1, WIDTH, HEIGHT);
  assert.ok(drawStart.frontTop < 0 && drawStart.frontBottom < 0);
  assert.ok(drawEnd.frontTop > WIDTH && drawEnd.frontBottom > WIDTH);
  const shapeStart = shapeRevealGeometry(0, WIDTH, HEIGHT);
  const shapeEnd = shapeRevealGeometry(1, WIDTH, HEIGHT);
  assert.equal(shapeStart.radius, 0);
  assert.ok(shapeEnd.radius >= Math.hypot(WIDTH / 2, HEIGHT / 2), 'shape covers every corner');
  assert.ok(shapeEnd.maxRadius >= shapeEnd.radius);
});
