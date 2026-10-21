/** Seeded 2D/3D simplex noise, fbm, curl and camera/particle drift (MOTION-UPGRADE M03).
 *
 * Own MIT implementation, re-expressed from Stefan Gustavson's public-domain
 * description of the simplex noise algorithm (skewed lattice, corner weights,
 * gradient dot products); no third-party noise code is copied. Every field is
 * deterministic for a given seed and explicitly bounded to [-1, 1]. There is no
 * import-time work: permutation and gradient tables are built lazily inside the
 * factory functions, so importing this module has no side effects.
 */

const TAU = Math.PI * 2;

// Lattice skewing: sum the coordinates into a simplex, then map back.
const F2 = 0.5 * (Math.sqrt(3) - 1);
const G2 = (3 - Math.sqrt(3)) / 6;
const F3 = 1 / 3;
const G3 = 1 / 6;

// Squared-radius cutoff for a corner's falloff weight (cut - r^2)^4.
const R2_CUT = 0.5;
const R3_CUT = 0.6;

// Output calibration. Raw corner sums were sampled densely and hill-climbed
// (max |raw| ~ 0.0101 in 2D, ~ 0.0247 in 3D); these factors bring the extremes
// to |v| <= 1 and the final clamp is the hard guarantee.
const SCALE_2D = 96;
const SCALE_3D = 39;
// Curl is built from finite differences of a scalar potential, so its raw
// magnitude tracks the scaled potential's gradient (peak |grad| ~ 6.9). This
// gain keeps every component inside the [-1, 1] band.
const CURL_GAIN = 0.14;

// Fixed decorrelation offsets for drift's two axes (lattice units, arbitrary).
const DRIFT_OX = 17.31;
const DRIFT_OY = -9.17;
const DRIFT_OX2 = -4.43;
const DRIFT_OY2 = 12.79;

function clampUnit(value) {
  if (value < -1) return -1;
  if (value > 1) return 1;
  return value;
}

/** Coerce any seed to a uint32 so PRNG and field builders share one convention. */
function normalizeSeed(seed) {
  const n = Math.floor(Number(seed));
  return Number.isFinite(n) ? n >>> 0 : 0;
}

/** mulberry32: tiny fast seeded PRNG. Returns floats in [0, 1). */
export function mulberry32(seed) {
  let a = normalizeSeed(seed);
  return function next() {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function buildPerm(rng) {
  const base = new Uint8Array(256);
  for (let i = 0; i < 256; i += 1) base[i] = i;
  for (let i = 255; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    const swap = base[i];
    base[i] = base[j];
    base[j] = swap;
  }
  const table = new Uint8Array(512);
  for (let i = 0; i < 512; i += 1) table[i] = base[i & 255];
  return table;
}

function buildGrad2(rng) {
  const table = new Float64Array(512);
  for (let i = 0; i < 256; i += 1) {
    const angle = rng() * TAU;
    table[2 * i] = Math.cos(angle);
    table[2 * i + 1] = Math.sin(angle);
  }
  return table;
}

function buildGrad3(rng) {
  const table = new Float64Array(768);
  for (let i = 0; i < 256; i += 1) {
    // Uniform point on the unit sphere: z from [-1, 1], then the longitude.
    const z = 2 * rng() - 1;
    const angle = rng() * TAU;
    const r = Math.sqrt(Math.max(0, 1 - z * z));
    table[3 * i] = r * Math.cos(angle);
    table[3 * i + 1] = r * Math.sin(angle);
    table[3 * i + 2] = z;
  }
  return table;
}

function fieldTables(seed) {
  const s = normalizeSeed(seed);
  const permRng = mulberry32(s);
  // A derived stream keeps the gradient table independent of the permutation.
  const gradRng = mulberry32((s ^ 0x9e3779b9) >>> 0);
  return { permRng, gradRng };
}

function corner2(grad, gi, x, y) {
  const t = R2_CUT - (x * x + y * y);
  if (t <= 0) return 0;
  const w = t * t;
  const g = gi * 2;
  return w * w * (grad[g] * x + grad[g + 1] * y);
}

/** Factory: seeded 2D simplex field, sample with noise2D(seed)(x, y) -> [-1, 1]. */
export function noise2D(seed) {
  const { permRng, gradRng } = fieldTables(seed);
  const perm = buildPerm(permRng);
  const grad = buildGrad2(gradRng);
  return function sample2(x, y) {
    const skew = (x + y) * F2;
    const i = Math.floor(x + skew);
    const j = Math.floor(y + skew);
    const t = (i + j) * G2;
    const x0 = x - (i - t);
    const y0 = y - (j - t);
    // Split the cell into two simplices along the lower diagonal.
    const i1 = x0 > y0 ? 1 : 0;
    const j1 = 1 - i1;
    const x1 = x0 - i1 + G2;
    const y1 = y0 - j1 + G2;
    const x2 = x0 - 1 + 2 * G2;
    const y2 = y0 - 1 + 2 * G2;
    const ii = i & 255;
    const jj = j & 255;
    const sum =
      corner2(grad, perm[ii + perm[jj]], x0, y0) +
      corner2(grad, perm[ii + i1 + perm[jj + j1]], x1, y1) +
      corner2(grad, perm[ii + 1 + perm[jj + 1]], x2, y2);
    return clampUnit(sum * SCALE_2D);
  };
}

function corner3(grad, gi, x, y, z) {
  const t = R3_CUT - (x * x + y * y + z * z);
  if (t <= 0) return 0;
  const w = t * t;
  const g = gi * 3;
  return w * w * (grad[g] * x + grad[g + 1] * y + grad[g + 2] * z);
}

/** Factory: seeded 3D simplex field, sample with noise3D(seed)(x, y, z) -> [-1, 1]. */
export function noise3D(seed) {
  const { permRng, gradRng } = fieldTables(seed);
  const perm = buildPerm(permRng);
  const grad = buildGrad3(gradRng);
  return function sample3(x, y, z) {
    const skew = (x + y + z) * F3;
    const i = Math.floor(x + skew);
    const j = Math.floor(y + skew);
    const k = Math.floor(z + skew);
    const t = (i + j + k) * G3;
    const x0 = x - (i - t);
    const y0 = y - (j - t);
    const z0 = z - (k - t);
    // Order the axes to pick the enclosing tetrahedra.
    let i1;
    let j1;
    let k1;
    let i2;
    let j2;
    let k2;
    if (x0 >= y0) {
      if (y0 >= z0) {
        i1 = 1; j1 = 0; k1 = 0; i2 = 1; j2 = 1; k2 = 0;
      } else if (x0 >= z0) {
        i1 = 1; j1 = 0; k1 = 0; i2 = 1; j2 = 0; k2 = 1;
      } else {
        i1 = 0; j1 = 0; k1 = 1; i2 = 1; j2 = 0; k2 = 1;
      }
    } else if (y0 < z0) {
      i1 = 0; j1 = 0; k1 = 1; i2 = 0; j2 = 1; k2 = 1;
    } else if (x0 < z0) {
      i1 = 0; j1 = 1; k1 = 0; i2 = 0; j2 = 1; k2 = 1;
    } else {
      i1 = 0; j1 = 1; k1 = 0; i2 = 1; j2 = 1; k2 = 0;
    }
    const x1 = x0 - i1 + G3;
    const y1 = y0 - j1 + G3;
    const z1 = z0 - k1 + G3;
    const x2 = x0 - i2 + 2 * G3;
    const y2 = y0 - j2 + 2 * G3;
    const z2 = z0 - k2 + 2 * G3;
    const x3 = x0 - 1 + 3 * G3;
    const y3 = y0 - 1 + 3 * G3;
    const z3 = z0 - 1 + 3 * G3;
    const ii = i & 255;
    const jj = j & 255;
    const kk = k & 255;
    const sum =
      corner3(grad, perm[ii + perm[jj + perm[kk]]], x0, y0, z0) +
      corner3(grad, perm[ii + i1 + perm[jj + j1 + perm[kk + k1]]], x1, y1, z1) +
      corner3(grad, perm[ii + i2 + perm[jj + j2 + perm[kk + k2]]], x2, y2, z2) +
      corner3(grad, perm[ii + 1 + perm[jj + 1 + perm[kk + 1]]], x3, y3, z3);
    return clampUnit(sum * SCALE_3D);
  };
}

/** Fractal brownian motion over any 2D or 3D noise function, normalised to [-1, 1].
 *  fbm(noise2D(7), 5) or fbm(noise3D(7), { octaves: 3, lacunarity: 2, gain: 0.5 }). */
export function fbm(fn, octaves = 4, options = {}) {
  let count = octaves;
  let opts = options;
  if (count !== null && typeof count === 'object') {
    opts = count;
    count = opts.octaves ?? 4;
  }
  const levels = Math.max(1, Math.floor(count)) || 1;
  const lacunarity = opts.lacunarity ?? 2;
  const gain = opts.gain ?? 0.5;
  const deep = fn.length >= 3;
  return function fbmField(x, y, z) {
    let sum = 0;
    let total = 0;
    let amp = 1;
    let freq = 1;
    for (let o = 0; o < levels; o += 1) {
      const value = deep ? fn(x * freq, y * freq, z * freq) : fn(x * freq, y * freq);
      sum += amp * value;
      total += amp;
      freq *= lacunarity;
      amp *= gain;
    }
    return clampUnit(sum / total);
  };
}

const potentialCache = new Map();

function potentialFor(seed, octaves) {
  const key = `${normalizeSeed(seed)}:${octaves}`;
  let field = potentialCache.get(key);
  if (!field) {
    const base = noise2D(seed);
    field = octaves > 1 ? fbm(base, octaves) : base;
    potentialCache.set(key, field);
  }
  return field;
}

/** Divergence-free 2D vector field: rotate the gradient of a seeded scalar
 *  potential. curl2d(seed, x, y, { scale, octaves, eps }) -> { x, y } in [-1, 1]. */
export function curl2d(seed, x, y, options = {}) {
  const scale = options.scale ?? 1;
  const octaves = Math.max(1, Math.floor(options.octaves ?? 1)) || 1;
  const eps = options.eps ?? 1e-3;
  const potential = potentialFor(seed, octaves);
  const px = x * scale;
  const py = y * scale;
  const dPdx = (potential(px + eps, py) - potential(px - eps, py)) / (2 * eps);
  const dPdy = (potential(px, py + eps) - potential(px, py - eps)) / (2 * eps);
  return {
    x: clampUnit(dPdy * scale * CURL_GAIN),
    y: clampUnit(-dPdx * scale * CURL_GAIN),
  };
}

const driftCache = new Map();

function driftFieldFor(seed) {
  const key = normalizeSeed(seed);
  let field = driftCache.get(key);
  if (!field) {
    field = noise2D(seed);
    driftCache.set(key, field);
  }
  return field;
}

/** Smooth camera/particle wobble: drift(seed, t, amp, { rate }) -> { x, y }.
 *  Offsets scale with amp and are clamped to [-1, 1]; pass amp <= 1 to stay
 *  inside [-amp, amp]. Same seed and t always reproduce the same pair. */
export function drift(seed, t, amp = 1, options = {}) {
  const rate = options.rate ?? 0.35;
  const field = driftFieldFor(seed);
  const u = t * rate;
  return {
    x: clampUnit(field(u + DRIFT_OX, DRIFT_OY) * amp),
    y: clampUnit(field(DRIFT_OX2, u + DRIFT_OY2) * amp),
  };
}
