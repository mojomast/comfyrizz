#!/usr/bin/env node
/**
 * Procedure capture without a screen-share prompt.
 *
 *   node --experimental-strip-types scripts/capture-procedure.mjs
 *     Runs the real Super Easy app headless against the scripted production
 *     fixture (apps/web/e2e/procedure-fixture.mjs), records it with Playwright's
 *     built-in video, saves the app's own step log, and assembles an MP4 with a
 *     chapter and a caption per step. GPU stages are mocked; no Google Colab
 *     units are spent.
 *
 *   node --experimental-strip-types scripts/capture-procedure.mjs --assemble rec.webm [--journal rec.json]
 *     Turns a recording saved by "Record this run" (WebM or MP4 plus its .json
 *     step log) into an edit-ready MP4 with the same chapters and captions.
 *
 * Output: out/procedure-capture/<stamp>/ (gitignored) unless --out is given.
 */
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { sanitizeProcedureDocument, toFfmetadata, toWebVtt } from '../apps/web/src/easy/procedure/format.ts';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const webRoot = join(repoRoot, 'apps', 'web');
const envFile = join(webRoot, 'e2e', '.e2e-env.json');
const webBase = 'http://127.0.0.1:4175';
const viewport = Object.freeze({ width: 1280, height: 720 });
const fps = 30;
const defaultPrompt = 'A friendly robot who learns to bake bread';
const fixtureNote = 'Fixture run: the Google Colab session and GPU stages are mocked; no Google Colab units are spent';
const finalPath = '/__procedure/final.webm';
let secrets = [];

function usage() {
  return [
    'Usage:',
    '  node --experimental-strip-types scripts/capture-procedure.mjs [--prompt "..."] [--phase-ms 2500] [--out dir] [--dry-run]',
    '  node --experimental-strip-types scripts/capture-procedure.mjs --assemble <video.webm|mp4> [--journal <log.json>] [--out dir]',
  ].join('\n');
}

function parseArgs(argv) {
  const options = { assemble: null, journal: null, out: null, prompt: defaultPrompt, phaseMs: 2500, dryRun: false, help: false };
  const value = (index, flag) => {
    const next = argv[index + 1];
    if (next === undefined || next.startsWith('--')) throw new Error(`${flag} needs a value`);
    return next;
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--assemble') { options.assemble = value(index, arg); index += 1; }
    else if (arg === '--journal') { options.journal = value(index, arg); index += 1; }
    else if (arg === '--out') { options.out = value(index, arg); index += 1; }
    else if (arg === '--prompt') { options.prompt = value(index, arg); index += 1; }
    else if (arg === '--phase-ms') {
      const ms = Number(value(index, arg));
      if (!Number.isFinite(ms) || ms < 200) throw new Error('--phase-ms must be a number of at least 200');
      options.phaseMs = ms;
      index += 1;
    } else throw new Error(`Unknown option: ${arg}\n${usage()}`);
  }
  if (options.journal !== null && options.assemble === null) throw new Error('--journal only applies with --assemble');
  return options;
}

function stamp(date = new Date()) {
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

function outputDir(option) {
  if (option === null) return join(repoRoot, 'out', 'procedure-capture', stamp());
  return isAbsolute(option) ? option : resolve(process.cwd(), option);
}

function shown(path) {
  const rel = relative(repoRoot, path);
  return rel !== '' && !rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel) ? rel : path;
}

function redact(value) {
  let text = String(value ?? '');
  for (const secret of secrets) {
    if (typeof secret === 'string' && secret.length > 0) text = text.split(secret).join('[redacted]');
  }
  return text
    .replace(/(token=)[^\s&"']+/giu, '$1[redacted]')
    .replace(/(?:[A-Za-z]:)?[\\/](?:home|Users)[\\/][^\s"'<>]+/gu, '[path]');
}

function requireTool(name) {
  const probe = spawnSync(name, ['-version'], { encoding: 'utf8', timeout: 10_000 });
  if (probe.error || probe.status !== 0) throw new Error(`${name} was not found on PATH. Install ffmpeg (it is already a Comfyrizz prerequisite) and try again.`);
}

function run(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: 15 * 60_000, maxBuffer: 16 * 1024 * 1024 });
  if (result.error || result.status !== 0) {
    throw new Error(`${command} failed: ${redact((result.stderr || result.error?.message || '').slice(-2000))}`);
  }
  return result.stdout;
}

function probeDurationMs(video) {
  const out = run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', video]).trim();
  const seconds = Number(out);
  if (Number.isFinite(seconds) && seconds > 0) return Math.round(seconds * 1000);
  // MediaRecorder WebM often has no duration header (and a 1000 fps timebase);
  // the last video packet's timestamp is the reliable length.
  const times = run('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'packet=pts_time', '-of', 'csv=p=0', video]);
  const last = times.split('\n').reduce((max, line) => {
    const value = Number.parseFloat(line);
    return Number.isFinite(value) && value > max ? value : max;
  }, 0);
  return Math.round(last * 1000);
}

/** Re-encode to H.264 MP4 at a constant frame rate, with step chapters and a caption track. */
function assemble({ video, doc, outDir }) {
  requireTool('ffmpeg');
  requireTool('ffprobe');
  mkdirSync(outDir, { recursive: true });
  const durationMs = probeDurationMs(video);
  const timed = doc ? { ...doc, durationMs: Math.max(doc.durationMs, durationMs) } : null;
  const mp4 = join(outDir, 'procedure.mp4');
  const args = ['-hide_banner', '-loglevel', 'error', '-y', '-i', video];
  const written = { mp4 };
  if (timed && timed.entries.length > 0) {
    written.vtt = join(outDir, 'procedure.vtt');
    written.chapters = join(outDir, 'procedure.ffmeta');
    written.json = join(outDir, 'procedure.json');
    writeFileSync(written.vtt, toWebVtt(timed));
    writeFileSync(written.chapters, toFfmetadata(timed));
    writeFileSync(written.json, `${JSON.stringify(timed, null, 2)}\n`);
    args.push('-i', written.vtt, '-i', written.chapters, '-map', '0:v:0', '-map', '1:0', '-map_metadata', '2', '-map_chapters', '2', '-c:s', 'mov_text', '-metadata:s:s:0', 'language=eng');
  } else {
    args.push('-map', '0:v:0');
  }
  args.push(
    '-vf', `fps=${fps},scale=trunc(iw/2)*2:trunc(ih/2)*2`,
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p',
    '-movflags', '+faststart', mp4,
  );
  run('ffmpeg', args);
  return { ...written, durationMs, steps: timed?.entries.length ?? 0 };
}

function readJournal(path) {
  return sanitizeProcedureDocument(JSON.parse(readFileSync(path, 'utf8')));
}

function siblingJournal(video) {
  const candidate = join(dirname(video), `${basename(video, extname(video))}.json`);
  return existsSync(candidate) ? candidate : null;
}

function report(result, extra = []) {
  const lines = [`procedure.mp4  ${shown(result.mp4)}  (${(result.durationMs / 1000).toFixed(1)} s, ${result.steps} step${result.steps === 1 ? '' : 's'})`];
  if (result.vtt) lines.push(`captions       ${shown(result.vtt)}`, `chapters       ${shown(result.chapters)}`, `step log       ${shown(result.json)}`);
  console.log([...lines, ...extra].join('\n'));
}

function assembleMode(options, outDir) {
  const video = resolve(process.cwd(), options.assemble);
  if (!existsSync(video)) throw new Error(`No recording at ${options.assemble}`);
  const journalPath = options.journal === null ? siblingJournal(video) : resolve(process.cwd(), options.journal);
  if (journalPath !== null && !existsSync(journalPath)) throw new Error(`No step log at ${options.journal}`);
  if (options.dryRun) {
    console.log(`Would assemble ${shown(video)}${journalPath ? ` with ${shown(journalPath)}` : ' without a step log'} into ${shown(outDir)}/procedure.mp4`);
    return;
  }
  const doc = journalPath ? readJournal(journalPath) : null;
  if (!doc) console.warn('warning: no step log found next to the recording; the MP4 has no chapters or captions.');
  report(assemble({ video, doc, outDir }));
}

async function loadChromium() {
  const resolvers = [createRequire(join(webRoot, 'package.json')), createRequire(import.meta.url)];
  for (const name of ['playwright', '@playwright/test', 'playwright-core']) {
    for (const resolver of resolvers) {
      let resolved;
      try {
        resolved = resolver.resolve(name);
      } catch {
        continue;
      }
      const module = await import(pathToFileURL(resolved).href);
      const chromium = module.chromium ?? module.default?.chromium;
      if (chromium) return chromium;
    }
  }
  throw new Error('Playwright is not installed. Run pnpm install and pnpm --filter @comfyrizz/web exec playwright install chromium.');
}

function startServer() {
  rmSync(envFile, { force: true });
  const logs = [];
  const child = spawn(process.execPath, ['--experimental-strip-types', 'e2e/serve.mjs'], { cwd: webRoot, stdio: ['ignore', 'pipe', 'pipe'] });
  for (const stream of [child.stdout, child.stderr]) {
    stream.on('data', (chunk) => {
      logs.push(String(chunk));
      if (logs.length > 40) logs.shift();
    });
  }
  return { child, logs };
}

async function waitForServer(server) {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (server.child.exitCode !== null) throw new Error(`e2e/serve.mjs exited ${server.child.exitCode}: ${redact(server.logs.join('').slice(-2000))}`);
    if (existsSync(envFile)) {
      try {
        const env = JSON.parse(readFileSync(envFile, 'utf8'));
        secrets = [env.token, env.runtimeDir];
        const response = await fetch(`${webBase}/`).catch(() => null);
        if (response?.ok) return env;
      } catch {
        // The env file is written in one go; a partial read just retries.
      }
    }
    await delay(250);
  }
  throw new Error(`The local app did not come up within 90 seconds: ${redact(server.logs.join('').slice(-2000))}`);
}

async function stopServer(server) {
  if (server.child.exitCode === null) {
    server.child.kill('SIGTERM');
    const deadline = Date.now() + 8000;
    while (server.child.exitCode === null && Date.now() < deadline) await delay(100);
    if (server.child.exitCode === null) server.child.kill('SIGKILL');
  }
  rmSync(envFile, { force: true });
}

function makeFinalVideo(dir) {
  const file = join(dir, 'final.webm');
  run('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `testsrc2=size=${viewport.width}x${viewport.height}:rate=${fps}`,
    '-t', '6', '-c:v', 'libvpx', '-deadline', 'realtime', '-b:v', '1M', '-pix_fmt', 'yuv420p', file,
  ]);
  return file;
}

/** Shift the in-app log onto the Playwright video clock and open with the fixture note. */
function alignJournal(doc, videoStartedAt) {
  const offset = Math.max(0, Date.parse(doc.startedAt) - videoStartedAt);
  return {
    ...doc,
    durationMs: doc.durationMs + offset,
    video: { fileName: 'procedure.mp4', mimeType: 'video/mp4' },
    videoUnavailable: null,
    entries: [
      { atMs: 0, kind: 'note', label: fixtureNote },
      ...doc.entries.map((entry) => ({ ...entry, atMs: entry.atMs + offset })),
    ],
  };
}

async function recordFixtureRun(options, outDir) {
  if (options.dryRun) {
    console.log([
      'Procedure capture plan (headless fixture run)',
      `  app      ${webBase}/?capture=1 (Super Easy, "Record this run" ticked)`,
      `  prompt   ${options.prompt}`,
      `  stages   7 fixture phases, ${options.phaseMs} ms each (${fixtureNote})`,
      `  video    Playwright recordVideo ${viewport.width}x${viewport.height} at ${fps} fps, then ffmpeg H.264 MP4`,
      `  output   ${shown(outDir)}/procedure.mp4 with chapters, captions and the step log`,
      '',
      'Dry run: no browser and no server were started.',
    ].join('\n'));
    return;
  }
  requireTool('ffmpeg');
  requireTool('ffprobe');
  const { procedureBackend, PROCEDURE_PHASES } = await import(pathToFileURL(join(webRoot, 'e2e', 'procedure-fixture.mjs')).href);
  const chromium = await loadChromium();
  const work = mkdtempSync(join(tmpdir(), 'comfyrizz-procedure-'));
  const finalVideo = makeFinalVideo(work);
  const server = startServer();
  let browser = null;
  try {
    await waitForServer(server);
    browser = await chromium.launch({
      headless: true,
      args: ['--hide-scrollbars', '--force-device-scale-factor=1', ...(process.getuid?.() === 0 ? ['--no-sandbox'] : [])],
    });
    const context = await browser.newContext({
      baseURL: webBase,
      viewport,
      deviceScaleFactor: 1,
      colorScheme: 'dark',
      locale: 'en-US',
      acceptDownloads: true,
      recordVideo: { dir: work, size: viewport, fps },
    });
    const backend = procedureBackend({ phaseMs: options.phaseMs, finalUrl: finalPath });
    await context.route('**/*', (route) => {
      const url = new URL(route.request().url());
      if (url.hostname !== '127.0.0.1' && url.hostname !== 'localhost') return route.abort();
      if (url.pathname === finalPath) return route.fulfill({ status: 200, contentType: 'video/webm', body: readFileSync(finalVideo) });
      if (url.pathname.startsWith('/api/')) return backend.handle(route);
      // The studio's eager step import also picks up colocated node:test modules in dev.
      if (/\/src\/easy\/steps\/[^/]+\.test\.ts$/u.test(url.pathname)) return route.fulfill({ status: 200, contentType: 'application/javascript', body: 'export {};' });
      return route.continue();
    });

    // Headless Chromium cannot share a tab. Playwright records the pixels, so
    // the app gets a tiny stand-in stream and its badge reads "Recording".
    await context.addInitScript(() => {
      if (!navigator.mediaDevices) return;
      navigator.mediaDevices.getDisplayMedia = async () => {
        const canvas = document.createElement('canvas');
        canvas.width = 16;
        canvas.height = 16;
        canvas.getContext('2d')?.fillRect(0, 0, 16, 16);
        return canvas.captureStream(1);
      };
    });

    const videoStartedAt = Date.now();
    const page = await context.newPage();
    page.setDefaultTimeout(30_000);
    await page.goto('/?capture=1', { waitUntil: 'domcontentloaded' });
    await page.locator('[data-super-easy-home]').waitFor({ state: 'visible' });
    await page.waitForTimeout(800);
    await page.locator('#super-easy-prompt').pressSequentially(options.prompt, { delay: 30 });
    await page.waitForTimeout(400);
    const journalDownload = page.waitForEvent('download', {
      predicate: (download) => download.suggestedFilename().endsWith('.json'),
      timeout: PROCEDURE_PHASES * options.phaseMs + 90_000,
    });
    await page.getByRole('button', { name: 'Generate', exact: true }).click();
    const download = await journalDownload;
    const journalFile = join(work, 'journal.json');
    await download.saveAs(journalFile);
    await page.locator('[data-procedure-capture][data-state="saved"]').waitFor({ state: 'visible' }).catch(() => {});
    await page.waitForTimeout(2000);
    const video = page.video();
    await page.close();
    const rawVideo = join(work, 'raw.webm');
    await video.saveAs(rawVideo);
    await context.close();

    const paid = backend.calls.filter((call) => call.startsWith('paid:'));
    if (paid.length > 0) throw new Error(`The fixture run reached a paid route (${paid.join(', ')}); nothing was spent, but the capture is not trustworthy.`);
    const doc = alignJournal(readJournal(journalFile), videoStartedAt);
    report(assemble({ video: rawVideo, doc, outDir }), ['', fixtureNote + '.']);
  } finally {
    if (browser) await browser.close().catch(() => {});
    await stopServer(server);
    rmSync(work, { recursive: true, force: true });
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }
  const outDir = outputDir(options.out);
  if (options.assemble !== null) assembleMode(options, outDir);
  else await recordFixtureRun(options, outDir);
}

main().catch((error) => {
  console.error(`capture-procedure: ${redact(error instanceof Error ? error.message : error)}`);
  process.exitCode = 1;
});
