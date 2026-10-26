#!/usr/bin/env node
// CPU-only structural check of the production package. It validates planning
// data (frame grid, timing beats, budget record) and never starts generation.
// Usage: node tools/validate-package.mjs [--markdown]
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const PRODUCTION_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
export const MODEL_PATHS = Object.freeze(['flux3-still', 'fasth3-omni', 'ltx25-fallback']);
export const FALLBACK_PATHS = Object.freeze(['ltx25-fallback', 'remotion-deterministic']);
export const RISK_TIERS = Object.freeze(['pilot', 'batch']);
export const PILOTS = Object.freeze(['P1', 'P2', 'P3']);
export const SHOT_RANGE = Object.freeze([24, 30]);

/** H3 temporal lattice: 17n+5 frames at 24fps. */
export const onH3Grid = frames => Number.isInteger(frames) && frames >= 22 && (frames - 5) % 17 === 0;

export function loadJson(name, dir = PRODUCTION_DIR) {
  return JSON.parse(readFileSync(join(dir, name), 'utf8'));
}

export function validatePackage({ production, skeleton }) {
  const errors = [];
  const err = (code, message) => errors.push({ code, message });
  const fps = production.fps;
  const total = production.targetSeconds * fps;

  const budget = production.budget ?? {};
  const envelopes = budget.envelopes ?? {};
  const sum = Object.values(envelopes).reduce((a, b) => a + b, 0);
  if (sum !== budget.approvedTotal) err('BUDGET_SUM', `envelopes sum to ${sum}, approvedTotal is ${budget.approvedTotal}`);
  if (JSON.stringify(envelopes) !== JSON.stringify({ setup: 2, pilots: 3, main: 10, reserve: 5 })) err('BUDGET_ENVELOPES', 'envelopes must be setup 2 / pilots 3 / main 10 / reserve 5');
  if (budget.status !== 'APPROVED') err('BUDGET_STATUS', 'budget status must record the APPROVED envelope');
  if (budget.retryPolicy !== 'no-unattended-retry-loops') err('RETRY_POLICY', 'retry policy must forbid unattended retry loops');

  const beats = production.timingBeats ?? [];
  const shots = skeleton.rows ?? [];
  if (skeleton.fps !== fps) err('FPS', `skeleton fps ${skeleton.fps} differs from production fps ${fps}`);
  if (shots.length < SHOT_RANGE[0] || shots.length > SHOT_RANGE[1]) err('SHOT_COUNT', `${shots.length} shots outside ${SHOT_RANGE.join('-')}`);
  const edit = shots.reduce((a, s) => a + (s.editFrames ?? 0), 0);
  if (edit !== total || skeleton.totalEditFrames !== total) err('TOTAL_FRAMES', `edit frames total ${edit}, expected ${total}`);

  const ids = new Set();
  for (const s of shots) {
    if (ids.has(s.id)) err('DUPLICATE_SHOT', `${s.id} repeated`);
    ids.add(s.id);
    if (!Number.isInteger(s.editFrames) || s.editFrames <= 0) err('EDIT_FRAMES', `${s.id} needs positive integer editFrames`);
    if (!MODEL_PATHS.includes(s.modelPath)) err('MODEL_PATH', `${s.id} modelPath ${s.modelPath}`);
    if (s.fallbackPath !== null && !FALLBACK_PATHS.includes(s.fallbackPath)) err('FALLBACK_PATH', `${s.id} fallbackPath ${s.fallbackPath}`);
    if (!RISK_TIERS.includes(s.riskTier)) err('RISK_TIER', `${s.id} riskTier ${s.riskTier}`);
    if ((s.riskTier === 'pilot') !== (s.pilot !== null)) err('PILOT_TAG', `${s.id} pilot id must be set exactly for pilot tier`);
    if (s.pilot !== null && !PILOTS.includes(s.pilot)) err('PILOT_ID', `${s.id} pilot ${s.pilot}`);
    if (s.modelPath === 'flux3-still') {
      if (s.generatedFrames !== null) err('STILL_FRAMES', `${s.id} is a still; generatedFrames must be null`);
    } else if (!onH3Grid(s.generatedFrames)) {
      err('GRID', `${s.id} generatedFrames ${s.generatedFrames} is not 17n+5`);
    } else if (s.generatedFrames < s.editFrames) {
      err('SHORT_GENERATION', `${s.id} generates ${s.generatedFrames} frames for ${s.editFrames} edited`);
    }
    if (s.measuredFrames !== null && !Number.isInteger(s.measuredFrames)) err('MEASURED', `${s.id} measuredFrames must be an integer or null`);
    for (const key of ['dominantAction', 'contactResult']) if (!String(s[key] ?? '').trim()) err('MISSING_FIELD', `${s.id} ${key}`);
  }
  for (const pilot of PILOTS) if (shots.filter(s => s.pilot === pilot).length !== 1) err('PILOT_COVERAGE', `${pilot} must tag exactly one shot`);

  let cursor = 0;
  for (const beat of beats) {
    const from = beat.fromSeconds * fps;
    const to = beat.toSeconds * fps;
    if (from !== cursor) err('BEAT_GAP', `${beat.id} starts at frame ${from}, expected ${cursor}`);
    const frames = shots.filter(s => s.beat === beat.id).reduce((a, s) => a + s.editFrames, 0);
    if (frames !== to - from) err('BEAT_FRAMES', `${beat.id} has ${frames} frames, window is ${to - from}`);
    cursor = to;
  }
  if (cursor !== total) err('BEAT_TOTAL', `beats end at frame ${cursor}, expected ${total}`);
  for (const s of shots) if (!beats.some(b => b.id === s.beat)) err('UNKNOWN_BEAT', `${s.id} beat ${s.beat}`);
  return { ok: errors.length === 0, shots: shots.length, editFrames: edit, errors };
}

const cell = text => String(text).replace(/\|/g, '/');

export function shotListMarkdown({ production, skeleton }) {
  const fps = production.fps;
  const lines = [
    '# Shot list skeleton',
    '',
    'Generated from `shots.skeleton.json` by `node tools/validate-package.mjs --markdown`.',
    'Edit the JSON, then regenerate; `node --test tools/package.test.mjs` fails when this file is stale.',
    '',
    `Edited length is ${skeleton.totalEditFrames} frames at ${fps}fps (${production.targetSeconds}s). `
      + '`Gen fr` is the generated length on the H3 17n+5 grid (22, 39, 56, 73, 90, 107, 124, 141, 158, ...); '
      + 'for example 124 frames is 5.1667s, not 5s. `-` means a still animated deterministically in Remotion/FFmpeg. '
      + 'The `Measured fr` column is filled from decoded takes; edit from measured frames.',
    '',
    '| ID | Beat | Edit fr | Gen fr | Measured fr | Dominant action | Contact / result | Risk tier | Model path | Fallback | Flags |',
    '|---|---|---:|---:|---:|---|---|---|---|---|---|',
  ];
  for (const s of skeleton.rows) {
    lines.push(`| ${s.id} | ${s.beat} | ${s.editFrames} (${(s.editFrames / fps).toFixed(2)}s) | ${s.generatedFrames ?? '-'}`
      + ` | ${s.measuredFrames ?? ''} | ${cell(s.dominantAction)} | ${cell(s.contactResult)}`
      + ` | ${s.riskTier}${s.pilot ? ` ${s.pilot}` : ''} | ${s.modelPath} | ${s.fallbackPath ?? ''} | ${s.highRiskFlags.join(', ')} |`);
  }
  lines.push('');
  return lines.join('\n');
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const input = { production: loadJson('production.json'), skeleton: loadJson('shots.skeleton.json') };
  if (process.argv.includes('--markdown')) process.stdout.write(shotListMarkdown(input));
  else {
    const result = validatePackage(input);
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    process.exitCode = result.ok ? 0 : 1;
  }
}
