#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const webRoot = join(repoRoot, 'apps', 'web');
const e2eDir = join(webRoot, 'e2e');
const envFile = join(e2eDir, '.e2e-env.json');
const webBase = 'http://127.0.0.1:4175';
const pipPackageId = 'pkg_pipnightshift01';
const pipTitle = "Pip's Night Shift";
const pipExample = join(repoRoot, 'examples', 'pip-night-shift', 'package.json');
const pipHistory = join(repoRoot, 'examples', 'pip-night-shift', 'colab-history.json');
const viewport = Object.freeze({ width: 1440, height: 900 });
const webpQuality = 82;
const defaultOut = 'docs/media';
let activeSecrets = [];

const editorUrl = `${webBase}/#token=<redacted>`;
const demoUrl = `${webBase}/demo.html?fixture=1`;

const shots = [
  {
    name: 'character-library',
    target: 'editor',
    required: ['#characters-tab', '[data-character-library]'],
    selectors: ['#characters-tab', '[data-character-library]', '[data-character-grid]', '[data-open-character]', '[data-character-editor]'],
    note: 'Character library grid with one character open in the editor drawer.',
  },
  {
    name: 'character-cast-mention',
    target: 'editor',
    required: ['[data-cast-strip]', '#prompt'],
    selectors: ['[data-cast-strip]', '[data-cast-chips]', '[data-cast-chip]', '#prompt'],
    note: 'Project cast strip above the composer, with an @handle mention typed into chat.',
  },
  {
    name: 'character-identity',
    target: 'editor',
    required: ['[data-character-editor]', '[data-section="identity"]', '[data-section="look"]'],
    selectors: ['[data-character-editor]', '[data-section="identity"]', '[data-identity-method]', '[data-field="visual.identity.method"]', '[data-action="generate-sheet"]', 'button:has-text("Generate sheet")', '[data-section="look"]'],
    note: 'Character editor identity and look sections; shows the sheet action and identity method when the build provides them.',
  },
  {
    name: 'character-speaker',
    target: 'editor',
    required: ['#scene-timeline', '#voice-panel'],
    selectors: ['#scene-timeline', '[data-speaker-picker]', '[data-scene-speaker]', '#voice-panel [data-speaker]'],
    note: 'Per-scene speaker picker when present, otherwise the speaker selector in the voice panel beside the timeline.',
  },
  {
    name: 'character-real-consent',
    target: 'editor',
    required: ['[data-character-editor]', '[data-section="identity"]'],
    selectors: ['[data-character-editor]', '[data-section="identity"]', '[data-real-consent]', '[data-consent]', '[data-likeness-warning]', '[data-fictional]'],
    note: 'Consent checkbox and likeness warning for an authorized real person, with the fictional-only control as the fallback.',
  },
  {
    name: 'ui-references',
    target: 'editor',
    required: ['.reference-panel', '[data-ref-pick]'],
    selectors: ['.reference-panel', '[data-ref-pick]', '[data-ref-count]', '[data-ref-cards]', '.ref-card'],
    note: 'References panel with the seeded Pip project reference cards.',
  },
  {
    name: 'ui-timeline-review',
    target: 'editor',
    required: ['[data-testid="timeline"]', '[data-inspector-tab="takes"]', '[data-render-bar]'],
    selectors: ['[data-testid="timeline"]', '[data-testid="scene"]', '[data-inspector-tab="takes"]', '[data-take-panel]', '[data-render-bar]'],
    note: 'Timeline clip chips, the Takes inspector and the final render gate.',
  },
  {
    name: 'ui-pip-default',
    target: 'editor',
    required: ['#save-status', '[data-testid="scene"][data-scene-id="s1_dawn"]', '[data-testid="timeline"]'],
    selectors: ['#save-status', '[data-testid="scene"][data-scene-id="s1_dawn"]', '[data-testid="timeline"]', '[data-cast-strip]'],
    note: "Pip's Night Shift editor on first open from the seeded local project.",
  },
  {
    name: 'ui-colab-spend',
    target: 'editor',
    required: ['#backend', '#run-backend'],
    selectors: ['#backend', '#run-backend', '#spend-card .spend-card', '[data-render-bar]'],
    note: 'Google Colab spend card from a dry-run plan, including the rate and collect-and-stop reserve in its budget message.',
  },
  {
    name: 'ui-agent-editor',
    target: 'editor',
    required: ['[data-testid="scene"]', '[data-cast-strip]', '.reference-panel', '[data-inspector-tab="takes"]'],
    selectors: ['[data-testid="scene"]', '[data-cast-strip]', '.reference-panel', '[data-inspector-tab="takes"]', '[data-take-panel]', '[data-render-bar]'],
    note: "Main editor with Pip's Night Shift, the project cast, references and the Takes inspector.",
  },
  {
    name: 'ui-demo-webapp',
    target: 'demo',
    required: ['#demo-mode[data-mode="fixture"]', '#storyboard .storyboard-scene'],
    selectors: ['#demo-mode[data-mode="fixture"]', '#storyboard .storyboard-scene', '#activity .activity-phase', '#spend .spend-card'],
    note: 'Offline demo page in fixture mode, with the storyboard and spend card.',
  },
  {
    name: 'colab-gauges-preview',
    target: 'editor',
    required: ['#scene-timeline'],
    selectors: ['.colab-history', '.colab-gauge', '[role="progressbar"]'],
    note: "Google Colab progress gauges replayed from examples/pip-night-shift/colab-history.json inside the editor.",
  },
];

function usage() {
  return 'Usage: node scripts/capture-readme-media.mjs [--only name,...] [--out docs/media] [--dry-run]';
}

function parseArgs(argv) {
  const options = { only: null, out: defaultOut, dryRun: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--dry-run') {
      options.dryRun = true;
    } else if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else if (arg === '--only') {
      const value = argv[index + 1];
      if (!value) throw new Error('--only needs a comma-separated list of shot names');
      options.only = value.split(',').map(item => item.trim()).filter(Boolean);
      index += 1;
    } else if (arg.startsWith('--only=')) {
      options.only = arg.slice('--only='.length).split(',').map(item => item.trim()).filter(Boolean);
    } else if (arg === '--out') {
      const value = argv[index + 1];
      if (!value) throw new Error('--out needs a directory');
      options.out = value;
      index += 1;
    } else if (arg.startsWith('--out=')) {
      options.out = arg.slice('--out='.length);
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }
  return options;
}

function selectedShots(only) {
  if (!only || only.length === 0) return shots;
  const names = new Set(shots.map(shot => shot.name));
  const unknown = only.filter(name => !names.has(name));
  if (unknown.length > 0) throw new Error(`Unknown shot name(s): ${unknown.join(', ')}. Known: ${[...names].join(', ')}`);
  const wanted = new Set(only);
  return shots.filter(shot => wanted.has(shot.name));
}

function printPlan(selection, outDir) {
  const lines = [`README media capture plan (${selection.length} shot${selection.length === 1 ? '' : 's'})`, `output: ${outDir}`];
  for (const shot of selection) {
    const url = shot.target === 'demo' ? demoUrl : editorUrl;
    lines.push('');
    lines.push(`- ${shot.name}`);
    lines.push(`  url: ${url}`);
    lines.push(`  selectors: ${shot.selectors.join(', ')}`);
    lines.push(`  note: ${shot.note}`);
  }
  lines.push('');
  lines.push('Dry run: no browser and no server were started.');
  console.log(lines.join('\n'));
}

function insideRepo(target) {
  const rel = relative(repoRoot, target);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function redact(value, context = {}) {
  let text = String(value ?? '');
  for (const secret of [context.token, context.runtimeDir, repoRoot, ...activeSecrets]) {
    if (typeof secret === 'string' && secret.length > 0) text = text.split(secret).join('[redacted]');
  }
  text = text.replace(/(?:[A-Za-z]:)?[\\/](?:home|Users)[\\/][^\s"'<>]+/g, '[path]');
  text = text.replace(/[\\/]tmp[\\/][^\s"'<>]+/g, '[path]');
  return text;
}

async function loadChromium() {
  const requireFromWeb = createRequire(join(webRoot, 'package.json'));
  const requireFromHere = createRequire(import.meta.url);
  for (const name of ['playwright', '@playwright/test', 'playwright-core']) {
    let resolved = null;
    for (const resolver of [requireFromWeb, requireFromHere]) {
      try {
        resolved = resolver.resolve(name);
        break;
      } catch {
        resolved = null;
      }
    }
    if (!resolved) continue;
    try {
      const module = await import(pathToFileURL(resolved).href);
      const chromium = module.chromium ?? module.default?.chromium;
      if (chromium) return chromium;
    } catch {
      continue;
    }
  }
  throw new Error('Playwright is not installed. Run pnpm install and pnpm --filter @comfyrizz/web exec playwright install chromium.');
}

function guardSeedFile() {
  const seedFiles = [
    'package.json',
    'timeline.json',
    'editor.json',
    'takes.json',
    'characters.json',
    'characters/library.json',
    'references/manifest.json',
  ].map(name => join(repoRoot, 'examples', 'pip-night-shift', name));
  const missing = seedFiles.filter(file => !existsSync(file));
  if (missing.length > 0) {
    throw new Error(`Pip seed incomplete: missing ${missing.map(file => relative(repoRoot, file)).join(', ')}. Restore examples/pip-night-shift before capturing.`);
  }
  let packageJson;
  try {
    packageJson = JSON.parse(readFileSync(pipExample, 'utf8'));
  } catch (error) {
    throw new Error(`Pip seed is not valid JSON: ${relative(repoRoot, pipExample)} (${error.message})`);
  }
  if (packageJson?.id !== pipPackageId || packageJson?.title !== pipTitle) {
    throw new Error(`Pip seed mismatch: ${relative(repoRoot, pipExample)} is ${packageJson?.id ?? 'an unknown package'} ("${packageJson?.title ?? ''}").`);
  }
}

function readHistoryFixture() {
  if (!existsSync(pipHistory)) {
    throw new Error(`Google Colab history fixture missing: ${relative(repoRoot, pipHistory)} does not exist.`);
  }
  const history = JSON.parse(readFileSync(pipHistory, 'utf8'));
  if (history?.projectId !== pipPackageId || history?.label !== 'Google Colab') {
    throw new Error(`Google Colab history fixture is not the Pip recording: ${relative(repoRoot, pipHistory)}.`);
  }
  return history;
}

function startServer() {
  rmSync(envFile, { force: true });
  const logs = [];
  const child = spawn(process.execPath, ['--experimental-strip-types', 'e2e/serve.mjs'], {
    cwd: webRoot,
    env: { ...process.env, COMFYRIZZ_DEMO: 'pip' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const collect = stream => stream.on('data', chunk => {
    logs.push(String(chunk));
    if (logs.length > 40) logs.shift();
  });
  collect(child.stdout);
  collect(child.stderr);
  return { child, logs };
}

async function waitForEnvFile(child, logs) {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`e2e/serve.mjs exited ${child.exitCode}: ${redact(logs.join('').slice(-3000))}`);
    }
    if (existsSync(envFile)) {
      try {
        return JSON.parse(readFileSync(envFile, 'utf8'));
      } catch {
        await delay(100);
        continue;
      }
    }
    await delay(200);
  }
  throw new Error(`e2e/serve.mjs did not write its environment file within 90 seconds: ${redact(logs.join('').slice(-3000))}`);
}

async function waitForWeb() {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${webBase}/`, { redirect: 'manual' });
      if (response.ok) return;
    } catch {
      await delay(0);
    }
    await delay(250);
  }
  throw new Error(`Vite did not answer at ${webBase} within 60 seconds.`);
}

async function seedDemoExtras(env) {
  if (!env || typeof env.runtimeDir !== 'string' || env.runtimeDir.length === 0) return;
  const runtimeDir = env.runtimeDir;
  const exampleDir = join(repoRoot, 'examples', 'pip-night-shift');
  const charactersDir = join(runtimeDir, 'characters');
  const pipCharacter = join(charactersDir, 'chr_542077e0091abbc6', 'character.json');
  if (!existsSync(pipCharacter)) {
    rmSync(join(charactersDir, 'library.json'), { force: true });
    const characters = await import(pathToFileURL(join(repoRoot, 'apps', 'server', 'src', 'seed-demo-characters.mjs')).href);
    characters.seedDemoCharacters({ runtimeDir, exampleDir });
  }
  const exampleLibrary = JSON.parse(readFileSync(join(exampleDir, 'characters', 'library.json'), 'utf8'));
  for (const character of Array.isArray(exampleLibrary.characters) ? exampleLibrary.characters : []) {
    const primary = Array.isArray(character.visual?.images) ? character.visual.images.find(image => image.primary === true) : null;
    const source = join(runtimeDir, 'characters', `${character.handle}.png`);
    const destination = primary ? join(runtimeDir, 'characters', character.id, 'images', `${primary.imgId}.png`) : null;
    if (destination && existsSync(source) && !existsSync(destination)) {
      mkdirSync(dirname(destination), { recursive: true });
      copyFileSync(source, destination);
    }
  }
  const historyPath = join(runtimeDir, 'colab-history', `${pipPackageId}.json`);
  if (!existsSync(historyPath)) {
    const history = await import(pathToFileURL(join(repoRoot, 'apps', 'server', 'src', 'seed-demo-history.mjs')).href);
    history.seedDemoHistory({ runtimeDir, exampleDir, packageId: pipPackageId });
  }
  const conversationFile = join(runtimeDir, 'conversations', 'chat_pipnightshift01.json');
  const projectCharacters = join(exampleDir, 'characters.json');
  if (!existsSync(conversationFile) && existsSync(projectCharacters)) {
    const seeded = JSON.parse(readFileSync(projectCharacters, 'utf8'));
    const cast = Array.isArray(seeded.cast) ? seeded.cast : [];
    if (cast.length > 0) {
      mkdirSync(dirname(conversationFile), { recursive: true });
      writeFileSync(conversationFile, `${JSON.stringify({
        id: 'chat_pipnightshift01',
        revision: 1,
        messages: [],
        plan: null,
        phase: 'chatting',
        projectId: pipPackageId,
        projectRevision: 1,
        cast,
      }, null, 2)}\n`, { mode: 0o600 });
    }
  }
}

/**
 * Attach the example takes as generated scene assets (same as
 * apps/web/e2e/default-project.spec.ts packageWithTakes), so the timeline
 * chips, Takes tab and render gate have clips to show. Runtime-only.
 */
async function attachPipTakes(env) {
  const exampleDir = join(repoRoot, 'examples', 'pip-night-shift');
  const headers = { 'x-comfyrizz-token': env.token, origin: env.api };
  const response = await fetch(`${env.api}/api/package/${encodeURIComponent(pipPackageId)}`, { headers });
  if (!response.ok) throw new Error(`attach takes: GET package HTTP ${response.status}`);
  const project = await response.json();
  const takes = JSON.parse(readFileSync(join(exampleDir, 'takes.json'), 'utf8'));
  // The takes point at MP4 placeholder clips that are generated, not committed
  // (PN02, gitignored). Without them the player draws "media not in this clone".
  const needsMedia = Object.values(takes.clips ?? {}).some(entry => entry.takes.some(take => !existsSync(join(exampleDir, take.file))));
  if (needsMedia) {
    const made = spawnSync(process.execPath, [join(repoRoot, 'scripts', 'pip-night-shift', 'make-media.mjs')], { cwd: repoRoot, stdio: 'ignore', timeout: 300_000 });
    if (made.status !== 0) console.warn('warning: make-media.mjs failed; previews may show the missing-media placeholder');
  }
  const packageRoot = join(env.runtimeDir, 'packages', pipPackageId);
  // Copy every take's file into the runtime package so the takes routes can
  // mint media tickets for them (the server seeded before make-media ran).
  for (const entry of Object.values(takes.clips ?? {})) {
    for (const take of entry.takes) {
      const from = join(exampleDir, take.file);
      const to = join(packageRoot, take.file);
      if (existsSync(from) && !existsSync(to)) {
        mkdirSync(dirname(to), { recursive: true });
        copyFileSync(from, to);
      }
    }
  }
  const next = structuredClone(project.package);
  let changed = false;
  for (const [assetId, entry] of Object.entries(takes.clips ?? {})) {
    if (next.assets?.[assetId]?.gen) continue;
    const take = entry.takes.find(candidate => candidate.takeId === entry.selected);
    const sceneId = take?.gen?.inputs?.scene;
    const scene = typeof sceneId === 'string' ? next.scenes.find(candidate => candidate.id === sceneId) : null;
    if (!take || !scene) continue;
    const sourceFile = [take.file, take.file.replace(/\.(?:mp4|mov|webm)$/i, '.svg')]
      .flatMap(file => [join(packageRoot, file), join(exampleDir, file)]).find(file => existsSync(file));
    const extension = sourceFile ? extname(sourceFile).slice(1).toLowerCase() : (take.file.split('.').pop() ?? 'mp4');
    if (sourceFile) {
      mkdirSync(join(packageRoot, 'assets'), { recursive: true });
      copyFileSync(sourceFile, join(packageRoot, 'assets', `${assetId}.${extension}`));
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
    changed = true;
  }
  if (!changed) return;
  const saved = await fetch(`${env.api}/api/package/${encodeURIComponent(pipPackageId)}`, {
    method: 'PATCH',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({ baseRevision: project.revision, package: next, ...(project.editor ? { editor: project.editor } : {}), editSequence: 0 }),
  });
  if (!saved.ok) throw new Error(`attach takes: PATCH package HTTP ${saved.status}`);
}

async function waitForSeededPackage(env) {
  const deadline = Date.now() + 45_000;
  let last = 'not requested';
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${env.api}/api/package/${encodeURIComponent(pipPackageId)}`, {
        headers: { 'x-comfyrizz-token': env.token, origin: env.api },
      });
      if (response.ok) {
        const body = await response.json();
        if (body?.package?.id !== pipPackageId || body?.package?.title !== pipTitle) {
          throw new Error(`the server returned ${body?.package?.id ?? 'no package'} instead of ${pipPackageId}.`);
        }
        return;
      }
      last = `HTTP ${response.status}`;
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    await delay(300);
  }
  throw new Error(`Pip seed missing: GET /api/package/${pipPackageId} did not succeed (${redact(last)}). Start the server once with the Pip example present and try again.`);
}

function isEventStream(url) {
  return url.includes('/api/events');
}

function watchNetwork(page) {
  let pending = 0;
  let lastActivity = Date.now();
  const done = request => {
    if (isEventStream(request.url())) return;
    pending = Math.max(0, pending - 1);
    lastActivity = Date.now();
  };
  page.on('request', request => {
    if (isEventStream(request.url())) return;
    pending += 1;
    lastActivity = Date.now();
  });
  page.on('requestfinished', done);
  page.on('requestfailed', done);
  return {
    async idle({ quietMs = 600, timeoutMs = 20_000 } = {}) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (pending === 0 && Date.now() - lastActivity >= quietMs) return true;
        await delay(100);
      }
      return false;
    },
  };
}

async function waitForSelector(page, selector, options = {}) {
  const timeout = options.timeout ?? 25_000;
  await page.locator(selector).first().waitFor({ state: options.state ?? 'visible', timeout });
}

async function waitForRequired(page, selectors, state = 'visible') {
  for (const selector of selectors) await waitForSelector(page, selector, { state });
}

async function firstVisible(page, selectors, timeout = 1500) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    for (const selector of selectors) {
      const visible = await page.locator(selector).first().isVisible().catch(() => false);
      if (visible) return selector;
    }
    await delay(100);
  }
  return null;
}

async function scrollTo(page, selector) {
  const target = page.locator(selector).first();
  await target.waitFor({ state: 'attached', timeout: 10_000 }).catch(() => {});
  await target.scrollIntoViewIfNeeded().catch(() => {});
  await page.waitForTimeout(150);
}

async function scrollToTop(page, selector) {
  const target = page.locator(selector).first();
  await target.waitFor({ state: 'attached', timeout: 10_000 }).catch(() => {});
  await target.evaluate(element => element.scrollIntoView({ block: 'start', inline: 'nearest' })).catch(() => {});
  await page.waitForTimeout(150);
}

async function disableMotion(page) {
  await page.addStyleTag({
    content: '*,*::before,*::after{animation:none!important;transition:none!important;scroll-behavior:auto!important;caret-color:transparent!important}',
  });
}

async function fontsAndFrames(page) {
  await page.evaluate(async () => {
    if (document.fonts?.ready) {
      await Promise.race([
        document.fonts.ready,
        new Promise(resolve => setTimeout(resolve, 3000)),
      ]);
    }
    await new Promise(resolveFrame => requestAnimationFrame(() => requestAnimationFrame(resolveFrame)));
  });
}

async function maskSensitive(page, context) {
  const secrets = [context.token, encodeURIComponent(context.token ?? ''), context.runtimeDir, repoRoot].filter(value => typeof value === 'string' && value.length > 0);
  await page.evaluate(({ values }) => {
    const pathPattern = /(?:[A-Za-z]:)?[\\/](?:home|Users)[\\/][^\s"'<>]+|[\\/]tmp[\\/][^\s"'<>]+/g;
    const replace = value => {
      let text = String(value ?? '');
      for (const secret of values) text = text.split(secret).join('[redacted]');
      // Live Google Colab account balance from the capturing machine is not README content.
      return text.replace(pathPattern, '[path]').replace(/\s*·\s*[\d.,]+ compute units left/g, '');
    };
    // Capture-only: hide the Hugging Face token-file setup warning (machine setup, not README content).
    for (const element of document.querySelectorAll('body *')) {
      const text = element.textContent ?? '';
      if (!/^\s*No Hugging Face read token file/.test(text)) continue;
      if ([...element.children].some(child => /^\s*No Hugging Face read token file/.test(child.textContent ?? ''))) continue;
      element.style.display = 'none';
    }
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    for (const node of nodes) {
      const parent = node.parentElement;
      if (!parent || ['SCRIPT', 'STYLE', 'NOSCRIPT'].includes(parent.tagName)) continue;
      const next = replace(node.nodeValue ?? '');
      if (next !== node.nodeValue) node.nodeValue = next;
    }
    for (const element of document.querySelectorAll('input, textarea')) {
      const value = String(element.value ?? '');
      if (element.type === 'password') {
        element.value = '';
      } else if (pathPattern.test(value) || values.some(secret => value.includes(secret))) {
        element.value = replace(value);
      }
      pathPattern.lastIndex = 0;
    }
    if (document.title) document.title = replace(document.title);
    if (location.hash && (values.some(secret => location.hash.includes(secret)) || pathPattern.test(location.hash))) {
      history.replaceState(null, '', `${location.pathname}${location.search}`);
    }
    for (const element of document.querySelectorAll('[data-token],[data-secret],#server-token,.server-token,#runtime-path,[data-runtime-path]')) {
      element.textContent = '';
      element.setAttribute('aria-hidden', 'true');
    }
  }, { values: secrets });
}

async function ensureEditor(page) {
  await waitForSelector(page, '#save-status');
  await waitForSelector(page, '[data-testid="scene"][data-scene-id="s1_dawn"]', { timeout: 35_000 });
  await waitForSelector(page, '[data-testid="timeline"]');
}

async function ensureCharacters(page) {
  const pane = page.locator('#characters-pane');
  const open = await pane.isVisible().catch(() => false);
  if (!open) await page.locator('#characters-tab').click();
  await waitForSelector(page, '[data-character-library]');
  await waitForSelector(page, '[data-character-grid]');
}

async function openPipCharacter(page) {
  const pipCard = page.locator('[data-character-grid] [data-character-id="chr_542077e0091abbc6"] [data-open-character]');
  const opener = (await pipCard.count()) > 0 ? pipCard.first() : page.locator('[data-character-grid] [data-open-character]').first();
  await opener.waitFor({ state: 'visible', timeout: 15_000 });
  await opener.click();
  await waitForSelector(page, '[data-character-editor]');
}

async function ensureCast(page) {
  await waitForSelector(page, '[data-cast-strip]');
  if ((await page.locator('[data-cast-chip]').count()) > 0) return;
  await ensureCharacters(page);
  const add = page.locator('[data-add-character]').first();
  if ((await add.count()) > 0) {
    await add.click();
    await page.waitForTimeout(1200);
  }
  await page.locator('[data-characters-close]').click().catch(() => {});
  await waitForSelector(page, '[data-cast-chip]', { timeout: 20_000 });
}

async function ensureTakesTab(page) {
  const tab = page.locator('[data-inspector-tab="takes"]');
  await tab.waitFor({ state: 'visible', timeout: 20_000 });
  await tab.click();
  // The take panel only mounts once a clip is chosen; pick the clip still in
  // review (s3) when the picker is shown, as the default-project e2e does.
  const picker = page.getByTestId('takes-clip');
  if ((await picker.count()) > 0 && (await page.locator('[data-take-panel]').count()) === 0) {
    await picker.locator('option').nth(0).waitFor({ state: 'attached', timeout: 20_000 });
    const values = await picker.locator('option').evaluateAll(options => options.map(option => option.value).filter(Boolean));
    const review = values.find(value => /s3|juno/i.test(value)) ?? values[0];
    if (review) await picker.selectOption(review);
  }
  await waitForSelector(page, '[data-take-panel]', { timeout: 25_000 });
}

async function ensureDemo(page) {
  await waitForSelector(page, '#demo-mode[data-mode="fixture"]');
  await page.waitForFunction(() => document.querySelectorAll('#storyboard .storyboard-scene').length === 6, null, { timeout: 30_000 });
  await page.waitForFunction(() => document.querySelectorAll('#activity .activity-phase').length === 5, null, { timeout: 30_000 });
}

async function ensureSpendCard(page) {
  await page.locator('#backend').selectOption('colab');
  await page.locator('#budget').fill('500');
  await page.locator('#run-backend').click();
  await waitForSelector(page, '#spend-card .spend-card', { timeout: 35_000 });
  await page.locator('#spend-card').getByText(/reserve/i).first().waitFor({ state: 'visible', timeout: 8000 }).catch(() => {});
}

async function mountHistory(page, history) {
  await page.evaluate(async ({ value }) => {
    document.getElementById('readme-colab-history')?.remove();
    const host = document.createElement('div');
    host.id = 'readme-colab-history';
    Object.assign(host.style, {
      position: 'fixed',
      right: '18px',
      bottom: '18px',
      width: '430px',
      maxHeight: '520px',
      overflow: 'auto',
      zIndex: '80',
      background: '#0f131b',
      border: '1px solid #232b3a',
      borderRadius: '14px',
      padding: '12px',
      boxShadow: '0 18px 50px rgba(0,0,0,0.55)',
    });
    document.body.append(host);
    const module = await import('/src/colab-history.ts');
    module.mountColabHistory(host, value, { heading: "Google Colab progress · Pip's Night Shift" });
  }, { value: history });
  await waitForSelector(page, '#readme-colab-history .colab-gauge', { timeout: 20_000 });
}

/** Seek the editor Player to a frame (via the playhead range) so the shot shows animated type. */
async function seekPreview(page, frame) {
  await page.locator('#scrub').evaluate((input, value) => {
    input.value = String(value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }, frame).catch(() => {});
  await page.waitForTimeout(1200);
}

async function prepareShot(name, page, context) {
  if (name === 'character-library') {
    await ensureEditor(page);
    await ensureCharacters(page);
    await openPipCharacter(page);
    await page.locator('#characters-pane').evaluate(element => { element.scrollTop = 0; }).catch(() => {});
    return;
  }
  if (name === 'character-cast-mention') {
    await ensureEditor(page);
    await ensureCast(page);
    const handle = (await page.locator('[data-cast-chip] .cast-handle').first().textContent().catch(() => ''))?.trim() || '@pip';
    await page.locator('#prompt').fill(`${handle} keep the counter scene warm.`);
    await page.locator('#prompt').focus();
    await scrollTo(page, '[data-cast-strip]');
    return;
  }
  if (name === 'character-identity') {
    await ensureEditor(page);
    await ensureCharacters(page);
    await openPipCharacter(page);
    await waitForSelector(page, '[data-section="look"]');
    const method = await firstVisible(page, ['[data-identity-method]', '[data-field="visual.identity.method"]', '[data-action="generate-sheet"]', 'button:has-text("Generate sheet")', '[data-section="look"]'], 1500);
    await scrollTo(page, method ?? '[data-section="look"]');
    return;
  }
  if (name === 'character-speaker') {
    await ensureEditor(page);
    await page.locator('[data-inspector-tab="script"]').click().catch(() => {});
    await waitForSelector(page, '#voice-panel');
    if (!(await firstVisible(page, ['[data-speaker-picker]', '[data-scene-speaker]', '#voice-panel [data-speaker]'], 1200))) {
      const mode = page.locator('#voice-panel [data-mode]');
      if ((await mode.count()) > 0) await mode.selectOption('custom').catch(() => {});
    }
    const target = (await firstVisible(page, ['[data-speaker-picker]', '[data-scene-speaker]', '#voice-panel [data-speaker]'], 3000)) ?? '#voice-panel';
    await scrollTo(page, target);
    return;
  }
  if (name === 'character-real-consent') {
    await ensureEditor(page);
    await ensureCharacters(page);
    await page.locator('[data-new-character]').click();
    await waitForSelector(page, '[data-character-editor]');
    const real = await firstVisible(page, ['[data-real-person]', '[data-kind-option="real"]', '[data-character-kind="real_authorized"]', '[data-character-kind="real"]', '[name="kind"][value="real_authorized"]', 'input[value="real_authorized"]'], 800);
    if (real) await page.locator(real).first().click().catch(() => {});
    await firstVisible(page, ['[data-real-consent]', '[data-consent]', '[data-likeness-warning]', '[data-fictional]'], 1500);
    await scrollTo(page, '[data-section="identity"]');
    return;
  }
  if (name === 'ui-references') {
    await ensureEditor(page);
    await waitForSelector(page, '.reference-panel');
    await page.locator('.ref-card').first().waitFor({ state: 'visible', timeout: 25_000 });
    await scrollToTop(page, '.reference-panel');
    return;
  }
  if (name === 'ui-timeline-review') {
    await ensureEditor(page);
    await ensureTakesTab(page);
    await waitForSelector(page, '[data-render-bar]');
    await scrollToTop(page, '[data-testid="timeline"]');
    return;
  }
  if (name === 'ui-pip-default') {
    await ensureEditor(page);
    await seekPreview(page, 90);
    await page.locator('#chat-pane').evaluate(element => { element.scrollTop = 0; }).catch(() => {});
    await page.locator('#work-pane').evaluate(element => { element.scrollTop = 0; }).catch(() => {});
    return;
  }
  if (name === 'ui-colab-spend') {
    await ensureEditor(page);
    try {
      await ensureSpendCard(page);
      await scrollTo(page, '#spend-card .spend-card');
    } catch {
      await page.goto(demoUrl, { waitUntil: 'domcontentloaded' });
      await ensureDemo(page);
      await scrollTo(page, '#spend .spend-card');
    }
    return;
  }
  if (name === 'ui-agent-editor') {
    await ensureEditor(page);
    await ensureTakesTab(page);
    await waitForSelector(page, '.reference-panel');
    await ensureCast(page);
    await scrollToTop(page, '.reference-panel');
    return;
  }
  if (name === 'ui-demo-webapp') {
    await ensureDemo(page);
    return;
  }
  if (name === 'colab-gauges-preview') {
    await ensureEditor(page);
    await seekPreview(page, 330);
    await mountHistory(page, context.history);
    return;
  }
  throw new Error(`No preparation for shot ${name}.`);
}

function findConverter() {
  const requireFromWeb = createRequire(join(webRoot, 'package.json'));
  const requireFromHere = createRequire(import.meta.url);
  for (const resolver of [requireFromWeb, requireFromHere]) {
    try {
      return { kind: 'sharp', path: resolver.resolve('sharp') };
    } catch {
      continue;
    }
  }
  const probe = spawnSync('ffmpeg', ['-version'], { encoding: 'utf8', timeout: 5000 });
  if (!probe.error && probe.status === 0) return { kind: 'ffmpeg' };
  return { kind: 'png' };
}

async function convertToWebp(buffer, destination, converter) {
  if (converter.kind === 'sharp') {
    const module = await import(pathToFileURL(converter.path).href);
    const sharp = module.default ?? module;
    await sharp(buffer, { failOn: 'none' }).webp({ quality: webpQuality, effort: 4 }).toFile(destination);
    return true;
  }
  if (converter.kind === 'ffmpeg') {
    const result = spawnSync('ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-y', '-i', 'pipe:0',
      '-c:v', 'libwebp', '-quality', String(webpQuality), destination,
    ], { input: buffer, timeout: 60_000 });
    return !result.error && result.status === 0 && existsSync(destination);
  }
  return false;
}

async function captureShot(page, shot, context, outDir, converter) {
  const url = shot.target === 'demo' ? demoUrl : `${webBase}/#token=${encodeURIComponent(context.token)}`;
  const network = context.networkFor(page);
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 35_000 });
  if (!(await network.idle())) console.warn(`warning: ${shot.name} network did not settle before the first checkpoint`);
  // Required selectors are checked after preparation: some targets (the
  // Characters pane and its editor) only appear once prepareShot opens them,
  // now that UO01 keeps [hidden] panes hidden.
  await waitForSelector(page, '#app, body', { state: 'attached' });
  await fontsAndFrames(page);
  await disableMotion(page);
  await prepareShot(shot.name, page, context);
  // A shot may fall back to the demo page (ui-colab-spend); its own checks ran.
  if ((shot.target === 'demo') === page.url().includes('/demo.html')) await waitForRequired(page, shot.required);
  if (!(await network.idle({ quietMs: 400, timeoutMs: 10_000 }))) console.warn(`warning: ${shot.name} network did not settle after preparation`);
  await disableMotion(page);
  await fontsAndFrames(page);
  await page.waitForTimeout(450);
  await maskSensitive(page, context);
  const buffer = await page.screenshot({ type: 'png', animations: 'disabled', caret: 'hide', fullPage: false });
  const webpPath = join(outDir, `${shot.name}.webp`);
  if (await convertToWebp(buffer, webpPath, converter)) return webpPath;
  const pngPath = join(outDir, `${shot.name}.png`);
  writeFileSync(pngPath, buffer);
  console.warn(`warning: no WebP encoder (sharp or ffmpeg) was available; wrote ${relative(repoRoot, pngPath)} instead of ${shot.name}.webp`);
  return pngPath;
}

async function runCapture(selection, outDir) {
  const usesEditor = selection.some(shot => shot.target === 'editor');
  if (usesEditor) guardSeedFile();
  const history = selection.some(shot => shot.name === 'colab-gauges-preview') ? readHistoryFixture() : null;
  const chromium = await loadChromium();
  const converter = findConverter();
  if (converter.kind === 'png') console.warn('warning: no WebP encoder (sharp or ffmpeg) found; screenshots fall back to PNG.');

  mkdirSync(outDir, { recursive: true });
  const server = startServer();
  let browser = null;
  let env = null;
  try {
    env = await waitForEnvFile(server.child, server.logs);
    activeSecrets = [env.token, env.runtimeDir];
    await waitForWeb();
    if (usesEditor) {
      await waitForSeededPackage(env);
      await seedDemoExtras(env);
      await attachPipTakes(env);
    }
    // Playwright's bundled Chromium has no H.264 decoder, so the take MP4s would
    // fall back to the missing-media card; prefer installed Google Chrome.
    const chromeChannel = process.env.CAPTURE_BROWSER_CHANNEL ?? (existsSync('/usr/bin/google-chrome') ? 'chrome' : undefined);
    browser = await chromium.launch({
      headless: true,
      ...(chromeChannel ? { channel: chromeChannel } : {}),
      args: ['--disable-gpu', '--hide-scrollbars', '--force-device-scale-factor=1', ...(typeof process.getuid === 'function' && process.getuid() === 0 ? ['--no-sandbox'] : [])],
    });
    const context = await browser.newContext({
      viewport,
      deviceScaleFactor: 1,
      reducedMotion: 'reduce',
      colorScheme: 'dark',
      locale: 'en-US',
    });
    const captureContext = {
      token: env.token,
      runtimeDir: env.runtimeDir,
      history,
      networkFor(page) {
        return watchNetwork(page);
      },
    };
    for (const shot of selection) {
      const page = await context.newPage();
      page.setDefaultTimeout(20_000);
      await page.route('**/*', route => {
        const requestUrl = route.request().url();
        let host = '';
        try {
          host = new URL(requestUrl).hostname;
        } catch {
          host = '';
        }
        if (!host || host === '127.0.0.1' || host === 'localhost') return route.continue();
        return route.abort();
      });
      try {
        const output = await captureShot(page, shot, captureContext, outDir, converter);
        console.log(`captured ${shot.name} -> ${relative(repoRoot, output)}`);
      } finally {
        await page.close().catch(() => {});
      }
    }
    await context.close();
  } finally {
    if (browser) await browser.close().catch(() => {});
    if (server.child.exitCode === null) {
      server.child.kill('SIGTERM');
      const deadline = Date.now() + 8000;
      while (server.child.exitCode === null && Date.now() < deadline) await delay(100);
      if (server.child.exitCode === null) server.child.kill('SIGKILL');
    }
    rmSync(envFile, { force: true });
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }
  const selection = selectedShots(options.only);
  const outDir = isAbsolute(options.out) ? resolve(options.out) : resolve(repoRoot, options.out);
  if (!insideRepo(outDir)) throw new Error(`Output directory must stay inside the repository: ${options.out}`);
  if (options.dryRun) {
    printPlan(selection, relative(repoRoot, outDir) || '.');
    return;
  }
  await runCapture(selection, outDir);
}

main().catch(error => {
  console.error(`capture-readme-media: ${redact(error instanceof Error ? error.stack ?? error.message : error)}`);
  process.exitCode = 1;
});
