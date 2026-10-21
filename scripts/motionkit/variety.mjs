// M11: Variety and anti-repetition engine for motion recipes.
//
// pickRecipe(recipes, { tone=[], goal, energy?, history=[], seed }) performs
// weighted selection based on taxonomy fit and penalises recipes within
// recipeDistance < 0.35 of the last 8 picks. sceneVariation(recipe, scenes, seed)
// rotates entries/emphasis so no 3 consecutive scenes share an entry and exactly
// one hero scene exists. History is plain JSON passed in/out.

const KEBAB = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const HEX = /^#[0-9a-fA-F]{6}$/;

function toNumber(hex) {
  if (!HEX.test(hex)) return 0;
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return r + g * 256 + b * 65536;
}

function clamp01(v) {
  if (v < 0) return 0;
  if (v > 1) return 1;
  return v;
}

function mulberry32(a) {
  return function () {
    let t = (a += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function createRng(seed) {
  const s = seed >>> 0;
  const r = mulberry32(s === 0 ? 0x12345678 : s);
  return {
    next() {
      return r();
    },
    nextInt(max) {
      if (max <= 0) return 0;
      return Math.floor(r() * max) % max;
    },
  };
}

function normalizeArray(arr) {
  if (!Array.isArray(arr)) return [];
  return arr.filter((v) => typeof v === "string");
}

function getTaxonomy(recipe) {
  if (recipe && recipe.taxonomy && typeof recipe.taxonomy === "object") {
    return recipe.taxonomy;
  }
  return {};
}

function getPalette(recipe) {
  if (Array.isArray(recipe?.palette)) return recipe.palette;
  return [];
}

function paletteRoleValue(palette, role) {
  for (let i = 0; i < palette.length; i++) {
    if (palette[i] && palette[i].role === role) {
      return palette[i].hex || "#000000";
    }
  }
  return null;
}

function hammingDistanceHex(a, b) {
  const na = toNumber(a);
  const nb = toNumber(b);
  let x = na ^ nb;
  let dist = 0;
  while (x) {
    dist += x & 1;
    x >>>= 1;
  }
  return dist / 24;
}

function taxonomyDistance(aTax, bTax) {
  let d = 0;
  const keys = ["era", "finish", "energy", "geometry", "type"];
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i];
    const va = aTax[k];
    const vb = bTax[k];
    if (typeof va === "string" && typeof vb === "string") {
      if (va !== vb) d += 1;
    } else if ((va && !vb) || (!va && vb)) {
      d += 0.5;
    }
  }
  return d / keys.length;
}

function paletteDistance(aPal, bPal) {
  const roles = ["background", "text", "accent"];
  let sum = 0;
  let count = 0;
  for (let i = 0; i < roles.length; i++) {
    const r = roles[i];
    const ha = paletteRoleValue(aPal, r);
    const hb = paletteRoleValue(bPal, r);
    if (ha && hb) {
      sum += hammingDistanceHex(ha, hb);
      count++;
    }
  }
  if (count === 0) return 0.5;
  return sum / count;
}

/**
 * Compute taxonomy+palette distance between two recipes (0-1). Lower is closer.
 */
export function recipeDistance(recipeA, recipeB) {
  if (!recipeA || !recipeB) return 1;
  const t = taxonomyDistance(getTaxonomy(recipeA), getTaxonomy(recipeB));
  const p = paletteDistance(getPalette(recipeA), getPalette(recipeB));
  return clamp01((t + p) / 2);
}

function toneMatches(recipeTax, tones) {
  if (!tones || tones.length === 0) return 0.5;
  let score = 0;
  const finish = typeof recipeTax.finish === "string" ? recipeTax.finish : "";
  const era = typeof recipeTax.era === "string" ? recipeTax.era : "";
  const energy = typeof recipeTax.energy === "string" ? recipeTax.energy : "";
  const geometry = typeof recipeTax.geometry === "string" ? recipeTax.geometry : "";
  const type = typeof recipeTax.type === "string" ? recipeTax.type : "";
  for (let i = 0; i < tones.length; i++) {
    const t = tones[i].toLowerCase();
    if (t === "playful") {
      if (finish === "playful" || geometry === "organic" || era === "y2k" || energy === "high" || type === "display") score += 1;
    } else if (t === "serious" || t === "formal") {
      if (finish === "clean" || era === "modernist" || geometry === "flat" || type === "grotesk") score += 1;
    } else if (t === "moody") {
      if (finish === "grain" || era === "noir" || energy === "calm" || finish === "print") score += 1;
    } else if (t === "energetic") {
      if (energy === "high" || geometry === "organic") score += 1;
    } else {
      // generic match by any field overlap
      if (finish === t || era === t || energy === t || geometry === t || type === t) score += 1;
    }
  }
  return clamp01(score / Math.max(1, tones.length));
}

function goalMatches(recipeTax, goal) {
  if (!goal || typeof goal !== "string") return 0.5;
  const g = goal.toLowerCase();
  const finish = typeof recipeTax.finish === "string" ? recipeTax.finish : "";
  const era = typeof recipeTax.era === "string" ? recipeTax.era : "";
  const energy = typeof recipeTax.energy === "string" ? recipeTax.energy : "";
  const geometry = typeof recipeTax.geometry === "string" ? recipeTax.geometry : "";
  const type = typeof recipeTax.type === "string" ? recipeTax.type : "";
  if (g === "explain" || g === "educational" || g === "technical") {
    if (era === "modernist" || geometry === "flat" || finish === "clean" || type === "grotesk" || finish === "print") return 0.9;
  }
  if (g === "story" || g === "narrative") {
    if (finish === "grain" || era === "film" || energy === "medium" || type === "serif") return 0.9;
  }
  if (g === "promo" || g === "marketing" || g === "hook") {
    if (energy === "high" || type === "display" || geometry === "organic") return 0.9;
  }
  if (g === "brand" || g === "minimal") {
    if (finish === "clean" || geometry === "flat") return 0.9;
  }
  // fallback
  if (finish === g || era === g || energy === g || geometry === g || type === g) return 0.8;
  return 0.5;
}

function energyMatches(recipeTax, energy) {
  if (!energy || typeof energy !== "string") return 0.5;
  if (recipeTax.energy === energy) return 1.0;
  return 0.4;
}

function computeBaseFit(recipe, options) {
  const tax = getTaxonomy(recipe);
  const tones = normalizeArray(options?.tone);
  const goal = options?.goal;
  const energy = options?.energy;
  let score = 0.5;
  score += 0.3 * toneMatches(tax, tones);
  score += 0.3 * goalMatches(tax, goal);
  score += 0.2 * energyMatches(tax, energy);
  return clamp01(score);
}

function getHistoryArray(history) {
  if (!Array.isArray(history)) return [];
  return history.filter((h) => h && typeof h === "object");
}

function recipeId(recipe) {
  if (typeof recipe?.id === "string") return recipe.id;
  if (typeof recipe?.recipeId === "string") return recipe.recipeId;
  return "";
}

function findRecentHistoryPenalty(recipe, history, maxLookback = 8) {
  if (history.length === 0) return 0;
  const lookback = Math.min(maxLookback, history.length);
  let minDist = 1;
  for (let i = history.length - lookback; i < history.length; i++) {
    const h = history[i];
    const histRecipe = h.recipe || h;
    const dist = recipeDistance(recipe, histRecipe);
    if (dist < minDist) minDist = dist;
  }
  if (minDist < 0.35) return Math.max(0.5, 0.35 - minDist + 0.5); // stronger penalty
  return 0;
}

/**
 * Pick a recipe using weighted sampling. Returns { recipe, distanceToLast, weight }.
 * History entries may be { recipe, distance, ... } or plain recipe objects.
 */
export function pickRecipe(recipes, options = {}) {
  if (!Array.isArray(recipes) || recipes.length === 0) {
    return { recipe: null, distanceToLast: 1, weight: 0 };
  }
  const seed = typeof options.seed === "number" ? options.seed >>> 0 : 0x12345678;
  const rng = createRng(seed);
  const history = getHistoryArray(options.history);

  const recentIds = history.slice(-4).map(h => recipeId(h.recipe || h)).filter(Boolean);

  const candidates = recipes.map((recipe) => {
    const base = computeBaseFit(recipe, options);
    const penalty = findRecentHistoryPenalty(recipe, history);
    let weight = Math.max(0.0001, base - penalty * 0.5);
    const rid = recipeId(recipe);
    if (recentIds.includes(rid)) {
      weight = 0.000001; // effectively forbid repeating within 4
    }
    return { recipe, base, penalty, weight };
  });

  const total = candidates.reduce((s, c) => s + c.weight, 0);
  let r = rng.next() * total;
  let chosen = candidates[0];
  for (let i = 0; i < candidates.length; i++) {
    r -= candidates[i].weight;
    if (r <= 0) {
      chosen = candidates[i];
      break;
    }
  }
  if (chosen == null) chosen = candidates[candidates.length - 1];

  const last = history[history.length - 1];
  const distanceToLast = last ? recipeDistance(chosen.recipe, last.recipe || last) : 1;

  const pickedId = recipeId(chosen.recipe);
  const newEntry = {
    recipeId: pickedId || undefined,
    recipe: chosen.recipe,
    distance: distanceToLast,
    timestamp: Date.now(),
  };

  return {
    recipe: chosen.recipe,
    distanceToLast,
    weight: chosen.weight,
    baseFit: chosen.base,
    penalty: chosen.penalty,
    historyEntry: newEntry,
  };
}

/**
 * Rotate entries/emphasis so no 3 consecutive scenes share an entry and exactly
 * one hero scene exists. Returns modified scenes array (shallow copies).
 */
export function sceneVariation(recipe, scenes, seed = 0) {
  if (!Array.isArray(scenes) || scenes.length === 0) return [];
  const rng = createRng(typeof seed === "number" ? seed >>> 0 : 0);
  const entries = Array.isArray(recipe?.entries) ? recipe.entries.slice() : [];
  const emphasis = Array.isArray(recipe?.emphasis) ? recipe.emphasis.slice() : [];
  const hasHero = emphasis.includes("hero");

  const result = scenes.map((s) => (s && typeof s === "object" ? { ...s } : { content: s }));

  // Assign exactly one hero if recipe has hero emphasis
  if (hasHero && result.length > 0) {
    const heroIdx = rng.nextInt(result.length);
    for (let i = 0; i < result.length; i++) {
      if (result[i].emphasis === "hero") delete result[i].emphasis;
    }
    result[heroIdx].emphasis = "hero";
  }

  // Assign entries ensuring no 3 consecutive share the same entry
  if (entries.length > 0) {
    for (let i = 0; i < result.length; i++) {
      let chosen = entries[rng.nextInt(entries.length)];
      if (i >= 2) {
        const prev1 = result[i - 1].entry;
        const prev2 = result[i - 2].entry;
        if (prev1 && prev2 && prev1 === prev2 && prev1 === chosen) {
          // pick different entry
          const others = entries.filter((e) => e !== chosen);
          if (others.length > 0) {
            chosen = others[rng.nextInt(others.length)];
          }
        }
      }
      result[i].entry = chosen;
    }
  }

  // Assign non-hero emphasis (rotate) if available
  const nonHeroEmph = emphasis.filter((e) => e !== "hero");
  if (nonHeroEmph.length > 0) {
    let offset = rng.nextInt(nonHeroEmph.length);
    for (let i = 0; i < result.length; i++) {
      if (result[i].emphasis === "hero") continue;
      result[i].emphasis = nonHeroEmph[offset % nonHeroEmph.length];
      offset++;
    }
  }

  return result;
}
