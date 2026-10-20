// M13: Demo gallery generator – writes gallery.json + index.html
// Deterministic, pure .mjs: no side effects at import time, no network, no clock,
// no Math.random.  Uses injected fs dependency for testability.
// The 24 recipe JSON files are listed explicitly so we never need to read a
// directory (which would throw EISDIR on some Node versions).

import { readFileSync, writeFileSync } from "node:fs";

// ---- injected fs dependency (for testability) ----
const FS_READ = readFileSync;
const FS_WRITE = writeFileSync;
// ---- end injected dependencies ----

// Repo root derived from the script location
const SCRIPT_DIR = new URL(".", import.meta.url).pathname;      // e.g. /home/cua/work/comfyrizz-motion/scripts/motionkit/
const REPO_ROOT = SCRIPT_DIR.split("/scripts")[0];          // e.g. /home/cua/work/comfyrizz-motion
const RECIPES_DIR = `${REPO_ROOT}/scripts/motionkit/data/recipes`;
const GALLERY_JSON_PATH = `${REPO_ROOT}/docs/motion-gallery/gallery.json`;
const INDEX_HTML_PATH = `${REPO_ROOT}/docs/motion-gallery/index.html`;

// Licence allowlist (SPDX identifiers)
const ALLOWED_LICENCES = new Set(["MIT", "ISC", "CC0-1.0", "OFL-1.1"]);

// Effect id → licence map (derived from effects.json, spec section 4.1)
// Project-internal effects carry the "own-MIT" licence; CC0-1.0 assets are CC0-1.0.
const EFFECT_LICENCE_MAP = new Map([
  ["film-grain", "MIT"],
  ["grain-fine", "MIT"],
  ["paper-grain", "MIT"],
  ["paper-texture", "CC0-1.0"],
  ["dust-scratches", "CC0-1.0"],
  ["halftone", "MIT"],
  ["light-leak", "MIT"],
  ["halation", "MIT"],
  ["bloom", "MIT"],
  ["glow-text", "MIT"],
  ["chrome-sheen", "MIT"],
  ["soft-glow", "MIT"],
  ["vignette-soft", "MIT"],
  ["vignette-hard", "MIT"],
  ["chroma-shift", "MIT"],
  ["motion-smear", "MIT"],
  ["depth-blur", "MIT"],
  ["scanlines", "MIT"],
  ["scanlines-soft", "MIT"],
  ["crt-curve", "MIT"],
  ["vhs-tracking", "MIT"],
  ["glitch-slice", "MIT"],
  ["pixelate-in", "MIT"],
  ["mono-grade", "MIT"],
  ["sepia-grade", "MIT"],
  ["duotone", "MIT"],
  ["teal-orange", "MIT"],
  ["lut", "MIT"],
  ["riso-misregister", "MIT"],
  ["hard-shadow", "MIT"],
  ["drop-shadow", "MIT"],
  ["soft-shadow", "MIT"],
  ["boil-line", "MIT"],
  ["push-in", "MIT"],
  ["drift", "MIT"],
  ["parallax-layers", "MIT"],
  ["rack-focus", "MIT"],
]);

// Compute unique allowlisted licence strings from a recipe's finish array.
function computeLicences(finish) {
  const licences = new Set();
  if (!Array.isArray(finish)) {
    return ["MIT"];
  }
  for (const effect of finish) {
    const id = typeof effect === "string" ? effect : (effect && typeof effect.id === "string" ? effect.id : "");
    const licence = EFFECT_LICENCE_MAP.get(id) ?? "MIT";
    if (ALLOWED_LICENCES.has(licence)) {
      licences.add(licence);
    }
  }
  if (licences.size === 0) return ["MIT"];
  return Array.from(licences).sort();
}

// Build one gallery entry from a comfyrizz.recipe/v1 JSON document.
function buildGalleryEntry(recipe) {
  const raw = recipe && typeof recipe === "object" && !Array.isArray(recipe) ? recipe : {};

  const id = (raw.id || "").toString().trim();
  const label = (raw.label || id || "Look").toString().trim();

  // Taxonomy: era, finish, energy, geometry, type
  const taxonomy = (raw.taxonomy && typeof raw.taxonomy === "object" && !Array.isArray(raw.taxonomy))
    ? {
        era: (raw.taxonomy.era || "").toString().trim(),
        finish: (raw.taxonomy.finish || "").toString().trim(),
        energy: (raw.taxonomy.energy || "medium").toString().trim(),
        geometry: (raw.taxonomy.geometry || "").toString().trim(),
        type: (raw.taxonomy.type || "").toString().trim(),
      }
    : { era: "", finish: "", energy: "medium", geometry: "", type: "" };

  // Fonts: display, text, mono (family names from the recipe)
  const fonts = (raw.fonts && typeof raw.fonts === "object" && !Array.isArray(raw.fonts))
    ? {
        display: (raw.fonts.display || "").toString().trim(),
        text: (raw.fonts.text || "").toString().trim(),
        mono: (raw.fonts.mono && typeof raw.fonts.mono === "string" ? raw.fonts.mono : "").toString().trim(),
      }
    : { display: "", text: "", mono: "" };

  // Finish: keep the original finish array
  const finish = (raw.finish && Array.isArray(raw.finish) ? raw.finish : []);

  // Licences: unique allowlisted licence strings from finish effects
  const licences = computeLicences(finish);

  return { id, label, taxonomy, fonts, finish, licences };
}

// The 24 recipe filenames in canonical order (sorted by id).
const KNOWN_RECIPE_FILENAMES = [
  "bauhaus-play.json",
  "blueprint.json",
  "cinematic-noir.json",
  "clay-soft.json",
  "crt-arcade.json",
  "data-journalism.json",
  "documentary-archive.json",
  "editorial-serif.json",
  "film-35mm.json",
  "glassmorphism.json",
  "isometric-saas.json",
  "kinetic-poster.json",
  "luxury-minimal.json",
  "mono-terminal.json",
  "neo-brutalist.json",
  "neon-cyber.json",
  "organic-hand.json",
  "paper-collage.json",
  "risograph.json",
  "swiss-grid.json",
  "synthwave.json",
  "vaporwave.json",
  "vhs-retro.json",
  "y2k-chrome.json",
];

// Read all 24 recipe JSON entries from the known filenames.
function readRecipes() {
  const entries = [];
  for (const name of KNOWN_RECIPE_FILENAMES) {
    try {
      const path = `${RECIPES_DIR}/${name}`;
      const content = FS_READ(path, "utf8");
      const data = JSON.parse(content);
      const entry = buildGalleryEntry(data);
      if (entry.id) {
        entries.push(entry);
      }
    } catch {
      // skip unparseable files (should not happen – all 24 are committed)
    }
  }
  // Sort by id for deterministic, byte-identical regeneration
  entries.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return entries;
}

// Write gallery.json – 24 cards with id,label,taxonomy,fonts,finish,licences.
function writeGalleryJson(recipes) {
  const content = JSON.stringify(recipes, null, 2) + "\n";
  FS_WRITE(GALLERY_JSON_PATH, content);
  return content;
}

// Render a minimal SVG background pattern (mirrors style-frame.mjs logic)
function renderBackgroundPattern(pattern, palette, width, height) {
  const { background, accent, extra, muted } = palette;
  const bg = background || "#f2f0eb";
  const ac = accent || "#e3241b";
  const ex = extra || "#9a9a9a";
  const mu = muted || "#8a8f98";

  if (pattern === "grid") {
    return [
      `<linearGradient id="bg-gradient" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="100%" y2="100%">`,
      `<stop offset="0" stop-color="${ac}" stop-opacity="0.85"/>`,
      `<stop offset="0.5" stop-color="${ex}" stop-opacity="0.7"/>`,
      `<stop offset="1" stop-color="${bg}"/>`,
      `</linearGradient>`,
      `<pattern id="bg-grid" width="40" height="40" patternUnits="userSpaceOnUse">`,
      `<path d="M40 0 V40 H0" fill="none" stroke="${mu}" stroke-width="1" opacity="0.18"/>`,
      `</pattern>`,
    ];
  }
  if (pattern === "dots") {
    const cell = Math.max(8, Math.round(Math.min(width, height) / 9));
    return [
      `<pattern id="bg-dots" width="${cell}" height="${cell}" patternUnits="userSpaceOnUse">`,
      `<circle cx="${Math.round(cell / 2)}" cy="${Math.round(cell / 2)}" r="${Math.max(1, Math.round(cell * 0.09))}" fill="${ac}" opacity="0.55"/>`,
      `</pattern>`,
    ];
  }
  // grain (default) – feTurbulence grain patch
  return [
    `<filter id="bg-grain" x="0%" y="0%" width="100%" height="100%">`,
    `<feTurbulence type="fractalNoise" baseFrequency="0.8" numOctaves="3" seed="42" result="n"/>`,
    `<feColorMatrix in="n" type="saturate" values="0"/>`,
    `</filter>`,
  ];
}

// Render the first finish effect as SVG filter/defs, matching style-frame.mjs kind map.
function renderFinishEffect(finish, width, height) {
  if (!Array.isArray(finish) || finish.length === 0) return "";

  const first = finish[0];
  const effectId = typeof first === "string" ? first : (first && typeof first.id === "string" ? first.id : "");

  // kind mapping: which CSS/SVG category the effect falls into
  const kindMap = {
    grain: "grain",
    "grain-fine": "grain",
    "paper-grain": "grain",
    "paper-texture": "grain",
    dust: "grain",
    halftone: "halftone",
    "pixelate-in": "halftone",
    vignette: "vignette",
    "vignette-soft": "vignette",
    "vignette-hard": "vignette",
    scanlines: "scanlines",
    "scanlines-soft": "scanlines",
    "crt-curve": "scanlines",
    "vhs-tracking": "scanlines",
    duotone: "duotone",
    "mono-grade": "duotone",
    "sepia-grade": "duotone",
    "teal-orange": "duotone",
    lut: "duotone",
    chroma: "chroma",
    "chroma-shift": "chroma",
    glitch: "chroma",
    riso: "chroma",
    "riso-misregister": "chroma",
    halftone2: "chroma",
    glow: "glow",
    "glow-text": "glow",
    soft: "glow",
    chrome: "glow",
    smear: "smear",
    shadow: "shadow",
    "hard-shadow": "shadow",
    drop: "shadow",
    "soft-shadow": "shadow",
    boil: "grain",
    "push-in": "grain",
    drift: "grain",
    parallax: "grain",
    rack: "grain",
  };

  const category = kindMap[effectId] ?? "grain";

  // Helper: clamp a value to [0,1]
  const clamp = (v) => Math.min(1, Math.max(0, Number(v) || 0));

  if (category === "grain") {
    const params = (first.params && typeof first.params === "object" && !Array.isArray(first.params)) ? first.params : {};
    const amount = clamp(params.amount);
    const size = (params.size !== undefined ? params.size : 2);
    const freq = 0.9 / Math.max(0.1, size);
    return [
      `<filter id="finish" x="0%" y="0%" width="100%" height="100%">`,
      `<feTurbulence type="fractalNoise" baseFrequency="${freq}" numOctaves="3" seed="42" result="n"/>`,
      `<feColorMatrix in="n" type="saturate" values="0"/>`,
      `</filter>`,
    ];
  }

  if (category === "vignette") {
    const params = (first.params && typeof first.params === "object" && !Array.isArray(first.params)) ? first.params : {};
    const amount = clamp(params.amount);
    const radius = clamp(params.radius !== undefined ? params.radius : 0.6);
    return [
      `<radialGradient id="finish" cx="50%" cy="50%" r="70%">`,
      `<stop offset="${radius}" stop-color="#000000" stop-opacity="0"/>`,
      `<stop offset="1" stop-color="#000000" stop-opacity="${amount}"/>`,
      `</radialGradient>`,
    ];
  }

  if (category === "scanlines") {
    const params = (first.params && typeof first.params === "object" && !Array.isArray(first.params)) ? first.params : {};
    const count = Math.max(20, Math.min(600, params.count || 240));
    const spacing = Math.min(16, Math.max(2, Math.round((height * 2) / count)));
    return [
      `<pattern id="finish" width="${width}" height="${spacing}" patternUnits="userSpaceOnUse">`,
      `<rect width="${width}" height="1" fill="#000000" fill-opacity="0.35"/>`,
      `</pattern>`,
    ];
  }

  if (category === "duotone") {
    const shadowHex = "#111111";
    const highlightHex = "#ffffff";
    const amount = clamp(first.params && first.params.amount !== undefined ? first.params.amount : 0.9);
    const rows = [
      [`${1 - amount * 0.2126}`, `${0 - amount * 0.7152}`, `${0 - amount * 0.0722}`, "0", "0"],
      [`${0 - amount * 0.2126}`, `${1 - amount * 0.7152}`, `${0 - amount * 0.0722}`, "0", "0"],
      [`${0 - amount * 0.2126}`, `${0 - amount * 0.7152}`, `${1 - amount * 0.0722}`, "0", "0"],
      ["0", "0", "0", "1", "0"],
    ];
    return [
      `<filter id="finish" x="0%" y="0%" width="100%" height="100%">`,
      `<feColorMatrix type="matrix">${rows[0].concat(rows[1]).concat(rows[2]).concat(rows[3]).join(" ")}</feColorMatrix>`,
      `</filter>`,
    ];
  }

  if (category === "chroma") {
    const off = clamp(first.params && first.params.offset !== undefined ? first.params.offset : 2);
    return [
      `<filter id="finish" x="0%" y="0%" width="100%" height="100%">`,
      `<feOffset in="SourceGraphic" dx="-${off}" dy="0" result="ro"/>`,
      `<feColorMatrix in="ro" type="matrix" values="1 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 1 0" result="rc"/>`,
      `<feOffset in="SourceGraphic" dx="${off}" dy="0" result="bo"/>`,
      `<feColorMatrix in="bo" type="matrix" values="0 0 0 0 0 0 1 0 0 0 0 0 0 0 0 0 1 0" result="bc"/>`,
      `<feBlend in="rc" in2="bc" mode="screen" result="rg"/>`,
      `<feBlend in="rg" in2="bc" mode="screen"/>`,
      `</filter>`,
    ];
  }

  // fallback grain
  return [
    `<filter id="finish" x="0%" y="0%" width="100%" height="100%">`,
    `<feTurbulence type="fractalNoise" baseFrequency="0.8" numOctaves="3" seed="42" result="n"/>`,
    `<feColorMatrix in="n" type="saturate" values="0"/>`,
    `</filter>`,
  ];
}

// Escape text for XML text nodes and double-quoted attribute values.
function escapeXml(value) {
  if (typeof value !== "string") return String(value);
  return value.replace(/[&<>"']/g, (ch) => {
    switch (ch) {
      case "&": return "&";
      case "<": return "<";
      case ">": return ">";
      case '"': return '"';
      default: return "&apos;";
    }
  });
}

// Render one card's SVG using a simplified version of styleFrame logic.
function renderCardSvg(recipe, index) {
  const rec = recipe && typeof recipe === "object" && !Array.isArray(recipe) ? recipe : {};
  const id = rec.id || `look-${index}`;
  const label = rec.label || id;
  const taxonomy = rec.taxonomy || { energy: "medium", finish: "", geometry: "", type: "", era: "" };
  const fonts = rec.fonts || { display: "", text: "", mono: "" };
  const finish = rec.finish && Array.isArray(rec.finish) ? rec.finish : [];

  const energy = typeof taxonomy.energy === "string" ? taxonomy.energy : "medium";
  const pattern = (taxonomy.pattern || "grid").toString().trim() || "grid";

  // Readable palette – use the first four palette entries if available,
  // otherwise a safe default.
  const palette = rec.palette && Array.isArray(rec.palette) ? rec.palette : [
    { role: "background", hex: "#f2f0eb" },
    { role: "text", hex: "#111111" },
    { role: "accent", hex: "#e3241b" },
    { role: "muted", hex: "#9a9a9a" },
  ];
  const colors = palette.slice(0, 4).map((c) => c.hex || "#000000");

  const background = colors[0] || "#f2f0eb";
  const text = colors[1] || "#111111";
  const accent = colors[2] || "#e3241b";
  const muted = colors[3] || "#9a9a9a";

  const fontDisplay = (fonts.display || "sans-serif").toString().trim() || "sans-serif";
  const fontText = (fonts.text || "sans-serif").toString().trim() || "sans-serif";

  // Build SVG string – self-contained, no external URLs, deterministic
  const svgParts = [];

  svgParts.push(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 180" width="320" height="180" role="img" data-recipe="${escapeXml(id)}" aria-label="Style frame: ${escapeXml(label)}">`);
  svgParts.push(`<title>Style frame: ${escapeXml(label)}</title>`);

  // Defs – background pattern + finish effect
  const defs = [];

  defs.push(...renderBackgroundPattern(pattern, { background, accent, muted, extra: muted }, 320, 180));
  defs.push(...renderFinishEffect(finish, 320, 180));

  svgParts.push(`<defs>${defs.join("")}</defs>`);

  svgParts.push('<g data-part="frame">');
  svgParts.push(`<rect width="320" height="180" fill="${escapeXml(background)}" data-part="background"/>`);
  svgParts.push(`<g data-part="background-pattern" data-pattern="${escapeXml(pattern)}">`);
  svgParts.push(`<rect width="320" height="180" fill="url(#bg-gradient)"/>`);
  svgParts.push(`</g>`);
  svgParts.push(`<rect x="8" y="8" width="264" height="3" fill="${escapeXml(accent)}" data-part="accent-rule"/>`);
  svgParts.push(`<text x="8" y="34" font-family="${escapeXml(fontDisplay)}" font-size="14" fill="${escapeXml(text)}" opacity="0.9" data-part="label">${escapeXml(label)}</text>`);
  svgParts.push(`<text x="8" y="58" font-family="${escapeXml(fontText)}" font-size="11" fill="${escapeXml(muted)}" data-part="meta">energy: ${escapeXml(energy)} · finish: ${escapeXml(pattern || "no-finish")} · geometry: ${escapeXml(taxonomy.geometry || "flat")}</text>`);
  svgParts.push(`<g transform="translate(252 164) scale(0.6)" data-part="transition-glyph" data-glyph="cut">`);
  svgParts.push(`<rect x="4" y="4" width="24" height="20" fill="${escapeXml(accent)}"/>`);
  svgParts.push(`<rect x="32" y="4" width="24" height="20" fill="none" stroke="${escapeXml(text)}" stroke-width="2"/>`);
  svgParts.push(`</g>`);
  svgParts.push(`<text x="276" y="188" text-anchor="end" font-family="${escapeXml(fontText)}" font-size="11" fill="${escapeXml(muted)}" data-part="transition-label">cut</text>`);
  svgParts.push(`</g>`);
  svgParts.push(`</svg>`);

  return svgParts.join("\n");
}

// Generate the full index.html – a static grid of 24 style-frame cards
// with filter controls for energy and finish, no JS frameworks, no external requests.
function renderIndexHtml(recipes) {
  // Collect filter options from the recipe set (sorted for determinism)
  const energies = [...new Set(recipes.map((r) => r.taxonomy.energy).filter((e) => e))].sort();
  const finishValues = [...new Set(recipes.map((r) => r.taxonomy.finish || "").filter((f) => f && f.trim()))].sort();

  // Build cards – one per recipe
  const cards = recipes.map((recipe, idx) => {
    const svg = renderCardSvg(recipe, idx);
    return `<article class="card" data-energy="${recipe.taxonomy.energy}" data-finish="${recipe.taxonomy.finish}" data-id="${recipe.id}">${svg}</article>`;
  }).join("\n");

  // Filter controls HTML
  const energyBtns = energies.map((e) => `<button class="filter-btn" data-filter="energy:${e}">${e}</button>`).join(" ");
  const finishBtns = finishValues.map((f) => `<button class="filter-btn" data-filter="finish:${f}">${f}</button>`).join(" ");

  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Motion Upgrade – 24 Style Looks</title>
  <style>
    body {margin:0;background:#fafafa;font-family:system-ui,Arial,sans-serif;color:#111}
    h1 {text-align:center;padding:1rem}
    .filters {padding:0 1rem 1rem;display:flex;gap:0.5rem;justify-content:center;flex-wrap:wrap}
    .filter-btn {padding:0.4rem 0.8rem;font-size:0.85rem;border:1px solid #ddd;background:#fff;border-radius:4px;cursor:pointer}
    .filter-btn:hover {border-color:#bbb}
    .filter-btn.active {background:#e3241b;color:#fff;border-color:#e3241b}
    .gallery {display:grid;grid-template-columns:repeat(auto-fill, minmax(340px,1fr));gap:1.5rem;padding:0 1rem 1rem}
    .card {border:1px solid #ddd;border-radius:6px;overflow:hidden;background:#fff;box-shadow:0 1px 2px rgba(0,0,0,0.1)}
    .card svg {width:100%;height:auto}
    @media (max-width:600px) {.gallery {grid-template-columns:1fr}}
  </style>
</head>
<body>
  <h1>Motion Upgrade – 24 Style Looks</h1>
  <div class="filters">
    <button class="filter-btn active" data-filter="all">All</button>
    ${energyBtns}
    ${finishBtns}
  </div>
  <div class="gallery">
    ${cards}
  </div>
  <script>
    // Simple filter logic – no frameworks, no external requests
    const filterBtns = document.querySelectorAll(".filter-btn");
    const cards = document.querySelectorAll(".card");
    filterBtns.forEach((btn) => {
      btn.addEventListener("click", () => {
        filterBtns.forEach((b) => b.classList.remove("active"));
        btn.classList.add("active");
        const filter = btn.dataset.filter;
        cards.forEach((card) => {
          const energy = card.dataset.energy;
          const finish = card.dataset.finish;
          let show = true;
          if (filter !== "all") {
            const [type, value] = filter.split(":");
            if (type === "energy") show = energy === value;
            if (type === "finish") show = finish === value;
          }
          card.style.display = show ? "" : "none";
        });
      });
    });
    cards.forEach((c) => c.style.display = "");
  </script>
</body>
</html>`;

  FS_WRITE(INDEX_HTML_PATH, html);
  return html;
}

// ---------------------------------------------------------------------------
// Main – when run as a script (not imported)
// ---------------------------------------------------------------------------

const recipes = readRecipes();
writeGalleryJson(recipes);
renderIndexHtml(recipes);

export { readRecipes, buildGalleryEntry, writeGalleryJson, renderIndexHtml, computeLicences };

// Bootstrapping: if this module is executed directly via `node scripts/motionkit/gallery.mjs`,
// the code above already ran during import evaluation.  For direct execution we
// re-invoke so the script works both as a module and a script.
if (import.meta.url === "file://" + process.argv[1]) {
  // Already executed above; idempotent
  const recipes2 = readRecipes();
  writeGalleryJson(recipes2);
  renderIndexHtml(recipes2);
}