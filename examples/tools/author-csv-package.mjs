// D1: build examples/csv-charts/package.json from data.csv. The dataset and the
// chart scenes are produced by the same pure agent functions the server uses,
// so the committed package's labels and values can be checked back against the
// CSV. Run it (after `npm --prefix packages/agent run build`):
//
//   node examples/tools/author-csv-package.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { datasetFromCsv, proposeChartScenes } from '../../packages/agent/dist/src/index.js';

const here = dirname(fileURLToPath(import.meta.url));
export const EXAMPLE_DIR = join(here, '..', 'csv-charts');
export const DATASET_ID = 'd_minutes';
export const CSV_PATH = join(EXAMPLE_DIR, 'data.csv');

/** Strip the `kind` used for proposal bookkeeping; the schema rejects extra keys. */
function toScene(proposal) {
  const { kind, ...scene } = proposal;
  return scene;
}

/** The body copy and source caption are read from the CSV, never typed by hand. */
export function buildCsvPackage() {
  const csv = readFileSync(CSV_PATH, 'utf8');
  const { dataset } = datasetFromCsv(csv, {
    unit: 'minutes',
    label: 'Where the minutes went',
    source: 'user',
    note: 'The team planning log for one launch video.',
  });
  const chartScenes = proposeChartScenes({ datasetId: DATASET_ID, dataset }).map(toScene);
  const [bar, number, comparison] = chartScenes;
  const title = {
    id: 's_title',
    layout: 'title',
    variant: 'centered',
    preferredFrames: 150,
    copy: { kicker: 'Data-driven scenes', headline: 'From a CSV to a chart', sub: 'Every label and value is the CSV value.' },
    background: { procedural: { pattern: 'mesh', seed: 11, palette: ['#0d0f14', '#1b2440', '#6d8cff'] } },
    foreground: [],
    transitionOut: { type: 'fade', frames: 15 },
  };
  const outro = {
    id: 's_outro',
    layout: 'title',
    variant: 'outro',
    preferredFrames: 150,
    copy: { headline: 'Your data, rendered', sub: 'Paste a CSV, get accurate charts.', cta: 'github.example/comfyrizz' },
    background: { procedural: { pattern: 'mesh', seed: 23, palette: ['#0d0f14', '#1b2440', '#6d8cff'] } },
    foreground: [],
  };
  return {
    $schema: 'https://comfyrizz.example/schema/package-v1.json',
    schemaVersion: 1,
    revision: 1,
    id: 'pkg_csvcharts0001',
    title: 'CSV chart scenes',
    createdAt: '2025-10-18T00:00:00.000Z',
    format: { width: 1920, height: 1080, fps: 30 },
    duration: { mode: 'flexible', flexibleCeilingFrames: 2700 },
    theme: { palette: ['#0d0f14', '#1b2440', '#6d8cff', '#e6e8ee'], font: 'Inter' },
    voice: { enabled: false, engine: 'none' },
    datasets: { [DATASET_ID]: dataset },
    scenes: [title, bar, number, comparison, outro],
    assets: {},
    compliance: {
      open_weights_only: true,
      llm: { provider: 'local-agent', model: 'csv-charts', weights: 'open' },
      backends_used: [],
      closed_apis_used: [],
      warnings: ['Dataset values come from data.csv; no invented numbers.'],
    },
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const pkg = buildCsvPackage();
  writeFileSync(join(EXAMPLE_DIR, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`);
  console.log(`wrote ${join(EXAMPLE_DIR, 'package.json')}`);
}
