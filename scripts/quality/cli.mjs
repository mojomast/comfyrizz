#!/usr/bin/env node
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { validateBeatPlan } from './beat-contract.mjs';
import { lintShotPlan } from './beat-lint.mjs';
import { gateBeats } from './beat-verdicts.mjs';
import { reviewTake } from './temporal-review.mjs';
import { validateLibrary } from './asset-library.mjs';
import { checkLedger, matchPairs } from './state-ledger.mjs';
import { attachRefs } from './shot-refs.mjs';
import { tailReport } from './dialogue-tails.mjs';
import { allocate, cutsInsideSpeech } from './allocate.mjs';
import { captionMetrics } from './caption-metrics.mjs';
import { presentCaptions } from './caption-split.mjs';
import { validateCueSheet, checkCues } from './cue-sheet.mjs';
import { duckingPlan } from './ducking.mjs';
import { AXES, approved, buildReceipt } from './receipt.mjs';

export const CLI_SCHEMA = 'comfyrizz.quality-cli/v1';
export const PREVIEW_LIMIT = 80;

const COMMANDS = Object.freeze([
  'beats',
  'takes',
  'continuity',
  'edit',
  'captions',
  'sound',
  'receipt',
]);

const MAX_JSON_BYTES = 8 * 1024 * 1024;

const FILE_NAMES = Object.freeze({
  plan: ['sandwich-plan.json', 'beat-lint-fixture.json', 'beat-lint.json', 'plan.json'],
  beats: ['beats.json', 'beat-plan.json', 'beats-plan.json', 'beat-contract.json'],
  shots: ['shots.json', 'shot-plan.json', 'shot-list.json', 'ledger-shots.json'],
  script: ['script.json', 'script-lines.json', 'dialogue.json', 'lines.json'],
  verdicts: ['verdicts.json', 'beat-verdicts.json'],
  library: ['library.json', 'asset-library.json'],
  ledger: ['ledger.json', 'state-ledger.json'],
  voice: ['voice-manifest.json', 'voice.json', 'voice_manifest.json'],
  captions: ['captions.json', 'caption-cues.json'],
  cueSheet: ['cue-sheet.json', 'cues.json', 'cue_sheet.json'],
  takes: ['takes.json', 'take-reviews.json', 'temporal-review.json', 'leak-take.json'],
  listening: ['listening.json', 'listening-review.json'],
  technical: ['technical.json', 'verification.json', 'final-verification.json'],
  utterances: ['utterances.json', 'utterance-manifest.json'],
});

const USAGE = [
  'Usage: node scripts/quality/cli.mjs <command> <production-dir or json> [--json]',
  `Commands: ${COMMANDS.join('|')}`,
  'Exit 1 when a blocking finding or a not_reviewed review is found.',
].join('\n');

const ROLE_RE = /^(setup|establish|establishing|reveal|punchline|joke|payoff|button|closer|reaction|reaction_pause|reaction_beat|pause|action|action_hold|hold|b[_ -]?roll|broll|cutaway)$/i;

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function preview(value) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  if (text.length <= PREVIEW_LIMIT) return text;
  return `${text.slice(0, PREVIEW_LIMIT - 3)}...`;
}

function hash(value) {
  return typeof value === 'string' ? value : String(value ?? '');
}

function lowerName(entry) {
  return hash(entry?.name).toLowerCase();
}

function findNamed(entries, names) {
  for (const name of names) {
    const entry = entries.find((item) => lowerName(item) === name);
    if (entry && entry.data !== undefined) return entry;
  }
  return null;
}

function findData(entries, predicate) {
  return entries.find((entry) => entry.data !== undefined && predicate(entry.data, entry)) ?? null;
}

function pickRole(entries, role) {
  const named = findNamed(entries, FILE_NAMES[role] ?? []);
  if (named) return named;
  const detector = DETECTORS[role];
  return detector ? findData(entries, detector) : null;
}

function isShotish(value) {
  if (!isObject(value)) return false;
  return (
    ('id' in value || 'shot' in value) &&
    ('participants' in value ||
      'imagePrompt' in value ||
      'actionPrompt' in value ||
      'in' in value ||
      'startS' in value ||
      'characters' in value ||
      'artwork' in value ||
      'costume' in value)
  );
}

function isLibrary(value) {
  return (
    (isObject(value) && value.schema === 'comfyrizz.asset-library/v1') ||
    (isObject(value) &&
      Array.isArray(value.assets) &&
      value.assets.some((asset) => isObject(asset) && 'kind' in asset && 'sha256' in asset))
  );
}

function isCueSheet(value) {
  return (
    isObject(value) &&
    Array.isArray(value.cues) &&
    Array.isArray(value.pauses) &&
    isObject(value.shots)
  );
}

function isCaptions(value) {
  if (Array.isArray(value)) {
    return (
      value.length > 0 &&
      value.every(
        (cue) => isObject(cue) && typeof cue.text === 'string' && 'start' in cue && 'end' in cue,
      )
    );
  }
  return (
    isObject(value) &&
    Array.isArray(value.cues) &&
    !isCueSheet(value) &&
    value.cues.some((cue) => isObject(cue) && 'start' in cue && 'end' in cue)
  );
}

function isVoice(value) {
  return (
    isObject(value) &&
    Array.isArray(value.segments) &&
    value.segments.some(
      (segment) => isObject(segment) && ('trailingPaddingSamples' in segment || 'speed' in segment),
    )
  );
}

function isLedger(value) {
  return (
    (isObject(value) && value.schema === 'comfyrizz.state-ledger/v1') ||
    (isObject(value) &&
      Array.isArray(value.shots) &&
      value.shots.some(
        (shot) => isObject(shot) && ('characters' in shot || 'artwork' in shot || 'costume' in shot),
      ))
  );
}

function isShotsDoc(value) {
  if (Array.isArray(value)) return value.some(isShotish);
  return (
    isObject(value) &&
    Array.isArray(value.shots) &&
    !isCueSheet(value) &&
    !isLedger(value) &&
    value.shots.some(isShotish)
  );
}

function isBeatDoc(value) {
  if (Array.isArray(value)) return value.some((beat) => isObject(beat) && 'dialogueAnchor' in beat);
  return isObject(value) && Array.isArray(value.beats);
}

function isPlanCases(value) {
  return isObject(value) && isObject(value.cases);
}

function isScript(value) {
  if (Array.isArray(value)) {
    return (
      value.length > 0 &&
      value.every((line) => isObject(line) && typeof line.speaker === 'string' && typeof line.text === 'string')
    );
  }
  return (
    isObject(value) &&
    (Array.isArray(value.lines) || isObject(value.lines) || Array.isArray(value.script) || isObject(value.script))
  );
}

function isVerdicts(value) {
  if (Array.isArray(value)) {
    return value.some((verdict) => isObject(verdict) && 'beat' in verdict && 'status' in verdict);
  }
  return isObject(value) && Array.isArray(value.verdicts);
}

function isTakes(value) {
  return (
    (isObject(value) && isObject(value.take) && Array.isArray(value.observations)) ||
    (isObject(value) && Array.isArray(value.takes)) ||
    (Array.isArray(value) && value.some((item) => isObject(item) && ('take' in item || 'observations' in item)))
  );
}

function isListening(value) {
  return (
    isObject(value) &&
    typeof value.status === 'string' &&
    (value.reviewer !== undefined || value.method !== undefined)
  );
}

function isTechnical(value) {
  return (
    isObject(value) &&
    (value.status !== undefined || Array.isArray(value.failures) || Array.isArray(value.reviewedFiles))
  );
}

function isUtterances(value) {
  if (Array.isArray(value)) {
    return value.some(
      (item) =>
        isObject(item) &&
        'speaker' in item &&
        'text' in item &&
        ('startS' in item || 'startFrame' in item),
    );
  }
  return isObject(value) && Array.isArray(value.utterances);
}

const DETECTORS = Object.freeze({
  plan: isPlanCases,
  beats: isBeatDoc,
  shots: isShotsDoc,
  script: isScript,
  verdicts: isVerdicts,
  library: isLibrary,
  ledger: isLedger,
  voice: isVoice,
  captions: isCaptions,
  cueSheet: isCueSheet,
  takes: isTakes,
  listening: isListening,
  technical: isTechnical,
  utterances: isUtterances,
});

function readEntries(target, deps) {
  const fs = deps.fs ?? { readFileSync, readdirSync, statSync };
  const stat = fs.statSync(target);
  const entries = [];

  const readOne = (full, name) => {
    try {
      const info = fs.statSync(full);
      if (!info.isFile() || info.size > MAX_JSON_BYTES) return;
    } catch {
      return;
    }
    try {
      entries.push({ name, data: JSON.parse(fs.readFileSync(full, 'utf8')) });
    } catch {
      entries.push({ name, error: true });
    }
  };

  if (stat.isDirectory()) {
    const names = fs.readdirSync(target).slice().sort();
    for (const name of names) {
      if (!/\.json$/i.test(name)) continue;
      readOne(join(target, name), name);
    }
  } else {
    readOne(target, basename(target));
  }

  return expandEntries(entries);
}

const COMPOSITE_KEYS = Object.freeze({
  plan: ['plan', 'beatPlan', 'beat_plan'],
  beats: ['beats'],
  shots: ['shots'],
  script: ['script', 'lines', 'dialogue'],
  verdicts: ['verdicts'],
  library: ['library', 'assetLibrary', 'asset_library'],
  ledger: ['ledger', 'stateLedger', 'state_ledger'],
  voice: ['voice', 'voiceManifest', 'voice_manifest'],
  captions: ['captions'],
  cueSheet: ['cueSheet', 'cue_sheet', 'cues'],
  takes: ['takes', 'takeReviews', 'take_reviews'],
  listening: ['listening', 'listeningReview', 'listening_review'],
  technical: ['technical', 'verification'],
  utterances: ['utterances'],
});

function expandEntries(entries) {
  const expanded = [...entries];
  for (const entry of entries) {
    if (!isObject(entry.data)) continue;
    for (const [role, keys] of Object.entries(COMPOSITE_KEYS)) {
      const fileName = (FILE_NAMES[role] ?? [])[0];
      if (!fileName) continue;
      for (const key of keys) {
        if (entry.data[key] === undefined) continue;
        const value = entry.data[key];
        const fits =
          (role === 'shots' || role === 'beats' || role === 'utterances') && Array.isArray(value)
            ? true
            : role === 'captions' && (Array.isArray(value) || isObject(value))
              ? true
              : role === 'cueSheet' && isObject(value)
                ? true
                : isObject(value);
        if (fits) expanded.push({ name: fileName, data: value });
        break;
      }
    }
  }
  return expanded;
}

function arrayOfShots(value) {
  if (Array.isArray(value)) return value;
  if (isObject(value) && Array.isArray(value.shots) && !isCueSheet(value)) return value.shots;
  return null;
}

function scriptOf(value) {
  if (value === undefined || value === null) return null;
  if (Array.isArray(value)) return value;
  if (isObject(value)) {
    if (value.lines !== undefined) return value.lines;
    if (value.script !== undefined) return value.script;
  }
  return value;
}

function extractVerdicts(value) {
  if (value === undefined || value === null) return null;
  if (Array.isArray(value)) return value;
  if (isObject(value) && Array.isArray(value.verdicts)) return value.verdicts;
  if (isObject(value) && typeof value.beat === 'string') return [value];
  return [];
}

function beatIdFromPath(path) {
  const match = /\$\.beats\[(\d+)\]/.exec(String(path ?? ''));
  return match ? Number(match[1]) : null;
}

function normalizeCase(name, value) {
  const input = isObject(value) ? value : {};
  return {
    name,
    beats: Array.isArray(input.beats) ? input.beats : [],
    shots: arrayOfShots(input.shots) ?? [],
    script: scriptOf(input.script ?? input.lines),
    verdicts: extractVerdicts(input.verdicts),
    gate: input.gate === true,
  };
}

function normalizeCases(cases) {
  if (Array.isArray(cases)) {
    return cases.map((item, index) =>
      normalizeCase(
        isObject(item) && typeof (item.name ?? item.case) === 'string'
          ? item.name ?? item.case
          : `case-${index + 1}`,
        item,
      ),
    );
  }
  return Object.entries(cases).map(([name, value]) => normalizeCase(name, value));
}

function beatCases(entries) {
  const beatEntry = pickRole(entries, 'beats') ?? findData(entries, isBeatDoc);
  const beatData = beatEntry?.data;
  const beats = Array.isArray(beatData) ? beatData : beatData?.beats;
  if (!Array.isArray(beats)) {
    const planEntry = pickRole(entries, 'plan') ?? findData(entries, isPlanCases);
    if (planEntry?.data && isPlanCases(planEntry.data)) {
      return normalizeCases(planEntry.data.cases);
    }
    return [];
  }

  const shotsEntry = pickRole(entries, 'shots') ?? findData(entries, isShotsDoc);
  const ledgerEntry = pickRole(entries, 'ledger') ?? findData(entries, isLedger);
  const scriptEntry = pickRole(entries, 'script') ?? findData(entries, isScript);
  const verdictEntry = pickRole(entries, 'verdicts') ?? findData(entries, isVerdicts);

  return [
    normalizeCase(beatEntry?.name ?? 'beats', {
      beats,
      shots:
        arrayOfShots(shotsEntry?.data) ??
        arrayOfShots(beatData?.shots) ??
        arrayOfShots(ledgerEntry?.data) ??
        [],
      script: scriptOf(scriptEntry?.data ?? beatData?.script ?? beatData?.lines),
      verdicts: extractVerdicts(verdictEntry?.data ?? beatData?.verdicts),
    }),
  ];
}

function runBeats(entries) {
  const cases = beatCases(entries);
  const findings = [];
  const passes = { cases: cases.length, beats: 0, validationErrors: 0, lintFindings: 0, gated: false, gateBlocking: 0 };

  if (cases.length === 0) {
    findings.push({ code: 'BEATS_MISSING', message: 'No beats or beat plan JSON was found.' });
    return { findings, passes };
  }

  for (const item of cases) {
    passes.beats += item.beats.length;
    const validation = validateBeatPlan({ beats: item.beats });
    passes.validationErrors += validation.errors.length;
    for (const error of validation.errors) {
      const index = beatIdFromPath(error.path);
      findings.push({
        code: `BEAT_${error.code}`,
        beat: index === null ? null : item.beats[index]?.beat ?? index,
        path: error.path,
        message: error.message,
      });
    }

    let script = item.script;
    if (script === null || script === undefined) {
      script = item.beats
        .map((beat) => ({ speaker: beat?.speaker, text: beat?.dialogueAnchor }))
        .filter((line) => typeof line.speaker === 'string' && typeof line.text === 'string');
      passes.scriptNotProvided = true;
    }

    const lint = lintShotPlan(item.beats, item.shots, script);
    passes.lintFindings += lint.length;
    findings.push(...lint);

    const hasVerdicts = item.verdicts !== null || item.gate;
    if (hasVerdicts) {
      passes.gated = true;
      const gate = gateBeats(item.beats, item.verdicts ?? []);
      passes.gateBlocking += gate.blocking.length;
      findings.push(...gate.blocking);
    }
  }

  return { findings, passes };
}

function collectTakeItems(value) {
  if (value === undefined || value === null) return [];
  if (Array.isArray(value)) return value;
  if (isObject(value) && Array.isArray(value.takes)) return value.takes;
  if (isObject(value) && (isObject(value.take) || Array.isArray(value.observations))) return [value];
  return [];
}

function takeCases(entries) {
  const entry = pickRole(entries, 'takes') ?? findData(entries, isTakes);
  if (!entry) return [];
  return collectTakeItems(entry.data).filter(isObject);
}

function reviewTakeCase(item, index) {
  if (typeof item.status === 'string' && (Array.isArray(item.failures) || item.observations === undefined)) {
    return {
      id: hash(item.id ?? item.take?.id ?? `take-${index + 1}`),
      status: item.status,
      failures: Array.isArray(item.failures) ? item.failures : [],
      inspected: Array.isArray(item.inspection) ? item.inspection.length : 0,
    };
  }
  const take = isObject(item.take) ? item.take : item;
  const result = reviewTake(take, item.observations ?? []);
  return {
    id: hash(item.id ?? take.id ?? `take-${index + 1}`),
    status: result.status,
    failures: result.failures ?? [],
    inspected: Array.isArray(result.inspection) ? result.inspection.length : 0,
  };
}

function takeResults(entries) {
  return takeCases(entries).map(reviewTakeCase);
}

function runTakes(entries) {
  const results = takeResults(entries);
  const findings = [];
  const passes = { takes: results.map((item) => ({ id: item.id, status: item.status, failures: item.failures.length, inspected: item.inspected })) };

  if (results.length === 0) {
    findings.push({ code: 'TAKES_MISSING', message: 'No take observations or take reviews were found.' });
    return { findings, passes };
  }

  for (const result of results) {
    if (result.status === 'passed') continue;
    if (result.failures.length === 0) {
      findings.push({
        code: 'TAKE_NOT_REVIEWED',
        id: result.id,
        status: result.status,
        message: `Take ${result.id} is ${result.status}; a missing review is not a pass.`,
      });
      continue;
    }
    for (const failure of result.failures) {
      findings.push({
        code: failure.code ?? 'TAKE_FAILED',
        id: result.id,
        startClock: failure.startClock,
        endClock: failure.endClock,
        message: failure.message ?? `Take ${result.id} failed review.`,
      });
    }
  }

  return { findings, passes };
}

function continuityInputs(entries) {
  const libraryEntry = pickRole(entries, 'library') ?? findData(entries, isLibrary);
  const ledgerEntry = pickRole(entries, 'ledger') ?? findData(entries, isLedger);
  const shotsEntry = pickRole(entries, 'shots') ?? findData(entries, isShotsDoc);
  return { libraryEntry, ledgerEntry, shotsEntry };
}

function runContinuity(entries) {
  const { libraryEntry, ledgerEntry, shotsEntry } = continuityInputs(entries);
  const findings = [];
  const passes = { library: null, shots: 0, ledgerFindings: 0, refFindings: 0, pair: null };

  if (!libraryEntry) {
    findings.push({ code: 'LIBRARY_MISSING', message: 'No approved asset library JSON was found.' });
  } else {
    const validation = validateLibrary(libraryEntry.data);
    passes.library = {
      ok: validation.ok,
      assets: Array.isArray(libraryEntry.data?.assets) ? libraryEntry.data.assets.length : 0,
      errors: validation.errors.length,
    };
    for (const error of validation.errors) {
      findings.push({ code: `LIBRARY_${error.code}`, path: error.path, message: error.message });
    }
  }

  const shotsDoc = ledgerEntry?.data ?? shotsEntry?.data;
  const shots = arrayOfShots(shotsDoc);
  if (!shots) {
    findings.push({ code: 'SHOTS_MISSING', message: 'No ledger or shots JSON was found.' });
    return { findings, passes };
  }
  passes.shots = shots.length;

  if (libraryEntry) {
    try {
      const ledgerFindings = checkLedger(libraryEntry.data, shotsDoc, {
        fps: Number.isFinite(shotsDoc?.fps) ? shotsDoc.fps : 30,
      });
      passes.ledgerFindings = ledgerFindings.length;
      findings.push(...ledgerFindings);
    } catch (error) {
      findings.push({ code: 'CONTINUITY_ERROR', message: error.message });
    }

    try {
      const refs = attachRefs(shots, libraryEntry.data);
      passes.refFindings = refs.findings.length;
      findings.push(...refs.findings);
    } catch (error) {
      findings.push({ code: 'REF_ERROR', message: error.message });
    }

    try {
      const pair = matchPairs(shots, 'raccoon_portrait');
      passes.pair = {
        assetId: pair.assetId,
        opening: pair.opening?.id ?? null,
        payoff: pair.payoff?.id ?? null,
        sameAsset: pair.sameAsset,
        matches: pair.matches,
      };
    } catch (error) {
      findings.push({ code: 'PAIR_ERROR', message: error.message });
    }
  }

  return { findings, passes };
}

function utteranceList(entries) {
  const entry = pickRole(entries, 'utterances') ?? findData(entries, isUtterances);
  if (!entry) return null;
  const value = entry.data;
  if (Array.isArray(value)) return value;
  return Array.isArray(value?.utterances) ? value.utterances : null;
}

function allocationBeats(entries) {
  const entry = pickRole(entries, 'beats') ?? findData(entries, isBeatDoc);
  const value = entry?.data;
  const beats = Array.isArray(value) ? value : value?.beats;
  if (!Array.isArray(beats)) return null;
  return beats.some((beat) => isObject(beat) && ROLE_RE.test(hash(beat.role))) ? beats : null;
}

function runEdit(entries) {
  const voiceEntry = pickRole(entries, 'voice') ?? findData(entries, isVoice);
  const findings = [];
  const passes = { tails: null, cuts: 0, allocation: null };

  if (!voiceEntry) {
    findings.push({ code: 'VOICE_MANIFEST_MISSING', message: 'No voice manifest JSON was found.' });
  } else {
    try {
      const report = tailReport(voiceEntry.data);
      passes.tails = {
        totalTrailingS: report.totalTrailingS,
        shareOfFilmPct: report.shareOfFilmPct,
        segments: report.segments.length,
        flagged: report.flagged.length,
      };
      findings.push(...report.flagged);
    } catch (error) {
      findings.push({ code: 'EDIT_INPUT_INVALID', message: error.message });
    }
  }

  const utterances = utteranceList(entries);
  if (!utterances) return { findings, passes };

  const beats = allocationBeats(entries);
  let shots = arrayOfShots(pickRole(entries, 'shots')?.data);

  if (beats) {
    try {
      const allocated = allocate(utterances, beats, { targetS: 600, fps: 30 });
      passes.allocation = {
        shots: allocated.length,
        totalFrames: allocated.totalFrames ?? null,
        targetFrames: allocated.targetFrames ?? null,
        findings: Array.isArray(allocated.findings) ? allocated.findings.length : 0,
      };
      if (Array.isArray(allocated.findings)) findings.push(...allocated.findings);
      shots = allocated;
    } catch (error) {
      findings.push({ code: 'ALLOCATION_ERROR', message: error.message });
    }
  }

  if (Array.isArray(shots)) {
    try {
      const cuts = cutsInsideSpeech(shots, utterances);
      const unexplained = cuts.filter((cut) => cut.reasonRequired);
      passes.cuts = cuts.length;
      findings.push(...unexplained);
    } catch (error) {
      findings.push({ code: 'CUTS_ERROR', message: error.message });
    }
  }

  return { findings, passes };
}

function captionsInput(entries) {
  return pickRole(entries, 'captions') ?? findData(entries, isCaptions);
}

function cueList(value) {
  if (Array.isArray(value)) return value;
  return Array.isArray(value?.cues) ? value.cues : null;
}

function runCaptions(entries) {
  const entry = captionsInput(entries);
  const findings = [];
  const passes = { cues: 0, maxCps: 0, maxChars: 0, medianChars: 0, longestS: 0, overCps: 0, overLength: 0, needsEdit: 0 };

  const cues = cueList(entry?.data);
  if (!cues) {
    findings.push({ code: 'CAPTIONS_MISSING', message: 'No caption cues JSON was found.' });
    return { findings, passes };
  }

  const metrics = captionMetrics(cues);
  const presentation = presentCaptions(cues);
  passes.cues = metrics.count;
  passes.maxCps = metrics.maxCps;
  passes.maxChars = metrics.maxChars;
  passes.medianChars = metrics.medianChars;
  passes.longestS = metrics.longestS;
  passes.overCps = metrics.overCps.length;
  passes.overLength = metrics.overLength.length;
  passes.needsEdit = presentation.needsEdit.length;

  for (const item of metrics.overCps) {
    findings.push({
      code: 'CAPTION_OVER_CPS',
      cue: item.index + 1,
      speaker: item.speaker,
      message: `Cue ${item.index + 1} is ${item.cps.toFixed(2)} cps, over the 20 cps limit.`,
    });
  }
  for (const item of metrics.overLength) {
    findings.push({
      code: 'CAPTION_OVER_LENGTH',
      cue: item.index + 1,
      speaker: item.speaker,
      message: `Cue ${item.index + 1} has ${item.chars} characters, over 2 x 42.`,
    });
  }
  for (const item of presentation.needsEdit) {
    findings.push({
      code: 'CAPTION_NEEDS_EDIT',
      cue: item.index ?? item.sourceIndex ?? null,
      message: 'A caption still exceeds the reading-rate or line limit after splitting.',
    });
  }

  return { findings, passes };
}

function runSound(entries) {
  const entry = pickRole(entries, 'cueSheet') ?? findData(entries, isCueSheet);
  const findings = [];
  const passes = { cues: 0, pauses: 0, validationErrors: 0, cueFindings: 0, ducking: null };

  if (!entry) {
    findings.push({ code: 'CUE_SHEET_MISSING', message: 'No cue sheet JSON was found.' });
    return { findings, passes };
  }

  const sheet = entry.data;
  const validation = validateCueSheet(sheet);
  passes.validationErrors = validation.errors.length;
  findings.push(...validation.errors);
  passes.cues = Array.isArray(sheet?.cues) ? sheet.cues.length : 0;
  passes.pauses = Array.isArray(sheet?.pauses) ? sheet.pauses.length : 0;

  const shots = isObject(sheet?.shots) ? sheet.shots : null;
  const cueFindings = checkCues(sheet, shots);
  passes.cueFindings = cueFindings.length;
  findings.push(...cueFindings);

  const captions = cueList(captionsInput(entries)?.data) ?? [];
  const utterances = captions.map((cue) => ({ startS: cue.start, endS: cue.end }));
  const filmS = Number.isFinite(sheet?.filmS) ? sheet.filmS : undefined;
  const plan = duckingPlan(utterances, Array.isArray(sheet?.pauses) ? sheet.pauses : [], {
    fps: Number.isFinite(sheet?.fps) ? sheet.fps : 30,
    filmS,
  });
  passes.ducking = { points: plan.points.length, rests: plan.rests.length, filmS: plan.options.filmS };

  return { findings, passes };
}

function receiptBeats(entries) {
  const cases = beatCases(entries);
  if (cases.length === 0) return {};
  const chosen = cases.find((item) => item.name === 'clean') ?? cases[0];
  if (chosen.verdicts !== null) {
    return { beats: { beats: chosen.beats, verdicts: chosen.verdicts } };
  }
  return { beats: chosen.beats };
}

function runReceipt(entries) {
  const inputs = {};
  const technicalEntry = pickRole(entries, 'technical') ?? findData(entries, isTechnical);
  if (technicalEntry) inputs.technical = technicalEntry.data;

  Object.assign(inputs, receiptBeats(entries));

  const takes = takeResults(entries);
  if (takes.length > 0) inputs.takes = takes;

  const continuitySources = continuityInputs(entries);
  const continuityReady = Boolean(
    continuitySources.libraryEntry &&
      arrayOfShots(continuitySources.ledgerEntry?.data ?? continuitySources.shotsEntry?.data),
  );
  if (continuityReady) {
    inputs.continuity = { findings: runContinuity(entries).findings };
  }

  const cues = cueList(captionsInput(entries)?.data);
  if (cues) inputs.captions = { cues };

  const listeningEntry = pickRole(entries, 'listening') ?? findData(entries, isListening);
  if (listeningEntry) inputs.listening = listeningEntry.data;

  const receipt = buildReceipt(inputs);
  const isApproved = approved(receipt);
  const findings = [];

  for (const failure of receipt.failures) {
    findings.push({
      code: failure.code ?? 'RECEIPT_FAILURE',
      axis: failure.axis,
      message: failure.message ?? 'Receipt validation failed.',
      blocking: !isApproved,
    });
  }

  const excused = new Set(
    (Array.isArray(receipt.acceptedExceptions) ? receipt.acceptedExceptions : [])
      .filter((item) => isObject(item) && typeof item.reason === 'string' && item.reason.trim())
      .map((item) => item.axis),
  );
  for (const axis of AXES) {
    if (receipt.states[axis] === 'passed' || excused.has(axis)) continue;
    findings.push({
      code: 'AXIS_NOT_PASSED',
      axis,
      status: receipt.states[axis],
      message: `${axis} is ${receipt.states[axis]}; a missing review is not a pass.`,
    });
  }

  if (!isApproved && findings.length === 0) {
    findings.push({ code: 'RECEIPT_NOT_APPROVED', message: 'The quality receipt is not approved.' });
  }

  return {
    findings,
    passes: {
      receipt: {
        approved: isApproved,
        states: receipt.states,
        failures: receipt.failures.length,
        acceptedExceptions: receipt.acceptedExceptions.length,
        selectedTakes: receipt.selectedTakes.length,
      },
    },
  };
}

const RUNNERS = Object.freeze({
  beats: runBeats,
  takes: runTakes,
  continuity: runContinuity,
  edit: runEdit,
  captions: runCaptions,
  sound: runSound,
  receipt: runReceipt,
});

function normalizeFinding(finding) {
  const output = {};
  if (isObject(finding)) {
    for (const key of ['code', 'beat', 'shot', 'cue', 'id', 'prop', 'axis', 'status', 'path', 'startClock', 'endClock']) {
      if (finding[key] !== undefined && finding[key] !== null) {
        output[key] = typeof finding[key] === 'number' ? finding[key] : preview(finding[key]);
      }
    }
    output.code = preview(finding.code ?? finding.type ?? 'FINDING');
    output.message = preview(finding.message ?? finding.reason ?? output.code);
    output.blocking = finding.blocking !== false;
  } else {
    output.code = 'FINDING';
    output.message = preview(finding);
    output.blocking = true;
  }
  return output;
}

function normalizeFindings(findings) {
  const seen = new Set();
  const output = [];
  for (const finding of Array.isArray(findings) ? findings : []) {
    const normalized = normalizeFinding(finding);
    const key = [
      normalized.code,
      normalized.beat ?? '',
      normalized.shot ?? '',
      normalized.cue ?? '',
      normalized.id ?? '',
      normalized.axis ?? '',
      normalized.message,
    ].join('\u0000');
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(normalized);
  }
  return output;
}

function buildReport(command, target, result) {
  const findings = normalizeFindings(result.findings);
  const blocking = findings.filter((finding) => finding.blocking).length;
  return {
    schema: CLI_SCHEMA,
    command,
    target: preview(basename(target)),
    ok: blocking === 0,
    exitCode: blocking === 0 ? 0 : 1,
    summary: { findings: findings.length, blocking },
    findings,
    passes: result.passes ?? {},
  };
}

export function formatHuman(report) {
  const lines = [
    `${report.command}: ${report.ok ? 'ok' : 'blocked'} (${report.summary.findings} finding(s), ${report.summary.blocking} blocking)`,
  ];
  for (const finding of report.findings) {
    const where = [finding.beat, finding.shot, finding.cue, finding.id]
      .filter((value) => value !== undefined && value !== null && value !== '')
      .slice(0, 2)
      .join(' / ');
    lines.push(`- [${finding.code}]${where ? ` ${where}` : ''}: ${finding.message}`);
  }
  return `${lines.join('\n')}\n`;
}

export function parseArgs(argv) {
  let json = false;
  let help = false;
  const positional = [];

  for (const arg of argv) {
    if (arg === '--json') {
      json = true;
    } else if (arg === '--help' || arg === '-h') {
      help = true;
    } else if (arg.startsWith('-')) {
      return { error: `Unknown option ${preview(arg)}` };
    } else {
      positional.push(arg);
    }
  }

  return { json, help, positional };
}

export function runCli(argv, deps = {}) {
  const parsed = parseArgs(argv);
  if (parsed.error) {
    return { exitCode: 2, report: null, stdout: '', stderr: `${parsed.error}\n${USAGE}\n` };
  }
  if (parsed.help) {
    return { exitCode: 0, report: null, stdout: `${USAGE}\n`, stderr: '' };
  }

  const [command, target, ...extra] = parsed.positional;
  const fail = (message) => ({
    exitCode: 2,
    report: parsed.json
      ? {
          schema: CLI_SCHEMA,
          command: command ?? null,
          target: target ? preview(basename(target)) : null,
          ok: false,
          exitCode: 2,
          summary: { findings: 1, blocking: 1 },
          findings: [{ code: 'CLI_USAGE', message: preview(message), blocking: true }],
          passes: {},
        }
      : null,
    stdout: parsed.json
      ? `${JSON.stringify(
          {
            schema: CLI_SCHEMA,
            command: command ?? null,
            target: target ? preview(basename(target)) : null,
            ok: false,
            exitCode: 2,
            summary: { findings: 1, blocking: 1 },
            findings: [{ code: 'CLI_USAGE', message: preview(message), blocking: true }],
            passes: {},
          },
          null,
          2,
        )}\n`
      : '',
    stderr: parsed.json ? '' : `${message}\n${USAGE}\n`,
  });

  if (!command || !target || extra.length > 0) return fail('A command and one production path are required.');
  if (!COMMANDS.includes(command)) return fail(`Unknown command ${preview(command)}.`);

  let entries;
  try {
    entries = readEntries(target, deps);
  } catch {
    return fail(`Could not read the production path ${preview(basename(target))}.`);
  }

  let result;
  try {
    result = RUNNERS[command](entries, deps);
  } catch (error) {
    result = {
      findings: [{ code: 'CLI_ERROR', message: error.message }],
      passes: {},
    };
  }

  const report = buildReport(command, target, result);
  return {
    exitCode: report.exitCode,
    report,
    stdout: parsed.json ? `${JSON.stringify(report, null, 2)}\n` : formatHuman(report),
    stderr: '',
  };
}

const isMain =
  Boolean(process.argv[1]) &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url;

if (isMain) {
  const result = runCli(process.argv.slice(2));
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  process.exitCode = result.exitCode;
}
