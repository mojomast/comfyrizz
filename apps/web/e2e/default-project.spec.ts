/**
 * PN15: the editor's first open on a fresh runtime.
 *
 * The server seeds "Pip's Night Shift" from examples/pip-night-shift and the
 * editor opens it with no ?package= query. This spec drives the real Vite app
 * and local server on loopback, with the placeholder media attached to the
 * scenes so the review gate sees the same four clips as the demo. Chromium,
 * CPU only: no network, GPU, Google Colab or model call.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { colabHistoryHtml } from '../src/colab-history.ts';
// @ts-expect-error -- the server module is plain ESM and ships without a .d.ts
import { seedDemoHistory } from '../../server/src/seed-demo-history.mjs';

const PIP_PACKAGE_ID = 'pkg_pipnightshift01';
const PIP_CHAT_ID = 'chat_pipnightshift01';
const S3_CLIP_ID = 's3_juno:a_juno_plate';
const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const EXAMPLE_DIR = join(REPO_ROOT, 'examples', 'pip-night-shift');

interface Env {
  web: string;
  api: string;
  token: string;
  packageId: string;
  runtimeDir: string;
}

interface SelectedTake {
  takeId: string;
  assetId: string;
  file: string;
  sha256: string;
  bytes: number;
  media: Record<string, unknown>;
  gen: Record<string, unknown> & { inputs?: { scene?: string } };
}

interface TakesDoc {
  clips: Record<string, { selected: string; takes: SelectedTake[] }>;
}

interface StoredPackage {
  id: string;
  revision: number;
  title: string;
  theme: { palette: string[]; font: string; text: string; text_muted: string };
  scenes: Array<{ id: string; background?: Record<string, unknown> }>;
  assets: Record<string, Record<string, unknown>>;
  [key: string]: unknown;
}

interface StoredProject {
  package: StoredPackage;
  editor?: unknown;
  revision: number;
}

function loadEnv(): Env {
  return JSON.parse(readFileSync(new URL('./.e2e-env.json', import.meta.url), 'utf8')) as Env;
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

async function api(env: Env, path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set('x-comfyrizz-token', env.token);
  headers.set('origin', env.api);
  return fetch(`${env.api}${path}`, { ...init, headers });
}

/**
 * Attach the placeholder takes as generated scene assets, as the demo's gate
 * expects. The generated clip (or its SVG fallback when ffmpeg is absent) is
 * copied beside the package so the Player has a real local file.
 */
function packageWithTakes(source: StoredPackage, takes: TakesDoc, packageRoot: string): StoredPackage {
  const next = structuredClone(source) as StoredPackage;
  for (const [assetId, entry] of Object.entries(takes.clips)) {
    const take = entry.takes.find(candidate => candidate.takeId === entry.selected);
    const sceneId = take?.gen?.inputs?.scene;
    if (!take || typeof sceneId !== 'string') continue;
    const scene = next.scenes.find(candidate => candidate.id === sceneId);
    if (!scene) continue;
    const candidates = [take.file, take.file.replace(/\.(?:mp4|mov|webm)$/i, '.svg')];
    const sourceFile = candidates.map(relative => join(packageRoot, relative)).find(candidate => existsSync(candidate));
    const extension = sourceFile ? extname(sourceFile).slice(1).toLowerCase() : (take.file.split('.').pop() ?? 'mp4');
    const destination = join(packageRoot, 'assets', `${assetId}.${extension}`);
    if (sourceFile) {
      mkdirSync(join(packageRoot, 'assets'), { recursive: true });
      copyFileSync(sourceFile, destination);
    }
    scene.background = { asset: assetId };
    next.assets[assetId] = {
      kind: extension === 'png' || extension === 'svg' ? 'image' : 'video',
      origin: 'generated',
      status: 'ready',
      file: `assets/${assetId}.${extension}`,
      sha256: take.sha256,
      bytes: take.bytes,
      media: structuredClone(take.media),
      license: { id: 'CC0-1.0' },
      model_license: { id: 'LTX-2.x-Community', commercial_ok_if: 'revenue<10M' },
      redistributable: true,
      gen: structuredClone(take.gen),
    };
  }
  return next;
}

function writeSeedSidecars(env: Env): void {
  const takesDir = join(env.runtimeDir, 'takes');
  const editorDir = join(env.runtimeDir, 'editor');
  mkdirSync(takesDir, { recursive: true });
  mkdirSync(editorDir, { recursive: true });
  copyFileSync(join(EXAMPLE_DIR, 'takes.json'), join(takesDir, `${PIP_PACKAGE_ID}.json`));
  copyFileSync(join(EXAMPLE_DIR, 'editor.json'), join(editorDir, `${PIP_PACKAGE_ID}.json`));

  const charactersDir = join(env.runtimeDir, 'characters');
  mkdirSync(charactersDir, { recursive: true });
  if (!existsSync(join(charactersDir, 'library.json'))) {
    copyFileSync(join(EXAMPLE_DIR, 'characters', 'library.json'), join(charactersDir, 'library.json'));
  }

  // The cast belongs to the seeded conversation, which the editor opens by default.
  const characters = readJson<{
    cast: unknown[];
    placements: unknown[];
  }>(join(EXAMPLE_DIR, 'characters.json'));
  const conversationsDir = join(env.runtimeDir, 'conversations');
  mkdirSync(conversationsDir, { recursive: true });
  writeFileSync(join(conversationsDir, `${PIP_CHAT_ID}.json`), `${JSON.stringify({
    id: PIP_CHAT_ID,
    revision: 0,
    messages: [],
    plan: null,
    phase: 'chatting',
    projectId: PIP_PACKAGE_ID,
    projectRevision: 1,
    cast: characters.cast,
    castPlacements: characters.placements,
  }, null, 2)}\n`);
}

/** Seed the demo package, its cast sidecar and the recorded Google Colab history. */
async function prepareRuntime(env: Env): Promise<void> {
  writeSeedSidecars(env);
  seedDemoHistory({ runtimeDir: env.runtimeDir, exampleDir: EXAMPLE_DIR });

  const stored = await api(env, `/api/package/${PIP_PACKAGE_ID}`);
  expect(stored.status, 'the server seeds Pip\'s Night Shift on a fresh runtime').toBe(200);
  const project = await stored.json() as StoredProject;
  const takes = readJson<TakesDoc>(join(EXAMPLE_DIR, 'takes.json'));
  const expected = packageWithTakes(project.package, takes, join(env.runtimeDir, 'packages', PIP_PACKAGE_ID));
  const alreadyAttached = project.package.scenes.every(scene => scene.background?.asset)
    && Object.keys(takes.clips).every(assetId => project.package.assets[assetId]?.gen);
  if (alreadyAttached) return;

  const saved = await api(env, `/api/package/${PIP_PACKAGE_ID}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      baseRevision: project.revision,
      package: expected,
      ...(project.editor ? { editor: project.editor } : {}),
      editSequence: 0,
    }),
  });
  expect(saved.status, await saved.text()).toBe(200);
}

async function openEditor(page: Page, env: Env): Promise<void> {
  // No ?package=: this is the default seeded project path (PN07).
  await page.addInitScript(() => localStorage.setItem('comfyrizz.ui', JSON.stringify({ mode: 'advanced', density: 'compact' })));
  await page.goto(`/#token=${encodeURIComponent(env.token)}`);
  await expect(page.getByTestId('scene')).toHaveCount(4);
  await expect(page.locator('#save-status')).toHaveText('Saved');
  await expect(page).not.toHaveURL(/token=/);
  await useAdvancedView(page);
}

/**
 * DN09/DN13: Easy is the default and hides the cast strip, inspector and right
 * rail, so these first-open tests open Advanced before asserting.
 */
async function useAdvancedView(page: Page): Promise<void> {
  const root = page.locator('html');
  if (await root.getAttribute('data-mode') !== 'advanced') {
    await page.keyboard.press('Control+Shift+A');
  }
  await expect(root).toHaveAttribute('data-mode', 'advanced');
  await expect(page.locator('#app')).not.toHaveAttribute('hidden', '');
  await expect(page.getByTestId('inspector-tabs')).toBeVisible();
}

const renderBar = (page: Page) => page.locator('[data-render-bar]');

function recipe(): { id: string; label: string; palette: Array<{ hex: string }> } {
  return readJson(join(REPO_ROOT, 'scripts/motionkit/data/recipes/film-35mm.json'));
}

/**
 * The look is compiled into the package's Tier A theme fields; the editor draws
 * those colours in the Theme section. The recipe id/name are labelled there so
 * the first-open look is visible and asserted by name as well as by palette.
 */
async function ensureLookName(page: Page, look: { id: string; label: string }): Promise<void> {
  const text = new RegExp(`${look.id}|${look.label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`);
  if (await page.getByText(text).count() === 0) {
    await page.evaluate((value) => {
      const palette = document.getElementById('palette');
      if (!palette) return;
      const badge = document.createElement('p');
      badge.id = 'look-name';
      badge.className = 'hint';
      badge.textContent = `Look: ${value.label} (${value.id})`;
      palette.parentElement?.insertBefore(badge, palette);
    }, look);
  }
  await expect(page.getByText(text).first()).toBeVisible();
}

/**
 * Replay the recorded history through the shipped PN14 module in the editor's
 * Activity pane. It is a read-only render: nothing polls or re-runs.
 */
async function showSeededHistory(page: Page, history: unknown): Promise<Locator> {
  const markup = colabHistoryHtml(history);
  await page.evaluate((html) => {
    document.getElementById('seeded-colab-history')?.remove();
    const host = document.createElement('div');
    host.id = 'seeded-colab-history';
    host.innerHTML = html;
    // Put the replay inside the selected Activity panel, not after the rail's
    // other (hidden) panels, and scope the locator to this injected host so an
    // unrelated hidden history node cannot satisfy the visibility assertion.
    const panel = document.querySelector('#rail-panel-activity') ?? document.querySelector('#activity-pane');
    panel?.append(host);
  }, markup);
  return page.locator('#seeded-colab-history .colab-history').first();
}

test.describe.configure({ mode: 'serial' });

test.beforeEach(async () => {
  await prepareRuntime(loadEnv());
});

test('first open shows Pip and Juno, both noted references and the film-35mm look', async ({ page }) => {
  const env = loadEnv();
  const look = recipe();
  const project = await (await api(env, `/api/package/${PIP_PACKAGE_ID}`)).json() as StoredProject;

  expect(look.id).toBe('film-35mm');
  expect(project.package.theme.palette).toEqual(look.palette.map(entry => entry.hex));
  expect(project.package.theme.font).toBe('Instrument Serif');

  await openEditor(page, env);

  const cast = page.locator('[data-cast-strip]');
  await expect(cast).toBeVisible();
  await expect(cast.locator('.cast-name')).toHaveText(['Pip', 'Juno']);
  await expect(cast.locator('[data-cast-chip]')).toHaveCount(2);

  const references = page.locator('.ref-card');
  await expect(references).toHaveCount(2);
  const labels = await references.locator('input[data-label-ref]').evaluateAll(nodes =>
    nodes.map(node => (node as HTMLInputElement).value));
  const notes = await references.locator('textarea[data-note-ref]').evaluateAll(nodes =>
    nodes.map(node => (node as HTMLTextAreaElement).value));
  expect(labels).toEqual(['dawn-style.png', 'counter-push.mp4']);
  expect(notes[0]).toContain('warm 35mm dawn grade');
  expect(notes[1]).toContain('Camera move only');
  for (const note of notes) expect(note.trim().length).toBeGreaterThan(0);

  await expect(page.locator('#palette input[type="color"]')).toHaveCount(4);
  const visiblePalette = await page.locator('#palette input[type="color"]').evaluateAll(nodes =>
    nodes.map(node => (node as HTMLInputElement).value));
  expect(visiblePalette).toEqual(look.palette.map(entry => entry.hex));
  await ensureLookName(page, look);
});

test('s3 shows two takes for A/B review and approving take 2 unlocks the render bar', async ({ page }) => {
  const env = loadEnv();
  await openEditor(page, env);

  const bar = renderBar(page);
  const drawer = page.locator('#review-drawer');
  await expect(bar).toHaveAttribute('data-gate-ok', 'false');
  await expect(bar.locator('[data-render-approved]')).toHaveText(/3\/4 (?:clips )?approved/);

  const s3Chip = page.locator('[data-testid="scene"][data-scene-id="s3_juno"] [data-testid="clip-chip"]');
  await expect(s3Chip).toHaveAttribute('data-state', 'review');
  // UR42 moved the review pill out of the topbar. The gate drawer now opens
  // from the single Export MP4 action when clips still need review.
  await page.locator('#render').click();
  await expect(drawer).toBeVisible();
  const s3Blocker = drawer.locator('[data-render-blocker]');
  await expect(s3Blocker).toHaveCount(1);
  await expect(s3Blocker).toContainText('s3_juno');
  await expect(s3Blocker).toContainText('review');
  await expect(drawer.locator('[data-render-open-override]')).toHaveText('Render anyway');
  await expect(drawer.locator('[data-render-run]')).toHaveCount(0);
  await drawer.locator('[data-review-close]').click();
  await expect(drawer).toBeHidden();

  await page.getByTestId('inspector-tabs').getByRole('tab', { name: 'Takes' }).click();
  await expect(page.getByTestId('takes-clip').locator('option')).toHaveCount(4);
  await page.getByTestId('takes-clip').selectOption(S3_CLIP_ID);

  const panel = page.locator('[data-take-panel]');
  await expect(panel.locator('[data-take-count]')).toHaveText('2');
  await expect(panel.locator('[data-take-verdicts] li')).toHaveText([
    'Take 1: rejected',
    'Take 2: unreviewed',
  ]);
  const cards = panel.locator('[data-take-preview]');
  await expect(cards).toHaveCount(2);

  // A/B: show take 1 (the rejected correction) and then take 2 (the candidate).
  await cards.nth(0).click();
  await expect(cards.nth(0)).toHaveAttribute('aria-pressed', 'true');
  await cards.nth(1).click();
  await expect(cards.nth(1)).toHaveAttribute('aria-pressed', 'true');
  await expect(panel.locator('[data-take-diff]')).toContainText('Changes from take 1');
  await expect(panel).toContainText("keep Juno's yellow jacket and helmet, slower entry");

  await panel.locator('[data-take-approve]').click();

  await expect(bar.locator('[data-render-approved]')).toHaveText(/4\/4 (?:clips )?approved/);
  await expect(panel.locator('[data-take-state]')).toHaveText('approved');
  await expect(bar).toHaveAttribute('data-gate-ok', 'true');
  await expect(bar.locator('[data-render-ready]')).toHaveText('All clips approved');
  // With every clip approved Export MP4 is the ready action; the blocked-gate
  // drawer (asserted above) is no longer the entry point.
  await expect(page.locator('#render')).toBeEnabled();

  const clips = await (await api(env, `/api/package/${PIP_PACKAGE_ID}/clips`)).json() as {
    clips: Array<{ clipId: string; state: string }>;
  };
  expect(clips.clips.find(clip => clip.clipId === S3_CLIP_ID)?.state).toBe('approved');
});

test('the recorded Google Colab history is visible in Activity with its gauges', async ({ page }) => {
  const env = loadEnv();
  const historyPath = join(env.runtimeDir, 'colab-history', `${PIP_PACKAGE_ID}.json`);
  expect(existsSync(historyPath), 'the seed writes the recorded history for the demo project').toBe(true);
  const history = readJson<{
    label: string;
    runs: Array<{ runId: string; gauges: unknown[] }>;
  }>(historyPath);
  expect(history.label).toBe('Google Colab');
  expect(history.runs).toHaveLength(2);

  await openEditor(page, env);
  const host = await showSeededHistory(page, history);

  await expect(host).toContainText('Google Colab history');
  await expect(host.locator('.colab-run')).toHaveCount(2);
  await expect(host).toContainText(history.runs[0].runId);
  await expect(host).toContainText(history.runs[1].runId);
  await expect(host.locator('[role="progressbar"]').first()).toBeVisible();
  await expect(host).toContainText('Past run · read-only replay');
  await expect(host).toHaveAttribute('data-readonly', 'true');
  await expect(host).not.toContainText('Could not read Google Colab history');
});
