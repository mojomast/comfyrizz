/**
 * CPU render-check for generated SVG (spec A5). Rasterises with `@resvg/resvg-js`
 * and fails on parse errors, blank/near-invisible output and content that falls
 * outside the requested palette, with structured errors a generator can repair.
 */

import { Resvg } from '@resvg/resvg-js';

export interface RenderCheckError {
  code: string;
  message: string;
  detail?: string;
}

export interface RenderCheckResult {
  ok: boolean;
  width: number;
  height: number;
  opaqueFraction: number;
  outOfPaletteFraction: number | null;
  errors: RenderCheckError[];
  warnings: string[];
}

export interface RenderCheckOptions {
  /** Target raster width in px. Height follows the SVG aspect ratio. */
  width?: number;
  height?: number;
  /** Allowed colours, e.g. the package theme palette. */
  palette?: string[];
  /** Background for the raster; defaults to transparent. */
  background?: string;
  /** Fail below this fraction of non-transparent pixels. Default 0.005 (0.5%). */
  minOpaqueFraction?: number;
  /** Fail above this fraction of out-of-palette pixels. Default 0.5. */
  maxOutOfPaletteFraction?: number;
  /** RGB distance treated as "in palette". Default 64. */
  paletteTolerance?: number;
  loadSystemFonts?: boolean;
}

const DEFAULT_WIDTH = 512;
const DEFAULT_MIN_OPAQUE = 0.005;
const DEFAULT_MAX_OUT_OF_PALETTE = 0.5;
const DEFAULT_TOLERANCE = 64;

function parseColor(value: string): [number, number, number] | null {
  const hex = value.trim().match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (hex) {
    const raw = hex[1];
    const full = raw.length === 3 ? raw.split('').map(char => char + char).join('') : raw;
    return [Number.parseInt(full.slice(0, 2), 16), Number.parseInt(full.slice(2, 4), 16), Number.parseInt(full.slice(4, 6), 16)];
  }
  const rgb = value.trim().match(/^rgba?\(\s*(\d+)\s*[, ]\s*(\d+)\s*[, ]\s*(\d+)/i);
  if (rgb) return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])];
  return null;
}

function distance(a: [number, number, number], b: [number, number, number]): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

export function renderCheck(svg: string, options: RenderCheckOptions = {}): RenderCheckResult {
  const errors: RenderCheckError[] = [];
  const warnings: string[] = [];
  const width = options.width ?? DEFAULT_WIDTH;
  let image: { width: number; height: number; pixels: Buffer } | null = null;
  try {
    const resvg = new Resvg(svg, {
      fitTo: { mode: 'width', value: width },
      ...(options.background ? { background: options.background } : {}),
      font: { loadSystemFonts: options.loadSystemFonts ?? false },
      logLevel: 'off',
    });
    const rendered = resvg.render();
    image = { width: rendered.width, height: rendered.height, pixels: rendered.pixels };
  } catch (error) {
    return {
      ok: false,
      width: 0,
      height: 0,
      opaqueFraction: 0,
      outOfPaletteFraction: null,
      errors: [{ code: 'parse-error', message: 'SVG could not be parsed or rasterised.', detail: error instanceof Error ? error.message : String(error) }],
      warnings,
    };
  }

  const { pixels } = image;
  const total = image.width * image.height;
  let opaque = 0;
  let outOfPalette = 0;
  const palette = (options.palette ?? []).map(parseColor).filter((color): color is [number, number, number] => color !== null);
  const tolerance = options.paletteTolerance ?? DEFAULT_TOLERANCE;
  for (let offset = 0; offset < pixels.length; offset += 4) {
    const alpha = pixels[offset + 3];
    if (alpha < 8) continue;
    opaque += 1;
    if (palette.length > 0) {
      // Composite over white before comparing, so translucent fills stay readable.
      const a = alpha / 255;
      const rgb: [number, number, number] = [
        Math.round(pixels[offset] * a + 255 * (1 - a)),
        Math.round(pixels[offset + 1] * a + 255 * (1 - a)),
        Math.round(pixels[offset + 2] * a + 255 * (1 - a)),
      ];
      const best = Math.min(...palette.map(color => distance(rgb, color)));
      if (best > tolerance) outOfPalette += 1;
    }
  }
  const opaqueFraction = total > 0 ? opaque / total : 0;
  const outOfPaletteFraction = palette.length > 0 && opaque > 0 ? outOfPalette / opaque : null;

  const minOpaque = options.minOpaqueFraction ?? DEFAULT_MIN_OPAQUE;
  if (opaqueFraction < 0.0001) {
    errors.push({ code: 'blank-output', message: 'Rendered SVG is transparent; nothing is visible.' });
  } else if (opaqueFraction < minOpaque) {
    errors.push({ code: 'near-invisible', message: `Rendered SVG covers only ${(opaqueFraction * 100).toFixed(2)}% of the frame; add a shape or darken it.` });
  }
  if (outOfPaletteFraction !== null) {
    const max = options.maxOutOfPaletteFraction ?? DEFAULT_MAX_OUT_OF_PALETTE;
    if (outOfPaletteFraction > max) {
      errors.push({
        code: 'out-of-palette',
        message: `${(outOfPaletteFraction * 100).toFixed(0)}% of visible pixels are outside the theme palette ${options.palette?.join(', ')}.`,
      });
    } else if (outOfPaletteFraction > max / 2) {
      warnings.push(`${(outOfPaletteFraction * 100).toFixed(0)}% of visible pixels are slightly outside the theme palette.`);
    }
  }

  return { ok: errors.length === 0, width: image.width, height: image.height, opaqueFraction, outOfPaletteFraction, errors, warnings };
}
