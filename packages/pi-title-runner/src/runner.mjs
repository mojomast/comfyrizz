import { createHash } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync, appendFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createToolset, classifyProductionIntent } from '@comfyrizz/agent';
import { validatePackage } from '../../schema/src/index.mjs';
import { compileTimeline } from '../../planner/dist/src/index.js';
import { cpuRender } from './cpu-render.mjs';
import { measureTitle } from './title-measurement.mjs';
import { auditExport } from './export-audit.mjs';
import { piTurn } from './pi-adapter.mjs';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
export const hash = value => createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest('hex');
export const readJson = path => JSON.parse(readFileSync(path, 'utf8'));
export function atomicJson(path, data) {
  const text = JSON.stringify(data, null, 2);
  if (Buffer.byteLength(text) > 4 * 1024 * 1024) throw new Error('Evidence record exceeds 4 MiB limit');
  writeFileSync(`${path}.tmp`, `${text}\n`, { mode: 0o600 });
  renameSync(`${path}.tmp`, path);
}

export function sourceFingerprint() {
  const files = [];
  const walk = path => {
    for (const entry of readdirSync(path, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (['node_modules', 'test', 'tests', '.cache'].includes(entry.name)) continue;
      const file = join(path, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (/\.(?:mjs|js|ts|tsx|json|ttf|woff2?)$/.test(entry.name)) files.push([file.slice(ROOT.length + 1), hash(readFileSync(file))]);
    }
  };
  for (const dir of ['packages/agent/src', 'packages/agent/dist/src', 'packages/llm/src', 'packages/llm/dist/src', 'packages/pi-title-runner/src', 'packages/schema/src', 'packages/planner/src', 'packages/planner/dist/src', 'packages/vector/src', 'packages/vector/dist/src', 'packages/compositions/src', 'apps/renderer/src', 'apps/renderer/scripts', 'apps/renderer/public/fonts']) walk(join(ROOT, dir));
  for (const file of ['packages/schema/package-v1.schema.json', 'pnpm-lock.yaml', 'packages/pi-title-runner/package.json', 'apps/server/src/supplied-font.mjs', 'apps/server/src/provider-settings.mjs']) files.push([file, hash(readFileSync(join(ROOT, file)))]);
  return { hash: hash(files), files };
}

export function freezeBrief(input) {
  const brief = typeof input === 'string' ? { prompt: input } : structuredClone(input);
  if (!brief || typeof brief.prompt !== 'string' || !brief.prompt.trim() || brief.prompt.length > 16000) throw new Error('Expected a Title prompt (1–16000 characters)');
  if (brief.videoType && brief.videoType !== 'title-reveal') throw new Error('Only title-reveal scope is supported');
  const intent = classifyProductionIntent(brief.prompt);
  const unsupportedSound = !intent.silent && (intent.evidence.nativeSoundscape || /\b(?:audio|sounds?|sfx|foley)\b/i.test(brief.prompt));
  if (intent.generatedFilm || intent.narrationRequested || intent.speechRequested || intent.musicRequested || unsupportedSound) throw new Error('This native Title runner supports silent/no-audio titles only; requested audio/media cannot be fulfilled');
  const seconds = brief.durationSeconds ?? intent.requestedSeconds;
  if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 30) throw new Error('Title duration must be explicit and between 0 and 30 seconds');
  if (intent.requestedSeconds !== null && seconds !== intent.requestedSeconds) throw new Error('JSON duration conflicts with prompt');
  const exactText = brief.exactText;
  if (exactText !== undefined && (typeof exactText !== 'string' || exactText.length > 48)) throw new Error('exactText must fit the native 48-character title slot');
  const revealSeconds = brief.revealSeconds ?? Math.min(3, seconds / 2);
  if (!Number.isFinite(revealSeconds) || revealSeconds < 0 || revealSeconds >= seconds) throw new Error('Invalid revealSeconds');
  const titleWidth = brief.titleWidth ?? null;
  if (titleWidth && (typeof titleWidth !== 'object' || Object.keys(titleWidth).some(key => !['fraction', 'tolerance', 'expectedLines'].includes(key)) || !Number.isFinite(titleWidth.fraction) || titleWidth.fraction <= 0 || titleWidth.fraction >= 1 || !Number.isFinite(titleWidth.tolerance) || titleWidth.tolerance <= 0 || titleWidth.tolerance > 0.1 || !Number.isInteger(titleWidth.expectedLines) || titleWidth.expectedLines < 1 || titleWidth.expectedLines > 3)) throw new Error('Invalid explicit titleWidth acceptance target');
  return { id: brief.id ?? 'title-prompt', videoType: 'title-reveal', prompt: brief.prompt, durationSeconds: seconds,
    exactText: exactText ?? null, revealSeconds, titleWidth, intent, audioPolicy: 'silent-native-only' };
}

export function packageKey(pkg) { return { id: pkg.id, revision: pkg.revision, hash: hash(pkg) }; }
export function findingsCurrent(findings, pkg) { return Boolean(findings && JSON.stringify(findings.packageKey) === JSON.stringify(packageKey(pkg))); }

// This is an admission boundary, not a replacement renderer. All creation and
// editing still go through createToolset's real Zod/semantic implementations.
export function admitPackage(pkg, brief, fonts = []) {
  if (pkg.scenes?.length !== 1 || pkg.scenes[0].layout !== 'title') throw new Error('Exactly one native title scene is admitted');
  if (Object.keys(pkg.assets ?? {}).length || Object.keys(pkg.datasets ?? {}).length || pkg.composition || pkg.audio || pkg.voice?.enabled) throw new Error('Media, datasets, custom code and audio are outside this Title experiment');
  const scene = pkg.scenes[0];
  for (const key of ['drawing', 'code', 'recipe', 'media', 'foreground', 'narration', 'narration_asset', 'presenter', 'data']) {
    if (scene[key] !== undefined && !(Array.isArray(scene[key]) && scene[key].length === 0)) throw new Error(`Unsupported Title field: ${key}`);
  }
  if (scene.background && Object.keys(scene.background).some(k => k !== 'procedural')) throw new Error('Only native procedural backgrounds are admitted');
  if (JSON.stringify(pkg.theme.fonts ?? []) !== JSON.stringify(fonts)) throw new Error('Font admission changed');
  if (pkg.theme.font !== (fonts[0]?.family ?? 'Inter')) throw new Error('Unadmitted font');
  const frames = brief.durationSeconds * pkg.format.fps;
  if (!Number.isInteger(frames)) throw new Error('Exact duration is not representable at this fps');
  // Same package duration contract used by the app. The compiler enforces exact
  // timing; model-authored preferredFrames cannot override application intent.
  pkg.duration = { mode: 'target', targetFrames: frames, exact: true };
  const validation = validatePackage(pkg);
  if (!validation.valid) throw new Error(`Invalid native package: ${JSON.stringify(validation.errors).slice(0, 1800)}`);
  const timeline = compileTimeline(pkg);
  if (timeline.durationInFrames !== frames) throw new Error('Compiler did not honor exact duration');
  return pkg;
}

const sceneKeys = ['id', 'layout', 'copy', 'headline_size', 'preferredFrames', 'motion', 'transitionOut', 'background'];
const packageSchema = readJson(join(ROOT, 'packages/schema/package-v1.schema.json'));
function inlineSchema(value) {
  if (Array.isArray(value)) return value.map(inlineSchema);
  if (!value || typeof value !== 'object') return value;
  if (value.$ref) {
    if (!value.$ref.startsWith('#/$defs/')) throw new Error('Non-local schema reference');
    return inlineSchema({ ...packageSchema.$defs[value.$ref.slice(8)], ...Object.fromEntries(Object.entries(value).filter(([key]) => key !== '$ref')) });
  }
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, inlineSchema(item)]));
}
const sceneParameters = Object.fromEntries(sceneKeys.map(key => [key, inlineSchema(packageSchema.$defs.scene.properties[key])]));
function restrictedObject(raw, keys, label) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`Expected ${label} object`);
  for (const key of Object.keys(raw)) if (!keys.includes(key)) throw new Error(`${label}.${key} is outside the native Title tool subset`);
}

export function titleTools({ state, commit, preview, repair = false }) {
  const names = repair ? ['storyboard.edit'] : ['storyboard.propose', 'storyboard.edit', 'storyboard.theme'];
  const repairFields = repair ? state.findings.items.filter(f => f.status === 'fail').flatMap(f => f.repairFields ?? []) : [];
  const seed = state.package ?? { theme: { fonts: state.fonts } };
  const native = createToolset({ initialPackage: seed, initialIntent: state.brief.intent });
  // Schemas below are projections of the existing definitions: same controls,
  // smaller admitted loadout. Runtime also validates with the existing Zod tool.
  const tools = names.map(name => {
    const definition = structuredClone(native[name].definition);
    if (name === 'storyboard.propose') {
      delete definition.parameters.properties.datasets;
      const scene = definition.parameters.properties.scenes.items;
      scene.properties = { ...sceneParameters, ...Object.fromEntries(Object.entries(scene.properties).filter(([key]) => sceneKeys.includes(key))) };
      scene.properties.layout = { type: 'string', enum: ['title'] };
      scene.properties.preferredFrames = { type: 'integer', minimum: 1 };
      scene.additionalProperties = false;
      definition.parameters.properties.scenes.minItems = 1;
      definition.parameters.properties.scenes.maxItems = 1;
      definition.parameters.required = ['brief', 'scenes'];
    }
    if (name === 'storyboard.edit') {
      definition.parameters.properties.patch.properties = { ...Object.fromEntries(Object.entries(sceneParameters).filter(([key]) => key !== 'id')), ...Object.fromEntries(Object.entries(definition.parameters.properties.patch.properties).filter(([key]) => sceneKeys.includes(key) && key !== 'id')) };
      definition.parameters.properties.patch.additionalProperties = false;
    }
    return { ...definition, label: name, executionMode: 'sequential', execute: async (_id, raw, signal) => {
      signal?.throwIfAborted();
      if (name === 'storyboard.propose') {
        if (state.package) throw new Error('A draft already exists; proposal replacement is forbidden');
        restrictedObject(raw, ['brief', 'title', 'theme', 'proposal', 'motion', 'scenes'], 'propose');
        if (raw.brief !== state.brief.prompt) throw new Error('Use the frozen brief verbatim');
        if (!Array.isArray(raw.scenes) || raw.scenes.length !== 1) throw new Error('Supply exactly one title scene');
        raw.scenes.forEach(scene => restrictedObject(scene, sceneKeys, 'scene'));
      }
      if (name === 'storyboard.edit') {
        restrictedObject(raw.patch, sceneKeys.filter(k => k !== 'id'), 'patch');
        if (repair) {
          if (Object.keys(raw.patch).some(k => !repairFields.includes(k))) throw new Error('Correction may only change fields implicated by supported findings');
          if (raw.patch.copy) restrictedObject(raw.patch.copy, ['headline'], 'correction.copy');
          if (raw.patch.headline_size !== undefined && (!Number.isInteger(raw.patch.headline_size) || raw.patch.headline_size < 24 || raw.patch.headline_size > 512)) throw new Error('Measured-size correction must remain within 24–512px');
        }
      }
      // Recreate from the committed revision on each call so rejected mutations
      // cannot leak into the next tool. Sequential Pi batches prevent races.
      let candidate;
      const tool = createToolset({ initialPackage: state.package ?? seed, initialIntent: state.brief.intent, onPackageChange: pkg => { candidate = structuredClone(pkg); } })[name];
      const result = await tool.run(tool.schema.parse(raw));
      if (!candidate) throw new Error('Native tool produced no package');
      admitPackage(candidate, state.brief, state.fonts);
      commit(candidate);
      const committedResult = { ...result, package: candidate };
      return { content: [{ type: 'text', text: JSON.stringify({ ...(tool.modelResult ? tool.modelResult(committedResult) : committedResult), packageKey: packageKey(candidate) }) }], details: { packageKey: packageKey(candidate) } };
    } };
  });
  tools.push({ name: 'title.inspect', label: 'Inspect native package', description: 'Read the current committed native package and revision. Runner adapter; no mutation.', parameters: { type: 'object', properties: {}, additionalProperties: false }, execute: async () => {
    if (!state.package) throw new Error('No draft');
    return { content: [{ type: 'text', text: JSON.stringify(state.package) }], details: packageKey(state.package) };
  } });
  tools.push({ name: 'title.preview', label: 'CPU preview samples', description: 'Render real CPU samples of the current committed package. Returns file hashes and deterministic findings, not an image understanding verdict.', parameters: { type: 'object', properties: {}, additionalProperties: false }, executionMode: 'sequential', execute: async () => {
    if (!state.package) throw new Error('No draft');
    const result = await preview();
    return { content: [{ type: 'text', text: JSON.stringify(result) }], details: result };
  } });
  return tools;
}

export async function sampleAndInspect({ state, dir, render = cpuRender, signal }) {
  const pkg = state.package;
  const timeline = compileTimeline(pkg);
  const end = timeline.durationInFrames - 1;
  const reveal = Math.min(end, Math.round(state.brief.revealSeconds * pkg.format.fps));
  const frames = [...new Set([0, reveal, Math.max(reveal, end - 3 * pkg.format.fps + 1), end])];
  const samples = [];
  for (const frame of frames) {
    signal.throwIfAborted();
    const file = `preview-r${pkg.revision}-${hash(pkg).slice(0, 10)}-f${frame}.png`;
    const output = join(dir, file);
    await render(join(dir, 'package.json'), output, { still: true, frame, scale: 0.5, signal });
    samples.push({ frame, seconds: frame / pkg.format.fps, file, sha256: hash(readFileSync(output)), scale: 0.5 });
  }
  const scene = pkg.scenes[0];
  const normalized = text => String(text).replace(/\s+/g, ' ').trim();
  const items = [
    { code: 'native-package', status: 'pass', evidence: 'Existing schema validation and compiler; one native Title scene, no external assets/code/audio' },
    { code: 'exact-duration', status: timeline.durationInFrames === state.brief.durationSeconds * pkg.format.fps ? 'pass' : 'fail', actualFrames: timeline.durationInFrames },
    { code: 'title-text', status: state.brief.exactText === null ? 'unverified' : normalized(scene.copy?.headline) === normalized(state.brief.exactText) ? 'pass' : 'fail', actual: scene.copy?.headline, expected: state.brief.exactText, evidence: 'Package string only; whitespace normalized, not OCR', repairFields: ['copy'] },
    { code: 'headline-size', status: 'pass', authoredPixels: scene.headline_size ?? null, evidence: 'Supported schema range 24–512 composition px when authored; omitted uses existing renderer default. Not a measured text bounding box' },
    { code: 'font-admission', status: 'pass', family: pkg.theme.font, evidence: state.fonts.length ? 'Validated user-upload bytes and rights record' : 'Bundled Inter; condensed font request remains unverified' },
    { code: 'silent-policy', status: 'pass', evidence: 'Package has no audio sources; no listening claim' },
  ];
  const hold = samples.filter(s => s.frame >= reveal);
  items.push({ code: 'sampled-hold', status: new Set(hold.map(s => s.sha256)).size === 1 ? 'pass' : 'fail', frames: hold.map(s => s.frame), evidence: 'Exact PNG byte equality at sampled half-resolution frames only; not all-frame or full-resolution correctness', repairFields: ['motion', 'transitionOut'] });
  items.push(await measureTitle({ state, dir, sample: samples.at(-1), render, signal }));
  for (const code of ['perceptual-quality', 'thin-blue-rule', 'word-by-word-reveal', 'all-frame-hold']) items.push({ code, status: 'unverified', evidence: code === 'thin-blue-rule' ? 'Capability gap: the admitted native Title tool subset has no rule geometry; a blue palette token is not a visible rule' : 'No reliable renderer measurement or visual reviewer implemented' });
  return { packageKey: packageKey(pkg), briefHash: state.briefHash, sourceHash: state.sourceHash, samples, items };
}

export const SYSTEM = `You are the experimental ComfyRizz native Title planner. Use only supplied native tools, never code, files, URLs, SVG, image/video generation or audio. The application owns the frozen brief, exact duration, admitted fonts, assets and acceptance targets. Author exactly ONE native title scene and ONLY the requested copy; no kicker/subtitle/CTA unless requested. For a plain background omit scene.background and set theme.palette[0]. Set theme.text for the headline color; palette[2] is an accent, not rule geometry. Use copy.headline with an explicit newline for a two-line title. headline_size is an INTEGER font size in composition pixels (24–512), not a width percentage: the actual admitted font and raster bounds determine width. Do not invent a font or use the filename as family; retain the admitted family. The Title subset cannot draw the requested blue rule; disclose this capability gap rather than approximating it with extra copy. No exact sequential-word reveal is guaranteed. Keep the final resolved scene unchanged, with no outro and transitionOut:{type:"cut",frames:0}. For entrance use supported native motion.entry, e.g. maskRise or fade-up, without kinetic/recipe/highlight behaviors that may hide the title later.
Use storyboard.propose with {brief: frozenBrief.prompt, title: short label, theme: {palette:[background,secondary,accent,text], text: textColor}, scenes:[{id:"s1",layout:"title",preferredFrames: durationSeconds*30,copy:{headline: requestedText},headline_size: chosenSize,motion:{entry:"maskRise"},transitionOut:{type:"cut",frames:0}}]}. Never send frozenBrief or scene as top-level tool arguments. You have ONE provider response per phase: emit a complete native proposal call now; the application then renders and inspects it automatically. Tool results need no acknowledgement. A correction prompt includes the full committed package, measured raster width, target/tolerance and a bounded size estimate; use storyboard.edit with scene_id and patch:{headline_size:...}, preserving unrelated copy/timing/theme/font. The estimate is not itself a passing measurement: the application re-renders once. No replacement plan, no self-directed repair loop. Evidence is experimental direct-run, never UI Download.`;

export async function runTitle({ dir, brief, mode, config = { provider: 'disabled', model: 'disabled', thinking: 'disabled', maxTokens: 8192 }, chatModel, fonts = [], source = sourceFingerprint(), render = cpuRender, timeoutMs = 180000, signal: externalSignal, fixture }) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const lockPath = join(dir, 'runner.lock');
  const lock = openSync(lockPath, 'wx', 0o600);
  writeFileSync(lock, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
  const controller = new AbortController();
  const abort = () => controller.abort();
  externalSignal?.addEventListener('abort', abort, { once: true });
  if (externalSignal?.aborted) abort();
  const timer = setTimeout(abort, timeoutMs);
  let state;
  const save = () => atomicJson(join(dir, 'checkpoint.json'), state);
  const event = value => {
    if (value.type === 'tool_execution_end' && value.isError) { state.toolErrors = (state.toolErrors ?? 0) + 1; save(); }
    const path = join(dir, 'events.jsonl');
    const line = JSON.stringify({ at: new Date().toISOString(), ...value });
    if (line.length > 256000 || (existsSync(path) && statSync(path).size > 8 * 1024 * 1024)) throw new Error('Bounded event log exhausted');
    appendFileSync(path, `${line}\n`, { mode: 0o600 });
  };
  const phase = async (name, fn) => {
    const start = Date.now(); state.phase = name; save(); event({ type: 'phase-start', phase: name });
    try { return await fn(); }
    finally { state.phaseTimes.push({ phase: name, ms: Date.now() - start }); save(); event({ type: 'phase-end', phase: name, ms: Date.now() - start }); }
  };
  try {
    if (existsSync(join(dir, 'checkpoint.json'))) {
      if (!['resume', 'inspect', 'export'].includes(mode)) throw new Error('Existing checkpoint: use resume, inspect or export');
      state = readJson(join(dir, 'checkpoint.json'));
      if (state.sourceHash !== source.hash) throw new Error('Source fingerprint changed: use a new run directory; old evidence is not valid for new code');
      if (brief && hash(freezeBrief(brief)) !== state.briefHash) throw new Error('Frozen brief changed: use a new run directory');
      if (existsSync(join(dir, 'package.json'))) {
        const pkg = readJson(join(dir, 'package.json'));
        admitPackage(pkg, state.brief, state.fonts);
        if (!state.package || hash(pkg) !== hash(state.package)) { state.findings = null; state.export = null; event({ type: 'revision-invalidated', previous: state.package && packageKey(state.package), current: packageKey(pkg) }); }
        state.package = pkg;
      }
      if (!state.package) throw new Error('No committed draft. An interrupted model phase is never replayed; start a new run explicitly');
    } else {
      if (['resume', 'inspect', 'export'].includes(mode)) throw new Error('No checkpoint to resume');
      if (readdirSync(dir).some(name => name !== 'runner.lock' && !(name === 'assets' && fonts.length))) throw new Error('New run directory contains unrelated files');
      const frozen = freezeBrief(brief);
      state = { version: 1, provenance: mode === 'smoke' ? 'deterministic-fixture-cpu-smoke-not-model-quality' : mode === 'preflight' ? 'model-disabled-preflight' : 'experimental-pi-direct-run-not-ui', brief: frozen, briefHash: hash(frozen), sourceHash: source.hash, config, fonts, fontHashes: fonts.map(font => ({ file: font.file, sha256: hash(readFileSync(join(dir, font.file))) })), phase: 'frozen', phaseTimes: [], initialCalls: 0, repairCalls: 0, package: null, findings: null, export: null };
      atomicJson(join(dir, 'source.json'), source); atomicJson(join(dir, 'brief.json'), frozen); save();
    }
    const checkDisk = () => {
      if (source.files?.length && sourceFingerprint().hash !== state.sourceHash) throw new Error('Source changed during run; evidence cannot certify mixed code revisions');
      for (const font of state.fontHashes) if (hash(readFileSync(join(dir, font.file))) !== font.sha256) throw new Error('Admitted font bytes changed');
      if (state.package && hash(readJson(join(dir, 'package.json'))) !== hash(state.package)) throw new Error('Package changed during run; resume to invalidate stale findings');
    };
    const commit = pkg => {
      checkDisk();
      state.package = pkg; state.findings = null; state.export = null;
      atomicJson(join(dir, `package-r${pkg.revision}-${hash(pkg).slice(0, 10)}.json`), pkg);
      atomicJson(join(dir, 'package.json'), pkg); save();
    };
    const preview = async () => {
      checkDisk();
      const evidence = [...(state.findings?.samples ?? []), ...(state.findings?.items.flatMap(item => item.artifacts ?? []) ?? [])];
      if (!findingsCurrent(state.findings, state.package) || !evidence.every(s => existsSync(join(dir, s.file)) && hash(readFileSync(join(dir, s.file))) === s.sha256)) {
        state.findings = await sampleAndInspect({ state, dir, render, signal: controller.signal });
        checkDisk(); atomicJson(join(dir, `findings-r${state.package.revision}-${hash(state.package).slice(0, 10)}.json`), state.findings); save();
      }
      return state.findings;
    };
    if (mode === 'preflight') {
      atomicJson(join(dir, 'tool-schemas.json'), titleTools({ state, commit, preview }).map(({ execute, ...tool }) => tool));
      atomicJson(join(dir, 'system-prompt.json'), { system: SYSTEM });
      state.phase = 'preflight-complete'; save(); return state;
    }
    const modelPhase = async repair => {
      if (!chatModel) throw new Error('Explicit live provider required');
      if (repair && (!findingsCurrent(state.findings, state.package) || state.repairCalls >= 1)) throw new Error('Stale findings or correction budget exhausted');
      const name = repair ? 'correction' : 'draft';
      // Reserve BEFORE network/tool effects. Crashes never replenish a budget.
      if (repair) state.repairCalls++; else { if (state.initialCalls) throw new Error('Initial request already reserved'); state.initialCalls++; }
      save();
      const tools = titleTools({ state, commit, preview, repair });
      const prompt = JSON.stringify({ frozenBrief: state.brief, admittedFonts: state.fonts, ...(repair ? { task: 'Correct only concrete failed findings, preserving every unrelated field. Do not replace the plan.', package: state.package, findings: state.findings } : { task: 'Create one complete native Title draft using storyboard.propose.' }) });
      atomicJson(join(dir, `${name}-prompt.json`), { system: SYSTEM, prompt });
      atomicJson(join(dir, `${name}-tools.json`), tools.map(({ execute, ...tool }) => tool));
      let requests = 0;
      await phase(name, () => piTurn({ chatModel, config: state.config, system: SYSTEM, prompt, tools, signal: controller.signal, event, sessionId: `pi-title-${state.briefHash.slice(0, 16)}`,
        recordRequest: request => { if (++requests > 1) throw new Error('Provider request budget exceeded'); atomicJson(join(dir, `${name}-effective-request.json`), request); } }));
    };
    if (!state.package) {
      if (mode === 'smoke') {
        if (!fixture) throw new Error('Smoke requires an explicit deterministic fixture');
        await phase('fixture-draft', async () => {
          const tools = titleTools({ state, commit, preview });
          await tools.find(t => t.name === 'storyboard.propose').execute('fixture', { ...fixture, brief: state.brief.prompt }, controller.signal);
        });
      } else await modelPhase(false);
      if (!state.package) throw new Error('Model response did not create an admitted package');
      atomicJson(join(dir, 'pre-correction-package.json'), state.package);
    }
    await phase('preview-inspect', preview);
    if (mode === 'live' && state.repairCalls === 0 && state.findings.items.some(f => f.status === 'fail' && f.repairFields?.length)) {
      await modelPhase(true);
      await phase('post-correction-preview', preview);
    }
    atomicJson(join(dir, 'post-correction-package.json'), state.package);
    if (mode !== 'inspect') {
      checkDisk();
      const current = packageKey(state.package);
      if (!state.export || JSON.stringify(state.export.packageKey) !== JSON.stringify(current) || !existsSync(join(dir, 'export.mp4')) || hash(readFileSync(join(dir, 'export.mp4'))) !== state.export.sha256) {
        await phase('export', async () => {
          try {
            await render(join(dir, 'package.json'), join(dir, 'export.mp4'), { signal: controller.signal });
            checkDisk();
            state.export = { packageKey: current, file: 'export.mp4', sha256: hash(readFileSync(join(dir, 'export.mp4'))), provenance: 'existing-renderPackageAsync CPU export; not UI Download' };
          } catch (error) { rmSync(join(dir, 'export.mp4'), { force: true }); throw error; }
        });
      }
    }
    if (mode !== 'inspect' && render === cpuRender && (!state.export.audit || !existsSync(join(dir, state.export.audit.file)) || hash(readFileSync(join(dir, state.export.audit.file))) !== state.export.audit.sha256)) {
      await phase('export-audit', async () => {
        state.export.audit = await auditExport({ dir, pkg: state.package, brief: state.brief, findings: state.findings, signal: controller.signal });
        state.export.audit.sha256 = hash(readFileSync(join(dir, state.export.audit.file)));
      });
    }
    state.acceptance = { verdict: 'human-review-required', failed: state.findings.items.filter(f => f.status === 'fail').map(f => f.code), unverified: state.findings.items.filter(f => f.status === 'unverified').map(f => f.code), toolErrors: state.toolErrors ?? 0 };
    state.phase = 'complete'; state.failure = null; save(); return state;
  } catch (error) {
    if (state) { state.failure = { phase: state.phase, message: error.message, at: new Date().toISOString() }; save(); }
    throw error;
  } finally {
    clearTimeout(timer); externalSignal?.removeEventListener('abort', abort); controller.abort();
    closeSync(lock); rmSync(lockPath, { force: true });
  }
}
