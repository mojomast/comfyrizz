/**
 * D1: propose real chart scenes from a validated dataset. Pure and offline —
 * every number and label comes straight from the dataset, so a rendered label
 * can be compared byte-for-byte with the CSV. No model is involved.
 *
 * The renderer already draws `chart` (bars, exact values), `stat` (first value)
 * and `list` (bullets), and `package-v1` allows `data.display` of
 * `bar | number | counter`; a `line` chart would need a new schema `variant`
 * (MS2), so it is deliberately not proposed here.
 */
import type { Dataset, DatasetValue } from './dataset.js';

export type ChartSceneKind = 'bar' | 'number' | 'comparison';

export interface ChartSceneProposal {
  kind: ChartSceneKind;
  id: string;
  layout: 'chart' | 'stat' | 'list';
  variant?: string;
  preferredFrames: number;
  copy: Record<string, unknown>;
  data?: { dataset: string; display: 'bar' | 'number' | 'counter' };
  background: { procedural: { pattern: string; seed: number } };
  foreground: [];
  transitionOut: { type: 'fade'; frames: number };
}

export interface ProposeChartScenesOptions {
  datasetId: string;
  dataset: Dataset;
  kinds?: ChartSceneKind[];
  preferredFrames?: Partial<Record<ChartSceneKind, number>>;
}

export const CHART_SCENE_KINDS: ChartSceneKind[] = ['bar', 'number', 'comparison'];

const PATTERNS = ['grid', 'gradient', 'grain', 'mesh'] as const;

/** Stable seed so the same dataset proposes the same backgrounds. */
function seedFor(text: string): number {
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return Math.abs(hash) % 997;
}

/** Exact value text the renderer draws: the raw number plus the unit. */
export function formatValue(value: number, unit: string): string {
  return unit ? `${value} ${unit}` : String(value);
}

/** A citation line for the scene footnote; never invents a number or a source. */
export function sourceCaption(datasetId: string, dataset: Dataset): string {
  const name = dataset.label ?? datasetId;
  if (dataset.source === 'example') return `${name} · example data — approve before a final render`;
  const where = dataset.source_url ?? dataset.note ?? `source: ${dataset.source}`;
  return `${name} · ${where}`;
}

function sceneId(datasetId: string, kind: ChartSceneKind): string {
  const slug = datasetId.replace(/^d_/, '').replace(/[^A-Za-z0-9]+/g, '_').slice(0, 24) || 'data';
  return `s_data_${slug}_${kind}`;
}

function sceneBase(datasetId: string, kind: ChartSceneKind, frames: number): Pick<ChartSceneProposal, 'id' | 'preferredFrames' | 'background' | 'foreground' | 'transitionOut'> {
  return {
    id: sceneId(datasetId, kind),
    preferredFrames: frames,
    background: { procedural: { pattern: PATTERNS[seedFor(`${datasetId}:${kind}`) % PATTERNS.length], seed: (seedFor(`${datasetId}:${kind}`) % 89) + 1 } },
    foreground: [],
    transitionOut: { type: 'fade', frames: 15 },
  };
}

function barScene(datasetId: string, dataset: Dataset, frames: number): ChartSceneProposal {
  return {
    ...sceneBase(datasetId, 'bar', frames),
    kind: 'bar',
    layout: 'chart',
    variant: 'bar',
    copy: {
      headline: dataset.label ?? 'The numbers',
      sub: `Unit: ${dataset.unit}`,
      footnote: sourceCaption(datasetId, dataset),
    },
    data: { dataset: datasetId, display: 'bar' },
  };
}

function numberScene(datasetId: string, dataset: Dataset, frames: number): ChartSceneProposal {
  const [first] = dataset.values;
  return {
    ...sceneBase(datasetId, 'number', frames),
    kind: 'number',
    layout: 'stat',
    copy: {
      headline: dataset.label ?? first.label,
      body: formatValue(first.value, dataset.unit),
      sub: first.label,
      footnote: sourceCaption(datasetId, dataset),
    },
    data: { dataset: datasetId, display: 'number' },
  };
}

function comparisonScene(datasetId: string, dataset: Dataset, frames: number): ChartSceneProposal {
  const items = dataset.values.map(item => `${item.label}: ${formatValue(item.value, dataset.unit)}`);
  return {
    ...sceneBase(datasetId, 'comparison', frames),
    kind: 'comparison',
    layout: 'list',
    variant: 'bullets',
    copy: {
      headline: dataset.label ?? 'How they compare',
      items,
      footnote: sourceCaption(datasetId, dataset),
    },
  };
}

/**
 * Propose one scene per requested kind. Values are the dataset's own values in
 * declaration order, so the labels a viewer sees are the CSV labels.
 */
export function proposeChartScenes({ datasetId, dataset, kinds = CHART_SCENE_KINDS, preferredFrames = {} }: ProposeChartScenesOptions): ChartSceneProposal[] {
  if (!datasetId || typeof datasetId !== 'string') throw new Error('proposeChartScenes needs a datasetId');
  if (!dataset || !Array.isArray(dataset.values) || dataset.values.length === 0) throw new Error('proposeChartScenes needs a dataset with values');
  const out: ChartSceneProposal[] = [];
  for (const kind of kinds) {
    if (kind === 'bar') out.push(barScene(datasetId, dataset, preferredFrames.bar ?? 240));
    else if (kind === 'number') out.push(numberScene(datasetId, dataset, preferredFrames.number ?? 180));
    else if (kind === 'comparison') out.push(comparisonScene(datasetId, dataset, preferredFrames.comparison ?? 210));
    else throw new Error(`unknown chart scene kind: ${String(kind)}`);
  }
  return out;
}

/** The label/value pairs a proposal sheet shows, straight from the dataset. */
export function proposalValues(dataset: Dataset): DatasetValue[] {
  return dataset.values.map(item => ({ label: item.label, value: item.value }));
}
