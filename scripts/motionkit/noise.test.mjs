/** M03 acceptance: seeded noise fields are deterministic, bounded and Math.random-free. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as motionNoise from './noise.mjs';
import { curl2d, drift, fbm, mulberry32, noise2D, noise3D } from './noise.mjs';

// Fixed sample points (derived from a seeded stream, so the suite itself is
// deterministic without any ambient randomness).
const POINTS_2D = (() => {
  const rng = mulberry32(20261020);
  return Array.from({ length: 512 }, () => [rng() * 16 - 8, rng() * 16 - 8]);
})();
const POINTS_3D = (() => {
  const rng = mulberry32(20261021);
  return Array.from({ length: 384 }, () => [rng() * 12 - 6, rng() * 12 - 6, rng() * 12 - 6]);
})();

test('the module surface is exactly the M03 export list', () => {
  assert.deepEqual(Object.keys(motionNoise).sort(), [
    'curl2d', 'drift', 'fbm', 'mulberry32', 'noise2D', 'noise3D',
  ]);
  for (const value of Object.values(motionNoise)) assert.equal(typeof value, 'function');
});

test('mulberry32 is reproducible, stays in [0, 1) and seeds cleanly', () => {
  const a = mulberry32(42);
  const b = mulberry32(42);
  const c = mulberry32(43);
  const seqA = Array.from({ length: 128 }, () => a());
  const seqB = Array.from({ length: 128 }, () => b());
  const seqC = Array.from({ length: 128 }, () => c());
  assert.deepEqual(seqA, seqB);
  assert.notDeepEqual(seqA, seqC);
  let changed = 0;
  for (let i = 0; i < seqA.length; i += 1) {
    assert.ok(seqA[i] >= 0 && seqA[i] < 1, `${seqA[i]} outside [0, 1)`);
    if (seqA[i] !== seqC[i]) changed += 1;
  }
  assert.ok(changed > 110, `seeds should diverge, diverged at ${changed}/128`);

  const rng = mulberry32(42);
  let total = 0;
  for (let i = 0; i < 8192; i += 1) total += rng();
  assert.ok(total / 8192 > 0.45 && total / 8192 < 0.55, 'mean should hover near 0.5');
});

test('noise2D: same seed reproduces every sample, different seeds differ', () => {
  const a = noise2D(7);
  const b = noise2D(7);
  const c = noise2D(8);
  let changed = 0;
  for (const [x, y] of POINTS_2D) {
    const value = a(x, y);
    assert.equal(value, b(x, y), `same seed must match at ${x},${y}`);
    if (value !== c(x, y)) changed += 1;
  }
  assert.ok(changed > 480, `different seeds should differ, differed at ${changed}/512`);
});

test('noise2D stays inside [-1, 1] and uses most of the range', () => {
  const field = noise2D(5);
  let max = -Infinity;
  let min = Infinity;
  let total = 0;
  let count = 0;
  for (let i = 0; i < 96; i += 1) {
    for (let j = 0; j < 96; j += 1) {
      const value = field(i * 0.37 - 17.6, j * 0.41 - 18.7);
      assert.ok(value >= -1 && value <= 1, `${value} outside [-1, 1]`);
      if (value > max) max = value;
      if (value < min) min = value;
      total += value;
      count += 1;
    }
  }
  assert.ok(max > 0.4, `max ${max} too small`);
  assert.ok(min < -0.4, `min ${min} too small`);
  assert.ok(Math.abs(total / count) < 0.1, 'field should sit near zero mean');
});

test('noise2D is continuous across simplex boundaries', () => {
  const field = noise2D(11);
  let worst = 0;
  let x = -3.7;
  for (let i = 0; i < 4000; i += 1) {
    const here = field(x, 0.31 * x + 0.7);
    const next = field(x + 1e-3, 0.31 * (x + 1e-3) + 0.7);
    const jump = Math.abs(next - here);
    if (jump > worst) worst = jump;
    x += 1e-3;
  }
  assert.ok(worst < 0.02, `worst adjacent jump ${worst} suggests a seam`);
});

test('noise3D: same seed reproduces every sample, different seeds differ, range holds', () => {
  const a = noise3D(3);
  const b = noise3D(3);
  const c = noise3D(4);
  let changed = 0;
  let max = -Infinity;
  let min = Infinity;
  for (const [x, y, z] of POINTS_3D) {
    const value = a(x, y, z);
    assert.equal(value, b(x, y, z));
    assert.ok(value >= -1 && value <= 1, `${value} outside [-1, 1]`);
    if (value > max) max = value;
    if (value < min) min = value;
    if (value !== c(x, y, z)) changed += 1;
  }
  assert.ok(changed > 350, `different seeds should differ, differed at ${changed}/384`);
  assert.ok(max > 0.4 && min < -0.4, `range too narrow: ${min}..${max}`);

  let worst = 0;
  let x = -2.4;
  for (let i = 0; i < 3000; i += 1) {
    const here = a(x, 0.5, -0.31 * x);
    const next = a(x + 1e-3, 0.5, -0.31 * (x + 1e-3));
    const jump = Math.abs(next - here);
    if (jump > worst) worst = jump;
    x += 1e-3;
  }
  assert.ok(worst < 0.03, `worst adjacent jump ${worst} suggests a seam`);
});

test('2D and 3D fields are distinct constructions for the same seed', () => {
  const two = noise2D(5);
  const three = noise3D(5);
  let changed = 0;
  for (const [x, y] of POINTS_2D) {
    if (two(x, y) !== three(x, y, 0.5)) changed += 1;
  }
  assert.ok(changed > 480);
});

test('factories stay pure when seeds are interleaved', () => {
  const reference = noise2D(77);
  const a = noise2D(77);
  const other = noise2D(78);
  for (let i = 0; i < 200; i += 1) {
    const x = i * 0.153 - 10;
    const y = i * -0.211 + 4;
    other(x, y);
    assert.equal(a(x, y), reference(x, y));
  }
});

test('fbm is deterministic, normalised to [-1, 1] and octave-sensitive', () => {
  const four = fbm(noise2D(21), 4);
  const fourAgain = fbm(noise2D(21), 4);
  const one = fbm(noise2D(21), 1);
  const base = noise2D(21);
  let changed = 0;
  for (const [x, y] of POINTS_2D) {
    const value = four(x, y);
    assert.equal(value, fourAgain(x, y));
    assert.ok(value >= -1 && value <= 1, `${value} outside [-1, 1]`);
    if (value !== one(x, y)) changed += 1;
  }
  assert.equal(one(0.5, -0.25), base(0.5, -0.25), 'one octave is the base field');
  assert.ok(changed > 400, 'extra octaves should change the field');

  // Normalisation keeps the sum bounded even when raw amplitudes add to ~5.7.
  const heavy = fbm(noise2D(9), 8, { gain: 0.9 });
  for (const [x, y] of POINTS_2D) {
    const value = heavy(x, y);
    assert.ok(value >= -1 && value <= 1, `${value} outside [-1, 1] at gain 0.9`);
  }

  // Options-object form and non-default lacunarity both work.
  const shaped = fbm(noise2D(21), { octaves: 3, lacunarity: 1.5, gain: 0.6 });
  const plain = fbm(noise2D(21), 3);
  let shapedDifferently = 0;
  for (const [x, y] of POINTS_2D) {
    assert.ok(shaped(x, y) >= -1 && shaped(x, y) <= 1);
    if (shaped(x, y) !== plain(x, y)) shapedDifferently += 1;
  }
  assert.ok(shapedDifferently > 400);

  // fbm also stacks 3D fields.
  const volumetric = fbm(noise3D(13), 3);
  for (const [x, y, z] of POINTS_3D.slice(0, 64)) {
    const value = volumetric(x, y, z);
    assert.ok(value >= -1 && value <= 1);
  }
});

test('curl2d is seeded, bounded and divergence-free', () => {
  const step = 1e-3;
  let maxDivergence = 0;
  let maxMagnitude = 0;
  let changed = 0;
  let checked = 0;
  for (const [x, y] of POINTS_2D.slice(0, 128)) {
    const value = curl2d(3, x, y);
    assert.deepEqual(curl2d(3, x, y), value, 'same seed must match');
    assert.ok(Math.abs(value.x) <= 1 && Math.abs(value.y) <= 1);
    const other = curl2d(4, x, y);
    if (other.x !== value.x || other.y !== value.y) changed += 1;

    const divergence =
      (curl2d(3, x + step, y).x - curl2d(3, x - step, y).x) / (2 * step) +
      (curl2d(3, x, y + step).y - curl2d(3, x, y - step).y) / (2 * step);
    if (Math.abs(divergence) > maxDivergence) maxDivergence = Math.abs(divergence);
    const magnitude = Math.hypot(value.x, value.y);
    if (magnitude > maxMagnitude) maxMagnitude = magnitude;
    checked += 1;
  }
  assert.ok(changed > 120, `different seeds should differ, differed at ${changed}/${checked}`);
  assert.ok(maxMagnitude > 0.2, `field looks dead: peak magnitude ${maxMagnitude}`);
  assert.ok(maxDivergence < 1e-6, `divergence ${maxDivergence} should be ~0`);

  // Scale and octave options stay bounded and change the field.
  const wide = curl2d(3, 0.5, -0.25, { scale: 0.5, octaves: 2 });
  const narrow = curl2d(3, 0.5, -0.25);
  assert.ok(Math.abs(wide.x) <= 1 && Math.abs(wide.y) <= 1);
  assert.notDeepEqual(wide, narrow);
});

test('drift is deterministic, scales with amp and stays smooth in t', () => {
  for (const t of [0, 0.5, 1.25, 7.75]) {
    assert.deepEqual(drift(5, t, 0.4), drift(5, t, 0.4));
    const full = drift(5, t, 1);
    const half = drift(5, t, 0.5);
    assert.equal(half.x, full.x * 0.5, 'amplitude should scale linearly');
    assert.equal(half.y, full.y * 0.5, 'amplitude should scale linearly');
    assert.ok(Math.abs(half.x) <= 0.5 && Math.abs(half.y) <= 0.5);
    assert.ok(Math.abs(full.x) <= 1 && Math.abs(full.y) <= 1);
    const zero = drift(5, t, 0);
    assert.ok(Math.abs(zero.x) === 0 && Math.abs(zero.y) === 0, 'zero amp means zero offset');
  }

  let changed = 0;
  let samples = 0;
  for (let t = 0; t < 20; t += 0.25) {
    const a = drift(1, t, 0.6);
    const b = drift(2, t, 0.6);
    if (a.x !== b.x || a.y !== b.y) changed += 1;
    samples += 1;
  }
  assert.ok(changed > samples - 5, `different seeds should differ, ${changed}/${samples}`);

  let worst = 0;
  for (let t = 0; t < 10; t += 0.01) {
    const a = drift(6, t, 1);
    const b = drift(6, t + 0.01, 1);
    const stepSize = Math.hypot(b.x - a.x, b.y - a.y);
    if (stepSize > worst) worst = stepSize;
  }
  assert.ok(worst < 0.1, `drift jumped ${worst} over dt 0.01`);

  // The rate option changes the path without breaking determinism.
  const slow = drift(6, 4, 0.5, { rate: 0.1 });
  const fast = drift(6, 4, 0.5, { rate: 1 });
  assert.notDeepEqual(slow, fast);
  assert.deepEqual(drift(6, 4, 0.5, { rate: 0.1 }), slow);
});

test('golden samples pin the algorithm across refactors', () => {
  const field2 = noise2D(7);
  const points2 = [[0, 0], [1.25, -3.5], [10.1, 0.2], [-4.75, 8.3], [3.333, -7.777]];
  assert.deepEqual(
    points2.map(([x, y]) => Number(field2(x, y).toFixed(9))),
    [0, 0.375876258, -0.496812729, 0.214412958, -0.775731598],
  );

  const field3 = noise3D(7);
  const points3 = [[0, 0, 0], [1.25, -3.5, 2.2], [10.1, 0.2, -0.5], [-4.75, 8.3, 1.1]];
  assert.deepEqual(
    points3.map(([x, y, z]) => Number(field3(x, y, z).toFixed(9))),
    [0, -0.525549721, 0.292093869, -0.513694143],
  );

  const fractal = fbm(noise2D(7), 4);
  assert.deepEqual(
    points2.map(([x, y]) => Number(fractal(x, y).toFixed(9))),
    [0, -0.023769193, -0.451675786, -0.131625949, -0.282765731],
  );

  assert.deepEqual(
    [[0, 0], [2.5, -1.25], [-6.4, 3.3]].map(([x, y]) => {
      const value = curl2d(7, x, y);
      return [Number(value.x.toFixed(9)), Number(value.y.toFixed(9))];
    }),
    [[0.194139182, -0.817250689], [0.290048493, -0.322462634], [-0.151558816, 0.417497601]],
  );

  assert.deepEqual(
    [0, 1.5, 4.25].map((t) => {
      const value = drift(7, t, 0.4);
      return [Number(value.x.toFixed(9)), Number(value.y.toFixed(9))];
    }),
    [[-0.197673476, -0.302611476], [-0.00759653, 0.242243039], [-0.355097702, -0.126049578]],
  );

  const rng = mulberry32(42);
  assert.deepEqual(
    Array.from({ length: 6 }, () => Number(rng().toFixed(9))),
    [0.601103752, 0.448290559, 0.852465793, 0.669734041, 0.174813899, 0.526592542],
  );
  // Seed 0 is a real stream, not a degenerate one.
  const zero = mulberry32(0);
  assert.deepEqual(
    Array.from({ length: 3 }, () => Number(zero().toFixed(9))),
    [0.266429209, 0.000329746, 0.223272027],
  );
});

test('noise.mjs reaches for no ambient randomness, clock, env or loader', () => {
  const source = readFileSync(fileURLToPath(new URL('./noise.mjs', import.meta.url)), 'utf8');
  const forbidden = [
    [/Math\.random/, 'ambient randomness'],
    [/Date\.now/, 'wall clock'],
    [/performance\.now/, 'monotonic clock'],
    [/process\.env/, 'environment variables'],
    [/globalThis/, 'ambient globals'],
    [/require\(/, 'CommonJS loader'],
    [/https?:\/\//, 'network reference'],
  ];
  for (const [pattern, why] of forbidden) {
    assert.ok(!pattern.test(source), `noise.mjs must not use ${why} (${pattern})`);
  }
});
