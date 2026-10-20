// M04 acceptance: the effects catalog data and its loader/validator.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  ALLOWED_COSTS,
  ALLOWED_LICENSES,
  CPU_COSTS,
  DEFAULT_EFFECTS_PATH,
  getEffect,
  listFamilies,
  loadEffects,
  selectEffects,
  validateEffects,
} from "./effects.mjs";

const catalog = loadEffects();
const effects = catalog.effects;

test("catalog loads and holds 30 or more effects", () => {
  assert.ok(effects.length >= 30, `expected 30+ effects, got ${effects.length}`);
});

test("effect ids are unique and kebab-case", () => {
  const ids = effects.map((effect) => effect.id);
  assert.equal(new Set(ids).size, ids.length, "effect ids must be unique");
  for (const id of ids) {
    assert.match(id, /^[a-z0-9]+(?:-[a-z0-9]+)*$/, `id "${id}" must be kebab-case`);
  }
});

test("the shipped catalog validates", () => {
  const result = validateEffects(effects);
  assert.equal(result.ok, true, JSON.stringify(result.errors, null, 2));
  assert.equal(result.errors.length, 0);
});

test("every effect has the required shape", () => {
  for (const effect of effects) {
    assert.equal(typeof effect.id, "string");
    assert.equal(typeof effect.label, "string");
    assert.equal(typeof effect.family, "string");
    assert.ok(ALLOWED_COSTS.includes(effect.cost), `unknown cost "${effect.cost}"`);
    assert.equal(typeof effect.source, "string");
    assert.equal(typeof effect.license, "string");
    assert.equal(typeof effect.notes, "string");
    assert.ok(effect.params && typeof effect.params === "object");
  }
});

test("every webgl effect has a valid css or svg fallback", () => {
  const byId = new Map(effects.map((effect) => [effect.id, effect]));
  const webgl = effects.filter((effect) => effect.cost === "webgl");
  assert.ok(webgl.length > 0, "the catalog should contain at least one webgl effect");
  for (const effect of webgl) {
    assert.equal(typeof effect.cpuFallback, "string", `${effect.id} needs a cpuFallback id`);
    const fallback = byId.get(effect.cpuFallback);
    assert.ok(fallback, `${effect.id} fallback "${effect.cpuFallback}" must exist`);
    assert.ok(CPU_COSTS.includes(fallback.cost), `${effect.id} fallback must be css or svg`);
    assert.notEqual(fallback.id, effect.id);
  }
});

test("licences stay inside the allowlist", () => {
  for (const effect of effects) {
    assert.ok(ALLOWED_LICENSES.includes(effect.license), `licence "${effect.license}" is not allowed`);
  }
});

test("defaults sit inside their range", () => {
  for (const effect of effects) {
    for (const [name, spec] of Object.entries(effect.params)) {
      assert.equal(typeof spec.min, "number", `${effect.id}.${name}.min`);
      assert.equal(typeof spec.max, "number", `${effect.id}.${name}.max`);
      assert.ok(spec.min <= spec.max, `${effect.id}.${name} min must not exceed max`);
      assert.ok(spec.default >= spec.min && spec.default <= spec.max, `${effect.id}.${name} default out of range`);
    }
  }
});

test("no effect references an http source or a local path", () => {
  const homeMarker = ["", "home", ""].join("/");
  for (const effect of effects) {
    assert.ok(!effect.source.includes("http://"), `${effect.id} source must be https`);
    assert.ok(!/^[a-z]:[\\/]/i.test(effect.source), `${effect.id} source must not be a local path`);
    assert.ok(!effect.source.includes(homeMarker), `${effect.id} source must not contain a home path`);
  }
});

test("getEffect resolves known ids and returns null otherwise", () => {
  const first = effects[0];
  assert.equal(getEffect(first.id).id, first.id);
  assert.equal(getEffect("no-such-effect"), null);
  assert.equal(getEffect("no-such-effect", effects), null);
});

test("selectEffects filters by family, cost and id", () => {
  const family = effects[0].family;
  const picked = selectEffects({ family }, effects);
  assert.ok(picked.length > 0);
  assert.ok(picked.every((effect) => effect.family === family));
  const cssOnly = selectEffects({ cost: "css" }, effects);
  assert.ok(cssOnly.every((effect) => effect.cost === "css"));
  const one = selectEffects({ ids: [effects[1].id] }, effects);
  assert.equal(one.length, 1);
});

test("listFamilies returns the distinct families", () => {
  const families = listFamilies(effects);
  assert.equal(new Set(families).size, families.length);
  assert.ok(families.includes("grain-texture"));
  assert.ok(families.includes("camera"));
});

test("loadEffects accepts an injected file reader", () => {
  const raw = readFileSync(DEFAULT_EFFECTS_PATH, "utf8");
  const fake = { readFileSync: () => raw };
  const loaded = loadEffects({ fs: fake, path: "ignored.json" });
  assert.deepEqual(loaded.effects, effects);
});

test("loadEffects rejects a malformed catalog", () => {
  const fake = { readFileSync: () => JSON.stringify({ nope: true }) };
  assert.throws(() => loadEffects({ fs: fake, path: "x.json" }), /malformed/);
});

test("validateEffects reports duplicate ids", () => {
  const broken = [effects[0], { ...effects[0] }];
  const result = validateEffects(broken);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => /duplicate effect id/.test(error.message)));
});

test("validateEffects reports an out of range default", () => {
  const broken = [{ ...effects[0], params: { amount: { min: 0, max: 1, default: 5 } } }];
  const result = validateEffects(broken);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => /default must be inside the range/.test(error.message)));
});

test("validateEffects reports a webgl effect without a usable fallback", () => {
  const webgl = effects.find((effect) => effect.cost === "webgl");
  const broken = [
    { ...webgl, cpuFallback: "missing-effect" },
    { ...webgl, id: "other-webgl", cpuFallback: null },
  ];
  const result = validateEffects(broken);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => /does not exist/.test(error.message)));
  assert.ok(result.errors.some((error) => /need a cpuFallback id/.test(error.message)));
});

test("validateEffects rejects a licence outside the allowlist", () => {
  const broken = [{ ...effects[0], license: "GPL-3.0" }];
  const result = validateEffects(broken);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => /license must be one of/.test(error.message)));
});

test("validateEffects rejects a webgl fallback that is also webgl", () => {
  const webglEffects = effects.filter((effect) => effect.cost === "webgl");
  const broken = [
    { ...webglEffects[0], cpuFallback: webglEffects[1].id },
    webglEffects[1],
  ];
  const result = validateEffects(broken);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => /must be a css or svg effect/.test(error.message)));
});

test("the catalog file path is the shipped data file", () => {
  assert.ok(DEFAULT_EFFECTS_PATH.endsWith("scripts/motionkit/data/effects.json"));
  assert.ok(DEFAULT_EFFECTS_PATH.includes("motionkit"));
});
