#!/usr/bin/env node
// Build three reproducible, schema-valid demo package sources for the rich-demos collection.
//
// This script does not generate media and does not touch Google Colab. It writes package.json
// plans, original procedural SVG assets, copied workflow graphs, and a build report. Stills and
// plates stay `status: "pending"` so the shared jobs planner can batch them on the runner.
//
// Usage:
//   node scripts/demos/build.mjs --out <external-source-directory> [--only ussy,hermes,ministry]
//
// All output paths come from --out. The script contains no host-specific path.

import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { planJobs, checkJobsDoc } from "../../packages/jobs/src/index.mjs";
import { compileTimeline } from "../../packages/planner/dist/src/index.js";
import { validatePackage } from "../../packages/schema/src/index.mjs";
import { sanitizeSvg, renderCheck, SANITIZER_VERSION } from "../../packages/vector/dist/src/index.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..", "..");
const WORKFLOW_DIR = join(REPO, "workflows");
const RENDERER_FONTS = join(REPO, "apps", "renderer", "public", "fonts");
const FIXED_AT = "2026-10-20T00:00:00.000Z";

const argv = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : fallback;
};
const outRoot = flag("--out", null);
if (!outRoot) {
  console.error("usage: node scripts/demos/build.mjs --out <external-source-directory> [--only ussy,hermes,ministry]");
  process.exit(2);
}
const only = new Set(String(flag("--only", "ussy,hermes,ministry")).split(",").map((s) => s.trim()).filter(Boolean));

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const sha256File = (path) => sha256(readFileSync(path));
const words = (text) => (String(text).match(/[A-Za-z0-9]+(?:['’][A-Za-z0-9]+)?/g) || []).length;

const FLUX = {
  workflow: "workflows/flux3_klein_t2i.api.json",
  model: "flux-3-image-klein",
  quantization: "bf16",
  license: {
    id: "LicenseRef-FLUX.3-Image-Klein",
    url: "https://huggingface.co/black-forest-labs/flux-3-image-klein",
  },
};
const LTX = {
  workflow: "workflows/ltx25_i2v_2stage.api.json",
  model: "ltx-2.5-22b-distilled",
  quantization: "int8",
  license: {
    id: "LicenseRef-LTX-2.5",
    url: "https://huggingface.co/Lightricks/LTX-2.5",
  },
};
const WORKFLOWS = [
  "flux3_klein_t2i.api.json",
  "flux3_klein_t2i.api.params.json",
  "ltx25_i2v_2stage.api.json",
  "ltx25_i2v_2stage.api.params.json",
];

function copyWorkflows(pkgDir) {
  const dir = join(pkgDir, "workflows");
  mkdirSync(dir, { recursive: true });
  for (const name of WORKFLOWS) copyFileSync(join(WORKFLOW_DIR, name), join(dir, name));
}

function assetKey(filmKey, sceneId, kind) {
  return `a_${filmKey}_${sceneId.replace(/^s_/, "")}_${kind}`;
}

function sceneKey(filmKey, n) {
  return `s_${filmKey}${String(n).padStart(2, "0")}`;
}

function paletteFor(film) {
  return film.palette;
}

// --- original procedural SVG compositions ------------------------------------------------

function svgWrap(p, w, h, body, bg = 0) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><rect width="${w}" height="${h}" fill="${p[bg]}"/>${body}</svg>`;
}

const SVG = {
  sketch: (p) => svgWrap(p, 800, 600, `
    <rect x="54" y="132" width="196" height="132" rx="14" fill="${p[0]}" stroke="${p[1]}" stroke-width="5"/>
    <rect x="62" y="140" width="180" height="116" rx="10" fill="none" stroke="${p[2]}" stroke-width="3" stroke-dasharray="9 7"/>
    <rect x="86" y="166" width="118" height="12" fill="${p[4]}"/>
    <rect x="86" y="194" width="82" height="8" fill="${p[1]}" opacity="0.7"/>
    <rect x="302" y="84" width="188" height="146" rx="14" fill="${p[0]}" stroke="${p[1]}" stroke-width="5"/>
    <rect x="310" y="92" width="172" height="130" rx="10" fill="none" stroke="${p[3]}" stroke-width="3" stroke-dasharray="12 8"/>
    <rect x="334" y="120" width="106" height="12" fill="${p[2]}"/>
    <rect x="334" y="150" width="126" height="8" fill="${p[1]}" opacity="0.7"/>
    <rect x="548" y="152" width="198" height="132" rx="14" fill="${p[0]}" stroke="${p[1]}" stroke-width="5"/>
    <rect x="556" y="160" width="182" height="116" rx="10" fill="none" stroke="${p[2]}" stroke-width="3" stroke-dasharray="7 6"/>
    <rect x="580" y="186" width="120" height="12" fill="${p[4]}"/>
    <rect x="580" y="214" width="88" height="8" fill="${p[1]}" opacity="0.7"/>
    <path d="M252 200 C274 200 280 170 302 166" fill="none" stroke="${p[1]}" stroke-width="7" stroke-linecap="round"/>
    <path d="M292 156 L306 166 L291 176" fill="none" stroke="${p[1]}" stroke-width="7" stroke-linecap="round" stroke-linejoin="round"/>
    <path d="M492 166 C516 166 522 206 546 206" fill="none" stroke="${p[1]}" stroke-width="7" stroke-linecap="round"/>
    <path d="M534 196 L548 206 L533 216" fill="none" stroke="${p[1]}" stroke-width="7" stroke-linecap="round" stroke-linejoin="round"/>
    <path d="M94 292 C202 330 292 306 370 344" fill="none" stroke="${p[2]}" stroke-width="9" stroke-linecap="round" opacity="0.85"/>
  `),
  receipt: (p) => svgWrap(p, 800, 600, `
    <rect x="210" y="42" width="380" height="500" rx="8" fill="${p[4]}" stroke="${p[1]}" stroke-width="5"/>
    <path d="M210 86 H590" stroke="${p[1]}" stroke-width="4"/>
    <path d="M210 470 H590" stroke="${p[1]}" stroke-width="4" stroke-dasharray="12 10"/>
    <rect x="246" y="118" width="188" height="16" fill="${p[1]}"/>
    <rect x="246" y="154" width="286" height="8" fill="${p[1]}" opacity="0.55"/>
    <rect x="246" y="176" width="242" height="8" fill="${p[1]}" opacity="0.55"/>
    <rect x="246" y="214" width="308" height="2" fill="${p[1]}" opacity="0.35"/>
    <rect x="246" y="244" width="132" height="10" fill="${p[3]}"/>
    <rect x="246" y="270" width="250" height="8" fill="${p[1]}" opacity="0.55"/>
    <rect x="246" y="292" width="214" height="8" fill="${p[1]}" opacity="0.55"/>
    <g stroke="${p[2]}" stroke-width="6" stroke-linecap="round">
      <path d="M430 382 l44 44 M474 382 l-44 44"/>
      <circle cx="452" cy="404" r="68" fill="none" stroke-width="7"/>
    </g>
    <rect x="246" y="498" width="96" height="14" fill="${p[2]}"/>
    <rect x="358" y="498" width="64" height="14" fill="${p[2]}"/>
    <rect x="438" y="498" width="112" height="14" fill="${p[2]}"/>
  `),
  hub: (p) => svgWrap(p, 800, 600, `
    <circle cx="400" cy="300" r="92" fill="${p[1]}"/>
    <circle cx="400" cy="300" r="126" fill="none" stroke="${p[2]}" stroke-width="3" stroke-dasharray="10 9"/>
    <g stroke="${p[2]}" stroke-width="6" fill="none" stroke-linecap="round">
      <path d="M400 174 V108"/><path d="M400 426 V492"/>
      <path d="M274 300 H146"/><path d="M526 300 H654"/>
      <path d="M310 210 L226 152"/><path d="M490 390 L574 448"/>
    </g>
    <g fill="${p[3]}">
      <rect x="330" y="62" width="140" height="62" rx="12"/>
      <rect x="330" y="476" width="140" height="62" rx="12"/>
      <rect x="74" y="268" width="140" height="64" rx="12"/>
      <rect x="586" y="268" width="140" height="64" rx="12"/>
    </g>
    <g fill="${p[4]}">
      <circle cx="400" cy="300" r="22"/>
      <circle cx="402" cy="94" r="10"/>
      <circle cx="402" cy="508" r="10"/>
      <circle cx="146" cy="300" r="10"/>
      <circle cx="654" cy="300" r="10"/>
    </g>
  `),
  channels: (p) => svgWrap(p, 800, 600, `
    <rect x="64" y="118" width="290" height="364" rx="18" fill="${p[3]}" stroke="${p[2]}" stroke-width="4"/>
    <rect x="446" y="118" width="290" height="364" rx="18" fill="${p[3]}" stroke="${p[1]}" stroke-width="4"/>
    <g fill="${p[0]}">
      <circle cx="112" cy="168" r="10"/><circle cx="146" cy="168" r="10"/><circle cx="180" cy="168" r="10"/>
    </g>
    <rect x="102" y="210" width="210" height="12" fill="${p[2]}"/>
    <rect x="102" y="240" width="164" height="8" fill="${p[0]}" opacity="0.6"/>
    <rect x="102" y="262" width="188" height="8" fill="${p[0]}" opacity="0.6"/>
    <rect x="102" y="310" width="210" height="2" fill="${p[2]}" opacity="0.5"/>
    <rect x="102" y="336" width="126" height="8" fill="${p[0]}" opacity="0.6"/>
    <circle cx="590" cy="184" r="48" fill="none" stroke="${p[1]}" stroke-width="6"/>
    <path d="M566 184 l17 17 l32 -38" fill="none" stroke="${p[1]}" stroke-width="8" stroke-linecap="round" stroke-linejoin="round"/>
    <rect x="484" y="260" width="210" height="12" fill="${p[1]}"/>
    <rect x="484" y="290" width="174" height="8" fill="${p[0]}" opacity="0.6"/>
    <rect x="484" y="312" width="198" height="8" fill="${p[0]}" opacity="0.6"/>
    <rect x="484" y="352" width="210" height="2" fill="${p[1]}" opacity="0.5"/>
    <rect x="484" y="378" width="144" height="8" fill="${p[0]}" opacity="0.6"/>
  `),
  catalog: (p) => svgWrap(p, 800, 600, `
    <g fill="${p[3]}" stroke="${p[0]}" stroke-width="3">
      <rect x="52" y="66" width="168" height="86" rx="8"/><rect x="232" y="66" width="168" height="86" rx="8"/><rect x="412" y="66" width="168" height="86" rx="8"/><rect x="592" y="66" width="156" height="86" rx="8"/>
      <rect x="52" y="166" width="168" height="86" rx="8"/><rect x="232" y="166" width="168" height="86" rx="8"/><rect x="412" y="166" width="168" height="86" rx="8"/><rect x="592" y="166" width="156" height="86" rx="8"/>
      <rect x="52" y="266" width="168" height="86" rx="8"/><rect x="232" y="266" width="168" height="86" rx="8"/><rect x="412" y="266" width="168" height="86" rx="8"/><rect x="592" y="266" width="156" height="86" rx="8"/>
      <rect x="52" y="366" width="168" height="86" rx="8"/><rect x="232" y="366" width="168" height="86" rx="8"/><rect x="412" y="366" width="168" height="86" rx="8"/><rect x="592" y="366" width="156" height="86" rx="8"/>
      <rect x="52" y="466" width="168" height="86" rx="8"/><rect x="232" y="466" width="168" height="86" rx="8"/><rect x="412" y="466" width="168" height="86" rx="8"/><rect x="592" y="466" width="156" height="86" rx="8"/>
    </g>
    <g fill="${p[1]}">
      <rect x="84" y="104" width="64" height="9" rx="4"/><rect x="264" y="204" width="64" height="9" rx="4"/><rect x="444" y="104" width="64" height="9" rx="4"/><rect x="624" y="404" width="64" height="9" rx="4"/>
    </g>
    <rect x="226" y="304" width="238" height="150" rx="10" fill="${p[4]}" stroke="${p[2]}" stroke-width="5"/>
    <rect x="254" y="334" width="150" height="12" fill="${p[1]}"/>
    <rect x="254" y="360" width="178" height="8" fill="${p[1]}" opacity="0.55"/>
    <rect x="254" y="382" width="132" height="8" fill="${p[1]}" opacity="0.55"/>
    <path d="M254 416 H430" stroke="${p[2]}" stroke-width="4"/>
  `),
  issue: (p) => svgWrap(p, 800, 600, `
    <rect x="118" y="90" width="564" height="420" rx="18" fill="${p[3]}" stroke="${p[2]}" stroke-width="4"/>
    <rect x="118" y="90" width="564" height="84" rx="18" fill="${p[4]}"/>
    <rect x="118" y="150" width="564" height="24" fill="${p[4]}"/>
    <rect x="118" y="90" width="26" height="420" fill="${p[4]}"/>
    <rect x="174" y="212" width="292" height="18" fill="${p[0]}"/>
    <rect x="174" y="250" width="420" height="9" fill="${p[0]}" opacity="0.55"/>
    <rect x="174" y="272" width="372" height="9" fill="${p[0]}" opacity="0.55"/>
    <rect x="174" y="294" width="402" height="9" fill="${p[0]}" opacity="0.55"/>
    <path d="M174 342 H614" stroke="${p[4]}" stroke-width="3" opacity="0.6"/>
    <g stroke="${p[2]}" stroke-width="9" stroke-linecap="round">
      <path d="M188 398 l56 40 l-30 48"/>
      <path d="M604 398 l-56 40 l30 48"/>
    </g>
    <rect x="320" y="66" width="160" height="48" rx="10" fill="${p[4]}"/>
  `),
  memo: (p) => svgWrap(p, 800, 600, `
    <rect x="112" y="64" width="576" height="472" rx="10" fill="${p[4]}" stroke="${p[1]}" stroke-width="4"/>
    <rect x="152" y="112" width="208" height="16" fill="${p[1]}"/>
    <rect x="152" y="146" width="420" height="8" fill="${p[1]}" opacity="0.5"/>
    <rect x="152" y="168" width="356" height="8" fill="${p[1]}" opacity="0.5"/>
    <rect x="152" y="214" width="196" height="92" rx="8" fill="none" stroke="${p[1]}" stroke-width="4"/>
    <path d="M184 286 L220 238 L256 262 L292 224" fill="none" stroke="${p[2]}" stroke-width="7" stroke-linecap="round" stroke-linejoin="round"/>
    <rect x="152" y="344" width="300" height="12" fill="${p[3]}"/>
    <rect x="152" y="372" width="252" height="8" fill="${p[1]}" opacity="0.5"/>
    <rect x="152" y="394" width="286" height="8" fill="${p[1]}" opacity="0.5"/>
    <g transform="rotate(-9 590 420)">
      <rect x="498" y="360" width="184" height="76" rx="8" fill="none" stroke="${p[1]}" stroke-width="8"/>
      <path d="M526 398 H654" stroke="${p[1]}" stroke-width="8"/>
    </g>
    <circle cx="596" cy="160" r="38" fill="none" stroke="${p[2]}" stroke-width="6"/>
  `),
  flow: (p) => svgWrap(p, 800, 600, `
    <rect x="46" y="228" width="150" height="110" rx="14" fill="${p[4]}" stroke="${p[1]}" stroke-width="4"/>
    <rect x="242" y="132" width="150" height="110" rx="14" fill="${p[4]}" stroke="${p[1]}" stroke-width="4"/>
    <rect x="242" y="334" width="150" height="110" rx="14" fill="${p[4]}" stroke="${p[2]}" stroke-width="5"/>
    <rect x="450" y="228" width="150" height="110" rx="14" fill="${p[4]}" stroke="${p[1]}" stroke-width="4"/>
    <rect x="646" y="228" width="108" height="110" rx="14" fill="${p[3]}"/>
    <g stroke="${p[1]}" stroke-width="7" fill="none" stroke-linecap="round">
      <path d="M196 283 H236"/><path d="M220 269 L238 283 L220 297"/>
      <path d="M317 242 V328"/><path d="M303 310 L317 330 L331 310"/>
      <path d="M392 400 H442"/><path d="M426 386 L444 400 L426 414"/>
      <path d="M600 283 H638"/><path d="M622 269 L640 283 L622 297"/>
    </g>
    <g fill="${p[2]}">
      <circle cx="121" cy="283" r="18"/><circle cx="317" cy="187" r="18"/><circle cx="525" cy="283" r="18"/>
    </g>
    <g stroke="${p[2]}" stroke-width="5" opacity="0.8">
      <path d="M678 258 H722 M678 282 H722 M678 306 H706"/>
    </g>
  `),
  calendar: (p) => svgWrap(p, 800, 600, `
    <rect x="58" y="52" width="684" height="496" rx="18" fill="${p[4]}" stroke="${p[1]}" stroke-width="4"/>
    <rect x="58" y="52" width="684" height="72" rx="18" fill="${p[1]}"/>
    <rect x="58" y="104" width="684" height="20" fill="${p[1]}"/>
    <g fill="${p[3]}" opacity="0.9">
      <rect x="94" y="156" width="130" height="70" rx="8"/><rect x="242" y="156" width="130" height="70" rx="8"/><rect x="390" y="156" width="130" height="70" rx="8"/><rect x="538" y="156" width="130" height="70" rx="8"/>
      <rect x="94" y="244" width="130" height="70" rx="8"/><rect x="538" y="244" width="130" height="70" rx="8"/>
      <rect x="94" y="332" width="130" height="70" rx="8"/><rect x="242" y="332" width="130" height="70" rx="8"/><rect x="390" y="332" width="130" height="70" rx="8"/><rect x="538" y="332" width="130" height="70" rx="8"/>
      <rect x="94" y="420" width="130" height="70" rx="8"/><rect x="242" y="420" width="130" height="70" rx="8"/><rect x="390" y="420" width="130" height="70" rx="8"/><rect x="538" y="420" width="130" height="70" rx="8"/>
    </g>
    <rect x="242" y="244" width="130" height="70" rx="8" fill="${p[4]}" stroke="${p[1]}" stroke-width="6"/>
    <path d="M258 258 L356 300 M356 258 L258 300" stroke="${p[1]}" stroke-width="9" stroke-linecap="round"/>
    <rect x="390" y="244" width="130" height="70" rx="8" fill="${p[4]}" stroke="${p[2]}" stroke-width="7"/>
    <path d="M416 280 l16 16 l38 -44" fill="none" stroke="${p[2]}" stroke-width="9" stroke-linecap="round" stroke-linejoin="round"/>
  `),
  consult: (p) => svgWrap(p, 800, 600, `
    <g fill="${p[4]}" stroke="${p[1]}" stroke-width="2">
      <rect x="54" y="74" width="144" height="104" rx="8" transform="rotate(-5 126 126)"/>
      <rect x="214" y="60" width="144" height="104" rx="8" transform="rotate(3 286 112)"/>
      <rect x="374" y="78" width="144" height="104" rx="8" transform="rotate(-2 446 130)"/>
      <rect x="534" y="62" width="144" height="104" rx="8" transform="rotate(4 606 114)"/>
      <rect x="78" y="218" width="144" height="104" rx="8" transform="rotate(2 150 270)"/>
      <rect x="238" y="226" width="144" height="104" rx="8" transform="rotate(-4 310 278)"/>
      <rect x="398" y="210" width="144" height="104" rx="8" transform="rotate(3 470 262)"/>
      <rect x="558" y="226" width="144" height="104" rx="8" transform="rotate(-2 630 278)"/>
      <rect x="94" y="368" width="144" height="104" rx="8" transform="rotate(-3 166 420)"/>
      <rect x="254" y="376" width="144" height="104" rx="8" transform="rotate(2 326 428)"/>
      <rect x="414" y="360" width="144" height="104" rx="8" transform="rotate(-3 486 412)"/>
      <rect x="574" y="376" width="144" height="104" rx="8" transform="rotate(2 646 428)"/>
    </g>
    <rect x="362" y="192" width="216" height="152" rx="10" fill="${p[4]}" stroke="${p[1]}" stroke-width="9"/>
    <rect x="390" y="222" width="128" height="12" fill="${p[1]}"/>
    <rect x="390" y="250" width="158" height="8" fill="${p[1]}" opacity="0.55"/>
    <rect x="390" y="272" width="112" height="8" fill="${p[1]}" opacity="0.55"/>
    <g fill="${p[2]}">
      <rect x="60" y="518" width="58" height="24" rx="4"/><rect x="126" y="518" width="58" height="24" rx="4"/><rect x="192" y="518" width="58" height="24" rx="4"/><rect x="258" y="518" width="58" height="24" rx="4"/><rect x="324" y="518" width="58" height="24" rx="4"/>
    </g>
  `),
  forms: (p) => svgWrap(p, 800, 600, `
    <rect x="62" y="78" width="306" height="444" rx="12" fill="${p[4]}" stroke="${p[1]}" stroke-width="4"/>
    <rect x="432" y="78" width="306" height="444" rx="12" fill="${p[4]}" stroke="${p[1]}" stroke-width="4"/>
    <g fill="${p[1]}">
      <rect x="96" y="116" width="152" height="14"/><rect x="96" y="150" width="226" height="7" opacity="0.55"/><rect x="96" y="170" width="198" height="7" opacity="0.55"/>
      <rect x="466" y="116" width="152" height="14"/><rect x="466" y="150" width="226" height="7" opacity="0.55"/><rect x="466" y="170" width="198" height="7" opacity="0.55"/>
    </g>
    <g fill="none" stroke="${p[1]}" stroke-width="4">
      <rect x="96" y="210" width="238" height="44" rx="6"/><rect x="96" y="278" width="238" height="44" rx="6"/><rect x="96" y="346" width="238" height="44" rx="6"/>
      <rect x="466" y="210" width="238" height="44" rx="6"/><rect x="466" y="278" width="238" height="44" rx="6"/><rect x="466" y="346" width="238" height="44" rx="6"/>
    </g>
    <path d="M96 428 H334" stroke="${p[3]}" stroke-width="5"/>
    <path d="M466 428 H704" stroke="${p[1]}" stroke-width="5" stroke-dasharray="10 8"/>
    <g stroke="${p[1]}" stroke-width="11" stroke-linecap="round" opacity="0.9">
      <path d="M500 400 L670 470"/>
      <path d="M670 400 L500 470"/>
    </g>
    <rect x="516" y="490" width="138" height="12" fill="${p[1]}" opacity="0.7"/>
  `),
  invite: (p) => svgWrap(p, 800, 600, `
    <rect x="96" y="66" width="608" height="468" rx="14" fill="${p[4]}" stroke="${p[1]}" stroke-width="5"/>
    <rect x="128" y="98" width="544" height="20" fill="${p[1]}"/>
    <rect x="128" y="146" width="302" height="14" fill="${p[1]}" opacity="0.8"/>
    <rect x="128" y="176" width="420" height="8" fill="${p[1]}" opacity="0.5"/>
    <rect x="128" y="198" width="386" height="8" fill="${p[1]}" opacity="0.5"/>
    <rect x="128" y="246" width="248" height="76" rx="8" fill="${p[3]}" opacity="0.8"/>
    <circle cx="596" cy="302" r="72" fill="none" stroke="${p[1]}" stroke-width="7"/>
    <circle cx="596" cy="302" r="48" fill="none" stroke="${p[1]}" stroke-width="3"/>
    <path d="M568 302 l20 20 l40 -46" fill="none" stroke="${p[1]}" stroke-width="8" stroke-linecap="round" stroke-linejoin="round"/>
    <g fill="${p[2]}">
      <rect x="150" y="468" width="18" height="18" transform="rotate(14 159 477)"/>
      <rect x="232" y="456" width="14" height="14" transform="rotate(-22 239 463)"/>
      <rect x="310" y="476" width="16" height="16" transform="rotate(31 318 484)"/>
      <rect x="408" y="454" width="12" height="12" transform="rotate(-14 414 460)"/>
      <rect x="492" y="474" width="18" height="18" transform="rotate(18 501 483)"/>
    </g>
  `),
};

// --- film definitions ---------------------------------------------------------------------

const FILMS = [
  {
    key: "ussy",
    id: "pkg_richussy20261020",
    title: "Slop Illustrated / ussy.host — The Issue Is the Argument",
    palette: ["#F4EBDD", "#171512", "#D9381E", "#0047AB", "#B45309"],
    theme: { font: "Inter", text: "#171512", text_muted: "#6B5A4A", text_on_accent: "#F4EBDD" },
    voice: { enabled: true, engine: "kokoro", voice: "am_michael", speed: 0.97, language: "en-us", chunking: "paragraph" },
    targetFrames: 3240,
    sceneSeconds: 126,
    sourceNote: "Public issue descriptions and project repositories; conceptual illustrations, not screenshots.",
    warnings: [
      "Generated stills and plates are conceptual illustrations, not screenshots of the site or applications.",
      "The site’s display fonts are not redistributed; the render uses Inter and JetBrains Mono.",
      "Narration is planned with Kokoro on CPU; no GPU or narration job was run by this build.",
    ],
    scenes: [
      {
        id: "s_u01", layout: "title", variant: "centered", seconds: 7,
        copy: { kicker: "A FIELD JOURNAL OF SOFTWARE", headline: "The Issue Is the Argument", sub: "SLOP Illustrated · Issue 01 · October 2026" },
        narration: "Every software project arrives with a changelog. Almost none arrive with a point of view.",
        motion: { recipe: "kinetic", seed: 101, intensity: 0.6, entry: "waterfall" },
        transitionOut: { type: "paper-reveal", frames: 16 },
        still: { prompt: "Overhead editorial still life of a cream-paper magazine folio advancing through a black cast-iron printing press, vermilion and cobalt ink rollers, visible paper fibers, halftone grain, deep soft shadows, warm gallery light from the left, calm upper third, no lettering, no logos, no watermark", seed: 1101 },
        plate: { prompt: "Use the provided start image as the first frame. The camera is static; the paper advances one step as the ink roller turns; dust motes drift through the light. Slow continuous motion, no cuts, no audio", frames: 121, role: "hero", scrim: 0.42 },
      },
      {
        id: "s_u02", layout: "hero", variant: "split", seconds: 10,
        copy: { kicker: "ISSUE 01 / OCTOBER 2026", headline: "Eleven projects. One editorial argument.", body: "Repositories treated as folios: edited, illustrated, sourced. The page is the interface." },
        narration: "SLOP Illustrated is a field journal of software and the work behind it. Issue one, October 2026: eleven projects, set like folios in a magazine.",
        transitionOut: { type: "paper-reveal", frames: 18 },
        still: { prompt: "Layered paper-cut collage of an open software magazine on a cream desk, folios fanning in precise registration, cut-paper edges, offset shadows, vermilion and cobalt accents, small halftone dots, warm side light, calm right third, no lettering, no logos, no watermark", seed: 1102, panel: { x: 0.78, y: 0.5, w: 0.38, anim: "ken-burns" } },
      },
      {
        id: "s_u03", layout: "list", variant: "bullets", seconds: 11,
        copy: { kicker: "METHOD / THREE MOVES", headline: "A repository is a story with receipts.", items: ["Read the source, not the screenshot", "Draw the mechanism, label the fiction", "Keep the upstream name in the frame"] },
        narration: "The premise is simple: treat a repository as a story worth editing, illustrating, and sourcing.",
        motion: { recipe: "sketch", seed: 103, intensity: 0.66, cue_phrases: ["repository", "story", "sourcing"] },
        transitionOut: { type: "draw-reveal", frames: 16 },
        svg: { id: "sketch", x: 0.79, y: 0.5, w: 0.36, anim: "fade-in" },
      },
      {
        id: "s_u04", layout: "hero", variant: "split", seconds: 12,
        copy: { kicker: "SOURCE · GITHUB.COM/MOJOMAST/ORBITDESKTOP", headline: "The workspace the agent can reshape.", body: "Movable panes, opt-in Docking, a Three.js spatial view. Layout and receipts live in local SQLite. The controller is read-only by default." },
        narration: "OrbitDesktop is the cover story: a browser desktop where a bound agent can rearrange panes, with layouts and revisions kept in local SQLite. Read-only by default.",
        motion: { recipe: "technical-flow", seed: 104, intensity: 0.62, cue_phrases: ["agent", "panes", "SQLite"] },
        transitionOut: { type: "draw-reveal", frames: 16 },
        still: { prompt: "Isometric cutaway of a browser desktop floating in a dark studio, translucent application panes at different depths, a terminal, a file pane and a chat pane, subtle cyan edge light, brushed dark surfaces, a thin gold path to a small local database cube, cinematic product photography, calm right third, no lettering, no logos, no watermark, no readable UI text", seed: 1104 },
        plate: { prompt: "Use the provided start image as the first frame. The camera is static while one pane slides gently into a new position and the gold path pulses once. Subtle parallax, static framing, no cuts, no audio", frames: 97, role: "background", scrim: 0.36 },
      },
      {
        id: "s_u05", layout: "compare", seconds: 12,
        copy: { kicker: "SOURCE · GITHUB.COM/MOJOMAST/VELVETRP", headline: "The model proposes. The server decides.", sub: "Committed actions leave a receipt; narration cannot overwrite state." },
        narration: "VelvetRP makes the division explicit. The model proposes what happens next; the server decides what became true, and every committed action leaves a receipt.",
        motion: { recipe: "focus", seed: 105, intensity: 0.55, focus: { x: 0.41, y: 0.7, width: 0.18, height: 0.2 } },
        transitionOut: { type: "fade", frames: 14 },
        media: [
          { procedural: { pattern: "grain", seed: 501, palette: ["#F4EBDD", "#D9381E", "#B45309"] }, label: "MODEL PROPOSES" },
          { procedural: { pattern: "grid", seed: 502, palette: ["#F4EBDD", "#171512", "#0047AB"] }, label: "SERVER DECIDES" },
        ],
        svg: { id: "receipt", x: 0.5, y: 0.84, w: 0.18, anim: "fade-in" },
      },
      {
        id: "s_u06", layout: "split", seconds: 13,
        copy: { kicker: "SOURCE · COCS / COCS-GODOT", headline: "Same arena. Different front end.", sub: "A predicting browser client; a native Godot 4.5 client; one Node server." },
        narration: "CoCS runs a sixty-hertz authoritative simulation, with the browser predicting ahead. CoCS-Godot keeps that same Node server and rebuilds the client natively in Godot 4.5. Same arena, different front end.",
        media: [],
        motion: { recipe: "morph", seed: 106, intensity: 0.62, morph: { from: "circle", to: "square" } },
        transitionOut: { type: "draw-reveal", frames: 16 },
        still: { prompt: "Wide conceptual shot of a stylized low-poly esports arena at dusk, split composition with a translucent browser window on the left and a native game view on the right, both looking at the same arena, a small authoritative server rack centered below, cool blue and signal-magenta lighting, light haze, cinematic depth, no lettering, no logos, no watermark, no readable HUD text", seed: 1106 },
        plate: { prompt: "Use the provided start image as the first frame. The camera is static while the two client views parallax and the server rack status light pulses once. Static framing, no cuts, no audio", frames: 97, role: "background", scrim: 0.2 },
        mediaMode: "still-procedural",
      },
      {
        id: "s_u07", layout: "code", seconds: 12,
        copy: { kicker: "SOURCE · GITHUB.COM/MOJOMAST/ROUTETOK", headline: "Fail before the first word." },
        narration: "RouteTok routes between model providers and fails over only before output starts. Once a stream is committed, it would rather report an interruption than splice two models together.",
        code: { language: "ts", code: "if (state.circuitState === \"open\") {\n  if (!state.circuitOpenUntil || state.circuitOpenUntil > now) return false;\n  state.circuitState = \"half-open\";\n}", highlights: [1, 3], typing: { charsPerSecond: 24 } },
        motion: { recipe: "focus", seed: 107, intensity: 0.55, focus: { x: 0.12, y: 0.3, width: 0.7, height: 0.28 } },
        transitionOut: { type: "draw-reveal", frames: 16 },
      },
      {
        id: "s_u08", layout: "list", variant: "bullets", seconds: 11,
        copy: { kicker: "SOURCE · RGI / MOTHBAKE", headline: "Make the state visible.", items: ["One keyboard lamp per agent session", "Green, white, blinking red", "Layered SHA-256 identity for every bake"] },
        narration: "RGBAgentFlightIndicator gives each agent session a keyboard lamp. MothBake gives every baked asset a layered content identity. Different scales, same instinct: make the state visible.",
        transitionOut: { type: "paper-reveal", frames: 16 },
        still: { prompt: "Macro editorial photograph of a dark mechanical keyboard with twelve small status lamps in a row, green, white and one blinking red, shallow depth of field, dust on the keycaps, warm desk light, a stack of translucent paper layers softly out of focus behind, precise product composition, no lettering, no logos, no watermark", seed: 1108 },
        plate: { prompt: "Use the provided start image as the first frame. The camera is static while the lamps cycle once from green to white to a single red blink; the translucent layers shift two millimeters. Static framing, no cuts, no audio", frames: 81, role: "background", scrim: 0.44 },
      },
      {
        id: "s_u09", layout: "hero", variant: "split", seconds: 12,
        copy: { kicker: "SOURCE · HERMESDASHBOARD / BECOMUSSY", headline: "Follow the work, not the log line.", body: "A live child-session drawer and a five-layer memory model. High-risk identity changes wait for a human." },
        narration: "HermesDashboard follows a child agent while it works. Becomussy gives memory five types, a versioned self-model, and a human approval gate for high-risk identity changes.",
        motion: { recipe: "focus", seed: 109, intensity: 0.58, focus: { x: 0.55, y: 0.24, width: 0.34, height: 0.42 } },
        transitionOut: { type: "fade", frames: 16 },
        still: { prompt: "Dark operator console in a quiet room, translucent graph of sessions connected to files, tools, models and skills, one child session panel floating above the graph, a stack of five colored memory layers at the right edge, violet and magenta trace lights, deep blacks, cinematic screen glow, no lettering, no logos, no watermark, no readable UI text", seed: 1109 },
        plate: { prompt: "Use the provided start image as the first frame. The camera is static while the graph edges ripple once and the child node expands while the memory layers settle. Slow continuous motion, no cuts, no audio", frames: 97, role: "background", scrim: 0.4 },
      },
      {
        id: "s_u10", layout: "title", variant: "centered", seconds: 8,
        copy: { kicker: "THE CONTENTS PAGE", headline: "Show the work. Credit the foundations.", sub: "The most radical thing in the issue is a source line." },
        narration: "The through-line is printed on the contents page: show the work; credit the foundations.",
        motion: { recipe: "kinetic", seed: 110, intensity: 0.7, entry: "maskRise" },
        transitionOut: { type: "paper-reveal", frames: 18 },
      },
      {
        id: "s_u11", layout: "code", seconds: 11,
        copy: { kicker: "SOURCE · MOTHBAKE @ 93E1825 · MIT", headline: "Provenance is a build step." },
        narration: "That means source links, labelled fixtures, conceptual art marked as conceptual, and upstream projects named instead of absorbed.",
        code: { language: "js", code: "export function hashBytes(bytes) {\n  if (!(bytes instanceof Uint8Array)) throw new TypeError('hashBytes requires bytes');\n  return createHash('sha256').update(bytes).digest('hex');\n}", highlights: [3], typing: { charsPerSecond: 22 } },
        transitionOut: { type: "draw-reveal", frames: 16 },
      },
      {
        id: "s_u12", layout: "title", variant: "outro", seconds: 9,
        copy: { kicker: "ISSUE 01 · OCTOBER 2026", headline: "Eleven folios. One argument.", sub: "ussy.host", cta: "Read the issue" },
        narration: "Eleven folios. One argument. Read the issue at ussy dot host.",
        motion: { recipe: "kinetic", seed: 112, intensity: 0.64, entry: "waterfall" },
        still: { prompt: "Overhead editorial still life of a cream-paper magazine folio advancing through a black cast-iron printing press, vermilion and cobalt ink rollers, visible paper fibers, halftone grain, deep soft shadows, warm gallery light from the left, calm upper third, no lettering, no logos, no watermark", seed: 1101, reuse: "s_u01" },
        plate: { prompt: "Use the provided start image as the first frame. The camera holds while the press settles and dust drifts through the light. Static framing, no cuts, no audio", frames: 97, role: "background", scrim: 0.5, reuse: "s_u01" },
      },
    ],
    svgs: [
      { key: "sketch", scene: "s_u03", file: "u_s03_sketch.svg", make: SVG.sketch, x: 0.82, y: 0.48, w: 0.28 },
      { key: "receipt", scene: "s_u05", file: "u_s05_receipt.svg", make: SVG.receipt, x: 0.5, y: 0.74, w: 0.15 },
    ],
  },
  {
    key: "hermes",
    id: "pkg_richhermes20261020",
    title: "Hermes Agent: The Threshold",
    palette: ["#070B14", "#F5C451", "#58C7D6", "#F2F0E9", "#E4573D"],
    theme: { font: "JetBrains Mono", text: "#F2F0E9", text_muted: "#9BA6B2", text_on_accent: "#070B14" },
    voice: { enabled: true, engine: "kokoro", voice: "af_heart", speed: 0.98, language: "en-us", chunking: "paragraph" },
    targetFrames: 3600,
    sceneSeconds: 130,
    sourceNote: "Public Hermes Agent release notes and documentation; conceptual illustrations, not product screenshots.",
    warnings: [
      "Generated stills and plates are conceptual illustrations, not recordings of the Hermes UI.",
      "The film covers v0.22.0 and v0.22.2; the known issue from v0.22.2 is stated on screen.",
      "Reviewed plugins are catalog-reviewed, not a security guarantee. Narration is planned with Kokoro on CPU.",
    ],
    scenes: [
      {
        id: "s_h01", layout: "title", variant: "centered", seconds: 8,
        copy: { kicker: "NOUS RESEARCH / HERMES AGENT", headline: "The Threshold", sub: "v0.22.0 · 2026-10-13 · v0.22.2 · 2026-10-15" },
        narration: "Every agent demo ends at the same door: the moment the demo has to become a working day.",
        motion: { recipe: "kinetic", seed: 201, intensity: 0.6, entry: "waterfall" },
        transitionOut: { type: "fade", frames: 18 },
        still: { prompt: "Monumental threshold in a dark concrete wall, a tall rectangular doorway opening onto warm gold light, thin dust in the air, brushed metal frame, minimal brutalist architecture, deep shadows, cinematic wide shot, calm upper third, no lettering, no logos, no watermark, no people", seed: 2101 },
        plate: { prompt: "Use the provided start image as the first frame. The camera is static; the light breathes once and dust drifts through the beam. Slow continuous motion, no cuts, no audio", frames: 121, role: "hero", scrim: 0.45 },
      },
      {
        id: "s_h02", layout: "hero", variant: "split", seconds: 10,
        copy: { kicker: "MIT · MODEL-AGNOSTIC", headline: "One agent, several surfaces.", body: "A terminal, a desktop app, and a messaging gateway share the same agent loop." },
        narration: "Hermes Agent is Nous Research's open-source agent. MIT-licensed, model-agnostic, and reachable from a terminal, a desktop app, or a messaging gateway.",
        transitionOut: { type: "draw-reveal", frames: 16 },
        still: { prompt: "Editorial photograph of a quiet developer desk at night, a terminal window glowing on a large monitor, a laptop and a phone at the edge of the frame, warm desk lamp and cool screen light, shallow depth of field, dark room, calm right third, no lettering, no logos, no watermark, no readable UI text", seed: 2102, panel: { x: 0.78, y: 0.5, w: 0.38, anim: "ken-burns" } },
      },
      {
        id: "s_h03", layout: "hero", variant: "split", seconds: 11,
        copy: { kicker: "V0.22.0 · GUIDED SETUP", headline: "The first conversation needs no key.", body: "A guided setup chat runs on a free trial model, once per OS user. Skip it, or run it again from Settings." },
        narration: "Version 0.22.0, the Threshold Release, opens a fresh desktop install with a guided setup chat on a free trial model, so the first conversation does not require an API key.",
        motion: { recipe: "paper-cut", seed: 203, intensity: 0.64 },
        transitionOut: { type: "paper-reveal", frames: 18 },
        still: { prompt: "Overhead paper-cut collage of a guided software setup, five clean cards laid out in a gentle diagonal, each with a simple abstract icon, warm cream paper, teal and gold accents, soft offset shadows, a tiny door icon at the end of the path, calm right third, no lettering, no logos, no watermark", seed: 2103 },
        plate: { prompt: "Use the provided start image as the first frame. The camera holds while the five cards settle into place one after another and the final door icon opens a crack of light. Static framing, no cuts, no audio", frames: 97, role: "background", scrim: 0.4 },
      },
      {
        id: "s_h04", layout: "list", variant: "bullets", seconds: 12,
        copy: { kicker: "V0.22.0 · CONNECTORS", headline: "Connectors meet you inside the app.", items: ["Linear and Notion via the Nous tool gateway", "One browser sign-in; tools in the same turn", "Named work and home accounts"] },
        narration: "Connectors carry it into hosted apps like Linear and Notion through the Nous tool gateway. Sign in once, and the tools arrive in the same turn.",
        motion: { recipe: "technical-flow", seed: 204, intensity: 0.64, cue_phrases: ["Linear", "Notion", "same turn"] },
        transitionOut: { type: "draw-reveal", frames: 16 },
        still: { prompt: "Dark architectural wall of connected app cards, each card a different muted color, thin cyan cables running to a central matte-black hub, a small browser sign-in card glowing at the edge, soft volumetric light, clean product-diagram aesthetic, no lettering, no logos, no watermark, no readable UI text", seed: 2104 },
        svg: { id: "hub", x: 0.8, y: 0.52, w: 0.36, anim: "fade-in" },
      },
      {
        id: "s_h05", layout: "hero", variant: "split", seconds: 12,
        copy: { kicker: "V0.22.0 · LOCAL MODELS", headline: "Local models come home.", body: "llama.cpp is installed and maintained for CPU, CUDA, Metal, Vulkan or ROCm; catalog models are rated against the machine." },
        narration: "Local models bring it home: a one-click llama.cpp runtime picks an engine for CPU, CUDA, Metal, Vulkan or ROCm, and rates catalog models against your hardware.",
        motion: { recipe: "morph", seed: 205, intensity: 0.6, morph: { from: "circle", to: "square" } },
        transitionOut: { type: "draw-reveal", frames: 16 },
        still: { prompt: "Small local AI workstation on a wooden desk, compact GPU enclosure with a soft cyan light strip, a laptop showing an abstract model graph, a router and a coffee cup at the edge, warm room light mixed with cool device glow, shallow depth of field, calm right third, no lettering, no logos, no watermark, no readable UI text", seed: 2105 },
        plate: { prompt: "Use the provided start image as the first frame. The camera is static; the cyan light strip pulses once and the laptop graph rotates a few degrees. Slow continuous motion, no cuts, no audio", frames: 97, role: "hero", scrim: 0.4 },
      },
      {
        id: "s_h06", layout: "compare", seconds: 11,
        copy: { kicker: "V0.22.0 · STABLE CHANNELS", headline: "Stable, signed, switchable.", sub: "Tested SemVer releases, signed desktop packages, one package manager." },
        narration: "The release also hardens the threshold: tested SemVer stable channels, signed desktop packages including a Microsoft Store MSIX, and one package manager underneath.",
        motion: { recipe: "focus", seed: 206, intensity: 0.56, focus: { x: 0.39, y: 0.68, width: 0.22, height: 0.22 } },
        transitionOut: { type: "fade", frames: 14 },
        media: [
          { procedural: { pattern: "grid", seed: 601, palette: ["#070B14", "#F5C451", "#F2F0E9"] }, label: "MAIN · EVERY COMMIT" },
          { procedural: { pattern: "dots", seed: 602, palette: ["#070B14", "#58C7D6", "#F2F0E9"] }, label: "STABLE · TESTED RELEASE" },
        ],
        svg: { id: "channels", x: 0.5, y: 0.84, w: 0.18, anim: "fade-in" },
      },
      {
        id: "s_h07", layout: "chart", variant: "bar", seconds: 12,
        data: { dataset: "d_release_gap", display: "bar" },
        copy: { kicker: "PUBLIC RELEASE TIMESTAMPS", headline: "A fortnight, then a run.", sub: "Days between dated releases, September 14 to October 15.", footnote: "Computed 2026-10-20 from GitHub release timestamps. Descriptive, not a quality metric." },
        narration: "The cadence tells its own story: seven days between the September 14 and September 21 releases, then three, then a fortnight, then three, two, one, one into October 15.",
        motion: { recipe: "kinetic", seed: 207, intensity: 0.5, entry: "countUp" },
        transitionOut: { type: "fade", frames: 14 },
      },
      {
        id: "s_h08", layout: "list", variant: "bullets", seconds: 10,
        copy: { kicker: "V0.22.0 · PLUGIN CATALOG", headline: "Six hundred reviewed entries.", items: ["Each pinned to a reviewed commit", "Catalog review is not a security guarantee", "Pinned means inspectable, not risk-free"] },
        narration: "The plugin catalog reached six hundred reviewed entries, each pinned to a reviewed commit. Reviewed is not the same as risk-free.",
        transitionOut: { type: "paper-reveal", frames: 16 },
        still: { prompt: "Wall of wooden card-catalog drawers in a warm archive room, hundreds of small paper tabs, one drawer pulled open with a single index card, soft dust in the light, olive and ochre palette, shallow depth of field, calm right third, no lettering, no logos, no watermark, no readable labels", seed: 2108 },
        plate: { prompt: "Use the provided start image as the first frame. The camera is static while one drawer slides open and its index card lifts slightly. Static framing, no cuts, no audio", frames: 81, role: "background", scrim: 0.5 },
        svg: { id: "catalog", x: 0.82, y: 0.5, w: 0.3, anim: "fade-in" },
      },
      {
        id: "s_h09", layout: "hero", variant: "split", seconds: 12,
        copy: { kicker: "V0.22.0 · SUBAGENTS", headline: "Subagents stay in sight.", body: "Task, elapsed time, live transcript, Steer and Stop. The parent keeps the thread; the children do the work." },
        narration: "Subagents stay visible above the composer, with task, elapsed time, live transcript, and Steer and Stop controls.",
        motion: { recipe: "technical-flow", seed: 209, intensity: 0.66, cue_phrases: ["task", "transcript", "Steer"] },
        transitionOut: { type: "draw-reveal", frames: 16 },
        still: { prompt: "Abstract multi-agent workspace floating in a dark room, one large parent thread and three smaller child threads connected by thin gold lines, each child with a narrow live-transcript strip, soft glass panels, cyan and gold accents, precise information-design aesthetic, no lettering, no logos, no watermark, no readable text", seed: 2109 },
        plate: { prompt: "Use the provided start image as the first frame. The camera is static while its transcript strip scrolls a few lines and one branch extends right. Slow continuous motion, no cuts, no audio", frames: 97, role: "background", scrim: 0.4 },
      },
      {
        id: "s_h10", layout: "code", seconds: 11,
        copy: { kicker: "V0.22.2 · 2026-10-15", headline: "The patch fixes the door." },
        narration: "Then the patch. Version 0.22.2 fixes a gateway that could mistake an unrelated process for a live one after reboot, and long local-model turns on laptops.",
        code: { language: "bash", code: "hermes update\nhermes doctor\nhermes model", highlights: [1], typing: { charsPerSecond: 18 } },
        motion: { recipe: "focus", seed: 210, intensity: 0.58, focus: { x: 0.12, y: 0.16, width: 0.34, height: 0.2 } },
        transitionOut: { type: "fade", frames: 14 },
        still: { prompt: "Close-up of a dark server-room door with a small brass PID plate, a thin wrench resting on a ledge, warm indicator light, brushed metal and concrete, shallow depth of field, cinematic side light, calm right third, no lettering, no logos, no watermark, no readable text", seed: 2110, panel: { x: 0.8, y: 0.5, w: 0.34, anim: "fade-in" } },
      },
      {
        id: "s_h11", layout: "compare", seconds: 11,
        copy: { kicker: "V0.22.2 · KNOWN ISSUE", headline: "What still sticks.", sub: "Sessions from the v0.22.1 gateway cannot be deleted in v0.22.2." },
        narration: "It also carries a known issue: sessions that ran under the 0.22.1 gateway cannot be deleted in 0.22.2. That is the unglamorous part of an agent growing up.",
        motion: { recipe: "paper-cut", seed: 211, intensity: 0.6 },
        transitionOut: { type: "paper-reveal", frames: 16 },
        media: [
          { procedural: { pattern: "grain", seed: 603, palette: ["#070B14", "#58C7D6", "#F2F0E9"] }, label: "FIXED" },
          { procedural: { pattern: "grid", seed: 604, palette: ["#070B14", "#E4573D", "#F2F0E9"] }, label: "KNOWN ISSUE" },
        ],
        svg: { id: "issue", x: 0.5, y: 0.84, w: 0.2, anim: "fade-in" },
      },
      {
        id: "s_h12", layout: "title", variant: "outro", seconds: 10,
        copy: { kicker: "MIT · NOUS RESEARCH", headline: "The door is the product.", sub: "hermes-agent.nousresearch.com/docs", cta: "Sources in the release notes" },
        narration: "Hermes Agent. The door is the product. Docs at hermes-agent dot nousresearch dot com.",
        motion: { recipe: "kinetic", seed: 212, intensity: 0.64, entry: "maskRise" },
        still: { prompt: "Monumental threshold in a dark concrete wall, a tall rectangular doorway opening onto warm gold light, thin dust in the air, brushed metal frame, minimal brutalist architecture, deep shadows, cinematic wide shot, calm upper third, no lettering, no logos, no watermark, no people", seed: 2101, reuse: "s_h01" },
        plate: { prompt: "Use the provided start image as the first frame. The camera holds while the doorway light settles and dust drifts. Static framing, no cuts, no audio", frames: 97, role: "background", scrim: 0.55, reuse: "s_h01" },
      },
    ],
    datasets: {
      d_release_gap: {
        unit: "days",
        label: "Days between dated Hermes Agent releases",
        values: [
          { label: "09-14 to 09-21", value: 7 },
          { label: "09-21 to 09-24", value: 3 },
          { label: "09-24 to 10-08", value: 14 },
          { label: "10-08 to 10-11", value: 3 },
          { label: "10-11 to 10-13", value: 2 },
          { label: "10-13 to 10-14", value: 1 },
          { label: "10-14 to 10-15", value: 1 },
        ],
        source: "derived",
        approved: true,
        source_url: "https://github.com/NousResearch/hermes-agent/releases",
        retrieved_at: FIXED_AT,
        note: "Computed from public GitHub release timestamps. Descriptive only; not a performance claim.",
      },
    },
    svgs: [
      { key: "hub", scene: "s_h04", file: "h_s04_hub.svg", make: SVG.hub, x: 0.84, y: 0.46, w: 0.26 },
      { key: "channels", scene: "s_h06", file: "h_s06_channels.svg", make: SVG.channels, x: 0.5, y: 0.74, w: 0.15 },
      { key: "catalog", scene: "s_h08", file: "h_s08_catalog.svg", make: SVG.catalog, x: 0.84, y: 0.46, w: 0.24 },
      { key: "issue", scene: "s_h11", file: "h_s11_issue.svg", make: SVG.issue, x: 0.5, y: 0.74, w: 0.16 },
    ],
  },
  {
    key: "ministry",
    id: "pkg_richministry20261020",
    title: "The Ministry of Mandatory Spontaneity",
    palette: ["#D8CDB8", "#6E1E24", "#3E5C4B", "#23405C", "#F6F1E6"],
    theme: { font: "Inter", text: "#231A16", text_muted: "#6B5A4A", text_on_accent: "#F6F1E6" },
    voice: { enabled: true, engine: "kokoro", voice: "bm_george", speed: 0.96, language: "en-gb", chunking: "paragraph" },
    targetFrames: 3150,
    sceneSeconds: 126,
    sourceNote: "Fictional civic satire. No real institution, person, statistic, or policy is depicted.",
    warnings: [
      "Fictional satire: every institution, statistic, form and official is invented.",
      "FICTIONAL TELEMETRY is labelled on screen; no real government marks or data are used.",
      "Narration is planned with Kokoro on CPU; no GPU or narration job was run by this build.",
    ],
    scenes: [
      {
        id: "s_m01", layout: "title", variant: "centered", seconds: 8,
        copy: { kicker: "A FICTIONAL CIVIC SATIRE", headline: "The Ministry of Mandatory Spontaneity", sub: "Because freedom works better with deadlines." },
        narration: "In a country that had eliminated every unnecessary surprise, one department was created to bring surprise back — on schedule.",
        motion: { recipe: "kinetic", seed: 301, intensity: 0.58, entry: "waterfall" },
        transitionOut: { type: "paper-reveal", frames: 18 },
        still: { prompt: "Monumental brutalist government building at dawn, wet concrete plaza, one warm lit window high in the facade, low fog, severe symmetry, a few pieces of confetti falling in a suspiciously even grid, muted beige and oxblood palette, cinematic wide shot, calm upper third, no lettering, no logos, no watermark, no people", seed: 3101 },
        plate: { prompt: "Use the provided start image as the first frame. The camera is static; confetti falls in synchronized rows, one piece drifting slightly out of line. Slow continuous motion, no cuts, no audio", frames: 121, role: "hero", scrim: 0.45 },
      },
      {
        id: "s_m02", layout: "stat", seconds: 9,
        data: { dataset: "d_joy_drop", display: "number" },
        copy: { kicker: "FICTIONAL TELEMETRY", headline: "Spontaneous joy fell 0.4%.", sub: "A crisis, by ministry standards.", body: "FICTIONAL TELEMETRY" },
        narration: "The Ministry of Mandatory Spontaneity began with a modest finding: spontaneous joy had fallen zero point four percent. A crisis, by ministry standards.",
        transitionOut: { type: "fade", frames: 14 },
        svg: { id: "memo", x: 0.8, y: 0.5, w: 0.34, anim: "fade-in" },
      },
      {
        id: "s_m03", layout: "hero", variant: "split", seconds: 11,
        copy: { kicker: "FORM 7-B · PLEASE ALLOW 48 HOURS", headline: "Request for Unplanned Joy.", body: "State the date of the spontaneous event, the reason it could not be planned, and the anticipated surprise level." },
        narration: "Citizens who wished to be surprised were asked to file Form Seven-B: Request for Unplanned Joy. Please allow forty-eight hours' notice.",
        motion: { recipe: "sketch", seed: 303, intensity: 0.66, cue_phrases: ["Form Seven-B", "notice", "joy"] },
        transitionOut: { type: "draw-reveal", frames: 16 },
        still: { prompt: "Overhead photograph of an absurdly long paper form on a gray metal desk, many blank fields and checkboxes, a red rubber stamp and a paper clip, harsh fluorescent office light, carbon-copy paper texture, muted beige and oxblood palette, calm right third, no lettering, no logos, no watermark, no readable text", seed: 3103 },
        plate: { prompt: "Use the provided start image as the first frame. The camera holds while the form slides two centimeters left and the rubber stamp presses once, leaving a puff of paper dust. Static framing, no cuts, no audio", frames: 97, role: "background", scrim: 0.4 },
      },
      {
        id: "s_m04", layout: "compare", seconds: 11,
        copy: { kicker: "THE SPONTANEITY INSPECTORATE", headline: "Compliance rose. Laughter did not.", sub: "Picnics, street festivals, and unattended laughter are subject to audit." },
        narration: "The Spontaneity Inspectorate was formed to audit picnics, street festivals, and unattended laughter. Compliance rose. Laughter did not.",
        transitionOut: { type: "paper-reveal", frames: 16 },
        media: [
          { asset: "SELF_PLATE", fit: "cover", scrim: 0.25, label: "COMPLIANCE" },
          { procedural: { pattern: "grain", seed: 701, palette: ["#D8CDB8", "#6E1E24", "#3E5C4B"] }, label: "LAUGHTER" },
        ],
        still: { prompt: "Paper-cut collage of a picnic in a gray government park, a neat blanket with one paper cup, a clipboard-wielding inspector cut from beige paper, a row of stamped forms on the left, an empty patch of grass on the right, overcast light, muted institutional palette, no lettering, no logos, no watermark, no readable text", seed: 3104 },
        plate: { prompt: "Use the provided start image as the first frame. The camera is static; the inspector clipboard lifts and a single paper form slides across the blanket. Slow continuous motion, no cuts, no audio", frames: 97, role: "background", scrim: 0.2 },
      },
      {
        id: "s_m05", layout: "list", variant: "bullets", seconds: 12,
        copy: { kicker: "PROJECT SERENDIPITY · FICTIONAL TELEMETRY", headline: "A dashboard for chance encounters.", items: ["Schedule a coincidence to the minute", "Route it through approval", "Measure the unexpected"] },
        narration: "Project Serendipity built a dashboard for chance encounters. It could schedule a coincidence to the minute, but not explain why anyone would want one.",
        motion: { recipe: "technical-flow", seed: 305, intensity: 0.62, cue_phrases: ["dashboard", "coincidence", "minute"] },
        transitionOut: { type: "draw-reveal", frames: 16 },
        still: { prompt: "Retro-futurist civic control room, beige consoles and a large wall dashboard with abstract dials and a calendar grid, fluorescent overhead light, a single red telephone, worn carpet, muted institutional palette, wide shot with calm right third, no lettering, no logos, no watermark, no readable text", seed: 3105 },
        plate: { prompt: "Use the provided start image as the first frame. The camera is static; one tile flips and a dial needle ticks once. Slow continuous motion, no cuts, no audio", frames: 97, role: "background", scrim: 0.55 },
        svg: { id: "flow", x: 0.8, y: 0.52, w: 0.34, anim: "fade-in" },
      },
      {
        id: "s_m06", layout: "title", variant: "centered", seconds: 9,
        copy: { kicker: "THE WEEKLY CALENDAR", headline: "Surprise Tuesday moved to Wednesday.", sub: "Attendance improved. Surprise did not." },
        narration: "Surprise Tuesday was moved to Wednesday to avoid competing with the weekly planning meeting. Attendance improved. Surprise did not.",
        motion: { recipe: "kinetic", seed: 306, intensity: 0.62, entry: "maskRise" },
        transitionOut: { type: "draw-reveal", frames: 14 },
        svg: { id: "calendar", x: 0.5, y: 0.55, w: 0.5, anim: "fade-in" },
      },
      {
        id: "s_m07", layout: "list", variant: "bullets", seconds: 11,
        copy: { kicker: "PUBLIC CONSULTATION", headline: "One thousand comments. One request.", items: ["Fewer surprises, please", "Recorded as overwhelming enthusiasm", "No follow-up scheduled"] },
        narration: "The public consultation received one thousand comments, all requesting fewer surprises. The Ministry recorded this as overwhelming enthusiasm.",
        motion: { recipe: "paper-cut", seed: 307, intensity: 0.6 },
        transitionOut: { type: "paper-reveal", frames: 14 },
        svg: { id: "consult", x: 0.8, y: 0.5, w: 0.32, anim: "fade-in" },
      },
      {
        id: "s_m08", layout: "hero", variant: "split", seconds: 11,
        copy: { kicker: "CAMPAIGN · EXPECT THE UNEXPECTED", headline: "Shot from a script.", body: "Approved in triplicate. Released on a predictable schedule. The confetti is swept into a neat pile." },
        narration: "Its new campaign, “Expect the Unexpected,” was shot from a script, approved in triplicate, and released on a predictable schedule.",
        motion: { recipe: "focus", seed: 308, intensity: 0.56, focus: { x: 0.56, y: 0.28, width: 0.3, height: 0.34 } },
        transitionOut: { type: "fade", frames: 16 },
        still: { prompt: "Film set for a government advertising campaign, a blank billboard frame, a director chair, a clapperboard and neatly stacked cue cards, harsh set lighting, beige and oxblood palette, artificial confetti in a tidy pile, wide shot, calm right third, no lettering, no logos, no watermark, no readable text", seed: 3108 },
        plate: { prompt: "Use the provided start image as the first frame. The camera is static; the clapper closes once and a single confetti piece falls. Slow continuous motion, no cuts, no audio", frames: 97, role: "background", scrim: 0.4 },
      },
      {
        id: "s_m09", layout: "compare", seconds: 10,
        copy: { kicker: "ANONYMOUS SUGGESTION", headline: "Anonymous is not a signature.", sub: "The suggestion was rejected on a technicality." },
        narration: "A citizen submitted an anonymous suggestion. It was rejected because the signature line was blank.",
        motion: { recipe: "paper-cut", seed: 309, intensity: 0.6 },
        transitionOut: { type: "paper-reveal", frames: 14 },
        media: [
          { procedural: { pattern: "grain", seed: 702, palette: ["#D8CDB8", "#3E5C4B", "#F6F1E6"] }, label: "SIGNED" },
          { procedural: { pattern: "grid", seed: 703, palette: ["#D8CDB8", "#6E1E24", "#F6F1E6"] }, label: "ANONYMOUS" },
        ],
        svg: { id: "forms", x: 0.5, y: 0.84, w: 0.22, anim: "fade-in" },
      },
      {
        id: "s_m10", layout: "chart", variant: "bar", seconds: 12,
        data: { dataset: "d_spontaneity", display: "bar" },
        copy: { kicker: "FICTIONAL TELEMETRY", headline: "A hundred percent compliant. Zero percent spontaneous.", sub: "The gap was called promising.", footnote: "Fictional telemetry for satire; not real data." },
        narration: "By year's end, compliance reached one hundred percent. Spontaneity reached zero. The chart was described as a success story with a promising gap.",
        motion: { recipe: "focus", seed: 310, intensity: 0.5, focus: { x: 0.42, y: 0.34, width: 0.16, height: 0.4 } },
        transitionOut: { type: "fade", frames: 14 },
      },
      {
        id: "s_m11", layout: "hero", variant: "split", seconds: 12,
        copy: { kicker: "INCIDENT #0001", headline: "An unscheduled idea.", body: "Mara had it. The system logged it as an incident and routed it to the Committee for Unforeseen Outcomes." },
        narration: "Then a clerk named Mara had an idea nobody had scheduled. The system logged it as an incident and routed it to the Committee for Unforeseen Outcomes.",
        motion: { recipe: "morph", seed: 311, intensity: 0.62, morph: { from: "blob", to: "square" } },
        transitionOut: { type: "draw-reveal", frames: 16 },
        still: { prompt: "A tired clerk in a beige cardigan standing in a vast file room, face turned three-quarters away from camera, holding a small warm glowing sphere, shelves of identical folders receding into the background, fluorescent overhead light, one desk lamp, muted institutional palette with a single warm accent, cinematic medium shot, calm right third, no lettering, no logos, no watermark, no readable text, no close-up face", seed: 3111 },
        plate: { prompt: "Use the provided start image as the first frame. The camera is static; the clerk hand lifts slightly and the sphere pulses once. Slow continuous motion, no cuts, no audio", frames: 97, role: "hero", scrim: 0.4 },
      },
      {
        id: "s_m12", layout: "title", variant: "outro", seconds: 10,
        copy: { kicker: "THE COMMITTEE MEETS QUARTERLY", headline: "Please RSVP by Friday.", sub: "A celebration of spontaneous thinking.", cta: "FICTIONAL CIVIC SATIRE" },
        narration: "The Committee met quarterly. Its first act was to schedule a celebration of spontaneous thinking. Please RSVP by Friday.",
        motion: { recipe: "kinetic", seed: 312, intensity: 0.64, entry: "waterfall" },
        still: { prompt: "Formal government invitation card on a beige desk, embossed seal, a rubber stamp and a neat pile of confetti, harsh office light, oxblood and filing-green accents, shallow depth of field, calm center, no lettering, no logos, no watermark, no readable text", seed: 3112 },
        plate: { prompt: "Use the provided start image as the first frame. The camera holds while the stamp presses once and confetti falls in a perfectly even grid. Static framing, no cuts, no audio", frames: 121, role: "hero", scrim: 0.5 },
        svg: { id: "invite", x: 0.84, y: 0.22, w: 0.14, anim: "fade-in" },
      },
    ],
    datasets: {
      d_joy_drop: {
        unit: "percent",
        label: "Spontaneous joy, fictional annual change",
        values: [{ label: "Spontaneous joy", value: -0.4 }],
        source: "example",
        approved: true,
        note: "Fictional telemetry. Not a real statistic.",
      },
      d_spontaneity: {
        unit: "percent",
        label: "Fictional year-end scorecard",
        values: [
          { label: "Compliance", value: 100 },
          { label: "Spontaneity", value: 0 },
        ],
        source: "example",
        approved: true,
        note: "Fictional telemetry for satire. Not real data.",
      },
    },
    svgs: [
      { key: "memo", scene: "s_m02", file: "m_s02_memo.svg", make: SVG.memo, x: 0.82, y: 0.46, w: 0.28 },
      { key: "flow", scene: "s_m05", file: "m_s05_flow.svg", make: SVG.flow, x: 0.82, y: 0.48, w: 0.28 },
      { key: "calendar", scene: "s_m06", file: "m_s06_calendar.svg", make: SVG.calendar, x: 0.82, y: 0.5, w: 0.24 },
      { key: "consult", scene: "s_m07", file: "m_s07_consult.svg", make: SVG.consult, x: 0.82, y: 0.48, w: 0.26 },
      { key: "forms", scene: "s_m09", file: "m_s09_forms.svg", make: SVG.forms, x: 0.5, y: 0.74, w: 0.17 },
      { key: "invite", scene: "s_m12", file: "m_s12_invite.svg", make: SVG.invite, x: 0.86, y: 0.2, w: 0.1 },
    ],
  },
];

// --- deterministic timing -----------------------------------------------------------------

function applyTiming(film) {
  const transitions = film.scenes.reduce((sum, scene) => sum + (scene.transitionOut?.frames ?? 0), 0);
  const desiredSceneFrames = film.targetFrames + transitions;
  const seconds = film.scenes.reduce((sum, scene) => sum + scene.seconds, 0);
  let frames = film.scenes.map((scene) => Math.max(1, Math.round((scene.seconds / seconds) * desiredSceneFrames)));
  let diff = desiredSceneFrames - frames.reduce((a, b) => a + b, 0);
  frames[frames.length - 1] += diff;
  film.scenes.forEach((scene, index) => {
    scene.preferredFrames = frames[index];
  });
}

// --- asset builders -----------------------------------------------------------------------

// Plates with a one-shot event are retimed over the scene, not looped. Ambient plates may loop.
// This follows the measured plate policy: hold/retime a short clip, and loop only seamless motion.
const ONE_SHOT_PLATES = new Set([
  "s_u01", "s_u04", "s_u06", "s_u08", "s_u09", "s_u12",
  "s_h03", "s_h08", "s_h09",
  "s_m01", "s_m03", "s_m04", "s_m05", "s_m08", "s_m12",
]);

function plateFill(scene) {
  const loop = scene.plate?.loop ?? !ONE_SHOT_PLATES.has(scene.id);
  if (loop) return { loop: true };
  const clipSeconds = scene.plate.frames / 24;
  const sceneSeconds = scene.preferredFrames / 30;
  const speed = Math.max(0.25, Math.min(2, clipSeconds / Math.max(0.1, sceneSeconds)));
  return { loop: false, speed: Number(speed.toFixed(3)) };
}

function stillAsset({ film, scene, id, prompt, seed, reuse }) {
  return {
    kind: "image",
    origin: "generated",
    status: "pending",
    redistributable: true,
    license: { id: "CC0-1.0" },
    model_license: FLUX.license,
    gen: {
      generator: "flux3-klein",
      workflow: FLUX.workflow,
      workflow_sha256: sha256File(join(WORKFLOW_DIR, "flux3_klein_t2i.api.json")),
      model: FLUX.model,
      quantization: FLUX.quantization,
      seed,
      created_at: FIXED_AT,
      caption: prompt,
      inputs: { prompt, width: 1024, height: 576, seed, steps: 16 },
    },
    notes: reuse ? `Planned still; reuses the ${reuse} composition intent.` : "Planned still; no media generated by this build.",
  };
}

function plateAsset({ film, scene, id, prompt, frames, role, scrim, stillId, seed }) {
  return {
    kind: "video",
    origin: "generated",
    status: "pending",
    redistributable: true,
    license: { id: "CC0-1.0" },
    model_license: LTX.license,
    gen: {
      generator: "ltx25",
      workflow: LTX.workflow,
      workflow_sha256: sha256File(join(WORKFLOW_DIR, "ltx25_i2v_2stage.api.json")),
      model: LTX.model,
      quantization: LTX.quantization,
      seed,
      created_at: FIXED_AT,
      caption: /frame and framing never change/i.test(prompt) ? prompt : `${prompt.trim().replace(/[.\s]+$/, "")}. The frame and framing never change.`,
      inputs: {
        prompt: /frame and framing never change/i.test(prompt) ? prompt : `${prompt.trim().replace(/[.\s]+$/, "")}. The frame and framing never change.`,
        image: stillId,
        width: 1024,
        height: 576,
        frames,
        fps: 24,
        seed,
        stage2_seed: seed + 1,
        role,
        ...(role === "background" ? { strength: 1 } : {}),
      },
    },
    notes: `Planned LTX-2.5 i2v plate; ${frames} frames at 24 fps. No media generated by this build.`,
  };
}

function svgAsset({ film, spec }) {
  const palette = paletteFor(film);
  const raw = spec.make(palette);
  const clean = sanitizeSvg(raw);
  if (!clean.ok) throw new Error(`${film.key}/${spec.file}: sanitize failed: ${JSON.stringify(clean.errors)}`);
  const check = renderCheck(clean.svg, { width: 512, palette, minOpaqueFraction: 0.01 });
  if (!check.ok) throw new Error(`${film.key}/${spec.file}: render check failed: ${JSON.stringify(check.errors)}`);
  const bytes = Buffer.from(clean.svg, "utf8");
  const file = `assets/${spec.file}`;
  const target = join(OUT_DIRS[film.key], file);
  writeFileSync(target, bytes);
  return {
    kind: "svg",
    origin: "generated",
    status: "ready",
    file,
    sha256: sha256(bytes),
    bytes: bytes.length,
    redistributable: true,
    license: { id: "CC0-1.0" },
    source: { provider: "repo", title: "Original procedural SVG composition", creator: "Comfyrizz demos" },
    gen: {
      generator: "llm-svg",
      sanitizer_version: SANITIZER_VERSION,
      render_check: {
        ok: true,
        version: "1",
        rasterizer: "resvg",
        width: check.width,
        height: check.height,
        blank: false,
        palette_ok: check.outOfPaletteFraction === null || check.outOfPaletteFraction <= 0.5,
        at: FIXED_AT,
      },
      caption: `Original procedural SVG composition for ${film.key}/${spec.scene}.`,
    },
    notes: "Written by scripts/demos/build.mjs; sanitised and CPU render-checked.",
  };
}

// --- package assembly ---------------------------------------------------------------------

const OUT_DIRS = {};

function backgroundFor(film, scene, stillId, plateId) {
  if (scene.media) return undefined;
  if (scene.plate) {
    return { asset: plateId, fit: "cover", muted: true, scrim: scene.plate.scrim ?? 0.4, ...plateFill(scene) };
  }
  if (scene.still && !scene.still.panel) {
    return { asset: stillId, fit: "cover", scrim: 0.4 };
  }
  return { procedural: { pattern: scene.pattern ?? "grain", seed: scene.seed ?? 11, palette: film.palette.slice(0, 4) } };
}

function mediaFor(film, scene, stillId, plateId) {
  if (!scene.media) return undefined;
  if (scene.mediaMode === "still-procedural") {
    const asset = plateId ?? stillId;
    return [
      { asset, fit: "cover", scrim: 0.15, label: "BROWSER CLIENT", ...plateFill(scene) },
      { procedural: { pattern: "grid", seed: 503, palette: film.palette.slice(0, 4) }, label: "NATIVE CLIENT" },
    ];
  }
  return scene.media.map((item) => {
    if (item.asset === "SELF_PLATE") {
      return { asset: plateId, fit: item.fit ?? "cover", scrim: item.scrim ?? 0.2, label: item.label, ...plateFill(scene) };
    }
    return item;
  });
}

function buildScene(film, scene, svgByScene) {
  const assets = {};
  const prefix = film.key;
  const stillId = scene.still ? assetKey(prefix, scene.still.reuse ?? scene.id, "still") : null;
  const plateId = scene.plate ? assetKey(prefix, scene.plate.reuse ?? scene.id, "plate") : null;
  let foreground = [];

  if (scene.still && !scene.still.reuse) {
    assets[stillId] = stillAsset({
      film, scene, id: stillId, prompt: scene.still.prompt, seed: scene.still.seed, reuse: scene.still.reuse,
    });
    if (scene.still.panel) {
      foreground.push({ asset: stillId, x: scene.still.panel.x, y: scene.still.panel.y, w: scene.still.panel.w, anim: scene.still.panel.anim ?? "fade-in" });
    }
  }
  if (scene.plate && !scene.plate.reuse) {
    if (!stillId) throw new Error(`${scene.id}: plate without still`);
    assets[plateId] = plateAsset({
      film, scene, id: plateId, prompt: scene.plate.prompt, frames: scene.plate.frames,
      role: scene.plate.role, scrim: scene.plate.scrim, stillId, seed: scene.still.seed + 7,
    });
  }

  const svgSpec = svgByScene.get(scene.id);
  if (svgSpec) {
    foreground.push({ asset: svgSpec.assetId, x: svgSpec.x, y: svgSpec.y, w: svgSpec.w, anim: svgSpec.anim ?? "fade-in" });
  }

  const out = {
    id: scene.id,
    layout: scene.layout,
    ...(scene.variant ? { variant: scene.variant } : {}),
    preferredFrames: scene.preferredFrames,
    copy: scene.copy,
    ...(scene.data ? { data: scene.data } : {}),
    ...(scene.code ? { code: scene.code } : {}),
    ...(scene.media ? { media: mediaFor(film, scene, stillId, plateId) } : { background: backgroundFor(film, scene, stillId, plateId) }),
    ...(foreground.length ? { foreground } : {}),
    ...(scene.motion ? { motion: scene.motion } : {}),
    narration: scene.narration,
    ...(scene.transitionOut ? { transitionOut: scene.transitionOut } : {}),
  };
  return { scene: out, assets };
}

function buildPackage(film) {
  applyTiming(film);
  const pkgDir = OUT_DIRS[film.key];
  rmSync(join(pkgDir, "assets"), { recursive: true, force: true });
  rmSync(join(pkgDir, "workflows"), { recursive: true, force: true });
  rmSync(join(pkgDir, "fonts"), { recursive: true, force: true });
  mkdirSync(join(pkgDir, "assets"), { recursive: true });
  copyWorkflows(pkgDir);

  if (film.key === "hermes") {
    mkdirSync(join(pkgDir, "fonts"), { recursive: true });
    copyFileSync(join(RENDERER_FONTS, "JetBrainsMono-Regular.ttf"), join(pkgDir, "fonts", "JetBrainsMono-Regular.ttf"));
  }

  const assets = {};
  const svgByScene = new Map();
  for (const spec of film.svgs ?? []) {
    const assetId = assetKey(film.key, spec.scene, "svg");
    assets[assetId] = svgAsset({ film, spec });
    svgByScene.set(spec.scene, { ...spec, assetId });
  }

  const scenes = film.scenes.map((scene) => {
    const built = buildScene(film, scene, svgByScene);
    Object.assign(assets, built.assets);
    return built.scene;
  });

  const theme = {
    ...film.theme,
    palette: film.palette,
    ...(film.key === "hermes" ? {
      fonts: [{ family: "JetBrains Mono", file: "fonts/JetBrainsMono-Regular.ttf", weight: 400, license: { id: "OFL-1.1", url: "https://github.com/JetBrains/JetBrainsMono/blob/master/OFL.txt" } }],
    } : {}),
  };

  const pkg = {
    $schema: "https://comfyrizz.example/schema/package-v1.json",
    schemaVersion: 1,
    revision: 1,
    id: film.id,
    title: film.title,
    createdAt: FIXED_AT,
    format: { width: 1920, height: 1080, fps: 30 },
    duration: { mode: "target", targetFrames: film.targetFrames },
    theme,
    voice: film.voice,
    captions: { style: "sentence" },
    datasets: film.datasets ?? {},
    scenes,
    assets,
    compliance: {
      open_weights_only: true,
      closed_apis_used: [],
      warnings: film.warnings,
    },
  };

  const validation = validatePackage(pkg);
  if (!validation.valid) {
    throw new Error(`${film.key}: package invalid:\n${validation.errors.map((e) => `${e.code} ${e.path}: ${e.message}`).join("\n")}`);
  }
  const jobs = planJobs(pkg);
  const jobProblems = checkJobsDoc(jobs);
  if (jobProblems.length) throw new Error(`${film.key}: jobs invalid:\n${jobProblems.join("\n")}`);
  const timeline = compileTimeline(pkg);
  if (timeline.durationInFrames !== film.targetFrames) {
    throw new Error(`${film.key}: compiled ${timeline.durationInFrames} frames, expected ${film.targetFrames}`);
  }

  writeFileSync(join(pkgDir, "package.json"), `${JSON.stringify(pkg, null, 2)}\n`);
  const stillCount = Object.values(assets).filter((a) => a.gen?.generator === "flux3-klein").length;
  const plateCount = Object.values(assets).filter((a) => a.gen?.generator === "ltx25").length;
  const svgCount = Object.values(assets).filter((a) => a.gen?.generator === "llm-svg").length;
  const routes = scenes.map((scene) => ({
    scene: scene.id,
    layout: scene.layout,
    recipe: scene.motion?.recipe ?? null,
    background: scene.background?.asset ?? (scene.background?.procedural ? "procedural" : scene.media ? "media" : null),
    foreground: (scene.foreground ?? []).map((item) => item.asset),
    media: (scene.media ?? []).map((item) => item.asset ?? (item.procedural ? "procedural" : null)),
    narrationWords: words(scene.narration),
    preferredFrames: scene.preferredFrames,
  }));

  const readme = `# ${film.title}

Built by \`node scripts/demos/build.mjs --out <source-root>\`. No still, plate or narration media is
generated by this build; the package is a valid generation plan.

- Package: \`${film.id}\`
- Format: 1920×1080, 30 fps
- Target: ${film.targetFrames} frames (${(film.targetFrames / 30).toFixed(1)} s)
- Narration: Kokoro \`${film.voice.voice}\`, ${film.voice.language}, ${film.voice.chunking}, speed ${film.voice.speed}
- Voice: CPU; no Google Colab job is planned for narration.
- Still/plate plan: ${stillCount} FLUX 3 Klein stills, ${plateCount} LTX-2.5 plates, ${svgCount} original SVGs.
- Soundtrack: intentionally absent. The parent runner adds an original CC0 score with \`scripts/demos/score.py\`.
- Source note: ${film.sourceNote}

## Scene routes

| scene | layout | recipe | background | foreground | media | words |
|---|---|---|---|---|---|---:|
${routes.map((r) => `| ${r.scene} | ${r.layout} | ${r.recipe ?? "—"} | ${r.background ?? "—"} | ${r.foreground.join(", ") || "—"} | ${r.media.join(", ") || "—"} | ${r.narrationWords} |`).join("\n")}

## Production notes

- Stills: 1024×576, 16 steps. Plates: 1024×576, 24 fps, 81/97/121 frames.
- All generated prompts forbid lettering; words are drawn by Remotion or original SVG/typography.
- Generated stills and plates are conceptual illustrations, not screenshots.
- \`planJobs\` must report exactly ${stillCount + plateCount} GPU jobs; \`compileTimeline\` must report
  ${film.targetFrames} frames before narration. Measured Kokoro timing may extend individual scenes;
  the final cut must remain within 90–150 seconds.
`;
  writeFileSync(join(pkgDir, "README.md"), readme);

  return {
    package: film.id,
    dir: film.key,
    title: film.title,
    targetFrames: film.targetFrames,
    seconds: Number((film.targetFrames / 30).toFixed(3)),
    scenes: scenes.length,
    stills: stillCount,
    plates: plateCount,
    svgs: svgCount,
    jobs: jobs.jobs.length,
    jobKinds: jobs.jobs.reduce((acc, job) => ({ ...acc, [job.kind]: (acc[job.kind] ?? 0) + 1 }), {}),
    batches: jobs.batches,
    jobsHash: jobs.hash,
    timelineHash: timeline.hash,
    provisional: timeline.provisional,
    warnings: timeline.warnings,
    routes,
    assetIds: Object.keys(assets).sort(),
  };
}

function main() {
  const sourceRoot = resolve(outRoot);
  mkdirSync(sourceRoot, { recursive: true });
  const reports = [];
  for (const film of FILMS) {
    if (!only.has(film.key)) continue;
    OUT_DIRS[film.key] = join(sourceRoot, film.key);
    mkdirSync(OUT_DIRS[film.key], { recursive: true });
    reports.push(buildPackage(film));
  }
  const report = {
    version: 1,
    builtAt: FIXED_AT,
    builder: "scripts/demos/build.mjs",
    sourceRoot: ".",
    films: reports,
    totals: {
      scenes: reports.reduce((sum, r) => sum + r.scenes, 0),
      stills: reports.reduce((sum, r) => sum + r.stills, 0),
      plates: reports.reduce((sum, r) => sum + r.plates, 0),
      svgs: reports.reduce((sum, r) => sum + r.svgs, 0),
      jobs: reports.reduce((sum, r) => sum + r.jobs, 0),
    },
  };
  writeFileSync(join(sourceRoot, "BUILD_REPORT.json"), `${JSON.stringify(report, null, 2)}\n`);
  for (const r of reports) {
    console.log(`${r.package}: ${r.scenes} scenes, ${r.stills} stills, ${r.plates} plates, ${r.svgs} svgs, ${r.jobs} GPU jobs, ${r.targetFrames} frames, timeline ${r.timelineHash.slice(0, 12)}`);
  }
  console.log(`report: ${join(sourceRoot, "BUILD_REPORT.json")}`);
}

main();
