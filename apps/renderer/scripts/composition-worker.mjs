// Optional local CPU plate materialization. Only the curated composition compiler
// produces executable HTML; this process boundary is not an OS sandbox.
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, realpath, mkdir, readFile, writeFile, rename, link, rm, mkdtemp } from 'node:fs/promises';
import { isAbsolute, join, resolve, sep } from 'node:path';

export const HYPERFRAMES_VERSION = '0.8.181';
const OWNER = 'comfyrizz-composition/v1';
const ENCODING = Object.freeze({ format: 'mp4', quality: 'high', hdr: 'off', gpu: false, workers: 1, browserGpu: false, strict: true, bestEffort: false });
const canonical = value => JSON.stringify(sort(value));
function sort(value) {
  if (Array.isArray(value)) return value.map(sort);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().filter(key => value[key] !== undefined).map(key => [key, sort(value[key])]));
  return value;
}
const hash = value => createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : canonical(value)).digest('hex');
async function fileHash(path) {
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(path)) digest.update(chunk);
  return digest.digest('hex');
}
function abortError(signal) { return signal?.reason ?? new Error('Composition cancelled'); }

/** Bounded process-group execution; no shell, installation, or inherited secrets. */
export function compositionCommand(bin, args, { cwd, signal, env = {}, timeoutMs = 120000, killGraceMs = 250, allowedCodes = [0] } = {}) {
  signal?.throwIfAborted();
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 86400000) throw new Error('Invalid composition timeout');
  return new Promise((resolveCommand, reject) => {
    const child = spawn(bin, args, { cwd, env, shell: false, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', failure, killTimer, settled = false;
    const kill = name => { try { process.platform === 'win32' ? child.kill(name) : process.kill(-child.pid, name); } catch { /* already gone */ } };
    const stop = error => {
      if (failure) return;
      failure = error;
      kill('SIGTERM');
      // Keep this timer even if the group leader exits before its descendants.
      killTimer = setTimeout(() => { kill('SIGKILL'); finish(); }, killGraceMs);
    };
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      if (failure || error) reject(failure || error); else resolveCommand(result);
    };
    const abort = () => stop(abortError(signal));
    const timer = setTimeout(() => stop(new Error('Composition subprocess timed out')), timeoutMs);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    child.stdout.on('data', chunk => {
      stdout += chunk.toString();
      if (stdout.length > 8 * 1024 * 1024) { stdout = stdout.slice(0, 8 * 1024 * 1024); stop(new Error('Composition subprocess output exceeded limit')); }
    });
    child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-32000); });
    child.on('error', error => { if (!failure) { clearTimeout(killTimer); finish(error); } });
    child.on('close', code => {
      if (failure) return; // escalation timer owns completion and descendant teardown
      if (!allowedCodes.includes(code)) return finish(new Error(`Composition subprocess exited ${code}`));
      finish(null, { code, stdout, stderr });
    });
  });
}

// Reject symlinks at every package-local path component, including existing leaves.
async function safePath(root, relative, { directory = false, createParents = true } = {}) {
  if (isAbsolute(relative) || relative.split(/[\\/]/).some(part => !part || part === '.' || part === '..')) throw new Error('Unsafe composition path');
  let current = root;
  const parts = relative.split('/');
  for (let i = 0; i < parts.length; i++) {
    current = join(current, parts[i]);
    let stat;
    try { stat = await lstat(current); } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      if (createParents && (i < parts.length - 1 || directory)) {
        try { await mkdir(current); } catch (error) { if (error.code !== 'EEXIST') throw error; }
        stat = await lstat(current);
      }
    }
    if (stat?.isSymbolicLink() || (stat && ((i < parts.length - 1 || directory) ? !stat.isDirectory() : !stat.isFile()))) throw new Error('Unsafe composition symlink or file type');
  }
  if (!current.startsWith(root + sep)) throw new Error('Composition path escaped package');
  return current;
}
async function jsonAt(path) {
  try { return JSON.parse(await readFile(path, 'utf8')); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
async function publish(path, bytes, { replace = false } = {}) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, bytes, { flag: 'wx', mode: 0o600 });
  try {
    if (replace) await rename(temporary, path);
    else await link(temporary, path); // exclusive publication: never clobber user files
  } finally { await rm(temporary, { force: true }); }
}

/** Exporters can recompute this from the current source/timeline and worker identity. */
export function compositionFingerprint({ compiled, timelineScene, identity, entry }) {
  // Plates own scene-local animation only. Background/media-only state and other
  // renderer presentation fields change when a plate is imported. Absolute scene
  // placement also changes when an earlier scene is edited, without changing this
  // scene's local animation. Neither is a source dependency.
  const timing = { durationInFrames: timelineScene.durationInFrames,
    motionCues: timelineScene.motionCues?.map(cue => ({ ...cue, frame: Number.isInteger(cue.frame) ? cue.frame - (timelineScene.from ?? 0) : cue.frame })) };
  return hash({ version: OWNER, sourceHash: compiled.sourceHash, htmlHash: hash(compiled.html), motionHash: hash(compiled.motionSpec), entry,
    timing, frames: compiled.frames, fps: compiled.fps, width: compiled.width, height: compiled.height,
    hyperframes: HYPERFRAMES_VERSION, identity, encoding: ENCODING });
}

export function verifyCompositionProbe(probe, compiled) {
  const streams = probe?.streams;
  const video = streams?.filter(stream => stream.codec_type === 'video');
  if (!Array.isArray(streams) || video.length !== 1 || streams.some(stream => stream.codec_type === 'audio')) throw new Error('Composition must contain exactly one silent video stream');
  const stream = video[0];
  const rate = raw => { const [n, d = 1] = String(raw).split('/').map(Number); return n / d; };
  const frames = Number(stream.nb_read_frames);
  const shortfall = compiled.frames - frames;
  if (frames !== compiled.frames || !Number.isInteger(frames)) throw new Error(`Composition frame mismatch: expected ${compiled.frames}, got ${stream.nb_read_frames}; shortfall ${shortfall}`);
  if (stream.width !== compiled.width || stream.height !== compiled.height ||
      Math.abs(rate(stream.r_frame_rate) - compiled.fps) > 1e-8 || Math.abs(rate(stream.avg_frame_rate) - compiled.fps) > 1e-8 ||
      !Number.isFinite(rate(stream.r_frame_rate)) || !Number.isFinite(rate(stream.avg_frame_rate))) throw new Error('Composition dimensions/frame rate mismatch');
  if (stream.codec_name !== 'h264' || stream.pix_fmt !== 'yuv420p') throw new Error('Composition encoding mismatch');
  return { frames, width: stream.width, height: stream.height, fps: rate(stream.r_frame_rate), codec: stream.codec_name, pixelFormat: stream.pix_fmt, audio: 'none', shortfallFrames: 0 };
}
function verifyCheck(check) {
  if (check?.ok !== true || check.browserSkipped !== false) throw new Error('Composition sampled check failed or browser checks skipped');
  for (const key of ['lint', 'runtime', 'layout', 'motion', 'contrast']) {
    const result = check[key];
    if (!result || result.ok !== true || result.errorCount !== 0 || !Array.isArray(result.findings) || result.findings.some(finding => finding.severity === 'error')) throw new Error(`Composition ${key} check failed`);
  }
  if (check.motion.enabled !== true || check.contrast.enabled !== true || !check.layout.samples?.length) throw new Error('Composition rendered sampling was disabled');
}
function validateCompiled(compiled, timelineScene, timeline) {
  if (!compiled || typeof compiled.html !== 'string' || !compiled.sourceHash || compiled.motionSpec == null ||
      !Number.isInteger(compiled.frames) || compiled.frames <= 0 || compiled.frames !== timelineScene.durationInFrames ||
      compiled.width !== timeline.width || compiled.height !== timeline.height || compiled.fps !== timeline.fps ||
      !Number.isInteger(compiled.width) || !Number.isInteger(compiled.height) || compiled.width <= 0 || compiled.height <= 0 ||
      !Number.isFinite(compiled.fps) || compiled.fps <= 0) throw new Error('Composition compiler timing/dimensions mismatch');
  if (compiled.diagnostics?.some(item => item.severity === 'error')) throw new Error('Composition compiler diagnostics contain errors');
}

function derivedAsset({ key, component, receipt, compiled }) {
  return { kind: 'video', origin: 'upload', status: 'ready', file: `assets/derived/${key}.mp4`, sha256: receipt.videoHash, bytes: receipt.bytes,
    media: { width: compiled.width, height: compiled.height, frames: compiled.frames, fps: compiled.fps, durationSeconds: compiled.frames / compiled.fps, codec: 'h264', audio: 'none' },
    license: { id: 'MIT', attribution: 'Copyright (c) 2026 Kyle Durepos. Original Comfyrizz curated template geometry; supplied text/data retain their source rights.' }, redistributable: true,
    notes: `${OWNER}; key ${key}; component ${component}; source ${compiled.sourceHash}` };
}

const ownedNotes = notes => /^comfyrizz-composition\/v1; key ([a-f0-9]{64}); component ([a-z-]+); source (.+)$/u.exec(notes ?? '');
function sanitizeCheck(check) {
  const sanitize = value => {
    if (typeof value === 'string') return value.replace(/(^|[\s"'(])(?:\/[^\s"'<>)]*|[A-Za-z]:[\\/][^\s"'<>)]*)/g, '$1[local path omitted]');
    if (Array.isArray(value)) return value.map(sanitize);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
      .filter(([key]) => !/path|file|snapshot|saved|url|directory|cwd|root/i.test(key)).map(([key, item]) => [key, sanitize(item)]));
    return value;
  };
  // No saved reports, snapshots, engine configuration, or runtime metadata.
  return Object.fromEntries(['ok', 'strict', 'browserSkipped', 'lint', 'runtime', 'layout', 'motion', 'contrast']
    .filter(key => check[key] !== undefined).map(key => [key, sanitize(check[key])]));
}

/** Archive/snapshot cache allowlist. Source manifests remain authoritative; these
 * files are only verified cache evidence and are never executed by the collector. */
export async function collectCompositionCacheExtras(pkg, packageDir) {
  const candidates = Object.entries(pkg?.assets ?? {}).filter(([, asset]) => typeof asset?.notes === 'string' && asset.notes.startsWith(OWNER));
  if (!candidates.length) return [];
  const root = await realpath(resolve(packageDir));
  const extras = [];
  const readLocal = async (relative, maximum = 8 * 1024 * 1024) => {
    const path = await safePath(root, relative, { createParents: false });
    if (await realpath(path) !== path) throw new Error('Composition cache realpath mismatch');
    const stat = await lstat(path);
    if (!stat.isFile() || stat.size > maximum) throw new Error('Composition cache artifact is not a bounded regular file');
    const data = await readFile(path);
    if (data.length > maximum) throw new Error('Composition cache artifact exceeds size limit');
    return data;
  };
  for (const [id, asset] of candidates) {
    const match = ownedNotes(asset.notes);
    if (!match || id !== `a_composition_${match[1].slice(0, 24)}` || asset.file !== `assets/derived/${match[1]}.mp4`) throw new Error(`Inconsistent owned composition asset ${id}`);
    const key = match[1];
    const prefix = `assets/derived/${key}.composition`;
    let receipt;
    try { receipt = JSON.parse((await readLocal(`${prefix}.json`)).toString('utf8')); } catch (error) {
      throw new Error(`Composition cache receipt missing or invalid for ${id}; restore the cache extras before re-materializing an effective package`, { cause: error });
    }
    if (receipt?.owner !== OWNER || receipt.key !== key || receipt.sourceHash !== match[3] ||
        !['htmlHash', 'motionHash', 'videoHash'].every(field => /^[a-f0-9]{64}$/.test(receipt[field] ?? '')) ||
        !Number.isSafeInteger(receipt.bytes) || receipt.bytes <= 0) throw new Error(`Inconsistent composition cache receipt for ${id}`);
    verifyCheck(receipt.check);
    const probe = receipt.probe;
    const expected = derivedAsset({ key, component: match[2], receipt, compiled: { ...probe, sourceHash: receipt.sourceHash } });
    if (canonical(asset) !== canonical(expected) || !probe || probe.audio !== 'none' || probe.codec !== 'h264' || probe.pixelFormat !== 'yuv420p' || probe.shortfallFrames !== 0 ||
        !Number.isInteger(probe.frames) || probe.frames <= 0 || !Number.isInteger(probe.width) || probe.width <= 0 || !Number.isInteger(probe.height) || probe.height <= 0 || !Number.isFinite(probe.fps) || probe.fps <= 0 || !/^[a-f0-9]{64}$/.test(probe.rawHash ?? '')) throw new Error(`Composition asset does not match its owned receipt: ${id}`);
    const videoPath = await safePath(root, asset.file, { createParents: false });
    if (await realpath(videoPath) !== videoPath || (await lstat(videoPath)).size !== receipt.bytes || await fileHash(videoPath) !== receipt.videoHash) throw new Error(`Composition cached video hash mismatch: ${id}`);
    const html = await readLocal(`${prefix}.html`);
    const motion = await readLocal(`${prefix}.motion.json`);
    if (hash(html) !== receipt.htmlHash || hash(JSON.parse(motion.toString('utf8'))) !== receipt.motionHash) throw new Error(`Composition cached source hash mismatch: ${id}`);
    const check = sanitizeCheck(receipt.check);
    verifyCheck(check);
    const portable = Object.fromEntries(['owner', 'key', 'sourceHash', 'htmlHash', 'motionHash', 'videoHash', 'bytes'].map(field => [field, receipt[field]]));
    portable.check = check;
    portable.probe = Object.fromEntries(['frames', 'width', 'height', 'fps', 'codec', 'pixelFormat', 'audio', 'shortfallFrames', 'rawHash'].map(field => [field, probe[field]]));
    extras.push({ path: `${prefix}.json`, data: Buffer.from(canonical(portable)) }, { path: `${prefix}.html`, data: html }, { path: `${prefix}.motion.json`, data: motion });
  }
  return extras.sort((a, b) => a.path.localeCompare(b.path));
}

async function pruneUnreferencedOwnedAssets(pkg, root) {
  const references = new Set();
  const visit = value => {
    if (typeof value === 'string') references.add(value);
    else if (value && typeof value === 'object') Object.values(value).forEach(visit);
  };
  // Include references from other assets as well as scenes and package metadata.
  // Object keys are deliberately excluded: the asset registry itself isn't a use.
  visit(pkg);
  for (const [id, asset] of Object.entries(pkg.assets)) {
    if (references.has(id)) continue;
    const match = ownedNotes(asset?.notes);
    if (!match || id !== `a_composition_${match[1].slice(0, 24)}`) continue;
    try {
      const receipt = await jsonAt(await safePath(root, `assets/derived/${match[1]}.composition.json`));
      if (receipt?.owner !== OWNER || receipt.key !== match[1] || receipt.sourceHash !== match[3]) continue;
      const expected = derivedAsset({ key: match[1], component: match[2], receipt, compiled: { ...receipt.probe, sourceHash: receipt.sourceHash } });
      if (canonical(asset) === canonical(expected)) delete pkg.assets[id];
    } catch { /* Unverifiable ownership is not permission to remove an entry. */ }
  }
  // Disk artifacts remain intact: another package/revision may still use them.
}

async function runtimeIdentity({ env, command, signal, timeoutMs }) {
  const cli = env.COMFYRIZZ_HYPERFRAMES_CLI;
  const browser = env.HYPERFRAMES_BROWSER_PATH || env.COMFYRIZZ_HYPERFRAMES_BROWSER;
  if (!cli || !isAbsolute(cli)) throw new Error('Set COMFYRIZZ_HYPERFRAMES_CLI to an installed, pinned HyperFrames CLI file');
  if (!browser || !isAbsolute(browser)) throw new Error('Set HYPERFRAMES_BROWSER_PATH to a pinned local browser');
  const node = env.COMFYRIZZ_HYPERFRAMES_NODE || process.execPath;
  if (!isAbsolute(node)) throw new Error('COMFYRIZZ_HYPERFRAMES_NODE must be absolute');
  const paths = { node: await realpath(node), cli: await realpath(cli), browser: await realpath(browser) };
  const childEnv = Object.fromEntries(['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'FONTCONFIG_PATH', 'FONTCONFIG_FILE'].filter(key => env[key]).map(key => [key, env[key]]));
  childEnv.HYPERFRAMES_NO_TELEMETRY = '1';
  childEnv.HYPERFRAMES_BROWSER_PATH = paths.browser;
  const options = { env: childEnv, signal, timeoutMs };
  const nodeVersion = (await command(paths.node, ['--version'], options)).stdout.trim();
  if (!/^v(?:2[2-9]|[3-9]\d)\./.test(nodeVersion)) throw new Error('HyperFrames worker requires Node 22+; configure COMFYRIZZ_HYPERFRAMES_NODE');
  const cliVersion = (await command(paths.node, [paths.cli, '--version'], options)).stdout.trim();
  if (!new RegExp(`(?:^|\\s)${HYPERFRAMES_VERSION.replaceAll('.', '\\.')}\\s*$`).test(cliVersion)) throw new Error(`HyperFrames must be pinned to ${HYPERFRAMES_VERSION}`);
  const browserVersion = (await command(paths.browser, ['--version'], options)).stdout.trim();
  if (!browserVersion) throw new Error('Cannot identify composition browser');
  return { ...paths, env: childEnv, fingerprint: { nodeVersion, cliVersion: HYPERFRAMES_VERSION, cliHash: await fileHash(paths.cli), browserVersion, browserHash: await fileHash(paths.browser), browserConfig: { path: paths.browser, gpu: false, locale: childEnv.LANG, fontconfigPath: childEnv.FONTCONFIG_PATH, fontconfigFile: childEnv.FONTCONFIG_FILE }, platform: process.platform, arch: process.arch } };
}

/** Test-only injections are trusted functions, never loaded from package data. */
export async function materializeCompositions({ pkg, packageDir, timeline, signal, onEvent = () => {},
  loadCompositionManifest, compileComposition, command = compositionCommand, env = process.env, timeoutMs = 180000,
  resolveRuntime = runtimeIdentity } = {}) {
  signal?.throwIfAborted();
  if (!loadCompositionManifest) ({ loadCompositionManifest } = await import('../../../packages/compositions/src/index.mjs'));
  const manifest = loadCompositionManifest(packageDir, structuredClone(pkg));
  if (!manifest) return { pkg, report: { version: 1, status: 'noop', scenes: [], fingerprint: null } };
  if (manifest.version !== 1 || !Array.isArray(manifest.scenes)) throw new Error('Invalid composition manifest');
  if (manifest.scenes.length === 0) return { pkg, report: { version: 1, status: 'noop', scenes: [], fingerprint: null } };
  if (!compileComposition) ({ compileComposition } = await import('../../../packages/compositions/src/index.mjs'));
  const root = await realpath(resolve(packageDir));
  const runtime = await resolveRuntime({ env, command, signal, timeoutMs });
  const result = structuredClone(pkg);
  result.assets ??= {};
  const report = { version: 1, owner: OWNER, status: 'ready', engine: { name: 'hyperframes', version: HYPERFRAMES_VERSION }, identity: runtime.fingerprint, encoding: ENCODING, scenes: [] };
  const seen = new Set();
  const emit = (stage, completed, sceneId) => onEvent({ phase: 'composition', stage, sceneId, progress: { mode: 'measured', completed, total: manifest.scenes.length, unit: 'scenes', fraction: completed / manifest.scenes.length, source: 'hyperframes' } });
  const run = (args, cwd, allowedCodes) => command(runtime.node, [runtime.cli, ...args], { cwd, env: runtime.env, signal, timeoutMs, allowedCodes });
  const probeFile = async (path, compiled) => {
    const response = await command(env.COMFYRIZZ_FFPROBE || 'ffprobe', ['-v', 'error', '-count_frames', '-show_entries', 'stream=codec_type,codec_name,pix_fmt,width,height,r_frame_rate,avg_frame_rate,nb_read_frames', '-of', 'json', path], { env: runtime.env, signal, timeoutMs });
    const raw = JSON.parse(response.stdout);
    return { ...verifyCompositionProbe(raw, compiled), rawHash: hash(raw) };
  };
  for (const entry of manifest.scenes) {
    signal?.throwIfAborted();
    const scene = result.scenes.find(scene => scene.id === entry.sceneId);
    const timelineScene = timeline.scenes.find(scene => scene.id === entry.sceneId);
    if (seen.has(entry.sceneId) || !scene || !timelineScene) throw new Error('Composition scene missing or duplicated');
    seen.add(entry.sceneId);
    const sourcePkg = structuredClone(pkg);
    const sourceScene = sourcePkg.scenes.find(scene => scene.id === entry.sceneId);
    // RecipeLayer renders even for media-only scenes. Normalize this field both
    // before compilation and in the returned scene, so a second pass has exactly
    // the same compiler inputs. Keep cue phrases, transitions and foregrounds.
    if (sourceScene.motion) delete sourceScene.motion.recipe;
    if (scene.motion) delete scene.motion.recipe;
    const compiled = compileComposition({ entry: structuredClone(entry), pkg: sourcePkg, scene: sourceScene, timelineScene: structuredClone(timelineScene), timeline: structuredClone(timeline) });
    validateCompiled(compiled, timelineScene, timeline);
    const key = compositionFingerprint({ compiled, entry, timelineScene, identity: runtime.fingerprint });
    const relative = `assets/derived/${key}.mp4`;
    const output = await safePath(root, relative);
    const metadataPath = await safePath(root, `assets/derived/${key}.composition.json`);
    const htmlPath = await safePath(root, `assets/derived/${key}.composition.html`);
    const motionPath = await safePath(root, `assets/derived/${key}.composition.motion.json`);
    const metadata = await jsonAt(metadataPath);
    const owned = metadata?.owner === OWNER && metadata.key === key;
    let receipt, cache = 'miss';
    if (metadata && !owned) throw new Error('Refusing to replace unowned composition metadata');
    if (owned) {
      try {
        verifyCheck(metadata.check);
        if (metadata.sourceHash !== compiled.sourceHash || metadata.htmlHash !== hash(compiled.html) || metadata.motionHash !== hash(compiled.motionSpec) ||
            (await lstat(output)).size !== metadata.bytes || await fileHash(output) !== metadata.videoHash || hash(await readFile(htmlPath, 'utf8')) !== metadata.htmlHash || hash(JSON.parse(await readFile(motionPath, 'utf8'))) !== metadata.motionHash) throw new Error('Invalid composition cache');
        const probe = await probeFile(output, compiled);
        receipt = { ...metadata, probe };
        cache = 'hit';
      } catch (error) { signal?.throwIfAborted(); cache = 'invalid'; }
    }
    emit(cache === 'hit' ? 'cache' : 'check', report.scenes.length, entry.sceneId);
    if (!receipt) {
      if (!owned) {
        for (const path of [output, htmlPath, motionPath]) {
          try { await lstat(path); throw new Error('Refusing to overwrite an unowned composition artifact: missing cache receipt; restore composition cache extras or materialize the original source in a fresh directory'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
        }
      }
      const workParent = await safePath(root, 'assets/derived', { directory: true });
      const work = await mkdtemp(join(workParent, '.composition-'));
      try {
        await writeFile(join(work, 'index.html'), compiled.html, { flag: 'wx' });
        await writeFile(join(work, 'index.motion.json'), canonical(compiled.motionSpec), { flag: 'wx' });
        const samples = [...new Set([0, Math.floor(compiled.frames / 4), Math.floor(compiled.frames / 2), Math.floor(compiled.frames * 3 / 4), compiled.frames - 1])].map(frame => frame / compiled.fps);
        const checked = await run(['check', work, '--json', '--at', samples.join(','), '--no-browser-gpu'], work, [0, 1]);
        const check = JSON.parse(checked.stdout);
        try { verifyCheck(check); if (checked.code !== 0) throw new Error('Composition sampled check exited nonzero'); } catch (error) {
          const findings = ['lint', 'runtime', 'layout', 'motion', 'contrast'].flatMap(kind =>
            (check[kind]?.findings ?? []).filter(finding => finding.severity === 'error').map(finding => ({ kind, code: finding.code, selector: finding.selector, time: finding.time })));
          const detail = findings.slice(0, 5).map(finding => `${finding.code ?? finding.kind}${finding.selector ? ` ${finding.selector}` : ''}${Number.isFinite(finding.time) ? ` at ${finding.time}s` : ''}`).join('; ');
          error.message = `${entry.sceneId}: ${error.message}${detail ? ` — ${detail}` : ''}`;
          error.check = check;
          onEvent({ phase: 'composition', stage: 'failed', sceneId: entry.sceneId, findings });
          throw error;
        }
        emit('render', report.scenes.length, entry.sceneId);
        const rendered = join(work, 'plate.mp4');
        await run(['render', work, '--fps', String(compiled.fps), '--format', 'mp4', '--quality', 'high', '--sdr', '--no-gpu', '--workers', '1', '--no-browser-gpu', '--strict', '--no-best-effort', '--output', rendered], work);
        signal?.throwIfAborted();
        const probe = await probeFile(rendered, compiled);
        const video = await readFile(rendered);
        if (!video.length) throw new Error('Empty composition output');
        receipt = { owner: OWNER, key, sourceHash: compiled.sourceHash, htmlHash: hash(compiled.html), motionHash: hash(compiled.motionSpec), videoHash: hash(video), bytes: video.length, check, probe };
        for (const [path, bytes] of [[output, video], [htmlPath, compiled.html], [motionPath, canonical(compiled.motionSpec)]]) {
          signal?.throwIfAborted();
          await safePath(root, path.slice(root.length + 1));
          await publish(path, bytes, { replace: owned });
        }
        await publish(metadataPath, canonical(receipt), { replace: owned });
      } finally { await rm(work, { recursive: true, force: true }); }
    }
    const assetId = `a_composition_${key.slice(0, 24)}`;
    const asset = derivedAsset({ key, component: entry.component, receipt, compiled });
    // A matching ID is reusable only when every field matches our verified
    // receipt and explicit provenance. Do not repair or replace user collisions.
    if (Object.hasOwn(result.assets, assetId) && canonical(result.assets[assetId]) !== canonical(asset)) throw new Error('Composition asset ID collision');
    result.assets[assetId] = asset;
    scene.background = { asset: assetId, fit: 'contain', scrim: 0, muted: true, speed: 1, loop: false };
    scene.media_only = true;
    report.scenes.push({ sceneId: entry.sceneId, component: entry.component, entry, fingerprint: key, sourceHash: compiled.sourceHash, timelineScene, cache,
      assetId, file: relative, source: { html: htmlPath.slice(root.length + 1), motion: motionPath.slice(root.length + 1), htmlHash: receipt.htmlHash, motionHash: receipt.motionHash, license: 'MIT (original template geometry only)' },
      videoHash: receipt.videoHash, bytes: receipt.bytes, check: receipt.check, checkHash: hash(receipt.check), probe: receipt.probe, diagnostics: compiled.diagnostics ?? [] });
    emit('ready', report.scenes.length, entry.sceneId);
  }
  await pruneUnreferencedOwnedAssets(result, root);
  report.fingerprint = hash(report.scenes.map(scene => ({ sceneId: scene.sceneId, fingerprint: scene.fingerprint, videoHash: scene.videoHash })));
  const reportRelative = `assets/derived/composition-report-${report.fingerprint}.json`;
  const reportPath = await safePath(root, reportRelative);
  const previous = await jsonAt(reportPath);
  if (previous && previous.owner !== OWNER) throw new Error('Refusing to replace unowned composition report');
  report.file = reportRelative;
  signal?.throwIfAborted();
  await publish(reportPath, canonical(report), { replace: !!previous });
  signal?.throwIfAborted();
  return { pkg: result, report };
}
