#!/usr/bin/env node
/**
 * PN02: deterministic placeholder media for "Pip's Night Shift".
 *
 * Writes the media the demo panels expect before any GPU or Google Colab job runs:
 *   - four 5 s / 150-frame clips (s1 take 1, s2 take 1, s3 take 1 and take 2)
 *   - the s4 still used by the take list
 *   - two reference files (a dawn style image and a camera-push clip)
 *   - two character stills (Pip and Juno)
 *
 * With ffmpeg the clips are H.264 MP4s built from lavfi colour and drawbox. Without ffmpeg
 * the script still succeeds: clips fall back to self-contained animated SVGs and every
 * still is written by the small PNG encoder below. Nothing is downloaded and no model,
 * browser or GPU is used.
 *
 * The output is a pure function of the constants in this file, so two runs produce
 * byte-identical files. Output lives under examples/pip-night-shift/, is generated at
 * seed/build time and is gitignored; no binaries are committed.
 *
 * Usage:
 *   node scripts/pip-night-shift/make-media.mjs [--out <dir>] [--no-ffmpeg]
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { deflateSync } from 'node:zlib';

export const FPS = 30;
export const WIDTH = 1920;
export const HEIGHT = 1080;
export const FRAMES = 150;
export const SECONDS = FRAMES / FPS;
export const CHARACTER_SIZE = 768;

const PALETTE = Object.freeze({
  ink: '#1a1410',
  paper: '#f6ead8',
  accent: '#ff8a3d',
  muted: '#6b4a33',
});

/**
 * Take ids are the content-addressed names recorded by the PN04 takes sidecar. The
 * placeholder bytes are not the real generated takes, but reusing the ids keeps the
 * demo's file layout stable when real Google Colab clips are swapped in.
 */
export const TAKE_IDS = Object.freeze({
  dawn: 'tk_9a800606deae',
  counter: 'tk_b1c22d07c9c0',
  junoTake1: 'tk_72d27ea08916',
  junoTake2: 'tk_27ff51ac5119',
  outro: 'tk_c7a196fd5d7e',
});

const clip = (entry) => Object.freeze({
  kind: 'clip',
  group: 'clip',
  width: WIDTH,
  height: HEIGHT,
  fps: FPS,
  frames: FRAMES,
  seconds: SECONDS,
  ...entry,
});

const image = (entry) => Object.freeze({
  kind: 'image',
  group: 'still',
  ...entry,
});

/** Every file this generator owns, in write order. */
export const MEDIA = Object.freeze([
  clip({
    id: 'take-dawn-1',
    assetId: 'a_dawn_plate',
    sceneId: 's1_dawn',
    take: 1,
    takeId: TAKE_IDS.dawn,
    file: `takes/a_dawn_plate/${TAKE_IDS.dawn}.mp4`,
    fallbackFile: `takes/a_dawn_plate/${TAKE_IDS.dawn}.svg`,
    motif: 'dawn',
  }),
  clip({
    id: 'take-counter-1',
    assetId: 'a_counter_plate',
    sceneId: 's2_counter',
    take: 1,
    takeId: TAKE_IDS.counter,
    file: `takes/a_counter_plate/${TAKE_IDS.counter}.mp4`,
    fallbackFile: `takes/a_counter_plate/${TAKE_IDS.counter}.svg`,
    motif: 'counter',
  }),
  clip({
    id: 'take-juno-1',
    assetId: 'a_juno_plate',
    sceneId: 's3_juno',
    take: 1,
    takeId: TAKE_IDS.junoTake1,
    file: `takes/a_juno_plate/${TAKE_IDS.junoTake1}.mp4`,
    fallbackFile: `takes/a_juno_plate/${TAKE_IDS.junoTake1}.svg`,
    motif: 'juno-grey',
  }),
  clip({
    id: 'take-juno-2',
    assetId: 'a_juno_plate',
    sceneId: 's3_juno',
    take: 2,
    takeId: TAKE_IDS.junoTake2,
    file: `takes/a_juno_plate/${TAKE_IDS.junoTake2}.mp4`,
    fallbackFile: `takes/a_juno_plate/${TAKE_IDS.junoTake2}.svg`,
    motif: 'juno-yellow',
  }),
  image({
    id: 'take-outro-1',
    group: 'still',
    assetId: 'a_outro_still',
    sceneId: 's4_outro',
    take: 1,
    takeId: TAKE_IDS.outro,
    file: `takes/a_outro_still/${TAKE_IDS.outro}.png`,
    motif: 'outro',
    width: WIDTH,
    height: HEIGHT,
  }),
  Object.freeze({
    id: 'reference-dawn-style',
    group: 'reference',
    kind: 'image',
    file: 'references/dawn-style.png',
    motif: 'dawn-reference',
    width: WIDTH,
    height: HEIGHT,
  }),
  Object.freeze({
    id: 'reference-counter-push',
    group: 'reference',
    kind: 'video',
    file: 'references/counter-push.mp4',
    fallbackFile: 'references/counter-push.svg',
    motif: 'counter-push',
    width: WIDTH,
    height: HEIGHT,
    fps: FPS,
    frames: FRAMES,
    seconds: SECONDS,
  }),
  Object.freeze({
    id: 'character-pip',
    group: 'character',
    kind: 'image',
    file: 'characters/pip.png',
    motif: 'pip',
    width: CHARACTER_SIZE,
    height: CHARACTER_SIZE,
  }),
  Object.freeze({
    id: 'character-juno',
    group: 'character',
    kind: 'image',
    file: 'characters/juno.png',
    motif: 'juno',
    width: CHARACTER_SIZE,
    height: CHARACTER_SIZE,
  }),
]);

export function mediaGroups(media = MEDIA) {
  return {
    clips: media.filter((entry) => entry.kind === 'clip'),
    stills: media.filter((entry) => entry.kind === 'image' && entry.group === 'still'),
    references: media.filter((entry) => entry.group === 'reference'),
    characters: media.filter((entry) => entry.group === 'character'),
  };
}

/* ------------------------------------------------------------------ */
/* PNG stills (no dependency, no ffmpeg)                              */
/* ------------------------------------------------------------------ */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const name = Buffer.from(type, 'ascii');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([name, data])), 0);
  return Buffer.concat([length, name, data, crc]);
}

/** Encode an 8-bit RGB buffer as a canonical PNG (filter 0 on every row). */
export function encodePng(width, height, rgb) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new Error('encodePng needs positive integer dimensions');
  }
  if (rgb.length !== width * height * 3) throw new Error('encodePng needs width*height*3 RGB bytes');
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  header[10] = 0;
  header[11] = 0;
  header[12] = 0;
  const stride = width * 3;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0;
    Buffer.from(rgb.buffer, rgb.byteOffset + y * stride, stride).copy(raw, y * (stride + 1) + 1);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

function hexRgb(hex) {
  const value = hex.replace('#', '');
  return [parseInt(value.slice(0, 2), 16), parseInt(value.slice(2, 4), 16), parseInt(value.slice(4, 6), 16)];
}

function mix(a, b, t) {
  return [
    Math.round(a[0] + (b[0] - a[0]) * t),
    Math.round(a[1] + (b[1] - a[1]) * t),
    Math.round(a[2] + (b[2] - a[2]) * t),
  ];
}

class Canvas {
  constructor(width, height, top, bottom) {
    this.width = width;
    this.height = height;
    this.rgb = new Uint8Array(width * height * 3);
    const from = hexRgb(top);
    const to = hexRgb(bottom);
    for (let y = 0; y < height; y += 1) {
      const color = mix(from, to, height === 1 ? 0 : y / (height - 1));
      for (let x = 0; x < width; x += 1) this.set(x, y, color);
    }
  }

  set(x, y, color, alpha = 1) {
    const px = Math.round(x);
    const py = Math.round(y);
    if (px < 0 || py < 0 || px >= this.width || py >= this.height) return;
    const offset = (py * this.width + px) * 3;
    if (alpha >= 1) {
      this.rgb[offset] = color[0];
      this.rgb[offset + 1] = color[1];
      this.rgb[offset + 2] = color[2];
      return;
    }
    this.rgb[offset] = Math.round(this.rgb[offset] + (color[0] - this.rgb[offset]) * alpha);
    this.rgb[offset + 1] = Math.round(this.rgb[offset + 1] + (color[1] - this.rgb[offset + 1]) * alpha);
    this.rgb[offset + 2] = Math.round(this.rgb[offset + 2] + (color[2] - this.rgb[offset + 2]) * alpha);
  }

  rect(x, y, width, height, color, alpha = 1) {
    const x0 = Math.max(0, Math.round(x));
    const y0 = Math.max(0, Math.round(y));
    const x1 = Math.min(this.width, Math.round(x + width));
    const y1 = Math.min(this.height, Math.round(y + height));
    for (let py = y0; py < y1; py += 1) {
      for (let px = x0; px < x1; px += 1) this.set(px, py, color, alpha);
    }
  }

  circle(cx, cy, radius, color, alpha = 1) {
    const r = Math.max(0, radius);
    const x0 = Math.max(0, Math.floor(cx - r));
    const x1 = Math.min(this.width - 1, Math.ceil(cx + r));
    const y0 = Math.max(0, Math.floor(cy - r));
    const y1 = Math.min(this.height - 1, Math.ceil(cy + r));
    for (let py = y0; py <= y1; py += 1) {
      for (let px = x0; px <= x1; px += 1) {
        const dx = px - cx;
        const dy = py - cy;
        if (dx * dx + dy * dy <= r * r) this.set(px, py, color, alpha);
      }
    }
  }

  vline(x, y, height, color, alpha = 1) {
    this.rect(x, y, 1, height, color, alpha);
  }

  grain(strength = 3) {
    for (let y = 0; y < this.height; y += 1) {
      for (let x = 0; x < this.width; x += 1) {
        const noise = ((Math.imul(x + 17, 374761393) ^ Math.imul(y + 31, 668265263)) >>> 0) % (strength * 2 + 1);
        const delta = noise - strength;
        const offset = (y * this.width + x) * 3;
        for (let channel = 0; channel < 3; channel += 1) {
          const value = this.rgb[offset + channel] + delta;
          this.rgb[offset + channel] = value < 0 ? 0 : value > 255 ? 255 : value;
        }
      }
    }
  }
}

function paintDawn(width, height, variant = 'dawn') {
  const canvas = new Canvas(width, height, PALETTE.ink, PALETTE.muted);
  const horizon = Math.round(height * 0.68);
  const accent = hexRgb(PALETTE.accent);
  const paper = hexRgb(PALETTE.paper);
  const muted = hexRgb(PALETTE.muted);
  const ink = hexRgb(PALETTE.ink);
  canvas.circle(width * 0.74, height * 0.4, height * 0.16, accent, variant === 'dawn-reference' ? 0.32 : 0.5);
  canvas.circle(width * 0.74, height * 0.4, height * 0.12, paper, 0.55);
  canvas.rect(0, horizon, width, height - horizon, muted, 0.75);
  for (let i = 0; i < 7; i += 1) {
    const w = width * (0.08 + 0.012 * i);
    const h = height * (0.1 + 0.035 * (i % 3));
    canvas.rect(width * (0.03 + i * 0.14), horizon - h, w, h + 1, ink, 0.9);
    canvas.rect(width * (0.05 + i * 0.14), horizon - h + height * 0.02, w * 0.18, height * 0.025, accent, 0.5);
  }
  canvas.rect(0, Math.round(height * 0.9), width, Math.round(height * 0.1), ink, 0.55);
  if (variant === 'dawn-reference') {
    for (let i = 0; i < 5; i += 1) {
      canvas.rect(width * 0.04, height * (0.06 + i * 0.045), width * 0.18, height * 0.014, paper, 0.25);
    }
  }
  canvas.grain(2);
  return canvas;
}

function paintCounter(width, height, push = false) {
  const canvas = new Canvas(width, height, PALETTE.ink, '#3a2a20');
  const paper = hexRgb(PALETTE.paper);
  const accent = hexRgb(PALETTE.accent);
  const muted = hexRgb(PALETTE.muted);
  if (push) {
    for (let i = 0; i < 5; i += 1) {
      const inset = Math.round(width * (0.06 + i * 0.045));
      canvas.rect(inset, Math.round(height * (0.08 + i * 0.02)), width - inset * 2, height - Math.round(height * (0.16 + i * 0.04)), muted, 0.18);
    }
  }
  canvas.rect(width * 0.08, height * 0.16, width * 0.5, height * 0.38, muted, 0.5);
  canvas.rect(width * 0.08, height * 0.16, width * 0.5, height * 0.38, paper, 0.08);
  canvas.rect(width * 0.1, height * 0.2, width * 0.46, height * 0.03, accent, 0.6);
  canvas.rect(0, Math.round(height * 0.7), width, Math.round(height * 0.3), muted, 0.8);
  canvas.rect(width * 0.12, Math.round(height * 0.66), width * 0.76, Math.round(height * 0.06), accent, 0.65);
  canvas.rect(width * 0.56, height * 0.3, width * 0.12, height * 0.4, paper, 0.16);
  canvas.circle(width * 0.62, height * 0.28, height * 0.055, paper, 0.25);
  for (let i = 0; i < 3; i += 1) {
    canvas.rect(width * (0.58 + i * 0.035), height * (0.2 - i * 0.03), width * 0.008, height * 0.1, paper, 0.16);
  }
  canvas.grain(2);
  return canvas;
}

function paintJuno(width, height, yellow) {
  const canvas = new Canvas(width, height, PALETTE.ink, '#2a211c');
  const paper = hexRgb(PALETTE.paper);
  const accent = hexRgb(PALETTE.accent);
  const muted = hexRgb(PALETTE.muted);
  const jacket = yellow ? hexRgb('#e8b23a') : [126, 128, 134];
  const helmet = yellow ? hexRgb('#f2c94c') : hexRgb('#5c6068');
  canvas.rect(0, Math.round(height * 0.72), width, Math.round(height * 0.28), muted, 0.65);
  canvas.circle(width * 0.5, height * 0.36, height * 0.17, helmet, 0.9);
  canvas.circle(width * 0.5, height * 0.4, height * 0.13, paper, 0.85);
  canvas.rect(width * 0.5 - height * 0.15, height * 0.38, height * 0.3, height * 0.045, hexRgb(PALETTE.ink), 0.85);
  canvas.rect(width * 0.34, height * 0.56, width * 0.32, height * 0.34, jacket, 0.95);
  canvas.rect(width * 0.47, height * 0.56, width * 0.06, height * 0.34, paper, 0.25);
  canvas.rect(width * 0.27, height * 0.66, width * 0.08, height * 0.14, jacket, 0.9);
  canvas.rect(width * 0.65, height * 0.66, width * 0.08, height * 0.14, jacket, 0.9);
  canvas.rect(width * 0.4, height * 0.86, width * 0.2, height * 0.05, accent, 0.8);
  if (!yellow) {
    canvas.rect(width * 0.34, height * 0.56, width * 0.32, height * 0.06, hexRgb('#3f4147'), 0.9);
  }
  canvas.grain(2);
  return canvas;
}

function paintOutro(width, height) {
  const canvas = new Canvas(width, height, '#120f0d', '#241a14');
  const paper = hexRgb(PALETTE.paper);
  const accent = hexRgb(PALETTE.accent);
  const muted = hexRgb(PALETTE.muted);
  for (let i = 0; i < 36; i += 1) {
    const x = (i * 977 + 131) % width;
    const y = (i * 613 + 47) % Math.round(height * 0.5);
    canvas.circle(x, y, 1 + (i % 2), paper, 0.35);
  }
  canvas.rect(width * 0.22, height * 0.18, width * 0.56, height * 0.56, muted, 0.9);
  canvas.rect(width * 0.24, height * 0.2, width * 0.52, height * 0.52, accent, 0.22);
  canvas.rect(width * 0.48, height * 0.2, width * 0.04, height * 0.52, hexRgb(PALETTE.ink), 0.75);
  canvas.rect(width * 0.24, height * 0.44, width * 0.52, height * 0.04, hexRgb(PALETTE.ink), 0.75);
  canvas.rect(width * 0.3, height * 0.64, width * 0.4, height * 0.035, paper, 0.5);
  canvas.rect(0, Math.round(height * 0.82), width, Math.round(height * 0.18), hexRgb(PALETTE.ink), 0.8);
  canvas.grain(3);
  return canvas;
}

function paintPip(width, height) {
  const canvas = new Canvas(width, height, '#1b1713', '#2f241c');
  const paper = hexRgb(PALETTE.paper);
  const accent = hexRgb(PALETTE.accent);
  const muted = hexRgb(PALETTE.muted);
  canvas.circle(width * 0.5, height * 0.5, width * 0.4, muted, 0.25);
  canvas.rect(width * 0.24, height * 0.3, width * 0.52, height * 0.38, paper, 0.92);
  canvas.rect(width * 0.28, height * 0.36, width * 0.44, height * 0.2, hexRgb(PALETTE.ink), 0.9);
  canvas.circle(width * 0.4, height * 0.45, width * 0.045, accent, 0.95);
  canvas.circle(width * 0.6, height * 0.45, width * 0.045, accent, 0.95);
  canvas.rect(width * 0.38, height * 0.54, width * 0.24, height * 0.025, accent, 0.8);
  canvas.rect(width * 0.34, height * 0.68, width * 0.32, height * 0.16, muted, 0.85);
  canvas.vline(width * 0.5, height * 0.22, height * 0.08, paper, 0.7);
  canvas.circle(width * 0.5, height * 0.21, width * 0.025, accent, 0.9);
  canvas.circle(width * 0.2, height * 0.7, width * 0.05, paper, 0.18);
  canvas.circle(width * 0.26, height * 0.66, width * 0.03, paper, 0.14);
  canvas.grain(2);
  return canvas;
}

function paintJunoPortrait(width, height) {
  const canvas = new Canvas(width, height, '#1b1713', '#33271c');
  const paper = hexRgb(PALETTE.paper);
  const accent = hexRgb(PALETTE.accent);
  const muted = hexRgb(PALETTE.muted);
  const helmet = hexRgb('#f2c94c');
  const jacket = hexRgb('#e8b23a');
  canvas.circle(width * 0.5, height * 0.5, width * 0.4, muted, 0.25);
  canvas.circle(width * 0.5, height * 0.4, width * 0.22, helmet, 0.95);
  canvas.circle(width * 0.5, height * 0.44, width * 0.16, paper, 0.95);
  canvas.rect(width * 0.34, height * 0.42, width * 0.32, height * 0.05, hexRgb(PALETTE.ink), 0.85);
  canvas.rect(width * 0.3, height * 0.64, width * 0.4, height * 0.22, jacket, 0.95);
  canvas.rect(width * 0.47, height * 0.64, width * 0.06, height * 0.22, paper, 0.3);
  canvas.rect(width * 0.42, height * 0.86, width * 0.16, height * 0.03, accent, 0.8);
  canvas.grain(2);
  return canvas;
}

export function renderStill(motif, width = WIDTH, height = HEIGHT) {
  let canvas;
  switch (motif) {
    case 'dawn':
    case 'dawn-reference':
      canvas = paintDawn(width, height, motif);
      break;
    case 'counter':
      canvas = paintCounter(width, height, false);
      break;
    case 'counter-push':
      canvas = paintCounter(width, height, true);
      break;
    case 'juno-grey':
      canvas = paintJuno(width, height, false);
      break;
    case 'juno-yellow':
      canvas = paintJuno(width, height, true);
      break;
    case 'outro':
      canvas = paintOutro(width, height);
      break;
    case 'pip':
      canvas = paintPip(width, height);
      break;
    case 'juno':
      canvas = paintJunoPortrait(width, height);
      break;
    default:
      throw new Error(`unknown still motif ${JSON.stringify(motif)}`);
  }
  return encodePng(width, height, canvas.rgb);
}

/* ------------------------------------------------------------------ */
/* Animated SVG fallback clips (no encoder needed)                    */
/* ------------------------------------------------------------------ */

function escapeXml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;',
  }[character]));
}

function svgShapes(entry) {
  const w = entry.width;
  const h = entry.height;
  switch (entry.motif) {
    case 'dawn':
      return `
    <circle cx="${w * 0.74}" cy="${h * 0.4}" r="${h * 0.16}" fill="${PALETTE.accent}" opacity="0.55"/>
    <circle cx="${w * 0.74}" cy="${h * 0.4}" r="${h * 0.12}" fill="${PALETTE.paper}" opacity="0.7"/>
    <rect x="0" y="${h * 0.68}" width="${w}" height="${h * 0.32}" fill="${PALETTE.muted}"/>
    ${[0, 1, 2, 3, 4, 5].map((i) => {
      const bw = w * (0.08 + i * 0.012);
      const bh = h * (0.1 + 0.03 * (i % 3));
      return `<rect x="${w * (0.03 + i * 0.15)}" y="${h * 0.68 - bh}" width="${bw}" height="${bh}" fill="${PALETTE.ink}"/>`;
    }).join('\n    ')}`;
    case 'counter':
    case 'counter-push':
      return `
    <rect x="${w * 0.08}" y="${h * 0.16}" width="${w * 0.5}" height="${h * 0.38}" fill="${PALETTE.muted}" opacity="0.7"/>
    <rect x="${w * 0.1}" y="${h * 0.2}" width="${w * 0.46}" height="${h * 0.03}" fill="${PALETTE.accent}" opacity="0.7"/>
    <rect x="0" y="${h * 0.7}" width="${w}" height="${h * 0.3}" fill="${PALETTE.muted}"/>
    <rect x="${w * 0.12}" y="${h * 0.66}" width="${w * 0.76}" height="${h * 0.06}" fill="${PALETTE.accent}" opacity="0.7"/>
    <rect x="${w * 0.56}" y="${h * 0.3}" width="${w * 0.12}" height="${h * 0.4}" fill="${PALETTE.paper}" opacity="0.18"/>`;
    case 'juno-grey':
    case 'juno-yellow': {
      const yellow = entry.motif === 'juno-yellow';
      return `
    <rect x="0" y="${h * 0.72}" width="${w}" height="${h * 0.28}" fill="${PALETTE.muted}" opacity="0.7"/>
    <circle cx="${w * 0.5}" cy="${h * 0.36}" r="${h * 0.17}" fill="${yellow ? '#f2c94c' : '#5c6068'}"/>
    <circle cx="${w * 0.5}" cy="${h * 0.4}" r="${h * 0.13}" fill="${PALETTE.paper}"/>
    <rect x="${w * 0.35}" y="${h * 0.38}" width="${w * 0.3}" height="${h * 0.045}" fill="${PALETTE.ink}" opacity="0.85"/>
    <rect x="${w * 0.34}" y="${h * 0.56}" width="${w * 0.32}" height="${h * 0.34}" fill="${yellow ? '#e8b23a' : '#7e8086'}"/>`;
    }
    default:
      return `<rect x="${w * 0.1}" y="${h * 0.1}" width="${w * 0.8}" height="${h * 0.8}" fill="${PALETTE.muted}" opacity="0.5"/>`;
  }
}

/** A self-contained animated SVG stand-in for a clip when ffmpeg is unavailable. */
export function renderClipSvg(entry) {
  const label = entry.sceneId ? `${entry.sceneId} take ${entry.take}` : entry.id;
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${entry.width}" height="${entry.height}" viewBox="0 0 ${entry.width} ${entry.height}" role="img" aria-label="${escapeXml(label)} placeholder" data-kind="placeholder-clip" data-frames="${entry.frames}" data-fps="${entry.fps}" data-take="${entry.take ?? 1}">
  <title>${escapeXml(label)} placeholder</title>
  <style>
    @keyframes drift { from { transform: translateX(-2.5%); } to { transform: translateX(2.5%); } }
    @keyframes flicker { 0%, 100% { opacity: 0.16; } 50% { opacity: 0.22; } }
    @media (prefers-reduced-motion: reduce) { .drift, .flicker { animation: none !important; } }
    .drift { animation: drift 5s ease-in-out infinite alternate; transform-origin: 50% 50%; }
    .flicker { animation: flicker 0.8s steps(2, end) infinite; }
  </style>
  <rect width="100%" height="100%" fill="${PALETTE.ink}"/>
  <rect width="100%" height="100%" fill="url(#warm)"/>
  <defs>
    <radialGradient id="warm" cx="70%" cy="35%" r="75%">
      <stop offset="0%" stop-color="${PALETTE.muted}" stop-opacity="0.75"/>
      <stop offset="100%" stop-color="${PALETTE.ink}" stop-opacity="0.95"/>
    </radialGradient>
  </defs>
  <g class="drift">
${svgShapes(entry)}
  </g>
  <rect class="flicker" width="100%" height="100%" fill="${PALETTE.paper}" opacity="0.18"/>
  <rect x="${entry.width * 0.04}" y="${entry.height * 0.88}" width="${entry.width * 0.28}" height="${entry.height * 0.012}" fill="${PALETTE.accent}"/>
  <text x="${entry.width * 0.04}" y="${entry.height * 0.94}" fill="${PALETTE.paper}" font-family="Inter, Arial, sans-serif" font-size="${Math.round(entry.height * 0.026)}">PLACEHOLDER · ${escapeXml(label)}</text>
</svg>
`, 'utf8');
}

/* ------------------------------------------------------------------ */
/* ffmpeg clips                                                       */
/* ------------------------------------------------------------------ */

function clipShapes(entry) {
  const w = entry.width;
  const h = entry.height;
  switch (entry.motif) {
    case 'dawn':
      return [
        [0, h * 0.68, w, h * 0.32, PALETTE.muted],
        [w * 0.58, h * 0.24, w * 0.32, h * 0.32, PALETTE.accent],
        [w * 0.64, h * 0.3, w * 0.2, h * 0.2, PALETTE.paper],
        [w * 0.08, h * 0.5, w * 0.12, h * 0.18, PALETTE.ink],
        [w * 0.26, h * 0.55, w * 0.1, h * 0.13, PALETTE.ink],
        [w * 0.82, h * 0.48, w * 0.14, h * 0.2, PALETTE.ink],
      ];
    case 'counter':
    case 'counter-push':
      return [
        [w * 0.08, h * 0.16, w * 0.5, h * 0.38, PALETTE.muted],
        [w * 0.1, h * 0.2, w * 0.46, h * 0.03, PALETTE.accent],
        [0, h * 0.7, w, h * 0.3, PALETTE.muted],
        [w * 0.12, h * 0.66, w * 0.76, h * 0.06, PALETTE.accent],
        [w * 0.56, h * 0.3, w * 0.12, h * 0.4, PALETTE.paper],
      ];
    case 'juno-grey':
    case 'juno-yellow': {
      const yellow = entry.motif === 'juno-yellow';
      return [
        [0, h * 0.72, w, h * 0.28, PALETTE.muted],
        [w * 0.33, h * 0.19, w * 0.34, h * 0.34, yellow ? '#f2c94c' : '#5c6068'],
        [w * 0.37, h * 0.27, w * 0.26, h * 0.26, PALETTE.paper],
        [w * 0.35, h * 0.38, w * 0.3, h * 0.045, PALETTE.ink],
        [w * 0.34, h * 0.56, w * 0.32, h * 0.34, yellow ? '#e8b23a' : '#7e8086'],
      ];
    }
    default:
      return [[w * 0.1, h * 0.1, w * 0.8, h * 0.8, PALETTE.muted]];
  }
}

/** ffmpeg arguments for one clip. Exported so the test can inspect them without running ffmpeg. */
export function clipArgs(entry, outputPath) {
  if (!entry || !outputPath) throw new Error('clipArgs needs an entry and an output path');
  const filter = [
    ...clipShapes(entry).map(([x, y, width, height, color]) => {
      const hex = color.replace('#', '').toUpperCase();
      return `drawbox=x=${Math.round(x)}:y=${Math.round(y)}:w=${Math.round(width)}:h=${Math.round(height)}:color=0x${hex}:t=fill`;
    }),
    'format=yuv420p',
  ].join(',');
  return [
    '-hide_banner',
    '-loglevel', 'error',
    '-nostdin',
    '-y',
    '-f', 'lavfi',
    '-i', `color=c=0x${PALETTE.ink.replace('#', '').toUpperCase()}:s=${entry.width}x${entry.height}:r=${entry.fps}:d=${entry.seconds}`,
    '-vf', filter,
    '-frames:v', String(entry.frames),
    '-an',
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-crf', '30',
    '-pix_fmt', 'yuv420p',
    '-threads', '1',
    '-fflags', '+bitexact',
    '-flags:v', '+bitexact',
    '-map_metadata', '-1',
    '-metadata', 'creation_time=1970-01-01T00:00:00.000Z',
    '-movflags', '+faststart',
    outputPath,
  ];
}

export function detectFfmpeg({ spawn = spawnSync } = {}) {
  try {
    const result = spawn('ffmpeg', ['-version'], { encoding: 'utf8', timeout: 10000 });
    return Boolean(result && result.status === 0);
  } catch {
    return false;
  }
}

export function createFfmpegRunner({ spawn = spawnSync } = {}) {
  return {
    available: detectFfmpeg({ spawn }),
    run(args) {
      const result = spawn('ffmpeg', args, { encoding: 'utf8', timeout: 120000 });
      return {
        ok: Boolean(result && result.status === 0),
        status: result?.status ?? 1,
        stderr: String(result?.stderr ?? ''),
      };
    },
  };
}

/* ------------------------------------------------------------------ */
/* Writing                                                            */
/* ------------------------------------------------------------------ */

export function sha256Hex(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function defaultFs() {
  return {
    mkdirSync,
    writeFileSync,
    readFileSync,
    existsSync,
    rmSync,
  };
}

/**
 * Write every placeholder file into `outDir`.
 *
 * @param {{
 *   outDir: string,
 *   fs?: { mkdirSync: Function, writeFileSync: Function, readFileSync: Function, existsSync?: Function, rmSync?: Function },
 *   ffmpeg?: { available?: boolean, run?: Function },
 * }} options
 */
export function writeMedia({ outDir, fs = defaultFs(), ffmpeg = { available: false } } = {}) {
  if (!outDir) throw new Error('writeMedia needs an outDir');
  fs.mkdirSync(outDir, { recursive: true });
  const warnings = [];
  const generated = [];
  let ffmpegUsed = 0;
  let fallbackUsed = 0;

  for (const entry of MEDIA) {
    const isMotion = entry.kind === 'clip' || entry.kind === 'video';
    let file = entry.file;
    let bytes = null;

    if (isMotion && ffmpeg?.available && typeof ffmpeg.run === 'function') {
      const target = join(outDir, entry.file);
      fs.mkdirSync(dirname(target), { recursive: true });
      let result;
      try {
        result = ffmpeg.run(clipArgs(entry, target));
      } catch (error) {
        result = { ok: false, stderr: String(error?.message ?? error) };
      }
      if (result?.ok !== false && fs.existsSync(target)) {
        bytes = fs.readFileSync(target);
        ffmpegUsed += 1;
      } else {
        if (typeof fs.rmSync === 'function') {
          try { fs.rmSync(target, { force: true }); } catch { /* the fallback still writes */ }
        }
        warnings.push(`${entry.id}: ffmpeg did not produce a clip, using the SVG fallback`);
      }
    }

    if (!bytes) {
      if (isMotion) {
        file = entry.fallbackFile;
        bytes = renderClipSvg(entry);
        fallbackUsed += 1;
      } else {
        bytes = renderStill(entry.motif, entry.width, entry.height);
      }
    }

    const target = join(outDir, file);
    fs.mkdirSync(dirname(target), { recursive: true });
    fs.writeFileSync(target, bytes);
    generated.push({
      id: entry.id,
      group: entry.group,
      kind: entry.kind,
      file,
      bytes: bytes.length,
      sha256: sha256Hex(bytes),
      width: entry.width,
      height: entry.height,
      ...(entry.fps ? { fps: entry.fps } : {}),
      ...(entry.frames ? { frames: entry.frames } : {}),
      ...(entry.seconds ? { seconds: entry.seconds } : {}),
      ...(entry.sceneId ? { sceneId: entry.sceneId } : {}),
      ...(entry.assetId ? { assetId: entry.assetId } : {}),
      ...(entry.takeId ? { takeId: entry.takeId } : {}),
      ...(entry.take ? { take: entry.take } : {}),
    });
  }

  const mode = ffmpegUsed > 0 && fallbackUsed > 0 ? 'mixed' : ffmpegUsed > 0 ? 'ffmpeg' : 'fallback';
  return { mode, generated, warnings };
}

function parseArgs(argv) {
  const out = {
    outDir: fileURLToPath(new URL('../../examples/pip-night-shift/', import.meta.url)),
    ffmpeg: true,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--out') {
      const value = argv[i + 1];
      if (!value) throw new Error('--out needs a directory');
      out.outDir = resolve(value);
      i += 1;
    } else if (arg === '--no-ffmpeg') {
      out.ffmpeg = false;
    } else {
      throw new Error(`unknown argument ${JSON.stringify(arg)}`);
    }
  }
  return out;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const ffmpeg = args.ffmpeg ? createFfmpegRunner() : { available: false };
  const report = writeMedia({ outDir: args.outDir, ffmpeg });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

const invoked = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (invoked === import.meta.url) main();
