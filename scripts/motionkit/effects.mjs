// M04: effects catalog.
//
// Loads scripts/motionkit/data/effects.json and validates it. Pure module: no
// side effects at import time, no network, no clock. The file system is
// injected so tests can supply a fake reader.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const EFFECTS_SCHEMA = "comfyrizz.effects/v1";

/** Licences an effect may declare. Vendorable third party licences plus our own. */
export const ALLOWED_LICENSES = Object.freeze(["MIT", "ISC", "CC0-1.0", "OFL-1.1", "own-MIT"]);

/** Implementation cost of an effect, cheapest first. */
export const ALLOWED_COSTS = Object.freeze(["css", "svg", "webgl"]);

/** Costs that can be produced without a GPU. */
export const CPU_COSTS = Object.freeze(["css", "svg"]);

export const DEFAULT_EFFECTS_PATH = fileURLToPath(new URL("./data/effects.json", import.meta.url));

const ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * Read and parse the effects catalog.
 * @param {{fs?: {readFileSync: Function}, path?: string}} [options]
 * @returns {{schema: string, effects: object[]}}
 */
export function loadEffects(options = {}) {
  const fs = options.fs ?? { readFileSync };
  const path = options.path ?? DEFAULT_EFFECTS_PATH;
  const raw = fs.readFileSync(path, "utf8");
  const parsed = JSON.parse(typeof raw === "string" ? raw : String(raw));
  if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.effects)) {
    throw new Error("effects catalog is malformed: expected an object with an effects array");
  }
  return parsed;
}

/**
 * Look up one effect by id.
 * @param {string} id
 * @param {object[]|{effects: object[]}} [catalog]
 * @returns {object|null} the effect, or null when it is unknown
 */
export function getEffect(id, catalog) {
  const effects = Array.isArray(catalog) ? catalog : (catalog?.effects ?? loadEffects().effects);
  return effects.find((effect) => effect.id === id) ?? null;
}

/**
 * Filter the catalog.
 * @param {{family?: string, cost?: string, ids?: string[]}} filter
 * @param {object[]} [effects]
 * @returns {object[]}
 */
export function selectEffects(filter = {}, effects = loadEffects().effects) {
  const ids = filter.ids ? new Set(filter.ids) : null;
  return effects.filter((effect) => {
    if (ids && !ids.has(effect.id)) return false;
    if (filter.family && effect.family !== filter.family) return false;
    if (filter.cost && effect.cost !== filter.cost) return false;
    return true;
  });
}

/**
 * Distinct family names, in first-seen order.
 * @param {object[]} [effects]
 * @returns {string[]}
 */
export function listFamilies(effects = loadEffects().effects) {
  const seen = [];
  for (const effect of effects) {
    if (!seen.includes(effect.family)) seen.push(effect.family);
  }
  return seen;
}

function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * Validate an effects catalog.
 * Checks: shape, unique ids, cost and licence allowlists, numeric params with
 * defaults inside their range, and a resolvable css/svg fallback for every
 * webgl effect.
 * @param {object[]|{effects: object[]}} catalog
 * @returns {{ok: boolean, errors: {path: string, message: string}[], effectCount: number}}
 */
export function validateEffects(catalog) {
  const errors = [];
  const effects = Array.isArray(catalog) ? catalog : catalog?.effects;

  if (!Array.isArray(effects)) {
    return { ok: false, errors: [{ path: "$", message: "effects catalog must be an array" }], effectCount: 0 };
  }

  const byId = new Map();
  effects.forEach((effect, index) => {
    const path = `$.effects[${index}]`;
    if (!effect || typeof effect !== "object") {
      errors.push({ path, message: "effect must be an object" });
      return;
    }
    if (typeof effect.id !== "string" || !ID_PATTERN.test(effect.id)) {
      errors.push({ path: `${path}.id`, message: "id must be kebab-case" });
    } else if (byId.has(effect.id)) {
      errors.push({ path: `${path}.id`, message: `duplicate effect id "${effect.id}"` });
    } else {
      byId.set(effect.id, effect);
    }
    if (typeof effect.label !== "string" || effect.label.trim() === "") {
      errors.push({ path: `${path}.label`, message: "label must be a non-empty string" });
    }
    if (typeof effect.family !== "string" || effect.family.trim() === "") {
      errors.push({ path: `${path}.family`, message: "family must be a non-empty string" });
    }
    if (!ALLOWED_COSTS.includes(effect.cost)) {
      errors.push({ path: `${path}.cost`, message: `cost must be one of ${ALLOWED_COSTS.join(", ")}` });
    }
    if (!ALLOWED_LICENSES.includes(effect.license)) {
      errors.push({ path: `${path}.license`, message: `license must be one of ${ALLOWED_LICENSES.join(", ")}` });
    }
    if (typeof effect.source !== "string" || effect.source.trim() === "") {
      errors.push({ path: `${path}.source`, message: "source must be a non-empty string" });
    }
    if (typeof effect.notes !== "string") {
      errors.push({ path: `${path}.notes`, message: "notes must be a string" });
    }

    const params = effect.params;
    if (!params || typeof params !== "object" || Array.isArray(params)) {
      errors.push({ path: `${path}.params`, message: "params must be an object" });
    } else {
      for (const [name, spec] of Object.entries(params)) {
        const paramPath = `${path}.params.${name}`;
        if (!spec || typeof spec !== "object") {
          errors.push({ path: paramPath, message: "param spec must be an object" });
          continue;
        }
        if (!isFiniteNumber(spec.min) || !isFiniteNumber(spec.max) || !isFiniteNumber(spec.default)) {
          errors.push({ path: paramPath, message: "min, max and default must be finite numbers" });
          continue;
        }
        if (spec.min > spec.max) {
          errors.push({ path: paramPath, message: "min must not be greater than max" });
        }
        if (spec.default < spec.min || spec.default > spec.max) {
          errors.push({ path: paramPath, message: "default must be inside the range" });
        }
      }
    }

    const fallback = effect.cpuFallback;
    if (fallback !== null && fallback !== undefined) {
      if (typeof fallback !== "string") {
        errors.push({ path: `${path}.cpuFallback`, message: "cpuFallback must be an effect id or null" });
      } else if (fallback === effect.id) {
        errors.push({ path: `${path}.cpuFallback`, message: "cpuFallback must not reference the effect itself" });
      }
    }
  });

  effects.forEach((effect, index) => {
    const path = `$.effects[${index}].cpuFallback`;
    const fallback = effect?.cpuFallback;
    if (effect?.cost === "webgl") {
      if (typeof fallback !== "string" || fallback === "") {
        errors.push({ path, message: "webgl effects need a cpuFallback id" });
        return;
      }
      const target = byId.get(fallback);
      if (!target) {
        errors.push({ path, message: `cpuFallback "${fallback}" does not exist` });
        return;
      }
      if (!CPU_COSTS.includes(target.cost)) {
        errors.push({ path, message: `cpuFallback "${fallback}" must be a css or svg effect` });
      }
      return;
    }
    if (typeof fallback === "string" && fallback !== "" && !byId.has(fallback)) {
      errors.push({ path, message: `cpuFallback "${fallback}" does not exist` });
    }
  });

  return { ok: errors.length === 0, errors, effectCount: effects.length };
}
