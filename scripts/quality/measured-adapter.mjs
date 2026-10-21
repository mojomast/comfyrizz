#!/usr/bin/env node
// Q12 - Map speaker-tagged utterances and Q11 shot ranges onto the measured
// planner timeline.
//
// Source: docs/research/MOCKUMENTARY_QUALITY_REVIEW_20261020.md sections 3 and
// 6 ("Integrate multi-speaker editorial data with the shared measured
// timeline"). Read-only contract, quoted from packages/planner/src/measured.ts:
//
//   interface DurationsReport {
//     engine?: string;
//     gapSeconds?: number;
//     paddingSeconds?: number;
//     scenes?: Record<string, { chunks?: NarrationChunk[] }>;
//   }
//   interface NarrationChunk {
//     text: string;
//     seconds: number;
//     words?: { text: string; start: number; end: number }[];
//     timing?: string;
//   }
//
// measuredFromReport only reads `scenes[sceneId].chunks[]`, so the editor-ready
// speaker/pause/clip data rides beside them, keyed by the same scene id. The
// planner package is deliberately not imported: this module stays pure .mjs.
//
// Pure module: no I/O, no clock, no network, no side effects at import time.

const DEFAULT_FPS = 30;
const DEFAULT_SCENE = 'main';

export const PROVENANCE = Object.freeze(['measured', 'estimated']);

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function firstNumber(...values) {
  for (const value of values) {
    if (isFiniteNumber(value)) return value;
  }
  return undefined;
}

function round(value, digits = 6) {
  const factor = 10 ** digits;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

function sceneIdOf(value) {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  if (isFiniteNumber(value)) return String(value);
  if (value && typeof value === 'object') {
    return sceneIdOf(value.id ?? value.sceneId ?? value.name);
  }
  return null;
}

function provenanceOf(value, fallback = 'measured') {
  const timing = typeof value === 'string' ? value.trim().toLowerCase() : null;
  if (timing === 'estimated' || timing === 'syllable-fallback') return 'estimated';
  if (timing === 'measured' || timing === 'aligner') return 'measured';
  return fallback;
}

function normalizeWords(words) {
  if (!Array.isArray(words)) return undefined;
  return words.map((word) => {
    if (!word || typeof word !== 'object') {
      throw new TypeError('narration words must be objects');
    }
    return {
      text: String(word.text ?? ''),
      start: Number(word.start ?? 0),
      end: Number(word.end ?? 0),
    };
  });
}

function frameRangeOf(value, fps) {
  if (!value || typeof value !== 'object') return { inFrame: null, outFrame: null };
  const explicitIn = firstNumber(value.in, value.inFrame, value.startFrame);
  const explicitOut = firstNumber(value.out, value.outFrame, value.endFrame);
  if (explicitIn !== undefined || explicitOut !== undefined) {
    return { inFrame: explicitIn ?? null, outFrame: explicitOut ?? null };
  }
  const startS = firstNumber(value.startS, value.start);
  const endS = firstNumber(value.endS, value.end);
  return {
    inFrame: startS === undefined ? null : Math.round(startS * fps),
    outFrame: endS === undefined ? null : Math.round(endS * fps),
  };
}

function frameOf(value) {
  if (isFiniteNumber(value)) return Math.round(value);
  return null;
}

function normalizeUtterances(utterances, fps) {
  if (!Array.isArray(utterances)) throw new TypeError('utterances must be an array');
  const seen = new Set();
  let cursor = 0;

  const normalized = utterances.map((raw, index) => {
    if (!raw || typeof raw !== 'object') {
      throw new TypeError(`utterance ${index + 1} must be an object`);
    }
    const id = String(raw.id ?? raw.utteranceId ?? `u${index + 1}`);
    if (seen.has(id)) throw new RangeError(`duplicate utterance id "${id}"`);
    seen.add(id);

    const range = frameRangeOf(raw, fps);
    const durationS = firstNumber(raw.durationS, raw.seconds, raw.duration);
    const givenFrames = firstNumber(raw.durationFrames);
    let durationFrames = givenFrames !== undefined
      ? Math.max(1, Math.round(givenFrames))
      : durationS !== undefined
        ? Math.max(1, Math.round(durationS * fps))
        : undefined;

    let startFrame = range.inFrame;
    let endFrame = range.outFrame;

    if (startFrame == null && endFrame != null && durationFrames != null) {
      startFrame = endFrame - durationFrames;
    }
    if (endFrame == null && startFrame != null && durationFrames != null) {
      endFrame = startFrame + durationFrames;
    }
    if (startFrame == null && endFrame == null) {
      startFrame = cursor;
      endFrame = startFrame + (durationFrames ?? fps);
    }
    if (startFrame == null) startFrame = endFrame - (durationFrames ?? fps);
    if (endFrame == null) endFrame = startFrame + (durationFrames ?? fps);

    startFrame = Math.max(0, Math.round(startFrame));
    endFrame = Math.round(endFrame);
    if (!(endFrame > startFrame)) {
      throw new RangeError(`utterance "${id}" must end after it starts`);
    }
    durationFrames = endFrame - startFrame;
    cursor = Math.max(cursor, endFrame);

    const seconds = durationS !== undefined && durationS > 0
      ? round(durationS)
      : round(durationFrames / fps);

    return {
      id,
      speaker: typeof raw.speaker === 'string' && raw.speaker.trim().length > 0
        ? raw.speaker.trim()
        : null,
      text: typeof raw.text === 'string' ? raw.text : String(raw.text ?? ''),
      timing: provenanceOf(raw.timing, 'measured'),
      startFrame,
      endFrame,
      durationFrames,
      startS: round(startFrame / fps, 3),
      endS: round(endFrame / fps, 3),
      seconds,
      words: normalizeWords(raw.words),
      scene: sceneIdOf(raw.scene ?? raw.sceneId ?? raw.chapterId ?? raw.chapter),
      order: index,
    };
  });

  return normalized;
}

function normalizeShots(shots, fps) {
  if (!Array.isArray(shots)) throw new TypeError('shots must be an array');
  return shots.map((raw, index) => {
    if (!raw || typeof raw !== 'object') {
      throw new TypeError(`shot ${index + 1} must be an object`);
    }
    const range = frameRangeOf(raw, fps);
    const inFrame = frameOf(firstNumber(raw.in, raw.inFrame, raw.startFrame)) ?? range.inFrame;
    const outFrame = frameOf(firstNumber(raw.out, raw.outFrame, raw.endFrame)) ?? range.outFrame;
    if (inFrame == null || outFrame == null || outFrame <= inFrame) {
      throw new RangeError(`shot ${raw.id ?? index + 1} needs positive in/out frames`);
    }
    const rawIds = raw.utteranceIds ?? raw.utterances ?? raw.utteranceId;
    const dialogueIds = Array.isArray(raw.dialogue)
      ? raw.dialogue.map((line) => line?.id).filter((id) => id != null)
      : [];
    const utteranceIds = (Array.isArray(rawIds) ? rawIds : rawIds == null ? [] : [rawIds])
      .concat(dialogueIds)
      .map((id) => String(id))
      .filter((id, position, list) => list.indexOf(id) === position);

    const kind = typeof raw.kind === 'string' ? raw.kind : null;
    return {
      id: String(raw.id ?? raw.shotId ?? raw.clipId ?? `clip-${String(index + 1).padStart(2, '0')}`),
      inFrame: Math.round(inFrame),
      outFrame: Math.round(outFrame),
      durationFrames: Math.round(outFrame) - Math.round(inFrame),
      role: typeof raw.role === 'string' ? raw.role : null,
      kind,
      beat: raw.beat == null ? null : String(raw.beat),
      reason: typeof raw.reason === 'string' && raw.reason.length > 0 ? raw.reason : null,
      timing: provenanceOf(raw.timing, kind === 'dialogue' ? 'measured' : 'estimated'),
      utteranceIds,
      scene: sceneIdOf(raw.scene ?? raw.sceneId ?? raw.chapterId ?? raw.chapter),
      order: index,
    };
  }).sort((a, b) => (a.inFrame - b.inFrame) || (a.order - b.order));
}

function intervalDistance(a, b) {
  if (a.endFrame <= b.inFrame) return b.inFrame - a.endFrame;
  if (b.endFrame <= a.inFrame) return a.inFrame - b.endFrame;
  return 0;
}

function assignScenes(utterances, shots) {
  const utteranceById = new Map(utterances.map((utterance) => [utterance.id, utterance]));

  for (const shot of shots) {
    if (shot.scene != null) continue;
    const linked = shot.utteranceIds
      .map((id) => utteranceById.get(id))
      .find((utterance) => utterance && utterance.scene != null);
    if (linked) shot.scene = linked.scene;
  }

  for (const utterance of utterances) {
    if (utterance.scene != null) continue;
    const linked = shots
      .filter((shot) => shot.utteranceIds.includes(utterance.id) && shot.scene != null)
      .sort((a, b) => (a.inFrame - b.inFrame) || (a.order - b.order))[0];
    if (linked) utterance.scene = linked.scene;
  }

  const anchors = [];
  for (const utterance of utterances) {
    if (utterance.scene != null) {
      anchors.push({ scene: utterance.scene, inFrame: utterance.startFrame, endFrame: utterance.endFrame, order: utterance.order });
    }
  }
  for (const shot of shots) {
    if (shot.scene != null) {
      anchors.push({ scene: shot.scene, inFrame: shot.inFrame, endFrame: shot.outFrame, order: shot.order });
    }
  }

  const nearestScene = (item) => {
    if (anchors.length === 0) return null;
    let best = null;
    for (const anchor of anchors) {
      const distance = intervalDistance(item, anchor);
      const startGap = Math.abs(item.inFrame - anchor.inFrame);
      if (
        best == null
        || distance < best.distance
        || (distance === best.distance && startGap < best.startGap)
        || (distance === best.distance && startGap === best.startGap && anchor.scene < best.scene)
      ) {
        best = { scene: anchor.scene, distance, startGap };
      }
    }
    return best.scene;
  };

  for (const utterance of utterances) {
    if (utterance.scene == null) {
      utterance.scene = nearestScene({
        inFrame: utterance.startFrame,
        endFrame: utterance.endFrame,
      }) ?? DEFAULT_SCENE;
    }
  }
  for (const shot of shots) {
    if (shot.scene == null) {
      shot.scene = nearestScene({
        inFrame: shot.inFrame,
        endFrame: shot.outFrame,
      }) ?? DEFAULT_SCENE;
    }
  }
}

function speakerSlug(name) {
  const slug = String(name)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return slug.length > 0 ? slug : 'speaker';
}

function buildSpeakerRegistry(utterances) {
  const namesByKey = new Map();
  for (const utterance of utterances) {
    if (!utterance.speaker) continue;
    const key = utterance.speaker.toLowerCase();
    if (!namesByKey.has(key)) namesByKey.set(key, []);
    namesByKey.get(key).push(utterance.speaker);
  }

  const used = new Set();
  const speakers = [];
  const idByName = new Map();

  for (const key of [...namesByKey.keys()].sort()) {
    const displayName = [...namesByKey.get(key)].sort()[0];
    const base = `spk_${speakerSlug(displayName)}`;
    let id = base;
    let suffix = 2;
    while (used.has(id)) {
      id = `${base}_${suffix}`;
      suffix += 1;
    }
    used.add(id);
    speakers.push({ id, name: displayName });
    idByName.set(displayName, id);
    idByName.set(displayName.toLowerCase(), id);
  }

  return { speakers, idByName };
}

function sidecarItem(utterance, speakerId) {
  return {
    id: utterance.id,
    speaker: utterance.speaker,
    speakerId,
    text: utterance.text,
    timing: utterance.timing,
    startFrame: utterance.startFrame,
    endFrame: utterance.endFrame,
    durationFrames: utterance.durationFrames,
    startS: utterance.startS,
    endS: utterance.endS,
  };
}

function reportChunk(utterance) {
  return {
    text: utterance.text,
    seconds: utterance.seconds,
    ...(utterance.words ? { words: utterance.words } : {}),
    timing: utterance.timing,
  };
}

function clipOf(shot, speakerIds) {
  return {
    id: shot.id,
    clipId: shot.id,
    shotId: shot.id,
    in: shot.inFrame,
    out: shot.outFrame,
    startFrame: shot.inFrame,
    endFrame: shot.outFrame,
    durationFrames: shot.durationFrames,
    role: shot.role,
    kind: shot.kind,
    beat: shot.beat,
    reason: shot.reason,
    timing: shot.timing,
    utteranceIds: [...shot.utteranceIds],
    speakerIds: shot.utteranceIds
      .map((id) => speakerIds.get(id))
      .filter(Boolean),
  };
}

function sceneTiming(utterances, clips) {
  if (utterances.length === 0 && clips.length === 0) return 'estimated';
  const all = [
    ...utterances.map((utterance) => utterance.timing),
    ...clips.map((clip) => clip.timing),
  ];
  return all.every((timing) => timing === 'measured') ? 'measured' : 'estimated';
}

/**
 * Build the durations sidecar that `measuredFromReport` accepts.
 *
 * The returned object keeps the planner contract exactly where it matters
 * (`scenes[sceneId].chunks[]` with `text`, `seconds` and optional `words`) and
 * adds a scene-keyed editorial sidecar with speaker-tagged utterances, pause
 * windows and the selected clip ranges from Q11.
 *
 * @param {object[]} utterances speaker-tagged measured utterances
 * @param {object[]} shots Q11 allocation (or plain {in,out,scene} shot ranges)
 * @param {object} [options]
 * @param {number} [options.fps=30] used when inputs carry seconds
 * @param {string} [options.engine] narration engine reported by the sidecar
 * @param {number} [options.gapSeconds]
 * @param {number} [options.paddingSeconds]
 * @returns {object} DurationsReport plus a scene-keyed editorial sidecar
 */
export function toDurationsReport(utterances, shots, options = {}) {
  if (!utterances) throw new TypeError('utterances must be an array');
  if (!shots) throw new TypeError('shots must be an array');

  const shotFps = Array.isArray(shots) ? shots.fps : undefined;
  const fps = firstNumber(options.fps, shotFps) ?? DEFAULT_FPS;
  if (!(fps > 0)) throw new TypeError('fps must be a positive finite number');

  const normalizedUtterances = normalizeUtterances(utterances, fps);
  const normalizedShots = normalizeShots(shots, fps);
  assignScenes(normalizedUtterances, normalizedShots);

  const registry = buildSpeakerRegistry(normalizedUtterances);
  const speakerIdsByUtterance = new Map(
    normalizedUtterances.map((utterance) => [
      utterance.id,
      utterance.speaker ? registry.idByName.get(utterance.speaker) ?? registry.idByName.get(utterance.speaker.toLowerCase()) ?? null : null,
    ]),
  );

  // Normalize declared pauses from the input shots (Q11 exposes them as a
  // non-enumerable property) so their scenes and frames stay integer-exact.
  const pauses = [];
  const declaredPauses = Array.isArray(shots.pauses) ? shots.pauses : null;
  const shotById = new Map(normalizedShots.map((shot) => [shot.id, shot]));
  if (declaredPauses && declaredPauses.length > 0) {
    for (const raw of declaredPauses) {
      if (!raw || typeof raw !== 'object') continue;
      const shotId = raw.shotId == null ? null : String(raw.shotId);
      const shot = shotId == null ? null : shotById.get(shotId);
      const startFrame = frameOf(firstNumber(raw.startFrame, raw.inFrame, raw.in)) ?? shot?.inFrame;
      const endFrame = frameOf(firstNumber(raw.endFrame, raw.outFrame, raw.out)) ?? shot?.outFrame;
      if (startFrame == null || endFrame == null || endFrame <= startFrame) continue;
      pauses.push({
        id: String(raw.id ?? `pause-${String(pauses.length + 1).padStart(2, '0')}`),
        shotId,
        scene: sceneIdOf(raw.scene ?? raw.sceneId) ?? shot?.scene ?? DEFAULT_SCENE,
        startFrame: Math.round(startFrame),
        endFrame: Math.round(endFrame),
        durationFrames: Math.round(endFrame) - Math.round(startFrame),
        reason: typeof raw.reason === 'string' ? raw.reason : shot?.reason ?? null,
        timing: 'estimated',
      });
    }
  } else {
    for (const shot of normalizedShots) {
      if (!/reaction|pause/i.test(shot.role ?? '')) continue;
      pauses.push({
        id: `pause-${String(pauses.length + 1).padStart(2, '0')}`,
        shotId: shot.id,
        scene: shot.scene,
        startFrame: shot.inFrame,
        endFrame: shot.outFrame,
        durationFrames: shot.durationFrames,
        reason: shot.reason,
        timing: 'estimated',
      });
    }
  }
  pauses.sort((a, b) => (a.startFrame - b.startFrame) || a.id.localeCompare(b.id));

  const utterancesByScene = new Map();
  for (const utterance of normalizedUtterances) {
    if (!utterancesByScene.has(utterance.scene)) utterancesByScene.set(utterance.scene, []);
    utterancesByScene.get(utterance.scene).push(utterance);
  }
  for (const list of utterancesByScene.values()) {
    list.sort((a, b) => (a.startFrame - b.startFrame) || (a.order - b.order));
  }

  const clipsByScene = new Map();
  for (const shot of normalizedShots) {
    if (!clipsByScene.has(shot.scene)) clipsByScene.set(shot.scene, []);
    clipsByScene.get(shot.scene).push(clipOf(shot, speakerIdsByUtterance));
  }

  const pausesByScene = new Map();
  for (const pause of pauses) {
    if (!pausesByScene.has(pause.scene)) pausesByScene.set(pause.scene, []);
    pausesByScene.get(pause.scene).push(pause);
  }

  const sceneIds = [...new Set([...utterancesByScene.keys(), ...clipsByScene.keys(), ...pausesByScene.keys()])].sort();

  const scenes = {};
  const sidecar = {};
  for (const sceneId of sceneIds) {
    const sceneUtterances = utterancesByScene.get(sceneId) ?? [];
    const sceneClips = (clipsByScene.get(sceneId) ?? [])
      .sort((a, b) => (a.startFrame - b.startFrame) || a.clipId.localeCompare(b.clipId));
    const scenePauses = pausesByScene.get(sceneId) ?? [];

    const startFrame = Math.min(
      ...sceneUtterances.map((utterance) => utterance.startFrame),
      ...sceneClips.map((clip) => clip.startFrame),
      ...scenePauses.map((pause) => pause.startFrame),
    );
    const endFrame = Math.max(
      ...sceneUtterances.map((utterance) => utterance.endFrame),
      ...sceneClips.map((clip) => clip.endFrame),
      ...scenePauses.map((pause) => pause.endFrame),
    );
    const timing = sceneTiming(sceneUtterances, sceneClips);

    const editorial = {
      sceneId,
      startFrame,
      endFrame,
      durationFrames: endFrame - startFrame,
      timing,
      utterances: sceneUtterances.map((utterance) => sidecarItem(utterance, speakerIdsByUtterance.get(utterance.id) ?? null)),
      pauses: scenePauses,
      clips: sceneClips,
    };

    scenes[sceneId] = {
      chunks: sceneUtterances.map(reportChunk),
      ...editorial,
    };
    sidecar[sceneId] = {
      utterances: editorial.utterances,
      pauses: editorial.pauses,
      clips: editorial.clips,
      startFrame: editorial.startFrame,
      endFrame: editorial.endFrame,
      durationFrames: editorial.durationFrames,
      timing: editorial.timing,
    };
  }

  const report = {
    schema: 'comfyrizz.durations-report/v1',
    fps,
    sceneIds,
    speakers: registry.speakers,
    speakerRegistry: Object.fromEntries(registry.speakers.map((speaker) => [speaker.id, speaker.name])),
    speakerIds: Object.fromEntries(registry.speakers.map((speaker) => [speaker.name, speaker.id])),
    scenes,
    sidecar,
  };

  if (typeof options.engine === 'string' && options.engine.length > 0) report.engine = options.engine;
  if (isFiniteNumber(options.gapSeconds)) report.gapSeconds = options.gapSeconds;
  if (isFiniteNumber(options.paddingSeconds)) report.paddingSeconds = options.paddingSeconds;

  return report;
}

export default toDurationsReport;
