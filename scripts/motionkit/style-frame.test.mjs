// M12 acceptance: deterministic SVG style frames.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { ENERGY_TRANSITIONS } from "../../packages/schema/src/motion.mjs";
import { FONT_IDS, validateRecipe } from "./recipe-schema.mjs";
import assetsData from "./data/assets.json" with { type: "json" };
import {
  FINISH_KIND_BY_ID,
  FINISH_PARAM_SPECS,
  SVG_NAMESPACE,
  escapeXml,
  styleFrame,
} from "./style-frame.mjs";

const MODULE_URL = new URL("./style-frame.mjs", import.meta.url);

function baseRecipe(overrides = {}) {
  return {
    schema: "comfyrizz.recipe/v1",
    id: "swiss-grid",
    label: "Swiss grid",
    taxonomy: { era: "modernist", finish: "clean", energy: "medium", geometry: "flat", type: "grotesk" },
    palette: [
      { role: "background", hex: "#f2f0eb" },
      { role: "text", hex: "#111111" },
      { role: "accent", hex: "#e3241b" },
      { role: "muted", hex: "#9a9a9a" },
    ],
    fonts: { display: "space-grotesk", text: "inter", mono: "jetbrains-mono" },
    easing: { personality: "editorial", entry: "enter", exit: "exit", spring: "settle" },
    entries: ["maskRise", "fadeUp", "waterfall"],
    emphasis: ["keyword", "hero"],
    transitions: { primary: "wipe", accent: ["push", "cut"] },
    storyRecipe: "kinetic",
    background: { pattern: "grid" },
    finish: [{ id: "paper-grain", params: { amount: 0.04 } }],
    rules: { do: ["flush-left headlines on a 12-col grid"], dont: ["centered text", "drop shadows"] },
    prompt: "Swiss International Style poster, strict grid, red accent, flat colour",
    ...overrides,
  };
}

function recipeForTransition(type) {
  const energy = Object.entries(ENERGY_TRANSITIONS).find(([, list]) => list.includes(type))?.[0] ?? "medium";
  return baseRecipe({
    id: `probe-${type}`,
    taxonomy: { era: "probe", finish: "clean", energy, geometry: "flat", type: "grotesk" },
    transitions: { primary: type, accent: [] },
  });
}

function recipeForFinish(id, params) {
  return baseRecipe({ id: `probe-${id}`, finish: [params ? { id, params } : { id }] });
}

/**
 * Minimal XML well-formedness checker: tag balance, quoted attributes and
 * entity-safe text. Deliberately DOM-free so the test runs on bare Node.
 */
function xmlErrors(svg) {
  const errors = [];
  const stack = [];
  const entity = /^&(amp|lt|gt|quot|apos|#x[0-9a-fA-F]+|#\d+);/;
  let i = 0;
  while (i < svg.length) {
    const lt = svg.indexOf("<", i);
    const text = svg.slice(i, lt === -1 ? svg.length : lt);
    let j = 0;
    for (;;) {
      const amp = text.indexOf("&", j);
      if (amp === -1) break;
      const m = entity.exec(text.slice(amp));
      if (!m) {
        errors.push(`unescaped & at offset ${i + amp}`);
        break;
      }
      j = amp + m[0].length;
    }
    if (lt === -1) break;
    if (svg.startsWith("<!--", lt)) {
      const end = svg.indexOf("-->", lt);
      if (end === -1) {
        errors.push("unterminated comment");
        break;
      }
      i = end + 3;
      continue;
    }
    const gt = svg.indexOf(">", lt);
    if (gt === -1) {
      errors.push("unterminated tag");
      break;
    }
    const raw = svg.slice(lt + 1, gt).trim();
    if (raw.startsWith("/")) {
      const name = raw.slice(1).trim();
      const open = stack.pop();
      if (open !== name) errors.push(`close </${name}> does not match <${open ?? "nothing"}>`);
    } else if (raw.endsWith("/")) {
      const name = raw.slice(0, -1).trim().split(/\s/, 1)[0] ?? "";
      if (!/^[A-Za-z_][\w:.-]*$/.test(name)) errors.push(`bad self-closing name "${name}"`);
    } else {
      const name = raw.split(/\s/, 1)[0];
      if (!/^[A-Za-z_][\w:.-]*$/.test(name)) errors.push(`bad tag name "${name}"`);
      stack.push(name);
      const attrStr = raw.slice(name.length);
      const attrRe = /\s+[\w:.-]+\s*=\s*"[^"]*"/g;
      let last = 0;
      let m;
      while ((m = attrRe.exec(attrStr)) !== null) last = m.index + m[0].length;
      const leftover = attrStr.slice(last).trim();
      if (leftover) errors.push(`unparsed attribute text in <${name}>: ${leftover}`);
    }
    i = gt + 1;
  }
  if (stack.length) errors.push(`unclosed tags: ${stack.join(", ")}`);
  return errors;
}

function assertWellFormed(svg) {
  const errors = xmlErrors(svg);
  assert.deepEqual(errors, [], `SVG is not well-formed: ${errors.join("; ")}`);
}

function count(haystack, needle) {
  return haystack.split(needle).length - 1;
}

test("fixtures themselves satisfy the M01 recipe contract", () => {
  assert.equal(validateRecipe(baseRecipe()).ok, true);
  for (const type of Object.keys(ENERGY_TRANSITIONS).flatMap((e) => ENERGY_TRANSITIONS[e])) {
    const result = validateRecipe(recipeForTransition(type));
    assert.equal(result.ok, true, `${type}: ${JSON.stringify(result.errors)}`);
  }
});

test("same input yields the same SVG bytes", () => {
  const recipe = baseRecipe();
  const a = styleFrame(recipe);
  const b = styleFrame(recipe);
  const c = styleFrame(recipe, {});
  assert.equal(a, b);
  assert.equal(a, c);
  assert.equal(a, styleFrame(recipe, { text: undefined, width: undefined, height: undefined }));
});

test("option key order does not change the output", () => {
  const recipe = baseRecipe();
  const a = styleFrame(recipe, { width: 320, height: 180, text: "Hello" });
  const b = styleFrame(recipe, { text: "Hello", height: 180, width: 320 });
  assert.equal(a, b);
});

test("rendering does not mutate the recipe input", () => {
  const recipe = baseRecipe();
  const snapshot = JSON.stringify(recipe);
  styleFrame(recipe);
  styleFrame(recipe, { width: 640, height: 360, text: "Other", seed: 7 });
  assert.equal(JSON.stringify(recipe), snapshot);
});

test("output parses as XML with a minimal checker", () => {
  assertWellFormed(styleFrame(baseRecipe()));
  assertWellFormed(styleFrame(baseRecipe({ background: { pattern: "mesh" } })));
  assertWellFormed(styleFrame({}));
  assertWellFormed(styleFrame(null));
  assertWellFormed(styleFrame("junk"));
  assertWellFormed(styleFrame(baseRecipe(), { width: 640, height: 360, text: "A longer headline for the frame" }));
});

test("headline and label text are XML-escaped", () => {
  const hostile = 'R&D <script> "quoted" \'single\'';
  const svg = styleFrame(baseRecipe(), { text: hostile });
  assert.ok(svg.includes("R&amp;D &lt;script&gt; &quot;quoted&quot; &apos;single&apos;"), "escaped headline missing");
  assert.ok(!svg.includes("<script>"), "raw angle brackets leaked into the document");
  assert.ok(!svg.includes('"quoted"'), "raw double quotes leaked into text content");
  assertWellFormed(svg);

  const label = styleFrame(baseRecipe({ label: 'Look <&" 1>' }));
  assert.ok(label.includes("Look &lt;&amp;&quot; 1&gt;"));
  assertWellFormed(label);
  assert.equal(escapeXml("a&b"), "a&amp;b");
});

test("the only http reference is the SVG namespace", () => {
  for (const recipe of [baseRecipe(), baseRecipe({ background: { pattern: "dots" } }), {}]) {
    const svg = styleFrame(recipe);
    const urls = svg.match(/https?:\/\/[^\s"'<>]+/g) ?? [];
    assert.deepEqual(urls, [SVG_NAMESPACE], `unexpected external refs: ${urls.join(", ")}`);
    assert.ok(!svg.includes("https://"));
  }
});

test("every url(#id) reference resolves inside the document", () => {
  const svg = styleFrame(baseRecipe({ background: { pattern: "mesh" } }));
  const ids = new Set([...svg.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
  const refs = [...svg.matchAll(/url\(#([^)]+)\)/g)].map((m) => m[1]);
  assert.ok(refs.length > 0, "expected at least one internal reference");
  for (const ref of refs) assert.ok(ids.has(ref), `dangling reference url(#${ref})`);
});

test("headline uses the display font via font-family attribute only", () => {
  const svg = styleFrame(baseRecipe());
  assert.ok(svg.includes('data-part="headline"'), "headline missing");
  const headline = svg.match(/<text[^>]*data-part="headline"[^>]*>([^<]*)<\/text>/);
  assert.ok(headline, "headline text node missing");
  assert.ok(svg.includes('font-family="Space Grotesk"'), "display family name missing");
  assert.ok(!svg.includes("font-face"), "font-face rules are not allowed");
  assert.ok(!svg.includes("@import"), "external imports are not allowed");
});

test("every background pattern renders its own layer", () => {
  const markers = {
    gradient: "url(#bg-gradient--",
    grid: "url(#bg-grid--",
    dots: "url(#bg-dots--",
    grain: "feTurbulence",
    mesh: "bg-mesh-a--",
  };
  for (const [pattern, marker] of Object.entries(markers)) {
    const svg = styleFrame(baseRecipe({ background: { pattern } }));
    assert.ok(svg.includes(`data-pattern="${pattern}"`), `${pattern}: pattern group missing`);
    assert.ok(svg.includes(marker), `${pattern}: expected marker ${marker}`);
    assertWellFormed(svg);
  }
  // An unknown pattern falls back to the first schema pattern.
  const fallback = styleFrame(baseRecipe({ background: { pattern: "plaid" } }));
  assert.ok(fallback.includes('data-pattern="gradient"'));
});

test("palette blocks cover the recipe palette", () => {
  const recipe = baseRecipe({
    palette: [
      { role: "background", hex: "#FFFFFF" },
      { role: "text", hex: "#000000" },
      { role: "accent", hex: "#AA0044" },
      { role: "muted", hex: "#8899AA" },
      { role: "extra", hex: "#123456" },
    ],
  });
  const svg = styleFrame(recipe);
  assert.equal(count(svg, 'data-part="swatch"'), 5);
  assert.ok(svg.includes('fill="#ffffff"'), "hex values are normalised to lowercase");
  assert.ok(svg.includes('fill="#aa0044"'));
  assert.ok(svg.includes('data-role="accent"'));
});

test("the first finish effect is rendered as CSS/SVG", () => {
  const grain = styleFrame(recipeForFinish("film-grain"));
  assert.ok(grain.includes('data-finish="grain"'));
  assert.ok(grain.includes("feTurbulence"), "grain needs feTurbulence");
  assertWellFormed(grain);

  const vignette = styleFrame(recipeForFinish("vignette-soft"));
  assert.ok(vignette.includes('data-finish="vignette"'));
  assert.ok(vignette.includes("radialGradient"), "vignette needs a radial gradient");
  assertWellFormed(vignette);

  const scanlines = styleFrame(recipeForFinish("scanlines"));
  assert.ok(scanlines.includes('data-finish="scanlines"'));
  assert.ok(scanlines.includes('fill-opacity="0.35"'), "scanline opacity comes from the effect params");
  assertWellFormed(scanlines);

  const duotone = styleFrame(recipeForFinish("duotone"));
  assert.ok(duotone.includes('data-finish="duotone"'));
  assert.ok(duotone.includes('feColorMatrix type="matrix"'), "duotone needs a colour matrix");
  assert.ok(duotone.includes('filter="url(#finish-duotone--'), "duotone filters the whole frame");
  assertWellFormed(duotone);
});

test("other finish families map to a faithful cheap representation", () => {
  const cases = {
    halftone: "patternTransform",
    "chroma-shift": "feOffset",
    "motion-smear": "feGaussianBlur",
    bloom: 'data-finish="glow"',
    "hard-shadow": 'data-finish="shadow"',
  };
  for (const [id, marker] of Object.entries(cases)) {
    const svg = styleFrame(recipeForFinish(id));
    assert.ok(svg.includes(marker), `${id}: expected ${marker}`);
    assertWellFormed(svg);
  }
  // Shadow kind draws an offset copy of the headline.
  const shadow = styleFrame(recipeForFinish("soft-shadow"));
  const plain = styleFrame(recipeForFinish("bloom"));
  assert.equal(count(shadow, ">Swiss grid<"), count(plain, ">Swiss grid<") + 1, "shadow kind should duplicate the headline once");
  // An unknown id falls back to grain so a frame never renders finish-less.
  assert.ok(styleFrame(recipeForFinish("not-a-real-effect")).includes('data-finish="grain"'));
});

test("finish params from the recipe are honoured and clamped", () => {
  const finishLine = (svg) => svg.split("\n").find((line) => line.includes('data-part="finish"')) ?? "";
  const strong = styleFrame(recipeForFinish("film-grain", { amount: 0.9, size: 1 }));
  const mild = styleFrame(recipeForFinish("film-grain", { amount: 0.05, size: 1 }));
  assert.match(finishLine(strong), /opacity="0\.9"/);
  assert.match(finishLine(mild), /opacity="0\.05"/);
  assert.notEqual(strong, mild);
  const clamped = styleFrame(recipeForFinish("film-grain", { amount: 99, size: -3 }));
  assert.match(finishLine(clamped), /opacity="1"/, "amount is clamped to the catalog range");
  assert.match(clamped, /baseFrequency="1\.8"/, "size is clamped and drives the noise frequency");
  assertWellFormed(clamped);
});

test("every schema transition type gets a glyph", () => {
  const types = ["none", "cut", "fade", "blur", "slide", "push", "wipe", "zoom", "iris", "paper-reveal", "draw-reveal", "shape-reveal"];
  for (const type of types) {
    const svg = styleFrame(recipeForTransition(type));
    assert.ok(svg.includes(`data-glyph="${type}"`), `glyph missing for ${type}`);
    assert.ok(svg.includes(`data-part="transition-label">${type}<`), `caption missing for ${type}`);
    assertWellFormed(svg);
  }
});

test("width and height options reshape the frame", () => {
  const svg = styleFrame(baseRecipe(), { width: 640, height: 360 });
  assert.ok(svg.includes('viewBox="0 0 640 360"'));
  assert.ok(svg.includes('width="640" height="360"'));
  assertWellFormed(svg);
  const tiny = styleFrame(baseRecipe(), { width: 80, height: 70 });
  assert.ok(tiny.includes('viewBox="0 0 80 70"'));
  assertWellFormed(tiny);
});

test("text option overrides the headline and the default is the label", () => {
  const recipe = baseRecipe();
  const custom = styleFrame(recipe, { text: "Custom words" });
  assert.ok(custom.includes(">Custom words<"));
  const dflt = styleFrame(recipe);
  assert.ok(dflt.includes(">Swiss grid<"));
  assert.equal(styleFrame({}), styleFrame({}));
});

test("the seed option is deterministic for grain frames", () => {
  const recipe = recipeForFinish("film-grain");
  const one = styleFrame(recipe, { seed: 11 });
  const two = styleFrame(recipe, { seed: 22 });
  assert.equal(one, styleFrame(recipe, { seed: 11 }));
  assert.notEqual(one, two);
  assertWellFormed(one);
});

test("def ids are slug-scoped so gallery frames cannot collide when inlined", () => {
  const a = styleFrame(baseRecipe({ id: "swiss-grid" }));
  const b = styleFrame(baseRecipe({ id: "cinematic-noir" }));
  const idsA = new Set([...a.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
  const idsB = [...b.matchAll(/id="([^"]+)"/g)].map((m) => m[1]);
  for (const id of idsB) assert.ok(!idsA.has(id), `id ${id} collides across frames`);
});

test("finish kind map only names real catalog effects and defaults sit in range", () => {
  const catalog = JSON.parse(readFileSync(new URL("./data/effects.json", import.meta.url), "utf8"));
  const byId = new Map(catalog.effects.map((effect) => [effect.id, effect]));
  for (const [id, kind] of Object.entries(FINISH_KIND_BY_ID)) {
    const effect = byId.get(id);
    assert.ok(effect, `unknown effect id in kind map: ${id}`);
    const spec = FINISH_PARAM_SPECS[kind];
    assert.ok(spec, `unknown finish kind "${kind}" for ${id}`);
    for (const [name, [, , dflt]] of Object.entries(spec)) {
      const declared = effect.params[name];
      if (!declared) continue;
      assert.ok(dflt >= declared.min && dflt <= declared.max, `${kind}.${name} default ${dflt} outside ${id} range`);
    }
  }
});

test("every recipe font id resolves to a hyphen-free family name", () => {
  const manifest = new Map((assetsData.fonts ?? []).map((font) => [font.id, font.name]));
  for (const id of FONT_IDS) {
    const svg = styleFrame(baseRecipe({ fonts: { display: id, text: id } }));
    const families = [...svg.matchAll(/font-family="([^"]+)"/g)].map((m) => m[1]);
    assert.equal(families.length, 4, `all four text nodes should carry the family for ${id}`);
    for (const family of families) {
      assert.ok(family.length > 0);
      assert.ok(!family.includes("-"), `family "${family}" still looks like a font id`);
      if (manifest.has(id)) assert.equal(family, manifest.get(id));
    }
  }
});

test("module source stays pure: no randomness, clock, network or machine paths", () => {
  const source = readFileSync(MODULE_URL, "utf8");
  assert.ok(!source.includes("Math.random"), "Math.random would break determinism");
  assert.ok(!source.includes("process."), "no process access");
  assert.ok(!/\bDate\b/.test(source), "no clock");
  assert.ok(!source.includes("fetch"), "no network");
  assert.ok(!source.includes("require("), "ESM only");
  assert.doesNotMatch(source, /https:\/\//);
  const httpRefs = source.match(/http:\/\/[^\s"'`]+/g) ?? [];
  assert.deepEqual(httpRefs, [SVG_NAMESPACE]);
  for (const forbidden of ["/home", "/workspace", "C:\\\\", "tailnet", "SECRET", "TOKEN", "API_KEY"]) {
    assert.ok(!source.includes(forbidden), `source must not contain ${forbidden}`);
  }
});
