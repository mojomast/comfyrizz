// M15: recipe cards and catalog card for prompt injection.
//
// Pure module: no filesystem, network, clock or randomness at import time.
// `recipeCard(recipe, effects)` renders one compact markdown card (<= 1400 chars)
// for prompt injection; `catalogCard(recipes)` renders one line per recipe (<= 120 chars).
//
// The 24 recipes are embedded here (spec section 3.3) so this file is self-contained.
// Every token comes from packages/schema vocabularies (imported, never copied).

import { MOTION_VOCABULARY, ENERGY_TRANSITIONS } from "../../packages/schema/src/motion.mjs";
import { ANIMATION_RECIPE_IDS } from "../../packages/schema/src/animation.mjs";

const RECIPE_SCHEMA_ID = "comfyrizz.recipe/v1";

const palette = (...roles) => roles.map(([role, hex]) => ({ role, hex }));

const entry = (list) => list.filter((e) => MOTION_VOCABULARY.entries.includes(e));
const emphasis = (list) => list.filter((e) => MOTION_VOCABULARY.emphasis.includes(e));

/** All 24 style recipes from MOTION_UPGRADE spec section 3.3. */
export const RECIPES = Object.freeze([
  {
    schema: RECIPE_SCHEMA_ID,
    id: "swiss-grid",
    label: "Swiss grid",
    taxonomy: { era: "modernist", finish: "clean", energy: "medium", geometry: "flat", type: "grotesk" },
    palette: palette(["background", "#f2f0eb"], ["text", "#111111"], ["accent", "#e3241b"], ["muted", "#9a9a9a"]),
    fonts: { display: "space-grotesk", text: "inter", mono: "jetbrains-mono" },
    easing: { personality: "editorial", entry: "enter", exit: "exit", spring: "settle" },
    entries: entry(["maskRise", "fadeUp", "waterfall"]),
    emphasis: emphasis(["keyword", "hero"]),
    transitions: { primary: "wipe", accent: ["push", "cut"] },
    storyRecipe: "kinetic",
    background: { pattern: "grid" },
    finish: [{ id: "paper-grain", params: { amount: 0.04 } }],
    rules: { do: ["flush-left headlines on a 12-col grid"], dont: ["centered text", "drop shadows"] },
    prompt: "Swiss International Style poster, strict grid, red accent, flat colour, no gradients",
  },
  {
    schema: RECIPE_SCHEMA_ID,
    id: "editorial-serif",
    label: "Editorial serif",
    taxonomy: { era: "modernist", finish: "clean", energy: "medium", geometry: "flat", type: "serif" },
    palette: palette(["background", "#faf7f2"], ["text", "#1c1a17"], ["accent", "#b0412e"], ["muted", "#d9cfc1"]),
    fonts: { display: "playfair-display", text: "inter" },
    easing: { personality: "editorial", entry: "enter", exit: "exit", spring: "settle" },
    entries: entry(["fadeUp", "maskRise"]),
    emphasis: emphasis(["keyword", "hero"]),
    transitions: { primary: "fade", accent: ["slide", "cut"] },
    storyRecipe: "focus",
    background: { pattern: "gradient" },
    finish: [{ id: "paper-grain", params: { amount: 0.04 } }, { id: "vignette-soft", params: { amount: 0.35 } }],
    rules: { do: ["ragged-right body text", "one accent pull-quote"], dont: ["all-caps body", "neon colours"] },
    prompt: "Magazine feature, editorial serif, warm paper, rust accent, soft vignette",
  },
  {
    schema: RECIPE_SCHEMA_ID,
    id: "neo-brutalist",
    label: "Neo-brutalist",
    taxonomy: { era: "y2k", finish: "clean", energy: "high", geometry: "flat", type: "grotesk" },
    palette: palette(["background", "#fffb00"], ["text", "#000000"], ["accent", "#ff3ea5"], ["muted", "#ffffff"]),
    fonts: { display: "archivo-black", text: "space-grotesk", mono: "jetbrains-mono" },
    easing: { personality: "snappy", entry: "enter", exit: "exit", spring: "snap" },
    entries: entry(["pop", "maskRise"]),
    emphasis: emphasis(["keyword", "hero"]),
    transitions: { primary: "cut", accent: ["push", "zoom"] },
    storyRecipe: "kinetic",
    background: { pattern: "dots" },
    finish: [{ id: "hard-shadow", params: { offset: 8, blur: 0 } }, { id: "halftone", params: { dotSize: 2, angle: 45 } }],
    rules: { do: ["hard black outlines", "primary colours only"], dont: ["gradients", "rounded corners"] },
    prompt: "Raw web brutalism, yellow background, hard shadow, magenta accent, no gradients",
  },
  {
    schema: RECIPE_SCHEMA_ID,
    id: "kinetic-poster",
    label: "Kinetic poster",
    taxonomy: { era: "modernist", finish: "clean", energy: "high", geometry: "flat", type: "grotesk" },
    palette: palette(["background", "#0d0d0d"], ["text", "#f5f5f5"], ["accent", "#ff5a1f"], ["muted", "#3a3a3a"]),
    fonts: { display: "bebas-neue", text: "inter" },
    easing: { personality: "snappy", entry: "enter", exit: "exit", spring: "snap" },
    entries: entry(["waterfall", "fadeUp"]),
    emphasis: emphasis(["keyword", "hero"]),
    transitions: { primary: "push", accent: ["zoom", "cut"] },
    storyRecipe: "kinetic",
    background: { pattern: "gradient" },
    finish: [{ id: "motion-smear", params: { amount: 6, direction: 0 } }, { id: "grain-fine", params: { amount: 0.06 } }],
    rules: { do: ["big type off the grid", "one colour per phrase"], dont: ["body paragraphs", "soft drop shadows"] },
    prompt: "Big type, high energy, black background, orange accent, motion smear",
  },
  {
    schema: RECIPE_SCHEMA_ID,
    id: "bauhaus-play",
    label: "Bauhaus play",
    taxonomy: { era: "modernist", finish: "clean", energy: "medium", geometry: "flat", type: "grotesk" },
    palette: palette(["background", "#f4efe1"], ["text", "#1d1d1b"], ["accent", "#d6402b"], ["muted", "#2a5db0"]),
    fonts: { display: "unbounded", text: "inter", mono: "jetbrains-mono" },
    easing: { personality: "elastic", entry: "enter", exit: "exit", spring: "pop" },
    entries: entry(["shape-reveal", "slide"]),
    emphasis: emphasis(["keyword", "hero"]),
    transitions: { primary: "shape-reveal", accent: ["slide", "wipe"] },
    storyRecipe: "morph",
    background: { pattern: "gradient" },
    finish: [{ id: "paper-grain", params: { amount: 0.05 } }],
    rules: { do: ["primary shapes on cream", "asymmetric layout"], dont: ["photos", "gradients"] },
    prompt: "Primary shapes, cream background, red and blue accents, asymmetric Bauhaus layout",
  },
  {
    schema: RECIPE_SCHEMA_ID,
    id: "mono-terminal",
    label: "Mono terminal",
    taxonomy: { era: "modernist", finish: "clean", energy: "medium", geometry: "flat", type: "mono" },
    palette: palette(["background", "#0b0f0c"], ["text", "#c8facc"], ["accent", "#39ff88"], ["muted", "#4a5a4e"]),
    fonts: { display: "jetbrains-mono", text: "ibm-plex-mono" },
    easing: { personality: "mechanical", entry: "enter", exit: "exit", spring: "settle" },
    entries: entry(["fadeUp", "maskRise"]),
    emphasis: emphasis(["none"]),
    transitions: { primary: "cut", accent: ["wipe", "fade"] },
    storyRecipe: "technical-flow",
    background: { pattern: "grid" },
    finish: [{ id: "scanlines-soft", params: { count: 120, opacity: 0.15 } }, { id: "glow-text", params: { intensity: 0.6, spread: 12 } }],
    rules: { do: ["monospace only", "green on dark"], dont: ["proportional type", "serifs"] },
    prompt: "Developer CLI, dark terminal, green text, scanlines, monospace",
  },
  {
    schema: RECIPE_SCHEMA_ID,
    id: "blueprint",
    label: "Blueprint",
    taxonomy: { era: "modernist", finish: "clean", energy: "medium", geometry: "flat", type: "mono" },
    palette: palette(["background", "#0f2a4a"], ["text", "#e8f1fb"], ["accent", "#7cc4ff"], ["muted", "#3d6a99"]),
    fonts: { display: "ibm-plex-mono", text: "inter" },
    easing: { personality: "editorial", entry: "enter", exit: "exit", spring: "settle" },
    entries: entry(["drawOn", "fadeUp"]),
    emphasis: emphasis(["keyword"]),
    transitions: { primary: "draw-reveal", accent: ["wipe", "fade"] },
    storyRecipe: "technical-flow",
    background: { pattern: "grid" },
    finish: [{ id: "paper-grain", params: { amount: 0.04 } }, { id: "vignette-soft", params: { amount: 0.35 } }],
    rules: { do: ["thin lines on blueprint blue", "callouts with leaders"], dont: ["colour fills", "drop shadows"] },
    prompt: "Engineering drawing, blueprint blue, white lines, faint grid, paper grain",
  },
  {
    schema: RECIPE_SCHEMA_ID,
    id: "isometric-saas",
    label: "Isometric SaaS",
    taxonomy: { era: "y2k", finish: "clean", energy: "medium", geometry: "isometric", type: "grotesk" },
    palette: palette(["background", "#0d1117"], ["text", "#e6edf3"], ["accent", "#2d6cff"], ["muted", "#31d0aa"]),
    fonts: { display: "space-grotesk", text: "inter" },
    easing: { personality: "snappy", entry: "enter", exit: "exit", spring: "snap" },
    entries: entry(["slide", "push"]),
    emphasis: emphasis(["keyword", "hero"]),
    transitions: { primary: "slide", accent: ["push"] },
    storyRecipe: "technical-flow",
    background: { pattern: "dots" },
    finish: [{ id: "soft-glow", params: { intensity: 0.35, radius: 30 } }],
    rules: { do: ["isometric cubes", "soft blue glow"], dont: ["perspective depth", "hard shadows"] },
    prompt: "Product explainer, isometric cubes, dark slate, blue accent, soft glow",
  },
  {
    schema: RECIPE_SCHEMA_ID,
    id: "glassmorphism",
    label: "Glassmorphism",
    taxonomy: { era: "y2k", finish: "clean", energy: "calm", geometry: "flat", type: "grotesk" },
    palette: palette(["background", "#0b1020"], ["text", "#eef3ff"], ["accent", "#4f6bff"], ["muted", "#9fe8ff"]),
    fonts: { display: "syne", text: "inter" },
    easing: { personality: "floaty", entry: "enter", exit: "exit", spring: "settle" },
    entries: entry(["fadeUp", "slide"]),
    emphasis: emphasis(["keyword"]),
    transitions: { primary: "blur", accent: ["fade"] },
    storyRecipe: "focus",
    background: { pattern: "gradient" },
    finish: [{ id: "bloom", params: { intensity: 0.5, radius: 24 } }, { id: "grain-fine", params: { amount: 0.06 } }],
    rules: { do: ["frosted cards on dark", "subtle border highlight"], dont: ["solid opaque blocks", "heavy grain"] },
    prompt: "Frosted UI, dark navy background, blue glass, soft bloom, fine grain",
  },
  {
    schema: RECIPE_SCHEMA_ID,
    id: "clay-soft",
    label: "Clay soft",
    taxonomy: { era: "y2k", finish: "print", energy: "medium", geometry: "dimensional", type: "serif" },
    palette: palette(["background", "#f4e9dd"], ["text", "#2b2320"], ["accent", "#c98a6b"], ["muted", "#6d4b3a"]),
    fonts: { display: "fraunces", text: "inter" },
    easing: { personality: "elastic", entry: "enter", exit: "exit", spring: "pop" },
    entries: entry(["shape-reveal", "slide"]),
    emphasis: emphasis(["keyword", "hero"]),
    transitions: { primary: "shape-reveal", accent: ["slide", "fade"] },
    storyRecipe: "morph",
    background: { pattern: "gradient" },
    finish: [{ id: "soft-shadow", params: { offsetY: 6, blur: 24, opacity: 0.3 } }, { id: "grain-fine", params: { amount: 0.06 } }],
    rules: { do: ["inflated rounded forms", "soft ambient shadow"], dont: ["sharp corners", "high contrast"] },
    prompt: "Claymation 3D-ish, warm cream, soft shadow, terracotta accent, fine grain",
  },
  {
    schema: RECIPE_SCHEMA_ID,
    id: "paper-collage",
    label: "Paper collage",
    taxonomy: { era: "modernist", finish: "print", energy: "medium", geometry: "flat", type: "grotesk" },
    palette: palette(["background", "#fdf6e3"], ["text", "#2d2a26"], ["accent", "#e0b13c"], ["muted", "#3f7d5a"]),
    fonts: { display: "caveat", text: "fraunces" },
    easing: { personality: "heavy", entry: "enter", exit: "exit", spring: "settle" },
    entries: entry(["drawOn", "slide"]),
    emphasis: emphasis(["keyword"]),
    transitions: { primary: "paper-reveal", accent: ["slide", "cut"] },
    storyRecipe: "paper-cut",
    background: { pattern: "grain" },
    finish: [{ id: "paper-texture", params: { scale: 1, opacity: 0.35 } }, { id: "drop-shadow", params: { offsetY: 10, blur: 14, opacity: 0.35 } }],
    rules: { do: ["torn paper edges", "offset shadows"], dont: ["vector cleanliness", "gradients"] },
    prompt: "Cut paper collage, cream paper, torn edges, yellow accent, drop shadow",
  },
  {
    schema: RECIPE_SCHEMA_ID,
    id: "risograph",
    label: "Risograph",
    taxonomy: { era: "retro-70s", finish: "print", energy: "medium", geometry: "flat", type: "grotesk" },
    palette: palette(["background", "#f6f1e7"], ["text", "#1f2a5c"], ["accent", "#ff4f7b"], ["muted", "#ffd23f"]),
    fonts: { display: "syne", text: "ibm-plex-mono" },
    easing: { personality: "snappy", entry: "enter", exit: "exit", spring: "snap" },
    entries: entry(["maskRise", "slide"]),
    emphasis: emphasis(["keyword", "hero"]),
    transitions: { primary: "wipe", accent: ["slide", "cut"] },
    storyRecipe: "kinetic",
    background: { pattern: "dots" },
    finish: [{ id: "riso-misregister", params: { offset: 3, angle: 8 } }, { id: "halftone", params: { dotSize: 2, angle: 45 } }, { id: "paper-grain", params: { amount: 0.08 } }],
    rules: { do: ["two ink colours", "misregistered overlay"], dont: ["full colour photos", "smooth gradients"] },
    prompt: "Two-ink riso print, cream paper, blue and pink inks, halftone, misregister",
  },
  {
    schema: RECIPE_SCHEMA_ID,
    id: "cinematic-noir",
    label: "Cinematic noir",
    taxonomy: { era: "retro-70s", finish: "grain", energy: "calm", geometry: "flat", type: "serif" },
    palette: palette(["background", "#050505"], ["text", "#f2f2f2"], ["accent", "#c9a227"], ["muted", "#3b3b3b"]),
    fonts: { display: "dm-serif-display", text: "inter" },
    easing: { personality: "heavy", entry: "enter", exit: "exit", spring: "settle" },
    entries: entry(["fadeUp", "drawOn"]),
    emphasis: emphasis(["keyword", "hero"]),
    transitions: { primary: "fade", accent: ["cut"] },
    storyRecipe: "focus",
    background: { pattern: "gradient" },
    finish: [{ id: "film-grain", params: { amount: 0.12, size: 2, seed: 1337 } }, { id: "vignette-hard", params: { amount: 0.6, radius: 0.45 } }, { id: "mono-grade", params: { amount: 1, contrast: 1.05 } }],
    rules: { do: ["black and white only", "hard vignette"], dont: ["colour", "soft light"] },
    prompt: "Black and white noir, hard vignette, film grain, gold accent, serif",
  },
  {
    schema: RECIPE_SCHEMA_ID,
    id: "film-35mm",
    label: "Film 35mm",
    taxonomy: { era: "retro-70s", finish: "grain", energy: "calm", geometry: "flat", type: "serif" },
    palette: palette(["background", "#1a1410"], ["text", "#f6ead8"], ["accent", "#ff8a3d"], ["muted", "#6b4a33"]),
    fonts: { display: "instrument-serif", text: "inter" },
    easing: { personality: "floaty", entry: "enter", exit: "exit", spring: "settle" },
    entries: entry(["fadeUp", "slide"]),
    emphasis: emphasis(["keyword"]),
    transitions: { primary: "fade", accent: ["blur", "cut"] },
    storyRecipe: "focus",
    background: { pattern: "grain" },
    finish: [{ id: "film-grain", params: { amount: 0.12, size: 2, seed: 1337 } }, { id: "halation", params: { threshold: 0.7, radius: 18 } }, { id: "light-leak", params: { intensity: 0.6, hue: 25, softness: 0.5 } }, { id: "gate-weave", params: { amount: 0.5 } }],
    rules: { do: ["warm highlights", "organic grain"], dont: ["digital cleanliness", "pure black text"] },
    prompt: "Warm 35mm film, orange highlights, halation, light leak, gate weave",
  },
  {
    schema: RECIPE_SCHEMA_ID,
    id: "vhs-retro",
    label: "VHS retro",
    taxonomy: { era: "y2k", finish: "crt", energy: "medium", geometry: "flat", type: "mono" },
    palette: palette(["background", "#120c1f"], ["text", "#f8f4ff"], ["accent", "#ff2fd1"], ["muted", "#19e3ff"]),
    fonts: { display: "vt323", text: "ibm-plex-mono" },
    easing: { personality: "mechanical", entry: "enter", exit: "exit", spring: "settle" },
    entries: entry(["fadeUp", "slide"]),
    emphasis: emphasis(["keyword"]),
    transitions: { primary: "cut", accent: ["wipe", "slide"] },
    storyRecipe: "kinetic",
    background: { pattern: "gradient" },
    finish: [{ id: "vhs-tracking", params: { bandHeight: 0.18, intensity: 0.5 } }, { id: "chroma-shift", params: { offset: 2, angle: 0 } }, { id: "scanlines", params: { count: 240, opacity: 0.35 } }],
    rules: { do: ["tracking band", "chromatic shift"], dont: ["sharp HD edges", "smooth gradients"] },
    prompt: "90s camcorder, purple dark, pink and cyan accent, VHS tracking, scanlines",
  },
  {
    schema: RECIPE_SCHEMA_ID,
    id: "crt-arcade",
    label: "CRT arcade",
    taxonomy: { era: "retro-70s", finish: "crt", energy: "high", geometry: "flat", type: "display" },
    palette: palette(["background", "#000000"], ["text", "#f8f8f8"], ["accent", "#ffd400"], ["muted", "#00e5ff"]),
    fonts: { display: "press-start-2p", text: "vt323" },
    easing: { personality: "mechanical", entry: "enter", exit: "exit", spring: "settle" },
    entries: entry(["pop", "fadeUp"]),
    emphasis: emphasis(["hero"]),
    transitions: { primary: "cut", accent: ["iris", "zoom"] },
    storyRecipe: "kinetic",
    background: { pattern: "grid" },
    finish: [{ id: "crt-curve", params: { curvature: 0.4, bezel: 6 } }, { id: "scanlines", params: { count: 240, opacity: 0.35 } }, { id: "pixelate-in", params: { size: 12, steps: 6 } }],
    rules: { do: ["8-bit palette", "scanlines and bezel"], dont: ["anti-aliased curves", "wide gamut"] },
    prompt: "8-bit arcade, black screen, yellow accent, CRT curve, scanlines, pixelate",
  },
  {
    schema: RECIPE_SCHEMA_ID,
    id: "y2k-chrome",
    label: "Y2K chrome",
    taxonomy: { era: "y2k", finish: "clean", energy: "high", geometry: "flat", type: "display" },
    palette: palette(["background", "#e9ecf5"], ["text", "#101326"], ["accent", "#6c5cff"], ["muted", "#b8f3ff"]),
    fonts: { display: "monoton", text: "syne" },
    easing: { personality: "elastic", entry: "enter", exit: "exit", spring: "pop" },
    entries: entry(["fadeUp", "maskRise"]),
    emphasis: emphasis(["keyword", "hero"]),
    transitions: { primary: "zoom", accent: ["iris", "push"] },
    storyRecipe: "morph",
    background: { pattern: "gradient" },
    finish: [{ id: "chrome-sheen", params: { angle: 105, sharpness: 0.35, width: 0.35 } }, { id: "bloom", params: { intensity: 0.5, radius: 24 } }],
    rules: { do: ["gradient chrome text", "sweeping highlight"], dont: ["flat fills", "matte surfaces"] },
    prompt: "Millennium chrome, gradient text, blue sheen, bloom, Y2K aesthetic",
  },
  {
    schema: RECIPE_SCHEMA_ID,
    id: "synthwave",
    label: "Synthwave",
    taxonomy: { era: "y2k", finish: "clean", energy: "high", geometry: "flat", type: "display" },
    palette: palette(["background", "#120428"], ["text", "#fdf0ff"], ["accent", "#ff2a6d"], ["muted", "#05d9e8"]),
    fonts: { display: "orbitron", text: "inter" },
    easing: { personality: "floaty", entry: "enter", exit: "exit", spring: "settle" },
    entries: entry(["fadeUp", "waterfall"]),
    emphasis: emphasis(["keyword", "hero"]),
    transitions: { primary: "zoom", accent: ["push", "cut"] },
    storyRecipe: "kinetic",
    background: { pattern: "grid" },
    finish: [{ id: "glow-text", params: { intensity: 0.6, spread: 12 } }, { id: "scanlines-soft", params: { count: 120, opacity: 0.15 } }, { id: "bloom", params: { intensity: 0.5, radius: 24 } }],
    rules: { do: ["neon grid horizon", "pink and cyan"], dont: ["warm earth tones", "matte paper"] },
    prompt: "Neon 80s horizon, dark purple, pink and cyan grid, glow text, scanlines",
  },
  {
    schema: RECIPE_SCHEMA_ID,
    id: "vaporwave",
    label: "Vaporwave",
    taxonomy: { era: "y2k", finish: "clean", energy: "calm", geometry: "flat", type: "grotesk" },
    palette: palette(["background", "#2b1055"], ["text", "#fef6ff"], ["accent", "#ff71ce"], ["muted", "#01cdfe"]),
    fonts: { display: "syne", text: "vt323" },
    easing: { personality: "floaty", entry: "enter", exit: "exit", spring: "settle" },
    entries: entry(["blur", "slide"]),
    emphasis: emphasis(["keyword"]),
    transitions: { primary: "blur", accent: ["fade"] },
    storyRecipe: "morph",
    background: { pattern: "gradient" },
    finish: [{ id: "chroma-shift", params: { offset: 2, angle: 0 } }, { id: "grain-fine", params: { amount: 0.06 } }, { id: "duotone", params: { amount: 0.9, contrast: 1 } }],
    rules: { do: ["pastel internet palette", "chroma shift"], dont: ["high contrast black", "sharp serifs"] },
    prompt: "Pastel internet, purple background, pink and cyan, chroma shift, grain",
  },
  {
    schema: RECIPE_SCHEMA_ID,
    id: "organic-hand",
    label: "Organic hand",
    taxonomy: { era: "modernist", finish: "print", energy: "calm", geometry: "organic", type: "grotesk" },
    palette: palette(["background", "#fbf8f1"], ["text", "#2e2a24"], ["accent", "#ef6f4b"], ["muted", "#6aa58e"]),
    fonts: { display: "caveat", text: "inter" },
    easing: { personality: "anticipate", entry: "enter", exit: "exit", spring: "pop" },
    entries: entry(["drawOn", "fadeUp"]),
    emphasis: emphasis(["keyword"]),
    transitions: { primary: "draw-reveal", accent: ["fade"] },
    storyRecipe: "sketch",
    background: { pattern: "grain" },
    finish: [{ id: "paper-texture", params: { scale: 1, opacity: 0.35 } }, { id: "boil-line", params: { jitter: 2, rate: 8, seed: 4242 } }],
    rules: { do: ["hand-drawn lines", "boil-line wobble"], dont: ["perfect vectors", "mechanical timing"] },
    prompt: "Hand-drawn, cream paper, orange accent, boil-line wobble, paper texture",
  },
  {
    schema: RECIPE_SCHEMA_ID,
    id: "data-journalism",
    label: "Data journalism",
    taxonomy: { era: "modernist", finish: "clean", energy: "medium", geometry: "flat", type: "serif" },
    palette: palette(["background", "#fff1e5"], ["text", "#262a33"], ["accent", "#0f5499"], ["muted", "#990f3d"]),
    fonts: { display: "instrument-serif", text: "ibm-plex-mono" },
    easing: { personality: "editorial", entry: "enter", exit: "exit", spring: "settle" },
    entries: entry(["slide", "wipe"]),
    emphasis: emphasis(["keyword"]),
    transitions: { primary: "slide", accent: ["wipe", "fade"] },
    storyRecipe: "technical-flow",
    background: { pattern: "gradient" },
    finish: [{ id: "paper-grain", params: { amount: 0.04 } }],
    rules: { do: ["chart-first layout", "source line under figures"], dont: ["clip art", "drop shadows"] },
    prompt: "FT/Bloomberg charts, cream background, blue accent, subtle paper grain",
  },
  {
    schema: RECIPE_SCHEMA_ID,
    id: "luxury-minimal",
    label: "Luxury minimal",
    taxonomy: { era: "modernist", finish: "clean", energy: "calm", geometry: "flat", type: "serif" },
    palette: palette(["background", "#0e0e0e"], ["text", "#f4efe6"], ["accent", "#c8a96a"], ["muted", "#2a2a2a"]),
    fonts: { display: "instrument-serif", text: "inter" },
    easing: { personality: "floaty", entry: "enter", exit: "exit", spring: "settle" },
    entries: entry(["fadeUp", "blur"]),
    emphasis: emphasis(["hero"]),
    transitions: { primary: "fade", accent: ["blur", "cut"] },
    storyRecipe: "focus",
    background: { pattern: "gradient" },
    finish: [{ id: "grain-fine", params: { amount: 0.06 } }, { id: "vignette-soft", params: { amount: 0.35, radius: 0.65 } }],
    rules: { do: ["generous whitespace", "one hero image"], dont: ["clutter", "bright colour"] },
    prompt: "Premium brand, black background, gold accent, fine grain, soft vignette",
  },
  {
    schema: RECIPE_SCHEMA_ID,
    id: "neon-cyber",
    label: "Neon cyber",
    taxonomy: { era: "y2k", finish: "clean", energy: "high", geometry: "flat", type: "display" },
    palette: palette(["background", "#05010d"], ["text", "#e7f9ff"], ["accent", "#00f0ff"], ["muted", "#ff003c"]),
    fonts: { display: "orbitron", text: "jetbrains-mono" },
    easing: { personality: "snappy", entry: "enter", exit: "exit", spring: "snap" },
    entries: entry(["pop", "fadeUp"]),
    emphasis: emphasis(["keyword", "hero"]),
    transitions: { primary: "cut", accent: ["zoom", "push"] },
    storyRecipe: "technical-flow",
    background: { pattern: "grid" },
    finish: [{ id: "glitch-slice", params: { slices: 8, offset: 18 } }, { id: "chroma-shift", params: { offset: 2, angle: 0 } }, { id: "glow-text", params: { intensity: 0.6, spread: 12 } }],
    rules: { do: ["cyberpunk HUD", "glitch slices"], dont: ["soft blur", "pastel paper"] },
    prompt: "Cyberpunk HUD, near-black, cyan and magenta neon, glitch slice, glow text",
  },
  {
    schema: RECIPE_SCHEMA_ID,
    id: "documentary-archive",
    label: "Documentary archive",
    taxonomy: { era: "retro-70s", finish: "grain", energy: "calm", geometry: "flat", type: "serif" },
    palette: palette(["background", "#e8e0cf"], ["text", "#241f1a"], ["accent", "#8a3b12"], ["muted", "#7d7464"]),
    fonts: { display: "dm-serif-display", text: "ibm-plex-mono" },
    easing: { personality: "heavy", entry: "enter", exit: "exit", spring: "settle" },
    entries: entry(["fadeUp", "drawOn"]),
    emphasis: emphasis(["keyword"]),
    transitions: { primary: "fade", accent: ["paper-reveal", "cut"] },
    storyRecipe: "focus",
    background: { pattern: "grain" },
    finish: [{ id: "dust-scratches", params: { density: 0.3, opacity: 0.5 } }, { id: "sepia-grade", params: { amount: 0.8 } }, { id: "gate-weave", params: { amount: 0.5 } }],
    rules: { do: ["sepia archive tone", "dust and scratches"], dont: ["saturated colour", "digital sharpness"] },
    prompt: "Archival document, sepia grade, dust scratches, gate weave, brown accent",
  },
]);

const BY_ID = new Map(RECIPES.map((r) => [r.id, r]));

/** Resolve an effect label by id from the effects catalog (may be undefined). */
const effectLabel = (effects, id) => {
  if (!effects || !Array.isArray(effects)) return id;
  const hit = effects.find((e) => e && e.id === id);
  return hit && hit.label ? hit.label : id;
};

const hexContrast = (a, b) => {
  const lum = (hex) => {
    const c = parseInt(hex.slice(1), 16);
    const s = (v) => {
      v /= 255;
      return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    };
    const r = s((c >> 16) & 255);
    const g = s((c >> 8) & 255);
    const bl = s(c & 255);
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const la = lum(a);
  const lb = lum(b);
  const light = Math.max(la, lb);
  const dark = Math.min(la, lb);
  return (light + 0.05) / (dark + 0.05);
};

const roleHex = (recipe, role) => {
  const hit = (recipe.palette || []).find((p) => p && p.role === role);
  return hit && hit.hex ? hit.hex : null;
};

/** Render one recipe as a compact markdown card (<= 1400 chars) for prompt injection. */
export function recipeCard(recipe, effects = []) {
  const r = recipe;
  const bg = roleHex(r, "background") ?? "#ffffff";
  const text = roleHex(r, "text") ?? "#000000";
  const accent = roleHex(r, "accent") ?? "#000000";
  const muted = roleHex(r, "muted");
  const contrast = bg && text ? hexContrast(bg, text) : null;
  const finish = (r.finish || [])
    .map((f) => (typeof f === "string" ? f : f.id))
    .map((id) => effectLabel(effects, id))
    .join(", ");
  const entries = (r.entries || []).join(", ");
  const emphasisList = (r.emphasis || []).join(", ");
  const accentList = (r.transitions && r.transitions.accent || []).join(", ");
  const types = new Set([r.transitions && r.transitions.primary, ...(r.transitions && r.transitions.accent || [])]).size;
  const doLines = (r.rules && r.rules.do || []).map((d) => `- Do: ${d}`).join("\n");
  const dontLines = (r.rules && r.rules.dont || []).map((d) => `- Don't: ${d}`).join("\n");
  const typePair = `${r.fonts && r.fonts.display} / ${r.fonts && r.fonts.text}`;

  const lines = [
    `# ${r.label} (${r.id})`,
    `Palette: background ${bg}, text ${text}, accent ${accent}${muted ? `, muted ${muted}` : ""}.`,
    `Type pair: ${typePair}. Easing: ${r.easing.personality} (entry ${r.easing.entry}, exit ${r.easing.exit}, spring ${r.easing.spring}).`,
    `Transitions: primary ${r.transitions.primary}, accents ${accentList} (${types} types, budget 3). Energy ${r.taxonomy.energy}.`,
    `Entries: ${entries}. Emphasis: ${emphasisList}. Story: ${r.storyRecipe || "none"}. Background: ${r.background.pattern}.`,
    `Finish: ${finish || "none"}.`,
    contrast !== null ? `Text/background contrast: ${contrast.toFixed(2)}:1.` : "",
    r.rules ? `Rules:\n${doLines}\n${dontLines}` : "",
    r.prompt ? `Prompt: ${r.prompt}` : "",
  ];

  return lines.filter((l) => l.length > 0).join("\n").trim();
}

/** Render one line per recipe (<= 120 chars each) for the catalog. */
export function catalogCard(recipes = RECIPES) {
  return recipes
    .map((r) => {
      const primary = r.transitions && r.transitions.primary ? r.transitions.primary : "cut";
      const accent = (r.transitions && r.transitions.accent || []).slice(0, 2).join("+");
      const acc = accent ? ` +${accent}` : "";
      const line = `${r.id} — ${r.label} · ${r.easing.personality} · ${primary}${acc} · ${r.taxonomy.energy} · ${r.fonts.display}/${r.fonts.text}`;
      return line.length > 120 ? line.slice(0, 117) + "..." : line;
    })
    .join("\n");
}

/** Look up a recipe by id. */
export function getRecipe(id) {
  return BY_ID.get(id);
}

/** List all recipe ids. */
export function listRecipeIds() {
  return [...BY_ID.keys()];
}
