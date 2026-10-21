import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { join, relative, isAbsolute } from 'node:path';

export const IMPLEMENTATION_VERSION = 'native-scenes/1.0.1';
export const MAX_MANIFEST_BYTES = 128 * 1024;
const COMPONENTS = ['object-transfer', 'mechanism-journey', 'evidence-reveal'];
const fail = message => { throw new Error(`Composition: ${message}`); };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
function keys(value, allowed, name) {
  if (!object(value)) fail(`${name} must be an object`);
  for (const key of Object.keys(value)) if (!allowed.includes(key)) fail(`${name}.${key} is not supported`);
}
function text(value, name, max = 120) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(value)) fail(`${name} must be nonempty text (max ${max})`);
  return value;
}
function integer(value, name, min, max) {
  if (!Number.isInteger(value) || value < min || value > max) fail(`${name} must be an integer in ${min}..${max}`);
  return value;
}

function evidenceData(params, pkg) {
  text(params.dataset, 'params.dataset');
  const dataset = Object.hasOwn(pkg.datasets ?? {}, params.dataset) ? pkg.datasets[params.dataset] : null;
  if (!object(dataset) || !Array.isArray(dataset.values)) fail(`dataset ${params.dataset} does not exist`);
  if (!['user', 'openverse', 'example', 'derived'].includes(dataset.source)) fail('dataset source must be declared');
  if (dataset.source === 'example' && dataset.approved !== true) fail('example dataset must be approved');
  if (typeof dataset.unit !== 'string' || dataset.unit.length > 40) fail('dataset unit must be text (max 40)');
  if (!Array.isArray(params.rows) || params.rows.length < 2 || params.rows.length > 6) fail('params.rows requires 2..6 exact dataset row labels');
  if (new Set(params.rows).size !== params.rows.length) fail('params.rows must be unique');
  const rows = params.rows.map(label => {
    text(label, 'dataset row label', 60);
    const matches = dataset.values.filter(row => row?.label === label);
    if (matches.length !== 1 || !Number.isFinite(matches[0].value) || Math.abs(matches[0].value) > 1e15) fail(`dataset row ${JSON.stringify(label)} must identify exactly one finite value`);
    return { label, value: matches[0].value };
  });
  if (dataset.label !== undefined) text(dataset.label, 'dataset.label');
  if (dataset.note !== undefined) text(dataset.note, 'dataset.note', 320);
  return {
    id: params.dataset, label: dataset.label ?? params.dataset, unit: dataset.unit,
    source: dataset.source, approved: dataset.approved === true,
    // This is provenance text only, never a fetched or linked resource.
    sourceUrl: typeof dataset.source_url === 'string' ? dataset.source_url : null,
    retrievedAt: typeof dataset.retrieved_at === 'string' ? dataset.retrieved_at : null,
    note: dataset.note ?? '', rows,
  };
}

/** Validate the editable, data-only manifest against actual package scene IDs. */
export function validateCompositionManifest(manifest, pkg) {
  keys(manifest, ['version', 'scenes'], 'manifest');
  if (manifest.version !== 1) fail('manifest.version must be 1');
  if (!Array.isArray(manifest.scenes) || manifest.scenes.length > 256) fail('manifest.scenes must be an array (max 256)');
  if (!Array.isArray(pkg?.scenes)) fail('package scenes are required');
  const ids = new Set();
  for (const entry of manifest.scenes) {
    keys(entry, ['sceneId', 'component', 'params', 'cues'], 'entry');
    text(entry.sceneId, 'entry.sceneId');
    if (ids.has(entry.sceneId)) fail(`duplicate sceneId ${entry.sceneId}`);
    ids.add(entry.sceneId);
    if (pkg.scenes.filter(scene => scene.id === entry.sceneId).length !== 1) fail(`sceneId ${entry.sceneId} must identify exactly one real scene`);
    if (!COMPONENTS.includes(entry.component)) fail(`unsupported component ${entry.component}`);
    const p = entry.params;
    const fields = entry.component === 'object-transfer'
      ? ['title', 'objectLabel', 'fromLabel', 'toLabel', 'resultLabel', 'qualifier']
      : entry.component === 'mechanism-journey'
        ? ['title', 'stations', 'signalLabel', 'resultLabel', 'qualifier']
        : ['title', 'dataset', 'rows', 'resultLabel', 'qualifier'];
    keys(p, fields, 'params');
    text(p.title, 'params.title', 100);
    text(p.resultLabel, 'params.resultLabel', 120);
    if (p.qualifier !== undefined) text(p.qualifier, 'params.qualifier', 180);
    if (entry.component === 'object-transfer') {
      for (const field of ['objectLabel', 'fromLabel', 'toLabel']) text(p[field], `params.${field}`, 60);
    } else if (entry.component === 'mechanism-journey') {
      text(p.signalLabel, 'params.signalLabel', 40);
      if (!Array.isArray(p.stations) || p.stations.length < 2 || p.stations.length > 4) fail('params.stations requires 2..4 stations');
      p.stations.forEach(station => {
        keys(station, ['label', 'detail'], 'station');
        text(station.label, 'station.label', 50);
        text(station.detail, 'station.detail', 100);
      });
    } else evidenceData(p, pkg);
    if (entry.cues !== undefined) {
      keys(entry.cues, ['action', 'result'], 'cues');
      for (const [slot, cue] of Object.entries(entry.cues)) {
        keys(cue, ['frame', 'phrase'], `cues.${slot}`);
        if (cue.frame === undefined && cue.phrase === undefined) fail(`cues.${slot} requires frame or phrase`);
        if (cue.frame !== undefined) integer(cue.frame, `cues.${slot}.frame`, 0, 2160000);
        if (cue.phrase !== undefined) text(cue.phrase, `cues.${slot}.phrase`, 160);
      }
    }
  }
  return manifest;
}

function manifestBytes(packageDir, pkg) {
  const id = pkg?.id;
  if (id !== undefined && (typeof id !== 'string' || !/^[A-Za-z0-9_-]+$/.test(id))) fail('package id must match /^[A-Za-z0-9_-]+$/ for composition lookup');
  const root = realpathSync(packageDir);
  const folder = join(root, 'compositions');
  const optionalStat = path => {
    try { return lstatSync(path); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  };
  const localDirectory = path => {
    const stat = optionalStat(path);
    if (!stat) return false;
    if (stat.isSymbolicLink() || realpathSync(path) !== path) fail('compositions directory must not be a symlink');
    if (!stat.isDirectory()) fail('compositions path must be a directory');
    return true;
  };
  // A dangling symlink is an invalid source, not an absent manifest.
  if (!localDirectory(folder)) return null;
  let exportPath = 'compositions/manifest.json';
  let path = join(folder, 'manifest.json');
  let stat;
  if (id !== undefined && localDirectory(join(folder, id))) {
    const scopedPath = join(folder, id, 'manifest.json');
    stat = optionalStat(scopedPath);
    if (stat) {
      path = scopedPath;
      exportPath = `compositions/${id}/manifest.json`;
    }
  }
  stat ??= optionalStat(path);
  if (!stat) return null;
  const real = realpathSync(path);
  const rel = relative(root, real);
  if (stat.isSymbolicLink() || isAbsolute(rel) || rel.startsWith('..') || real !== path) fail('manifest must be a package-local regular file, without symlinks');
  if (!stat.isFile() || stat.size > MAX_MANIFEST_BYTES) fail(`manifest must be a regular file of at most ${MAX_MANIFEST_BYTES} bytes`);
  const data = readFileSync(path);
  if (data.length > MAX_MANIFEST_BYTES) fail('manifest exceeds size limit');
  return { path: exportPath, data };
}

export function loadCompositionManifest(packageDir, pkg) {
  const source = manifestBytes(packageDir, pkg);
  return source === null ? null : validateCompositionManifest(JSON.parse(source.data.toString('utf8')), pkg);
}

/** Only editable data is exported. No files named by a user manifest are executed or copied. */
export function collectCompositionExtras(pkg, packageDir) {
  const source = manifestBytes(packageDir, pkg);
  if (source === null) return [];
  validateCompositionManifest(JSON.parse(source.data.toString('utf8')), pkg);
  return [source];
}

const tokens = value => (String(value).normalize('NFKC').toLowerCase().match(/[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu) ?? []);
function phraseCue(phrase, scene, timelineScene, timeline) {
  const needle = tokens(phrase);
  if (!needle.length) fail(`cue phrase ${JSON.stringify(phrase)} has no spoken tokens`);
  const same = candidate => tokens(candidate).join(' ') === needle.join(' ');
  const resolved = (timelineScene.motionCues ?? []).filter(cue => same(cue.phrase));
  const usable = resolved.find(cue => Number.isInteger(cue.frame) && cue.source !== 'unresolved');
  if (usable) return { ...usable, frame: usable.frame - timelineScene.from, matches: resolved.length };
  const captions = (timeline.captions ?? []).filter(caption => caption.sceneId === timelineScene.id);
  const hasWords = caption => Array.isArray(caption.words) && caption.words.length > 0;
  // The planner applies display-only caption corrections AFTER resolving motionCues.
  // words[] is untouched, but text is not a speech transcript we can blindly trust.
  // For sentence anchors require the ENTIRE ordered transcript to agree with the
  // authoritative narration, so an override cannot move an existing spoken phrase
  // into a different caption and silently give it that caption's earlier frame.
  const narration = typeof scene.narration === 'string' ? scene.narration : timelineScene.narration;
  const spokenTokens = typeof narration === 'string' ? tokens(narration) : [];
  const captionTokens = captions.flatMap(caption => hasWords(caption)
    ? caption.words.flatMap(word => tokens(word.text)) : tokens(caption.text));
  const captionTextTrusted = spokenTokens.length > 0 && spokenTokens.join(' ') === captionTokens.join(' ');
  const matches = [];
  let unverifiedCaptionMatch = false;
  for (const caption of captions) {
    const wordTimed = hasWords(caption);
    const words = wordTimed
      ? caption.words.flatMap(word => tokens(word.text).map(text => ({ text, frame: word.from })))
      : tokens(caption.text).map(text => ({ text, frame: caption.from }));
    for (let i = 0; i + needle.length <= words.length; i++) {
      if (needle.every((word, offset) => word === words[i + offset].text)) {
        if (!wordTimed && !captionTextTrusted) {
          unverifiedCaptionMatch = true;
          continue;
        }
        matches.push({ phrase, frame: words[i].frame - timelineScene.from,
          source: wordTimed ? 'word-cues' : caption.estimated ? 'estimated-caption' : 'measured-caption',
          estimated: Boolean(caption.estimated || (wordTimed && caption.timing === 'syllable-fallback')),
          ...(wordTimed && caption.timing ? { timing: caption.timing } : {}), occurrence: 1 });
      }
    }
  }
  if (!matches.length && unverifiedCaptionMatch) fail(`cannot verify spoken text for caption-only cue ${JSON.stringify(phrase)} in scene ${timelineScene.id}; provide planner motionCues or original word timings`);
  if (!matches.length) fail(`cue phrase ${JSON.stringify(phrase)} has no narration timing in scene ${timelineScene.id}`);
  return { ...matches[0], matches: matches.length };
}

function resolveCues(entry, scene, timelineScene, timeline, frames) {
  const defaults = { action: Math.floor((frames - 1) * 0.22), result: Math.floor((frames - 1) * 0.64) };
  const cues = {};
  for (const slot of ['action', 'result']) {
    const cue = entry.cues?.[slot];
    const resolved = cue?.frame !== undefined
      ? { frame: cue.frame, source: 'explicit-frame', estimated: false, ...(cue.phrase ? { phrase: cue.phrase } : {}) }
      : cue?.phrase ? phraseCue(cue.phrase, scene, timelineScene, timeline)
        : { frame: defaults[slot], source: 'intentional-default', estimated: false };
    integer(resolved.frame, `${slot} local cue frame`, 0, frames - 1);
    cues[slot] = resolved;
  }
  if (cues.result.frame <= cues.action.frame) fail('result cue must follow action cue by at least one frame');
  return cues;
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (object(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
const escape = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const scriptJSON = value => canonical(value).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
const color = (value, fallback) => typeof value === 'string' && /^#[\da-f]{6}$/i.test(value) ? value : fallback;

// This original runtime is serialized inline. Every property is recomputed from the requested
// integer frame; no CSS animation, wall clock, random source, or previous-frame state is used.
function frameRuntime(config) {
  const root = document.getElementById('root');
  const get = id => document.getElementById(id);
  const clamp = value => Math.min(1, Math.max(0, value));
  function render(time) {
    const frame = Math.min(config.frames - 1, Math.max(0, Math.round(time * config.fps)));
    const progress = clamp((frame - config.action) / (config.result - config.action));
    const smooth = progress * progress * (3 - 2 * progress);
    const arrived = frame >= config.result;
    get('result').style.opacity = arrived ? '1' : '0';
    if (config.component === 'object-transfer') {
      get('object').style.transform = `translate(${config.dx * smooth}px,${config.dy * smooth}px)`;
      get('target').style.borderColor = arrived ? config.accent : config.muted;
    } else if (config.component === 'mechanism-journey') {
      const index = Math.min(config.points.length - 2, Math.floor(smooth * (config.points.length - 1)));
      const t = smooth * (config.points.length - 1) - index;
      const a = config.points[index], b = config.points[index + 1];
      get('signal').style.transform = `translate(${a.x + (b.x - a.x) * t}px,${a.y + (b.y - a.y) * t}px)`;
      config.points.forEach((_, i) => {
        get(`station-${i}`).style.borderColor = smooth * (config.points.length - 1) >= i ? config.accent : config.muted;
        get(`station-${i}`).style.background = smooth * (config.points.length - 1) >= i ? config.active : config.panel;
      });
    } else {
      config.bars.forEach((bar, i) => {
        get(`bar-${i}`).style.width = `${bar.width * smooth}px`;
        get(`bar-${i}`).style.left = `${bar.negative ? bar.zero - bar.width * smooth : bar.zero}px`;
        get(`value-${i}`).style.opacity = arrived ? '1' : '0';
      });
    }
    root.dataset.frame = String(frame);
  }
  render(0);
  // The fallback permits local standalone inspection without an external runtime.
  window.__comfyrizzComposition = { render, config };
  if (window.__hyperframes?.registerFrameSource) {
    window.__hyperframes.registerFrameSource({ element: root, ready: document.fonts.ready, render });
  }
}

/** Compile one validated curated scene to a full-frame opaque silent HTML plate. */
export function compileComposition({ entry, pkg, scene, timelineScene, timeline }) {
  validateCompositionManifest({ version: 1, scenes: [entry] }, pkg);
  if (!scene || scene.id !== entry.sceneId || timelineScene?.id !== entry.sceneId) fail('entry, scene and timelineScene IDs must match');
  const frames = integer(timelineScene.durationInFrames, 'durationInFrames', 3, 2160000);
  const fps = integer(timeline?.fps, 'fps', 1, 240);
  const width = integer(timeline.width, 'width', 240, 8192);
  const height = integer(timeline.height, 'height', 240, 8192);
  integer(timelineScene.from, 'scene.from', 0, Number.MAX_SAFE_INTEGER);
  const cues = resolveCues(entry, scene, timelineScene, timeline, frames);
  const p = entry.params;
  const evidence = entry.component === 'evidence-reveal' ? evidenceData(p, pkg) : null;
  const portrait = height > width * 1.15;
  const square = !portrait && width < height * 1.4;
  const scale = Math.min(width, height) / 720;
  const font = Math.round(25 * scale);
  const margin = Math.round(Math.min(width * 0.065, 64 * scale));
  // All authored content ends at 77% height; the bottom 20% belongs to final captions.
  const safeBottom = height * 0.77;
  const top = height * (portrait ? 0.23 : 0.26);
  const contentWidth = width - 2 * margin;
  const theme = {
    background: '#10272d', panel: '#193a42', active: '#214d50',
    text: color(pkg.theme?.text, '#f4f5ed'), muted: color(pkg.theme?.text_muted, '#b5c9c8'),
    accent: color(pkg.theme?.palette?.[1], '#73dfc2'),
  };
  const config = { component: entry.component, frames, fps, action: cues.action.frame, result: cues.result.frame, ...theme };
  const fit = (value, w, h, preferred) => {
    let size = preferred;
    while (size > 8 * scale && Math.ceil(String(value).length / Math.max(1, Math.floor(w / (size * 0.8)))) * size * 1.18 > h) size -= scale;
    return Math.max(size, 8 * scale);
  };
  const box = (id, className, x, y, w, h, html, fontSize) => `<div id="${id}" data-element-id="${id}" class="${className}" style="left:${x}px;top:${y}px;width:${w}px;height:${h}px${fontSize ? `;font-size:${fontSize}px` : ''}">${html}</div>`;
  let body = '';
  const resultY = height * 0.625;
  if (entry.component === 'object-transfer') {
    const vertical = portrait || square;
    const w = vertical ? contentWidth : contentWidth * 0.38;
    const h = height * (vertical ? 0.13 : 0.27);
    const targetX = vertical ? margin : width - margin - w;
    const targetY = vertical ? top + h + height * 0.065 : top;
    body += box('origin', 'container', margin, top, w, h, `<span>${escape(p.fromLabel)}</span>`, fit(p.fromLabel, w - 24 * scale, h * 0.43, font));
    body += box('target', 'container', targetX, targetY, w, h, `<span>${escape(p.toLabel)}</span>`, fit(p.toLabel, w - 24 * scale, h * 0.43, font));
    const objectW = w * (vertical ? 0.60 : 0.82);
    const objectH = h * 0.42;
    const x = margin + (w - objectW) / 2, y = top + h * 0.50;
    body += box('object', 'object', x, y, objectW, objectH, escape(p.objectLabel), fit(p.objectLabel, objectW - 10 * scale, objectH - 10 * scale, font));
    config.dx = targetX - margin;
    config.dy = targetY - top;
  } else if (entry.component === 'mechanism-journey') {
    const n = p.stations.length;
    const vertical = portrait || (square && n === 2);
    const grid = square && n > 2;
    const available = height * 0.34;
    const w = vertical ? contentWidth * 0.84 : grid ? (contentWidth - 22 * scale) / 2 : (contentWidth - (n - 1) * 22 * scale) / n;
    const h = vertical ? available / n * 0.80 : grid ? available * 0.40 : available * 0.70;
    const points = p.stations.map((station, i) => {
      const x = vertical ? margin + contentWidth * 0.16 : grid ? margin + (i % 2) * (w + 22 * scale) : margin + i * (w + 22 * scale);
      const y = vertical ? top + i * available / n : grid ? top + Math.floor(i / 2) * available * 0.53 : top + available * 0.15;
      body += box(`station-${i}`, 'station', x, y, w, h,
        `<strong>${escape(station.label)}</strong><span>${escape(station.detail)}</span>`, fit(`${station.label} ${station.detail}`, w - 24 * scale, h - 30 * scale, font * 0.85));
      return vertical ? { x: margin + contentWidth * 0.035, y: y + h / 2 } : { x: x + w / 2, y: grid ? y + h + 8 * scale : top + available * 0.96 };
    });
    const path = points.map(point => `${point.x},${point.y}`).join(' ');
    body += `<svg class="path" width="${width}" height="${height}" aria-hidden="true"><polyline points="${path}" fill="none" stroke="${theme.muted}" stroke-width="${3 * scale}"/></svg>`;
    body += box('signal', 'signal', -9 * scale, -9 * scale, 18 * scale, 18 * scale, '');
    body += box('signal-label', 'signal-label', margin, top - font * 1.5, contentWidth, font * 1.2, escape(p.signalLabel));
    config.points = points;
  } else {
    const chartTop = top;
    const chartH = height * 0.32;
    const rowH = chartH / evidence.rows.length;
    const labelW = contentWidth * (portrait ? 0.37 : 0.25);
    const chartX = margin + labelW;
    const chartW = contentWidth * (portrait ? 0.38 : 0.52);
    const min = Math.min(0, ...evidence.rows.map(row => row.value));
    const max = Math.max(0, ...evidence.rows.map(row => row.value));
    const range = max - min || 1;
    const zero = chartX + (-min / range) * chartW;
    config.bars = [];
    evidence.rows.forEach((row, i) => {
      const y = chartTop + i * rowH;
      const end = chartX + (row.value - min) / range * chartW;
      const barWidth = Math.abs(end - zero);
      body += box(`label-${i}`, 'row-label', margin, y, labelW - 10 * scale, rowH, escape(row.label), fit(row.label, labelW - 10 * scale, rowH, font * 0.72));
      body += box(`bar-${i}`, 'bar', Math.min(zero, end), y + rowH * 0.22, barWidth, rowH * 0.56, '');
      const value = `${row.value}${evidence.unit ? ` ${evidence.unit}` : ''}`;
      const valueW = contentWidth - labelW - chartW - 12 * scale;
      body += box(`value-${i}`, 'value', chartX + chartW + 12 * scale, y, valueW, rowH, escape(value), fit(value, valueW, rowH, font * 0.72));
      config.bars.push({ width: barWidth, negative: row.value < 0, zero });
    });
    body += box('baseline', 'baseline', zero, chartTop, Math.max(1, scale), chartH, '');
  }
  const notes = [p.qualifier, evidence ? `${evidence.label} · ${evidence.source}${evidence.source === 'example' ? ' (approved example)' : ''}${evidence.note ? ` · ${evidence.note}` : ''}` : null].filter(Boolean);
  const title = box('title', 'title', margin, height * 0.065, contentWidth, height * 0.14, escape(p.title), fit(p.title, contentWidth, height * 0.14, font * 1.65));
  const result = box('result', 'result', margin, resultY, contentWidth, height * 0.085, escape(p.resultLabel), fit(p.resultLabel, contentWidth, height * 0.085, font * 1.15));
  const note = box('qualifier', 'qualifier', margin, height * 0.72, contentWidth, safeBottom - height * 0.72, escape(notes.join(' · ')), fit(notes.join(' · '), contentWidth, safeBottom - height * 0.72, font * 0.56));
  const duration = frames / fps;
  const html = `<!doctype html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=${width},initial-scale=1"><title>${escape(p.title)}</title>
<style>
@font-face{font-family:ComfyrizzSystem;src:local("Arial"),local("Liberation Sans"),local("DejaVu Sans");font-weight:400;font-style:normal}@font-face{font-family:ComfyrizzSystem;src:local("Arial Bold"),local("Liberation Sans Bold"),local("DejaVu Sans Bold");font-weight:700;font-style:normal}
*{box-sizing:border-box}
html,body{margin:0;width:${width}px;height:${height}px;background:${theme.background};color:${theme.text};font-family:ComfyrizzSystem,sans-serif}
#root{position:relative;width:${width}px;height:${height}px;overflow:hidden}
#root>div{position:absolute;overflow-wrap:anywhere}
.title{font-size:${font * 1.65}px;line-height:1.12;font-weight:700;display:flex;align-items:center}
.container,.station{border:${2 * scale}px solid ${theme.muted};border-radius:${12 * scale}px;background:${theme.panel};padding:${12 * scale}px;font-size:${font}px;line-height:1.15}
.container>span{display:block}
.object{display:flex;align-items:center;justify-content:center;text-align:center;padding:${5 * scale}px;border-radius:${8 * scale}px;background:${theme.accent};color:${theme.background};font-size:${font}px;font-weight:700}
.station{display:flex;flex-direction:column;justify-content:center;gap:${6 * scale}px;font-size:${font * (portrait || square ? 0.75 : 0.85)}px}
.station span{font-size:0.85em;color:${theme.muted}}
.path{position:absolute;inset:0;pointer-events:none}
.signal{border-radius:50%;background:${theme.accent}}
.signal-label{font-size:${font * 0.7}px;color:${theme.muted}}
.result{font-size:${font * 1.15}px;font-weight:700;line-height:1.12;display:flex;align-items:center;color:${theme.accent};opacity:0}
.qualifier{font-size:${font * 0.56}px;line-height:1.15;color:${theme.muted}}
.row-label,.value{display:flex;align-items:center;font-size:${font * 0.72}px;line-height:1.12}
.bar{background:${theme.accent};border-radius:${3 * scale}px}
.baseline{background:${theme.muted}}
</style></head><body><div id="root" data-no-timeline data-scene-id="${escape(entry.sceneId)}" data-composition-id="${escape(entry.sceneId)}" data-start="0" data-duration="${duration}" data-width="${width}" data-height="${height}" data-fps="${fps}" data-caption-safe-bottom="${height * 0.8}">${title}${body}${result}${note}</div><script>(${frameRuntime.toString()})(${scriptJSON(config)});</script></body></html>`;
  // HyperFrames 0.8.181 samples at 20 Hz, capped at 300 samples. An exact-frame
  // deadline between samples otherwise falsely fails a correctly timed reveal.
  const sampleCount = Math.min(300, Math.max(2, Math.ceil(duration * 20) + 1));
  const sampleStep = duration / (sampleCount - 1);
  const sampledDeadline = Math.min(duration, Math.ceil((cues.result.frame / fps) / sampleStep) * sampleStep + 0.001);
  const motionSpec = { version: 1, duration, assertions: [
    { kind: 'appearsBy', selector: '#result', bySec: sampledDeadline },
    { kind: 'staysInFrame', selector: '#result' },
    { kind: 'staysInFrame', selector: '#title' },
    ...(entry.component === 'object-transfer' ? [{ kind: 'staysInFrame', selector: '#object' }, { kind: 'before', a: '#object', b: '#result' }] : []),
  ] };
  const diagnostics = [
    ...Object.entries(cues).map(([slot, cue]) => ({ code: 'COMPOSITION_CUE', sceneId: entry.sceneId, slot, ...cue })),
    { code: 'COMPOSITION_INTENTIONAL_HOLD', sceneId: entry.sceneId, fromFrame: cues.result.frame, throughFrame: frames - 1, selector: '#result' },
    { code: 'COMPOSITION_NOT_BEFORE', sceneId: entry.sceneId, frame: cues.result.frame, selector: '#result' },
    { code: 'COMPOSITION_ASPECT', aspect: portrait ? 'portrait' : square ? 'square' : 'landscape', captionSafeBottom: height * 0.8 },
  ];
  const sourceHash = createHash('sha256').update(canonical({ version: IMPLEMENTATION_VERSION, entry, cues, evidence, theme, frames, fps, width, height, html, motionSpec })).digest('hex');
  return { html, motionSpec, sourceHash, frames, width, height, fps, diagnostics };
}
