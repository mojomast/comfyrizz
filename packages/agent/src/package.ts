/**
 * Deterministic CPU package skeleton (C5). The agent still drives the tools;
 * this module only supplies the readable default scenes/datasets so a chat
 * brief can become a valid comfyrizz.package/v1 document without a GPU.
 */

export const PACKAGE_SCHEMA = 'https://comfyrizz.example/schema/package-v1.json';
export const DEFAULT_PALETTE = ['#0d0f14', '#1b2440', '#6d8cff', '#e6e8ee'];

export interface CpuScene {
  id: string;
  layout: 'title' | 'hero' | 'stat' | 'chart' | 'list';
  variant?: string;
  preferredFrames: number;
  copy: Record<string, unknown>;
  data?: { dataset: string; display: string };
  background: { procedural: { pattern: string; seed: number; palette?: string[] } };
  foreground?: Array<{ asset: string; x: number; y: number; w: number; anim: string }>;
  transitionOut?: { type: 'fade'; frames: number };
}

export function titleFor(brief: string): string {
  const first = brief.replace(/\s+/g, ' ').split(/[.!?\n]/)[0]?.trim() || 'Comfyrizz package';
  return first.length > 48 ? `${first.slice(0, 45).trimEnd()}…` : first;
}

export function defaultCpuDatasets(): Record<string, unknown> {
  return {
    d_minutes: {
      unit: 'minutes',
      label: 'Example minutes per step',
      values: [
        { label: 'CPU slice', value: 6 },
        { label: 'Render queue', value: 19 },
        { label: 'Review edits', value: 11 },
        { label: 'Waiting', value: 34 },
      ],
      source: 'example',
      approved: true,
      note: 'Invented numbers for the CPU demo; labelled as an example.',
    },
  };
}

/** Five readable scenes plus an outro; every layout is exercised on CPU. */
export function defaultCpuScenes(brief: string): CpuScene[] {
  const title = titleFor(brief);
  return [
    {
      id: 's_title',
      layout: 'title',
      variant: 'centered',
      preferredFrames: 150,
      copy: { kicker: 'Agent-built package', headline: title, sub: 'Chat brief to storyboard to CPU MP4.' },
      background: { procedural: { pattern: 'mesh', seed: 11, palette: DEFAULT_PALETTE.slice(0, 3) } },
      foreground: [],
      transitionOut: { type: 'fade', frames: 15 },
    },
    {
      id: 's_hero',
      layout: 'hero',
      variant: 'split',
      preferredFrames: 240,
      copy: {
        headline: 'Generated-first assets',
        sub: 'Icons, diagrams and patterns are SVG written as code.',
        body: 'The agent sanitizes and render-checks every SVG on CPU, repairs it at most twice, then hands the vector straight to Remotion.',
      },
      background: { procedural: { pattern: 'grid', seed: 3 } },
      foreground: [],
      transitionOut: { type: 'fade', frames: 15 },
    },
    {
      id: 's_stat',
      layout: 'stat',
      preferredFrames: 180,
      copy: { headline: 'CPU time for this slice', sub: 'Measured locally, no GPU and no network.', body: '6 min' },
      data: { dataset: 'd_minutes', display: 'number' },
      background: { procedural: { pattern: 'gradient', seed: 5 } },
      foreground: [],
      transitionOut: { type: 'fade', frames: 15 },
    },
    {
      id: 's_chart',
      layout: 'chart',
      variant: 'bar',
      preferredFrames: 240,
      copy: { headline: 'Where the example minutes went', sub: 'Shorter is better.', footnote: 'Example data, invented for this demo.' },
      data: { dataset: 'd_minutes', display: 'bar' },
      background: { procedural: { pattern: 'grain', seed: 17 } },
      foreground: [],
      transitionOut: { type: 'fade', frames: 15 },
    },
    {
      id: 's_list',
      layout: 'list',
      variant: 'bullets',
      preferredFrames: 210,
      copy: {
        headline: 'What the CPU slice does',
        items: [
          'Routes icons, diagrams and patterns to SVG',
          'Sanitizes and render-checks every vector',
          'Marks FLUX and LTX needs pending-GPU',
          'Keeps a procedural fallback on every scene',
        ],
      },
      background: { procedural: { pattern: 'dots', seed: 2 } },
      foreground: [],
      transitionOut: { type: 'fade', frames: 15 },
    },
    {
      id: 's_outro',
      layout: 'title',
      variant: 'outro',
      preferredFrames: 150,
      copy: { headline: 'Ready to render', sub: 'Local, deterministic and free.', cta: 'github.example/comfyrizz' },
      background: { procedural: { pattern: 'mesh', seed: 23, palette: DEFAULT_PALETTE.slice(0, 3) } },
      foreground: [],
    },
  ];
}

/** Deterministic foreground placement per layout so generated assets are visible. */
export function foregroundFor(sceneId: string, index: number): { asset: string; x: number; y: number; w: number; anim: string } | null {
  const slots: Record<string, { x: number; y: number; w: number; anim: string }> = {
    s_title: { x: 0.5, y: 0.79, w: 0.07, anim: 'fade-in' },
    s_hero: { x: 0.72, y: 0.5, w: 0.46, anim: 'slide-in' },
    s_stat: { x: 0.13, y: 0.2, w: 0.06, anim: 'zoom-in' },
    s_chart: { x: 0.88, y: 0.22, w: 0.1, anim: 'fade-in' },
    s_list: { x: 0.83, y: 0.5, w: 0.3, anim: 'parallax-in' },
    s_outro: { x: 0.5, y: 0.72, w: 0.34, anim: 'slide-in' },
  };
  const slot = slots[sceneId];
  if (!slot) return null;
  const jitter = (index % 2) * 0.03;
  return { asset: '', ...slot, y: Math.min(0.9, slot.y + jitter) };
}
