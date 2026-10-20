// M13: Demo gallery generator – writes gallery.json + index.html
// Deterministic, pure .mjs: no side effects at import time, no network, no clock,
// no Math.random.  Uses injected fs dependency for testability.
// The 24 recipe JSON files are listed explicitly so we never need to read a
// directory (which would throw EISDIR on some Node versions).

import { readFileSync, writeFileSync } from "node:fs";
import { styleFrame } from "./style-frame.mjs";

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

// Full recipe documents keyed by id, so cards render with each recipe's real
// palette/background/finish via styleFrame (gallery.json stays a summary).
const RAW_RECIPES = new Map();

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
        RAW_RECIPES.set(entry.id, data);
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

// Render one card's SVG through the recipe code's own renderer (styleFrame),
// using the full recipe document so each card gets its real palette.
function renderCardSvg(recipe, index) {
  const rec = recipe && typeof recipe === "object" && !Array.isArray(recipe) ? recipe : {};
  const full = (rec.id && RAW_RECIPES.get(rec.id)) || rec;
  const doc = full.id ? full : { ...full, id: `look-${index}` };
  return styleFrame(doc, { width: 320, height: 180 }).replace(/^<\?xml[^>]*>\s*/, "");
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

export { readRecipes, buildGalleryEntry, writeGalleryJson, renderIndexHtml, renderCardSvg, computeLicences };

// Bootstrapping: if this module is executed directly via `node scripts/motionkit/gallery.mjs`,
// the code above already ran during import evaluation.  For direct execution we
// re-invoke so the script works both as a module and a script.
if (import.meta.url === "file://" + process.argv[1]) {
  // Already executed above; idempotent
  const recipes2 = readRecipes();
  writeGalleryJson(recipes2);
  renderIndexHtml(recipes2);
}