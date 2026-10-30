// RW-W2: the LTX 2.5 stage-2 refinement schedule and its opt-in A/B.
//
// The graphs default to `0.85, 0.7250, 0.4219, 0.0`, the Comfy-Org built-in template's stage-2
// ManualSigmas value (also used by the open leafreel and openfield graphs). The Lightricks
// advanced example uses `0.909375, 0.725, 0.421875, 0.0`; it is opt-in only, because the
// research review found no authorised clip A/B between the two (docs/research/COMFY_LTX_QUALITY.md).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { STAGE2_SIGMAS, applyStage2SigmasPreset } from "../src/defaults.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const WORKFLOWS = join(HERE, "..", "..", "..", "workflows");

const readJson = (name) => JSON.parse(readFileSync(join(WORKFLOWS, name), "utf8"));

const GRAPHS = ["ltx25_i2v_2stage.api.json", "ltx25_t2v_2stage.api.json", "ltx25_a2v_2stage.api.json"];
const MAPS = [
  "ltx25_i2v_2stage.api.params.json",
  "ltx25_i2v_2stage.upscale.params.json",
  "ltx25_a2v_2stage.api.params.json",
];

function stage2Node(graph) {
  const manual = Object.entries(graph).filter(([, node]) => node.class_type === "ManualSigmas");
  assert.equal(manual.length, 2, "a two-stage graph has a stage-1 and a stage-2 ManualSigmas");
  const [stage2] = manual.filter(([, node]) => Number(String(node.inputs.sigmas).split(",")[0]) < 1);
  assert.ok(stage2, "the stage-2 schedule starts below 1");
  return stage2;
}

test("the template schedule is the default in every two-stage graph", () => {
  for (const name of GRAPHS) {
    const [, node] = stage2Node(readJson(name));
    assert.equal(node.inputs.sigmas, STAGE2_SIGMAS.template, `${name} stage-2 ManualSigmas`);
  }
});

test("each preset schedule starts below 1", () => {
  for (const [preset, sigmas] of Object.entries(STAGE2_SIGMAS)) {
    assert.ok(Number(String(sigmas).split(",")[0]) < 1, `${preset} starts below 1`);
  }
});

test("the template preset leaves params unchanged so the graph default stands", () => {
  const params = { prompt: "a plate" };
  applyStage2SigmasPreset(params, "template");
  assert.deepEqual(params, { prompt: "a plate" });
  assert.equal("stage2_sigmas" in params, false);
  applyStage2SigmasPreset(params);
  assert.equal("stage2_sigmas" in params, false, "template is the default preset");
});

test("lightricks writes its schedule to every params map that maps stage2_sigmas", () => {
  for (const name of MAPS) {
    const mapping = readJson(name);
    const target = mapping.map.stage2_sigmas;
    assert.ok(target, `${name} maps stage2_sigmas`);

    const params = {};
    applyStage2SigmasPreset(params, "lightricks");
    assert.equal(params.stage2_sigmas, STAGE2_SIGMAS.lightricks, `${name} params`);

    const graph = readJson(`${name.replace(".api.params.json", ".api.json").replace(".upscale.params.json", ".api.json")}`);
    const [nodeId, field] = target;
    assert.equal(graph[nodeId].class_type, "ManualSigmas", `${name} maps to a ManualSigmas node`);
    graph[nodeId].inputs[field] = params.stage2_sigmas;
    assert.equal(graph[nodeId].inputs[field], STAGE2_SIGMAS.lightricks, `${name} node ${nodeId}.${field}`);
  }
});

test("t2v has no stage2_sigmas param and stays on the template schedule", () => {
  const mapping = readJson("ltx25_t2v_2stage.api.params.json");
  assert.equal("stage2_sigmas" in mapping.map, false);

  const [, node] = stage2Node(readJson("ltx25_t2v_2stage.api.json"));
  assert.equal(node.inputs.sigmas, STAGE2_SIGMAS.template);
});

test("an unknown preset throws", () => {
  assert.throws(() => applyStage2SigmasPreset({}, "nope"), /unknown/i);
  assert.throws(() => applyStage2SigmasPreset({}, "__proto__"), /unknown/i);
});
