#!/usr/bin/env node
// Q11 - Dialogue-led shot allocation.
//
// Source: docs/research/MOCKUMENTARY_QUALITY_REVIEW_20261020.md section 3
// ("Replace the fixed shot grid with dialogue-led editing") and section 7.
//
// Shots are half-open frame ranges [in, out). Dialogue frames always come from
// the measured utterance, never from a fixed 300-frame slot. The remaining
// time is carried by explicitly reasoned reaction/action holds. Speech is never
// retimed or dropped; only holds are stretched or shrunk to reach targetFrames.
//
// Utterance input:
//   { id, speaker, text, timing, startS|startFrame, endS|endFrame,
//     durationS|durationFrames }
// Beat input:
//   { id, role: 'setup'|'reveal'|'reaction'|'payoff'|'action',
//     utterance|utteranceId|utterances, after, holdS|holdFrames,
//     startS|startFrame, endS|endFrame, reason|note, cutReason }
//
// Pure module: no I/O, no clock, no network, no side effects at import time.

const DIALOGUE_ROLES = new Set(['setup', 'reveal', 'payoff']);
const HOLD_ROLES = new Set(['reaction', 'action']);

export const CUT_REASONS = Object.freeze(['b-roll', 'reaction']);

export const FINDING_CODES = Object.freeze({
  CUT_INSIDE_SPEECH: 'CUT_INSIDE_SPEECH',
  OVERLAP: 'OVERLAP',
  TARGET_TOO_SHORT: 'TARGET_TOO_SHORT',
  BEAT_UNRESOLVED: 'BEAT_UNRESOLVED',
});

const DEFAULT_TARGET_S = 600;
const DEFAULT_FPS = 30;
const DEFAULT_REACTION_S = 1.5;
const DEFAULT_ACTION_S = 2;

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function round(value, digits = 3) {
  const factor = 10 ** digits;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

function firstNumber(...values) {
  for (const value of values) {
    if (isFiniteNumber(value)) return value;
  }
  return undefined;
}

function secondsToFrames(seconds, fps) {
  return Math.round(seconds * fps);
}

function normalizeCutReason(value) {
  if (value == null) return null;
  const raw = typeof value === 'object'
    ? value.reason ?? value.type ?? value.kind ?? null
    : value;
  if (typeof raw !== 'string') return null;
  const text = raw.trim().toLowerCase();
  if (text.length === 0) return null;
  if (/b[\s_-]?roll/.test(text)) return 'b-roll';
  if (/reaction/.test(text)) return 'reaction';
  return null;
}

function reasonFromRole(shot) {
  const role = shot?.role ?? shot?.kind ?? shot?.type;
  if (typeof role !== 'string') return null;
  if (/reaction/i.test(role)) return 'reaction';
  if (/b[\s_-]?roll/i.test(role)) return 'b-roll';
  return null;
}

function reasonFromShot(shot) {
  if (!shot || typeof shot !== 'object') return null;
  const cut = shot.cut && typeof shot.cut === 'object' ? shot.cut : null;
  return normalizeCutReason(
    shot.cutReason
      ?? shot.cut_reason
      ?? shot.reason
      ?? shot.cutReasonType
      ?? (cut ? cut.reason ?? cut.type : null),
  ) ?? reasonFromRole(shot);
}

function reasonIntoShot(shot) {
  if (!shot || typeof shot !== 'object') return null;
  const cutIn = shot.cutIn && typeof shot.cutIn === 'object' ? shot.cutIn : null;
  return normalizeCutReason(
    shot.cutInReason
      ?? shot.inReason
      ?? (cutIn ? cutIn.reason ?? cutIn.type : null),
  ) ?? reasonFromRole(shot);
}

/** Normalize a role name; returns null for an unknown role. */
export function normalizeRole(value) {
  if (typeof value !== 'string') return null;
  const role = value.trim().toLowerCase().replace(/[\s-]+/g, '_');
  if (['setup', 'establish', 'establishing'].includes(role)) return 'setup';
  if (['reveal', 'punchline', 'joke'].includes(role)) return 'reveal';
  if (['payoff', 'button', 'closer'].includes(role)) return 'payoff';
  if (['reaction', 'reaction_pause', 'reaction_beat', 'pause'].includes(role)) return 'reaction';
  if (['action', 'action_hold', 'hold', 'b_roll', 'broll', 'cutaway'].includes(role)) return 'action';
  return null;
}

function frameRangeOf(value, fps) {
  if (!value || typeof value !== 'object') return null;
  const inFrame = firstNumber(value.in, value.inFrame, value.startFrame);
  const outFrame = firstNumber(value.out, value.outFrame, value.endFrame);
  if (inFrame !== undefined || outFrame !== undefined) {
    return { inFrame: inFrame ?? null, outFrame: outFrame ?? null };
  }
  const startS = firstNumber(value.startS);
  const endS = firstNumber(value.endS);
  if (startS !== undefined || endS !== undefined) {
    return {
      inFrame: startS === undefined ? null : secondsToFrames(startS, fps),
      outFrame: endS === undefined ? null : secondsToFrames(endS, fps),
    };
  }
  const start = firstNumber(value.start);
  const end = firstNumber(value.end);
  if (start !== undefined || end !== undefined) {
    return {
      inFrame: start === undefined ? null : secondsToFrames(start, fps),
      outFrame: end === undefined ? null : secondsToFrames(end, fps),
    };
  }
  return { inFrame: null, outFrame: null };
}

function normalizeUtterances(utterances, fps) {
  if (!Array.isArray(utterances)) {
    throw new TypeError('utterances must be an array');
  }
  const seen = new Set();
  const normalized = utterances.map((raw, index) => {
    if (!raw || typeof raw !== 'object') {
      throw new TypeError(`utterance ${index + 1} must be an object`);
    }
    const id = String(raw.id ?? raw.utteranceId ?? `u${index + 1}`);
    if (seen.has(id)) throw new RangeError(`duplicate utterance id "${id}"`);
    seen.add(id);

    const durationS = firstNumber(raw.durationS, raw.seconds, raw.duration);
    const durationFrames = firstNumber(
      raw.durationFrames,
      durationS === undefined ? undefined : secondsToFrames(durationS, fps),
    );
    const range = frameRangeOf(raw, fps);
    let startFrame = range.inFrame;
    let endFrame = range.outFrame;

    if (startFrame == null && endFrame != null && durationFrames != null) {
      startFrame = endFrame - durationFrames;
    }
    if (endFrame == null && startFrame != null && durationFrames != null) {
      endFrame = startFrame + durationFrames;
    }

    return {
      id,
      speaker: raw.speaker ?? null,
      text: typeof raw.text === 'string' ? raw.text : '',
      timing: raw.timing === 'estimated' ? 'estimated' : 'measured',
      startFrame,
      endFrame,
      durationFrames,
      explicitStart: startFrame != null,
      source: raw,
    };
  });

  let cursor = 0;
  for (const utterance of normalized) {
    if (utterance.startFrame == null) {
      utterance.startFrame = cursor;
      utterance.endFrame = utterance.startFrame
        + (utterance.durationFrames ?? Math.max(1, secondsToFrames(1, fps)));
    } else if (utterance.endFrame == null) {
      utterance.endFrame = utterance.startFrame
        + (utterance.durationFrames ?? Math.max(1, secondsToFrames(1, fps)));
    }
    utterance.startFrame = Math.max(0, Math.round(utterance.startFrame));
    utterance.endFrame = Math.round(utterance.endFrame);
    if (utterance.endFrame <= utterance.startFrame) {
      throw new RangeError(`utterance "${utterance.id}" must end after it starts`);
    }
    utterance.durationFrames = utterance.endFrame - utterance.startFrame;
    utterance.startS = round(utterance.startFrame / fps, 3);
    utterance.endS = round(utterance.endFrame / fps, 3);
    cursor = Math.max(cursor, utterance.endFrame);
  }

  return normalized;
}

function resolveUtteranceRefs(beat, utterances) {
  const raw = beat.utterances
    ?? beat.utteranceIds
    ?? beat.utterance
    ?? beat.utteranceId
    ?? beat.line
    ?? beat.dialogueAnchor;
  if (raw == null) return [];
  const list = Array.isArray(raw) ? raw : [raw];
  const found = [];
  for (const candidate of list) {
    const ref = candidate && typeof candidate === 'object'
      ? candidate.id ?? candidate.utteranceId ?? candidate.text
      : candidate;
    if (ref == null) continue;
    const key = String(ref);
    let utterance = utterances.find((item) => item.id === key);
    if (!utterance) {
      const lower = key.toLowerCase();
      utterance = utterances.find((item) => item.text.toLowerCase().includes(lower));
    }
    if (utterance && !found.some((item) => item.id === utterance.id)) {
      found.push(utterance);
    }
  }
  return found;
}

function beatExplicitRange(beat, fps) {
  return frameRangeOf(beat, fps);
}

function holdFramesOf(beat, role, fps) {
  const explicit = firstNumber(beat.holdFrames, beat.frames);
  if (explicit !== undefined) return Math.max(0, Math.round(explicit));
  const seconds = firstNumber(
    beat.holdS,
    beat.durationS,
    beat.seconds,
    beat.duration,
    beat.pauseS,
  );
  if (seconds !== undefined) return Math.max(0, secondsToFrames(seconds, fps));
  return secondsToFrames(role === 'reaction' ? DEFAULT_REACTION_S : DEFAULT_ACTION_S, fps);
}

function holdReason(beat, role) {
  const reason = beat.reason ?? beat.note ?? beat.label ?? beat.title;
  if (typeof reason === 'string' && reason.trim().length > 0) return reason.trim();
  return role === 'reaction' ? 'reaction pause' : 'action hold';
}

function buildBeatItems(utterances, beats, fps) {
  if (!Array.isArray(beats)) throw new TypeError('beats must be an array');
  const items = [];
  const beatItems = new Map();

  beats.forEach((beat, order) => {
    if (!beat || typeof beat !== 'object') {
      throw new TypeError(`beat ${order + 1} must be an object`);
    }
    const beatId = String(beat.id ?? beat.beat ?? `beat-${order + 1}`);
    const role = normalizeRole(beat.role ?? beat.type ?? beat.kind);
    const refs = resolveUtteranceRefs(beat, utterances);
    const range = beatExplicitRange(beat, fps);

    if (role == null) {
      items.push({
        kind: 'hold',
        role: 'action',
        beatId,
        beat,
        order,
        in: range.inFrame ?? (items.length ? items[items.length - 1].out : 0),
        out: range.outFrame,
        reason: holdReason(beat, 'action'),
        flexible: beat.flexible !== false,
        cutReason: normalizeCutReason(beat.cutReason) ?? 'action',
        refs: [],
        timing: 'estimated',
      });
      beatItems.set(beatId, items[items.length - 1]);
      return;
    }

    if (DIALOGUE_ROLES.has(role) && refs.length > 0) {
      const first = refs.reduce((min, item) => (item.startFrame < min.startFrame ? item : min), refs[0]);
      const last = refs.reduce((max, item) => (item.endFrame > max.endFrame ? item : max), refs[0]);
      const inFrame = range.inFrame ?? first.startFrame;
      const outFrame = range.outFrame ?? last.endFrame;
      items.push({
        kind: 'dialogue',
        role,
        beatId,
        beat,
        order,
        in: inFrame,
        out: Math.max(inFrame + 1, outFrame),
        reason: typeof beat.reason === 'string' ? beat.reason : null,
        flexible: false,
        cutReason: normalizeCutReason(beat.cutReason)
          ?? (role === 'reveal' ? 'reveal' : role === 'payoff' ? 'payoff' : null),
        refs,
        timing: refs.every((item) => item.timing === 'measured') ? 'measured' : 'estimated',
      });
      beatItems.set(beatId, items[items.length - 1]);
      return;
    }

    if (HOLD_ROLES.has(role) || range.inFrame != null || range.outFrame != null) {
      const holdRole = HOLD_ROLES.has(role) ? role : 'action';
      const declared = holdFramesOf(beat, holdRole, fps);
      let inFrame = range.inFrame;
      let outFrame = range.outFrame;
      const afterRaw = beat.after ?? beat.afterUtterance ?? beat.afterBeat ?? beat.afterId;
      let anchorFrame = null;

      if (afterRaw != null) {
        const afterKey = String(afterRaw);
        const afterUtterance = utterances.find((item) => item.id === afterKey);
        if (afterUtterance) {
          anchorFrame = afterUtterance.endFrame;
        } else if (beatItems.has(afterKey)) {
          anchorFrame = beatItems.get(afterKey).out;
        }
      }
      if (anchorFrame == null && refs.length > 0) {
        anchorFrame = Math.max(...refs.map((item) => item.endFrame));
      }
      if (anchorFrame == null && items.length > 0) {
        anchorFrame = items[items.length - 1].out;
      }
      if (inFrame == null) inFrame = anchorFrame ?? 0;
      if (outFrame == null) outFrame = inFrame + declared;
      if (outFrame <= inFrame) outFrame = inFrame + 1;

      const item = {
        kind: 'hold',
        role: holdRole,
        beatId,
        beat,
        order,
        in: inFrame,
        out: outFrame,
        reason: holdReason(beat, holdRole),
        flexible: beat.flexible !== false,
        cutReason: normalizeCutReason(beat.cutReason)
          ?? (holdRole === 'reaction' ? 'reaction' : 'action'),
        refs: [],
        timing: 'estimated',
        requestedFrames: outFrame - inFrame,
      };
      items.push(item);
      beatItems.set(beatId, item);
      return;
    }

    items.push({
      kind: 'hold',
      role: 'action',
      beatId,
      beat,
      order,
      in: range.inFrame ?? (items.length ? items[items.length - 1].out : 0),
      out: null,
      reason: holdReason(beat, 'action'),
      flexible: beat.flexible !== false,
      cutReason: 'action',
      refs: [],
      timing: 'estimated',
      unresolved: true,
    });
    beatItems.set(beatId, items[items.length - 1]);
  });

  return { items, beatItems };
}

function ensureAllUtterances(utterances, items) {
  const used = new Set();
  for (const item of items) {
    if (item.kind !== 'dialogue') continue;
    for (const utterance of item.refs) used.add(utterance.id);
  }

  for (const utterance of utterances) {
    if (used.has(utterance.id)) continue;
    const container = items.find(
      (item) => item.in <= utterance.startFrame && utterance.endFrame <= item.out,
    );
    if (container && container.kind === 'dialogue') {
      container.refs.push(utterance);
      used.add(utterance.id);
      continue;
    }
    const item = {
      kind: 'dialogue',
      role: 'setup',
      beatId: null,
      beat: null,
      order: Number.MAX_SAFE_INTEGER - items.length,
      in: utterance.startFrame,
      out: utterance.endFrame,
      reason: null,
      flexible: false,
      cutReason: null,
      refs: [utterance],
      timing: utterance.timing,
      synthetic: true,
    };
    items.push(item);
    used.add(utterance.id);
  }

  return used;
}

function gapReason(previous, next) {
  const role = previous?.role;
  if (role === 'reveal') return 'reaction pause';
  if (role === 'payoff') return 'payoff hold';
  if (role === 'setup') return 'setup hold';
  if (next?.kind === 'dialogue') return 'beat transition';
  return 'transition hold';
}

function makeShot(item, fps, id) {
  const refs = item.refs ?? [];
  const shot = {
    id,
    kind: item.kind,
    role: item.role,
    beat: item.beatId ?? null,
    scene: item.beat?.scene ?? null,
    in: Math.round(item.in),
    out: Math.round(item.out),
    inFrame: Math.round(item.in),
    outFrame: Math.round(item.out),
    durationFrames: Math.round(item.out) - Math.round(item.in),
    startS: round(item.in / fps, 3),
    endS: round(item.out / fps, 3),
    utteranceIds: refs.map((utterance) => utterance.id),
    utterances: refs.map((utterance) => utterance.id),
    dialogue: refs.map((utterance) => ({
      id: utterance.id,
      speaker: utterance.speaker,
      text: utterance.text,
      timing: utterance.timing,
      startFrame: utterance.startFrame,
      endFrame: utterance.endFrame,
    })),
    speaker: refs.length > 0 ? refs[0].speaker ?? null : null,
    reason: item.reason ?? null,
    cutReason: item.cutReason ?? null,
    flexible: item.flexible === true,
    requestedFrames: item.requestedFrames ?? null,
    adjustmentFrames: 0,
    timing: item.timing ?? (item.kind === 'dialogue' ? 'measured' : 'estimated'),
    synthetic: item.synthetic === true,
  };
  return shot;
}

function updateShot(shot, fps) {
  shot.in = Math.round(shot.in);
  shot.out = Math.round(shot.out);
  shot.inFrame = shot.in;
  shot.outFrame = shot.out;
  shot.durationFrames = shot.out - shot.in;
  shot.startS = round(shot.in / fps, 3);
  shot.endS = round(shot.out / fps, 3);
}

function allocateInternal(utterances, beats, options, fps) {
  const targetS = firstNumber(options.targetS) ?? DEFAULT_TARGET_S;
  const targetFrames = Math.round(targetS * fps);
  const findings = [];
  const adjustments = [];

  const { items } = buildBeatItems(utterances, beats, fps);
  const used = ensureAllUtterances(utterances, items);

  for (const item of items) {
    if (item.unresolved) {
      findings.push({
        code: FINDING_CODES.BEAT_UNRESOLVED,
        severity: 'error',
        beat: item.beatId,
        message: `${item.beatId} has no utterance reference and no explicit timing.`,
      });
    }
    if (item.out == null) item.out = item.in + (item.requestedFrames ?? 1);
    if (item.kind === 'dialogue' && item.requestedFrames == null) {
      item.requestedFrames = item.out - item.in;
    }
  }

  items.sort((a, b) => (a.in - b.in) || (a.order - b.order));

  const shots = [];
  let cursor = 0;
  let shotIndex = 0;

  const nextId = () => {
    shotIndex += 1;
    return `shot-${String(shotIndex).padStart(2, '0')}`;
  };

  const recordAdjustment = (shot, previousFrames, cause) => {
    const delta = shot.durationFrames - previousFrames;
    if (delta === 0) return;
    shot.adjustmentFrames += delta;
    adjustments.push({
      shotId: shot.id,
      role: shot.role,
      reason: shot.reason,
      cause,
      requestedFrames: previousFrames,
      actualFrames: shot.durationFrames,
      deltaFrames: delta,
    });
  };

  const trimTailTo = (targetFrame, cause) => {
    while (cursor > targetFrame && shots.length > 0) {
      const last = shots[shots.length - 1];
      if (last.kind === 'dialogue') break;
      const before = last.durationFrames;
      if (last.in >= targetFrame) {
        shots.pop();
        cursor = shots.length > 0 ? shots[shots.length - 1].out : 0;
        continue;
      }
      last.out = targetFrame;
      updateShot(last, fps);
      recordAdjustment(last, before, cause);
      cursor = last.out;
    }
  };

  for (const item of items) {
    let inFrame = Math.round(item.in);
    let outFrame = Math.round(item.out);

    if (inFrame > cursor) {
      const previous = shots.length > 0 ? shots[shots.length - 1] : null;
      if (previous && previous.kind !== 'dialogue' && previous.flexible) {
        const before = previous.durationFrames;
        previous.out = inFrame;
        updateShot(previous, fps);
        recordAdjustment(previous, before, 'gap_stretch');
        cursor = previous.out;
      } else {
        const gap = makeShot({
          kind: 'gap',
          role: 'action',
          beatId: null,
          in: cursor,
          out: inFrame,
          reason: gapReason(previous, item),
          cutReason: null,
          flexible: true,
          refs: [],
          timing: 'estimated',
          synthetic: true,
        }, fps, nextId());
        gap.requestedFrames = gap.durationFrames;
        shots.push(gap);
        cursor = gap.out;
      }
    }

    if (inFrame < cursor) {
      if (item.kind === 'dialogue') {
        trimTailTo(inFrame, 'overlap_trim');
        if (cursor > inFrame) {
          findings.push({
            code: FINDING_CODES.OVERLAP,
            severity: 'error',
            beat: item.beatId,
            frame: inFrame,
            message: `${item.beatId ?? 'dialogue'} starts at frame ${inFrame} inside the previous shot (frame ${cursor}); move the beat or shorten a hold.`,
          });
          inFrame = cursor;
        }
      } else {
        inFrame = cursor;
      }
    }

    if (outFrame <= inFrame) {
      if (item.kind === 'dialogue') {
        findings.push({
          code: FINDING_CODES.OVERLAP,
          severity: 'error',
          beat: item.beatId,
          frame: inFrame,
          message: `${item.beatId ?? 'dialogue'} has no room after frame ${inFrame}.`,
        });
      }
      continue;
    }

    const shot = makeShot({ ...item, in: inFrame, out: outFrame }, fps, nextId());
    shots.push(shot);
    cursor = shot.out;
  }

  while (cursor < targetFrames) {
    const last = shots.length > 0 ? shots[shots.length - 1] : null;
    if (last && last.kind !== 'dialogue' && last.flexible) {
      const before = last.durationFrames;
      last.out = targetFrames;
      updateShot(last, fps);
      recordAdjustment(last, before, 'target_stretch');
      cursor = last.out;
      break;
    }
    const tail = makeShot({
      kind: 'gap',
      role: 'action',
      beatId: null,
      in: cursor,
      out: targetFrames,
      reason: 'tail hold',
      cutReason: null,
      flexible: true,
      refs: [],
      timing: 'estimated',
      synthetic: true,
    }, fps, nextId());
    tail.requestedFrames = tail.durationFrames;
    shots.push(tail);
    cursor = tail.out;
  }

  if (cursor > targetFrames) {
    trimTailTo(targetFrames, 'target_shrink');
    if (cursor > targetFrames) {
      findings.push({
        code: FINDING_CODES.TARGET_TOO_SHORT,
        severity: 'error',
        frame: cursor,
        message: `dialogue ends at frame ${cursor}, beyond the ${targetFrames}-frame target; shorten or rewrite speech instead of speeding it.`,
      });
    }
  }

  const utterancesById = new Map(utterances.map((utterance) => [utterance.id, utterance]));
  for (const shot of shots) {
    const before = shot.durationFrames;
    shot.durationFrames = shot.out - shot.in;
    if (shot.durationFrames !== before) updateShot(shot, fps);
    shot.dialogue = shot.utteranceIds
      .map((id) => utterancesById.get(id))
      .filter(Boolean)
      .map((utterance) => ({
        id: utterance.id,
        speaker: utterance.speaker,
        text: utterance.text,
        timing: utterance.timing,
        startFrame: utterance.startFrame,
        endFrame: utterance.endFrame,
      }));
  }

  const cuts = cutsInsideSpeech(shots, utterances, { fps });
  for (const cut of cuts) {
    if (!cut.explained) {
      findings.push({
        ...cut,
        severity: 'error',
      });
    }
  }

  const pauses = shots
    .filter((shot) => shot.role === 'reaction')
    .map((shot, index) => ({
      id: `pause-${String(index + 1).padStart(2, '0')}`,
      shotId: shot.id,
      startFrame: shot.in,
      endFrame: shot.out,
      durationFrames: shot.durationFrames,
      reason: shot.reason,
    }));

  const retainedUtterances = utterances.map((utterance) => ({
    id: utterance.id,
    speaker: utterance.speaker,
    text: utterance.text,
    timing: utterance.timing,
    startFrame: utterance.startFrame,
    endFrame: utterance.endFrame,
    startS: utterance.startS,
    endS: utterance.endS,
    durationFrames: utterance.durationFrames,
  }));

  const droppedUtteranceIds = utterances
    .filter((utterance) => !used.has(utterance.id))
    .map((utterance) => utterance.id);

  const totalFrames = shots.reduce((sum, shot) => sum + shot.durationFrames, 0);

  const metadata = {
    schema: 'comfyrizz.beat-allocation/v1',
    targetS,
    targetFrames,
    fps,
    totalFrames,
    ok: totalFrames === targetFrames && !findings.some((finding) => finding.severity === 'error'),
    shots,
    utterances: retainedUtterances,
    retainedUtterances,
    retainedUtteranceIds: retainedUtterances.map((utterance) => utterance.id),
    droppedUtteranceIds,
    pauses,
    cuts,
    adjustments,
    findings,
  };

  for (const [key, value] of Object.entries(metadata)) {
    Object.defineProperty(shots, key, {
      value,
      enumerable: false,
      configurable: false,
      writable: false,
    });
  }

  return shots;
}

/**
 * Allocate shots from measured utterances and beat roles.
 *
 * Returns an array of shots carrying `in`/`out` integer half-open frames. The
 * array also exposes `totalFrames`, `targetFrames`, `pauses`, `cuts`,
 * `adjustments`, `findings`, `utterances` and `droppedUtteranceIds` as
 * non-enumerable properties, so it can be passed directly to Q12.
 *
 * @param {object[]} utterances measured, speaker-tagged utterances
 * @param {object[]} beats setup/reveal/reaction/payoff/action beat instructions
 * @param {object} [options]
 * @param {number} [options.targetS=600] film length in seconds
 * @param {number} [options.fps=30] integer-frame frame rate
 * @returns {object[]} shots
 */
export function allocate(utterances, beats, options = {}) {
  const fps = firstNumber(options.fps) ?? DEFAULT_FPS;
  const targetS = firstNumber(options.targetS) ?? DEFAULT_TARGET_S;
  if (!(fps > 0)) throw new TypeError('fps must be a positive finite number');
  if (!(targetS > 0)) throw new TypeError('targetS must be a positive finite number');
  const normalized = normalizeUtterances(utterances, fps);
  return allocateInternal(normalized, beats, { ...options, targetS }, fps);
}

/**
 * List every shot cut that falls strictly inside a spoken utterance.
 *
 * Shots use half-open [in, out) frames. A cut at an utterance start or end is
 * a boundary and is not listed. A cut inside speech is explained only when the
 * outgoing or incoming shot carries a `b-roll` or `reaction` cut reason.
 *
 * @param {object[]} shots
 * @param {object[]} utterances
 * @param {object} [options]
 * @param {number} [options.fps=30] used when an input carries seconds
 * @returns {object[]} findings sorted by cut frame
 */
export function cutsInsideSpeech(shots, utterances, options = {}) {
  if (!Array.isArray(shots)) throw new TypeError('shots must be an array');
  if (!Array.isArray(utterances)) throw new TypeError('utterances must be an array');
  const fps = firstNumber(options.fps) ?? DEFAULT_FPS;
  if (!(fps > 0)) throw new TypeError('fps must be a positive finite number');

  const normalizedUtterances = utterances.map((utterance, index) => {
    if (!utterance || typeof utterance !== 'object') {
      throw new TypeError(`utterance ${index + 1} must be an object`);
    }
    const range = frameRangeOf(utterance, fps);
    const startFrame = range.inFrame;
    const endFrame = range.outFrame;
    if (startFrame == null || endFrame == null || endFrame <= startFrame) {
      throw new RangeError(`utterance ${utterance.id ?? index + 1} needs a positive start/end`);
    }
    return {
      id: String(utterance.id ?? `u${index + 1}`),
      speaker: utterance.speaker ?? null,
      startFrame: Math.round(startFrame),
      endFrame: Math.round(endFrame),
    };
  });

  const normalizedShots = shots.map((shot, index) => {
    if (!shot || typeof shot !== 'object') {
      throw new TypeError(`shot ${index + 1} must be an object`);
    }
    const range = frameRangeOf(shot, fps);
    const inFrame = range.inFrame;
    const outFrame = range.outFrame;
    if (inFrame == null || outFrame == null || outFrame <= inFrame) {
      throw new RangeError(`shot ${shot.id ?? index + 1} needs a positive in/out`);
    }
    return {
      ...shot,
      id: String(shot.id ?? `shot-${index + 1}`),
      inFrame: Math.round(inFrame),
      outFrame: Math.round(outFrame),
    };
  }).sort((a, b) => a.inFrame - b.inFrame);

  const cuts = [];
  for (let index = 0; index < normalizedShots.length - 1; index += 1) {
    const shot = normalizedShots[index];
    const next = normalizedShots[index + 1];
    const cutFrame = shot.outFrame;
    const utterance = normalizedUtterances.find(
      (item) => cutFrame > item.startFrame && cutFrame < item.endFrame,
    );
    if (!utterance) continue;

    const reason = reasonFromShot(shot) ?? reasonIntoShot(next);
    const explained = reason !== null;
    const distanceToStart = cutFrame - utterance.startFrame;
    const distanceToEnd = utterance.endFrame - cutFrame;
    const nearestBoundaryFrame = distanceToStart <= distanceToEnd
      ? utterance.startFrame
      : utterance.endFrame;

    cuts.push({
      code: FINDING_CODES.CUT_INSIDE_SPEECH,
      cutFrame,
      frame: cutFrame,
      cutS: round(cutFrame / fps, 3),
      utteranceId: utterance.id,
      utterance: utterance.id,
      speaker: utterance.speaker,
      shotId: shot.id,
      nextShotId: next.id,
      reason,
      explained,
      reasonRequired: !explained,
      nearestBoundaryFrame,
      nearestBoundary: nearestBoundaryFrame,
      nearestBoundaryS: round(nearestBoundaryFrame / fps, 3),
      message: explained
        ? `Cut at frame ${cutFrame} inside ${utterance.id} is explained by "${reason}".`
        : `Cut at frame ${cutFrame} inside ${utterance.id} has no b-roll or reaction reason; move it to frame ${nearestBoundaryFrame}.`,
    });
  }

  cuts.sort((a, b) => a.cutFrame - b.cutFrame);
  return cuts;
}

export default allocate;
