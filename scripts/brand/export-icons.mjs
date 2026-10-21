#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { inflateSync } from "node:zlib";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const outDir = join(root, "brand/export");
const publicDir = join(root, "apps/web/public");

const FAVICON = join(root, "brand/favicon.svg");
const SYMBOL = join(root, "brand/comfyrizz-symbol.svg");
const LOGO_LIGHT = join(root, "brand/comfyrizz-logo-light.svg");
const LOGO_DARK = join(root, "brand/comfyrizz-logo-dark.svg");

const SMALL_SIZES = [16, 32, 48];
const LARGE_SIZES = [180, 192, 512, 1024];
const LOCKUP_WIDTH = 1024;
const SYMBOL_SCALE = 0.92;

function findChromium() {
  const fromEnv = process.env.CHROMIUM_BIN;
  if (fromEnv && existsSync(fromEnv)) return fromEnv;

  const names = ["chromium", "chromium-browser", "google-chrome", "google-chrome-stable", "chrome"];
  const pathDirs = (process.env.PATH ?? "").split(":").filter(Boolean);
  for (const name of names) {
    for (const dir of pathDirs) {
      const candidate = join(dir, name);
      if (existsSync(candidate)) return candidate;
    }
  }
  for (const candidate of ["/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/google-chrome"]) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error("No Chromium binary found. Set CHROMIUM_BIN to a chromium/chrome executable.");
}

function svgFor(file, width, height, viewBox) {
  let svg = readFileSync(file, "utf8")
    .replace(/<\?xml[^>]*\?>/g, "")
    .replace(/<svg\b([^>]*)>/, (_match, attrs) => {
      const cleaned = attrs
        .replace(/\swidth="[^"]*"/g, "")
        .replace(/\sheight="[^"]*"/g, "")
        .replace(/\sviewBox="[^"]*"/g, "");
      const box = viewBox ?? /viewBox="([^"]*)"/.exec(attrs)?.[1];
      return `<svg${cleaned} viewBox="${box}" width="${width}" height="${height}" preserveAspectRatio="xMidYMid meet">`;
    });
  if (!/<svg\b/.test(svg)) throw new Error(`Not an SVG: ${file}`);
  return svg;
}

function html(svg, width, height) {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;padding:0;width:${width}px;height:${height}px;background:transparent;overflow:hidden}
svg{display:block;width:${width}px;height:${height}px}
</style></head><body>${svg}</body></html>`;
}

function rasterize(chromium, { file, width, height, viewBox, out }) {
  const work = mkdtempSync(join(tmpdir(), "comfyrizz-icon-"));
  try {
    const page = join(work, "index.html");
    writeFileSync(page, html(svgFor(file, width, height, viewBox), width, height));
    const args = [
      "--headless",
      "--no-sandbox",
      "--disable-gpu",
      "--disable-dev-shm-usage",
      "--hide-scrollbars",
      "--no-first-run",
      "--force-device-scale-factor=1",
      "--default-background-color=00000000",
      `--user-data-dir=${join(work, "profile")}`,
      `--window-size=${width},${height}`,
      `--screenshot=${out}`,
      page,
    ];
    const run = spawnSync(chromium, args, { encoding: "utf8", timeout: 120_000 });
    if (run.error) throw run.error;
    if (run.status !== 0) {
      throw new Error(`Chromium exited ${run.status} for ${out}\n${run.stderr ?? ""}`);
    }
    if (!existsSync(out)) throw new Error(`Chromium did not write ${out}`);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

function readPng(file) {
  const buf = readFileSync(file);
  const signature = "89504e470d0a1a0a";
  if (buf.subarray(0, 8).toString("hex") !== signature) throw new Error(`${file}: not a PNG`);
  let pos = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  const idat = [];
  while (pos + 8 <= buf.length) {
    const length = buf.readUInt32BE(pos);
    const type = buf.subarray(pos + 4, pos + 8).toString("ascii");
    const data = buf.subarray(pos + 8, pos + 8 + length);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
    } else if (type === "IDAT") {
      idat.push(data);
    } else if (type === "IEND") {
      break;
    }
    pos += 12 + length;
  }
  if (colorType !== 6 || bitDepth !== 8) {
    throw new Error(`${file}: expected 8-bit RGBA (color type 6), got bit depth ${bitDepth} type ${colorType}`);
  }
  const raw = inflateSync(Buffer.concat(idat));
  const bpp = 4;
  const stride = width * bpp;
  const pixels = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const prev = y > 0 ? pixels.subarray((y - 1) * stride, y * stride) : Buffer.alloc(stride);
    const out = pixels.subarray(y * stride, (y + 1) * stride);
    for (let x = 0; x < stride; x += 1) {
      const a = x >= bpp ? out[x - bpp] : 0;
      const b = prev[x];
      const c = x >= bpp ? prev[x - bpp] : 0;
      let value = line[x];
      if (filter === 1) value += a;
      else if (filter === 2) value += b;
      else if (filter === 3) value += Math.floor((a + b) / 2);
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        value += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      } else if (filter !== 0) {
        throw new Error(`${file}: unsupported PNG filter ${filter}`);
      }
      out[x] = value & 0xff;
    }
  }
  const alphaAt = (x, y) => pixels[(y * width + x) * 4 + 3];
  let opaque = 0;
  for (let i = 3; i < pixels.length; i += 4) if (pixels[i] > 0) opaque += 1;
  return { width, height, alphaAt, opaque }; 
}

function assertPng(file, width, height) {
  const png = readPng(file);
  if (png.width !== width || png.height !== height) {
    throw new Error(`${file}: expected ${width}x${height}, got ${png.width}x${png.height}`);
  }
  const corners = [
    [0, 0],
    [width - 1, 0],
    [0, height - 1],
    [width - 1, height - 1],
  ];
  for (const [x, y] of corners) {
    if (png.alphaAt(x, y) !== 0) throw new Error(`${file}: corner ${x},${y} is not transparent`);
  }
  if (png.opaque === 0) throw new Error(`${file}: no visible artwork`);
  return png;
}

function paddedSquareViewBox(scale) {
  const cx = 80;
  const cy = 79.5;
  const size = 160 / scale;
  const x = +(cx - size / 2).toFixed(3);
  const y = +(cy - size / 2).toFixed(3);
  return `${x} ${y} ${size.toFixed(3)} ${size.toFixed(3)}`;
}

const chromium = findChromium();
mkdirSync(outDir, { recursive: true });
mkdirSync(publicDir, { recursive: true });

const outputs = [];
const padded = paddedSquareViewBox(SYMBOL_SCALE);

for (const size of SMALL_SIZES) {
  outputs.push({
    out: join(outDir, `comfyrizz-symbol-${size}.png`),
    file: FAVICON,
    width: size,
    height: size,
  });
}
for (const size of LARGE_SIZES) {
  outputs.push({
    out: join(outDir, `comfyrizz-symbol-${size}.png`),
    file: SYMBOL,
    width: size,
    height: size,
    viewBox: padded,
  });
}

const lockupHeight = Math.round((LOCKUP_WIDTH * 160) / 628);
for (const [name, file] of [
  ["light", LOGO_LIGHT],
  ["dark", LOGO_DARK],
]) {
  outputs.push({
    out: join(outDir, `comfyrizz-logo-${name}-${LOCKUP_WIDTH}.png`),
    file,
    width: LOCKUP_WIDTH,
    height: lockupHeight,
  });
}

for (const item of outputs) {
  rasterize(chromium, item);
  assertPng(item.out, item.width, item.height);
  console.log(`ok ${item.out.replace(`${root}/`, "")} ${item.width}x${item.height} RGBA transparent`);
}

// Web copies: favicon + standard install sizes.
const copies = [
  [join(root, "brand/favicon.svg"), join(publicDir, "favicon.svg")],
  [join(outDir, "comfyrizz-symbol-32.png"), join(publicDir, "favicon-32.png")],
  [join(outDir, "comfyrizz-symbol-180.png"), join(publicDir, "apple-touch-icon.png")],
  [join(outDir, "comfyrizz-symbol-192.png"), join(publicDir, "icon-192.png")],
  [join(outDir, "comfyrizz-symbol-512.png"), join(publicDir, "icon-512.png")],
];
for (const [from, to] of copies) {
  writeFileSync(to, readFileSync(from));
  console.log(`copied ${to.replace(`${root}/`, "")}`);
}

const manifest = {
  name: "Comfyrizz",
  short_name: "comfyrizz",
  theme_color: "#14112B",
  background_color: "#14112B",
  start_url: "/",
  display: "standalone",
  icons: [
    { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
    { src: "/icon-512.png", sizes: "512x512", type: "image/png" },
  ],
};
const manifestPath = join(publicDir, "site.webmanifest");
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`wrote ${manifestPath.replace(`${root}/`, "")}`);
