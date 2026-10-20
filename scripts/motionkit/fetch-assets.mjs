import { createHash } from 'node:crypto';
import { promises as nodeFs } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..');
const DEFAULT_MANIFEST = join(HERE, 'data', 'assets.json');
const DEFAULT_OUT = join(REPO_ROOT, 'assets', 'motionkit');

export const ALLOWED_LICENSES = Object.freeze(['MIT', 'ISC', 'CC0-1.0', 'OFL-1.1']);
const ALLOWED = new Set(ALLOWED_LICENSES);
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._()\[\] -]*$/;

export const isAllowedLicense = (license) => ALLOWED.has(license);
export const sha256 = (data) => createHash('sha256').update(data).digest('hex');

export function collectItems(manifest) {
  if (Array.isArray(manifest)) return manifest.slice();
  const items = [];
  for (const [category, list] of Object.entries(manifest || {})) {
    if (Array.isArray(list)) for (const item of list) items.push({ category, ...item });
  }
  return items;
}

const safeName = (name) => typeof name === 'string' && name === basename(name) && SAFE_NAME.test(name);
const licenseLike = (name) => /^(licen[cs]e|ofl)(\.(txt|md))?$/i.test(name);
const normalizeFiles = (item) =>
  (item.files || []).map((file) => (typeof file === 'string' ? { name: file } : { ...file }));

function fileUrl(item, name) {
  const file = (item.files || []).find((c) => (typeof c === 'string' ? c : c.name) === name);
  if (file && typeof file === 'object' && file.url) return file.url;
  if (item.baseUrl) {
    return new URL(name, item.baseUrl.endsWith('/') ? item.baseUrl : `${item.baseUrl}/`).href;
  }
  const source = String(item.source || '').replace(/\/+$/, '');
  if (/^https:\/\/github\.com\/[^/]+\/[^/]+\/tree\//.test(source)) {
    return `${source.replace('/tree/', '/raw/')}/${encodeURIComponent(name)}`;
  }
  return `${source}/${encodeURIComponent(name)}`;
}

function attribution(item) {
  return `${item.name || item.id} (${item.id})\nKind: ${item.kind || item.category || 'asset'}\n` +
    `License: ${item.license} (SPDX)\nLicense URL: ${item.licenseUrl || 'n/a'}\nSource: ${item.source || 'n/a'}\n\n`;
}

export function buildNotice(items) {
  const groups = new Map();
  for (const item of items) {
    if (!groups.has(item.license)) groups.set(item.license, []);
    groups.get(item.license).push(item);
  }
  const lines = [
    'MOTIONKIT ASSET NOTICE', '',
    'Third-party assets fetched by scripts/motionkit/fetch-assets.mjs.',
    'Only MIT, ISC, CC0-1.0 and OFL-1.1 assets are permitted.', '',
  ];
  for (const license of [...groups.keys()].sort()) {
    const group = groups.get(license).sort((a, b) => String(a.id).localeCompare(String(b.id)));
    lines.push(`${license} (${group.length})`, '');
    for (const item of group) {
      lines.push(`  ${item.name || item.id} [${item.kind || item.category || 'asset'}/${item.id}]`);
      lines.push(`    Source: ${item.source || 'n/a'}`);
      lines.push(`    License: ${license}${item.licenseUrl ? ` - ${item.licenseUrl}` : ''}`);
      lines.push(`    Files: ${normalizeFiles(item).map((file) => file.name).join(', ')}`, '');
    }
  }
  return `${lines.join('\n').replace(/\n+$/, '')}\n`;
}

async function exists(fs, path) {
  try {
    await fs.stat(path);
    return true;
  } catch {
    return false;
  }
}

function fail(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

export async function fetchAssets(options) {
  const {
    manifest,
    fetch: fetchImpl,
    fs = nodeFs,
    outDir = DEFAULT_OUT,
    only,
    dryRun = false,
    logger = console,
  } = options || {};
  if (typeof fetchImpl !== 'function') throw new TypeError('fetchAssets requires injected fetch');
  const allItems = collectItems(manifest);
  for (const item of allItems) {
    if (!isAllowedLicense(item.license)) {
      throw fail(`refusing disallowed license ${item.license} for ${item.id}`, 'ELICENSE');
    }
  }
  const items = only
    ? allItems.filter((item) => item.kind === only || item.category === only)
    : allItems;
  const plan = [];
  for (const item of items) {
    const kind = item.kind || item.category;
    if (!safeName(kind) || !safeName(item.id)) throw fail(`unsafe manifest path for ${item.id}`, 'EPATH');
    for (const file of normalizeFiles(item)) {
      if (!safeName(file.name)) throw fail(`unsafe file name ${file.name} for ${item.id}`, 'EPATH');
      plan.push(`${kind}/${item.id}/${file.name}`);
    }
  }
  if (dryRun) {
    for (const path of plan) logger.log(`would fetch ${path}`);
    return { ok: true, dryRun: true, written: [], plan, lock: {}, notice: buildNotice(items) };
  }
  const existed = await exists(fs, outDir);
  await fs.mkdir(outDir, { recursive: true });
  const stage = await fs.mkdtemp(join(outDir, '.stage-'));
  const written = [];
  const lock = {};
  try {
    for (const item of items) {
      const kind = item.kind || item.category;
      const files = normalizeFiles(item);
      const dir = join(stage, kind, item.id);
      await fs.mkdir(dir, { recursive: true });
      const contents = new Map();
      const primary = files.find((file) => !licenseLike(file.name)) || files[0];
      for (const file of files) {
        const response = await fetchImpl(fileUrl(item, file.name));
        if (!response || response.ok === false) {
          throw new Error(`download failed (${response?.status ?? 'no response'}) for ${item.id}/${file.name}`);
        }
        const data = Buffer.from(await response.arrayBuffer());
        const expected = file.sha256 || (primary && file.name === primary.name ? item.sha256 : null);
        const actual = sha256(data);
        if (expected && actual !== String(expected).toLowerCase()) {
          throw fail(`sha256 mismatch for ${item.id}/${file.name}`, 'ESHA');
        }
        await fs.writeFile(join(dir, file.name), data);
        contents.set(file.name, data);
        lock[`${kind}/${item.id}/${file.name}`] = actual;
        written.push(`${kind}/${item.id}/${file.name}`);
      }
      const licensePath = join(dir, 'LICENSE');
      if (!(await exists(fs, licensePath))) {
        const source = files.find((file) => licenseLike(file.name));
        const header = Buffer.from(attribution(item));
        await fs.writeFile(licensePath, source ? Buffer.concat([header, contents.get(source.name)]) : header);
        written.push(`${kind}/${item.id}/LICENSE`);
      }
    }
    const sortedLock = {};
    for (const key of Object.keys(lock).sort()) sortedLock[key] = lock[key];
    const noticeText = buildNotice(items);
    await fs.writeFile(join(stage, 'lock.json'), `${JSON.stringify({ version: 1, files: sortedLock }, null, 2)}\n`);
    await fs.writeFile(join(stage, 'NOTICE.txt'), noticeText);
    for (const item of items) {
      const kind = item.kind || item.category;
      const dest = join(outDir, kind, item.id);
      await fs.rm(dest, { recursive: true, force: true });
      await fs.mkdir(dirname(dest), { recursive: true });
      await fs.rename(join(stage, kind, item.id), dest);
    }
    for (const name of ['lock.json', 'NOTICE.txt']) {
      await fs.rm(join(outDir, name), { force: true });
      await fs.rename(join(stage, name), join(outDir, name));
    }
    written.push('lock.json', 'NOTICE.txt');
    await fs.rm(stage, { recursive: true, force: true });
    return { ok: true, dryRun: false, written, plan, lock: sortedLock, notice: noticeText };
  } catch (error) {
    await fs.rm(stage, { recursive: true, force: true });
    if (!existed) await fs.rm(outDir, { recursive: true, force: true });
    throw error;
  }
}

export async function main(argv = process.argv.slice(2), deps = {}) {
  const fs = deps.fs || nodeFs;
  const logger = deps.logger || console;
  let only;
  let dryRun = false;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--dry-run') dryRun = true;
    else if (argv[i] === '--only') {
      only = argv[i + 1];
      if (!only) {
        logger.error('fetch-assets: --only requires a kind');
        return 2;
      }
      i += 1;
    } else {
      logger.error(`fetch-assets: unknown argument ${argv[i]}`);
      return 2;
    }
  }
  try {
    const manifest = deps.manifest || JSON.parse(await fs.readFile(deps.manifestPath || DEFAULT_MANIFEST, 'utf8'));
    const result = await fetchAssets({ manifest, fetch: deps.fetch || globalThis.fetch, fs, outDir: deps.outDir || DEFAULT_OUT, only, dryRun, logger });
    const summary = result.dryRun ? `dry run, ${result.plan.length} file(s) planned` : `wrote ${result.written.length} file(s) to ${deps.outDir || 'assets/motionkit'}`;
    logger.log(`fetch-assets: ${summary}`);
    return 0;
  } catch (error) {
    logger.error(`fetch-assets: ${error.message}`);
    return 1;
  }
}

if (import.meta.filename === process.argv[1]) process.exitCode = await main();
