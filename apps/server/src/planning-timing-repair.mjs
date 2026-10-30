import { compileTimeline, LAYOUT_LIMITS } from '../../../packages/planner/dist/src/index.js';
import { runAgent } from '../../../packages/agent/dist/src/index.js';
import { accumulateUsage } from '../../../packages/agent/dist/src/pi-runtime.js';
import { validatePackage } from '../../../packages/schema/src/index.mjs';
import { ENERGY_SCALES, READING, STAGGER_STEP_SECONDS } from '../../../packages/schema/src/motion.mjs';
import { sceneShotPlates } from './scene-shot-plates.mjs';

export const TIMING_REPAIR_TOOL = 'storyboard.repair_timing';
export const EXACT_PLANNING_GUIDANCE = 'For an exact runtime, author all scene preferredFrames and transitionOut.frames together: total = sum(scene windows) - sum(non-cut outgoing overlaps, excluding the last scene). Use frames, not duration/durationFrames, for transitions. Plan source frames at the source fps (24 for LTX/H3), not project fps. Every visible video must cover its entire scene after existing trim and speed. Preserve the requested shot count, ordered native copy, settled reading windows and longer final title. Re-plan an under-covered pending shot with sufficient source frames using its existing image/references and creative direction; never split requested shots, stretch, loop, change speed or add holds to conceal insufficient footage. Preserve ready assets and explicit user-authored shot/transition timings.';

export function overlapFrames(scene) {
  return scene?.transitionOut && !['none', 'cut'].includes(scene.transitionOut.type)
    ? Math.max(0, Math.floor(Number(scene.transitionOut.frames) || 0)) : 0;
}

// Ready media is authoritative; generation requests are coverage only while pending.
export function videoCoverageSeconds(pkg, plate) {
  const asset = pkg.assets?.[plate.asset];
  if (asset?.kind !== 'video') return null;
  const seconds = asset.status === 'ready' ? Number(asset.media?.durationSeconds)
    : Number(asset.gen?.inputs?.frames) / Number(asset.gen?.inputs?.fps);
  if (!(seconds > 0) || !Number.isFinite(seconds)) return 0;
  const speed = plate.speed ?? 1;
  const start = plate.trim?.startSeconds ?? 0;
  const end = Math.min(seconds, plate.trim?.endSeconds ?? seconds);
  if (!(speed > 0) || !(start >= 0) || !(end >= start)) return 0;
  return (end - start) / speed;
}

export function videoCoverageFrames(pkg, plate) {
  const seconds = videoCoverageSeconds(pkg, plate);
  return seconds === null ? null : Math.floor(seconds * pkg.format.fps + 1e-7);
}

function measuredOptions(pkg) {
  const narration = {};
  for (const scene of pkg.scenes ?? []) {
    const audio = pkg.assets?.[scene.narration_asset];
    if (audio?.status === 'ready' && audio.media?.durationSeconds > 0) {
      narration[scene.id] = [{ text: scene.narration ?? '', seconds: audio.media.durationSeconds }];
    }
  }
  return { narration };
}

export function compilePlanningTimeline(pkg) {
  // Native dialogue does not live on the finishing narration track, so the
  // timeline compiler cannot infer this floor from narration options alone.
  for (const scene of pkg.scenes ?? []) {
    for (const plate of [...sceneShotPlates(scene), ...(scene.foreground ?? [])]) {
      const video = pkg.assets?.[plate.asset];
      if (!video?.gen?.direction?.dialogue) continue;
      const measured = Number(pkg.assets?.[video.gen.inputs?.audio]?.media?.durationSeconds);
      const required = Math.ceil((measured + 0.2) * pkg.format.fps) + overlapFrames(scene);
      if (!(measured > 0) || scene.preferredFrames < required) {
        throw Object.assign(new Error(`${scene.id}: measured native dialogue needs ${Number.isFinite(required) ? `at least ${required} project frames including natural reaction padding and outgoing overlap` : 'ready measured conditioning audio'}; preserve the exact words and natural playback speed.`), { code: 'DIALOGUE_AUDIO_TOO_LONG', status: 422 });
      }
    }
  }
  const timeline = compileTimeline(pkg, measuredOptions(pkg));
  const hasVideo = (pkg.scenes ?? []).some(scene => sceneShotPlates(scene).some(plate => pkg.assets?.[plate.asset]?.kind === 'video'));
  if (pkg.duration?.exact && hasVideo && timeline.scenes.some((scene, i) => scene.durationInFrames !== pkg.scenes[i].preferredFrames)) {
    throw Object.assign(new Error('Exact mixed-media timeline must use explicitly authored scene windows. The compiler would absorb the duration mismatch into a non-video beat; author all preferredFrames and overlaps atomically instead of silently extending the still/native beat.'), { code: 'EXACT_AUTHORED_WINDOWS_REQUIRED', status: 422 });
  }
  return timeline;
}

export function planningTimingFacts(pkg) {
  const options = measuredOptions(pkg);
  let currentFrames;
  let error;
  try { currentFrames = compilePlanningTimeline(pkg).durationInFrames; } catch (caught) { error = caught.message; }
  // Never fall back to a sum that conceals the overlaps responsible for failure.
  if (currentFrames === undefined) {
    try { currentFrames = compileTimeline({ ...pkg, duration: { mode: 'flexible' } }, options).durationInFrames; }
    catch { currentFrames = (pkg.scenes ?? []).reduce((sum, scene, i, scenes) => sum + (Number(scene.preferredFrames) || 0) - (i < scenes.length - 1 ? overlapFrames(scene) : 0), 0); }
  }
  const overlaps = (pkg.scenes ?? []).slice(0, -1).reduce((sum, scene) => sum + overlapFrames(scene), 0);
  return { currentFrames, overlaps, targetFrames: pkg.duration?.targetFrames, error,
    scenes: (pkg.scenes ?? []).map(scene => ({ scene_id: scene.id, preferredFrames: scene.preferredFrames,
      transitionOut: scene.transitionOut ?? null, locked: scene.locked === true,
      narration_duration_frames: scene.narration_duration_frames ?? null,
      measuredNarrationSeconds: options.narration[scene.id]?.[0]?.seconds ?? null,
      sources: sceneShotPlates(scene).filter(plate => pkg.assets?.[plate.asset]?.kind === 'video').map(plate => ({
        asset: plate.asset, status: pkg.assets[plate.asset].status, sourceFps: pkg.assets[plate.asset].gen?.inputs?.fps,
        coverageFrames: videoCoverageFrames(pkg, plate), trim: plate.trim ?? null, speed: plate.speed ?? 1,
        ...(pkg.assets[plate.asset].gen?.direction?.dialogue ? {
          minimumDialogueFrames: Math.ceil((Number(pkg.assets[pkg.assets[plate.asset].gen.inputs?.audio]?.media?.durationSeconds) + 0.2) * pkg.format.fps) || null,
        } : {}),
      })),
    })),
  };
}

export function planningTimingGuide(pkg) {
  if (!pkg?.duration?.exact) return [];
  const facts = planningTimingFacts(pkg);
  return [EXACT_PLANNING_GUIDANCE,
    `Exact timing facts: ${JSON.stringify(facts)}. With unchanged overlaps, explicitly author scene windows summing to ${facts.targetFrames + facts.overlaps} frames. Coverage is per simultaneous plate, never the sum of plates. Under-covered pending sources need sufficient generation frames before a timing correction can pass.`,
  ];
}

const numbers = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
const number = '(?:\\d+(?:\\.\\d+)?|one|two|three|four|five|six|seven|eight|nine|ten)';
function briefTiming(brief, seconds) {
  let text = String(brief ?? '');
  let readingSeconds = 0;
  text = text.replace(new RegExp(`at least (${number}) seconds? (?:of )?(?:fully readable|settled)`, 'gi'), (_, value) => {
    readingSeconds = Math.max(readingSeconds, numbers[value.toLowerCase()] ?? Number(value));
    return '';
  });
  // Only the explicit whole-film runtime and understood minimum reading hold
  // are safe to ignore. Other timing prose is not permission to redistribute it.
  const target = String(seconds).replace(/\./g, '\\.');
  text = text.replace(new RegExp(`\\b(?:(?:exactly|precisely)\\s+)?${target}[\\s-]*(?:seconds?|secs?|s)\\b`, 'gi'), (match, offset) => {
    const prefix = text.slice(0, offset).split(/[.!?;,\n]|\bso(?:\s+that)?\b/i).at(-1);
    const suffix = text.slice(offset + match.length);
    const sceneWords = /\b(?:beats?|shots?|scenes?|transitions?|labels?|headlines?|holds?)\b/gi;
    const outputWords = /\b(?:create|make|deliver|export|film|video|runtime)\b/gi;
    const lastScene = [...prefix.matchAll(sceneWords)].at(-1)?.index ?? -1;
    const lastOutput = [...prefix.matchAll(outputWords)].at(-1)?.index ?? -1;
    const sceneScope = lastScene > lastOutput || /^\s+(?:long\s+)?(?:beat|shot|scene|transition|hold)\b/i.test(suffix);
    const outputScope = /\b(?:create|make|deliver|export|film|video|runtime)\b/i.test(prefix)
      || /^\s*(?:(?:whole|full|overall)\s+)?(?:duration|length|total)\s*(?::|=|is|of)?\s*(?:(?:about|around|roughly|approximately)\s*)?$/i.test(prefix)
      || /^\s+(?:of\s+)?(?:(?:landscape|portrait|generated|native|cinematic)\s+)*(?:film|video)\b/i.test(suffix);
    return outputScope && !sceneScope ? '' : match;
  });
  const authoredNumber = `(?:${number}|half|quarter|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty)`;
  // An approximate per-beat pacing suggestion can yield to the explicit whole
  // film total. Only this scoped duration phrase is relaxed: nearby hard bounds,
  // readable holds, timestamps and unrelated numeric prose remain authoritative.
  text = text.replace(new RegExp(`\\b(?:roughly|about|around|approximately)\\s+${authoredNumber}[\\s-]*(?:seconds?|secs?|s)\\b(?:\\s+(?:each|per\\s+(?:beat|shot|scene)))?`, 'gi'), (match, offset) => {
    const prefix = text.slice(0, offset).split(/[.!?;\n]/).at(-1);
    if (/\b(?:at least|at most|minimum|maximum|exactly|precisely|no less than|no more than)\b/i.test(prefix)) return match;
    const perBeat = /\bper\s+(?:beat|shot|scene)$/i.test(match)
      || /\beach$/i.test(match) && /\b(?:beats|shots|scenes)\b/i.test(prefix)
      || /\b(?:each\s+(?:beat|shot|scene)|(?:beat|shot|scene)\s+\d+)\s*(?:is|lasts?|runs?|should\s+(?:be|last)|:)?\s*$/i.test(prefix);
    return perBeat ? '' : match;
  });
  const authored = new RegExp(`\\b${authoredNumber}[\\s-]*(?:seconds?|secs?|s|minutes?|mins?|frames?|ms)\\b|\\b\\d+:\\d{2}\\b`, 'i').test(text);
  return { readingSeconds, authored };
}

function readingFloor(scene, pkg, seconds) {
  const panels = ['compare', 'split'].includes(scene.layout) && scene.media_only !== true && scene.media?.some(plate => plate.label);
  if (!seconds || !scene.copy && !scene.lower_third && !panels) return 0;
  // Same settle model/constants as schema motion reading-hold lint.
  const motion = scene.motion ?? {};
  const scales = ENERGY_SCALES[motion.energy ?? pkg.motion?.energy ?? 'medium'] ?? ENERGY_SCALES.medium;
  const family = motion.stagger ?? (scene.layout === 'list' && scene.variant === 'bullets' ? 'listItem' : 'none');
  const count = family === 'listItem' ? scene.copy?.items?.length ?? 0 : family === 'word'
    ? String(scene.copy?.headline ?? scene.copy?.quote ?? '').split(/\s+/).filter(Boolean).length : 0;
  const settle = motion.entry === 'none' ? 0 : READING.entrySeconds * scales.entryScale
    + Math.min(READING.maxStaggerSeconds, Math.max(0, count - 1) * (STAGGER_STEP_SECONDS[family] ?? 0) * scales.staggerScale);
  const panelSettle = panels ? Math.round(0.12 * pkg.format.fps) + Math.min(16, Math.round(0.45 * pkg.format.fps)) : 0;
  return Math.ceil(seconds * pkg.format.fps - 1e-7) + Math.max(Math.ceil(settle * pkg.format.fps - 1e-7), panelSettle);
}

function validateArgs(args) {
  if (!args || typeof args !== 'object' || Object.keys(args).some(key => key !== 'scenes') || !Array.isArray(args.scenes)) throw new Error('Supply only scenes: one timing entry for every existing scene, in order.');
  for (const entry of args.scenes) {
    if (!entry || typeof entry.scene_id !== 'string' || !Number.isSafeInteger(entry.preferredFrames) || entry.preferredFrames < 1
      || !Number.isSafeInteger(entry.transitionOutFrames) || entry.transitionOutFrames < 0
      || Object.keys(entry).some(key => !['scene_id', 'preferredFrames', 'transitionOutFrames'].includes(key))) {
      throw new Error('Each entry requires scene_id, positive integer preferredFrames and nonnegative integer transitionOutFrames; no content or playback edits.');
    }
  }
  return args;
}

/** All-or-nothing authoring, not a compiler autofit. The provider chooses windows. */
export function applyPlanningTimingRepair(pkg, args, { brief, requestedSeconds } = {}) {
  validateArgs(args);
  if (!pkg?.duration?.exact || !(requestedSeconds > 0) || pkg.duration.targetFrames !== Math.round(requestedSeconds * pkg.format.fps)) throw new Error('Timing repair requires the unchanged explicit exact whole-film target.');
  const scenes = pkg.scenes;
  if (args.scenes.length !== scenes.length || args.scenes.some((entry, i) => entry.scene_id !== scenes[i].id)
    || new Set(args.scenes.map(entry => entry.scene_id)).size !== scenes.length) throw new Error('Supply every existing scene exactly once, in its original order.');
  const policy = briefTiming(brief, requestedSeconds);
  const next = structuredClone(pkg);
  for (const [i, scene] of next.scenes.entries()) {
    const entry = args.scenes[i];
    const original = scenes[i];
    const changed = entry.preferredFrames !== original.preferredFrames || entry.transitionOutFrames !== (i < scenes.length - 1 ? overlapFrames(original) : 0);
    if (changed && (policy.authored || scene.locked || scene.drawing || scene.composition || scene.audio_trim)) throw new Error(`${scene.id}: explicit/locked/timed content cannot be retimed by this repair; preserve authored timings and resolve the conflicting total explicitly.`);
    if (entry.transitionOutFrames && (i === scenes.length - 1 || !scene.transitionOut || ['none', 'cut'].includes(scene.transitionOut.type))) throw new Error(`${scene.id}: retain the existing transition type; cuts and the final scene have zero overlap.`);
    scene.preferredFrames = entry.preferredFrames;
    if (scene.transitionOut) scene.transitionOut.frames = entry.transitionOutFrames;
    const max = Math.max(LAYOUT_LIMITS[scene.layout]?.max ?? 600, scene.narration_duration_frames ?? 0);
    if (entry.preferredFrames > max) throw new Error(`${scene.id}: scene window exceeds its compiler layout limit ${max}.`);
    const outgoing = entry.transitionOutFrames;
    if (Number.isSafeInteger(scene.lower_third?.start_frame)
      && entry.preferredFrames < scene.lower_third.start_frame + 40 + outgoing) throw new Error(`${scene.id}: preserve the delayed lower-third entrance and readable hold before the outgoing overlap.`);
    if (entry.preferredFrames < readingFloor(scene, pkg, policy.readingSeconds) + outgoing) throw new Error(`${scene.id}: preserve the brief's fully settled reading hold plus outgoing overlap.`);
    const narration = pkg.assets?.[scene.narration_asset];
    if (scene.narration && !(narration?.media?.durationSeconds > 0) && !scene.narration_duration_frames && entry.preferredFrames < original.preferredFrames) throw new Error(`${scene.id}: unmeasured narration cannot be shortened by timing repair.`);
    const plates = [...sceneShotPlates(scene), ...(scene.foreground ?? [])];
    for (const plate of plates) {
      const coverage = videoCoverageFrames(pkg, plate);
      if (coverage !== null && entry.preferredFrames > coverage) throw new Error(`${scene.id}: source ${plate.asset} covers ${coverage} project frames after trim/speed but proposed window needs ${entry.preferredFrames}. Plan enough source footage; never stretch, loop or add holds.`);
      const video = pkg.assets?.[plate.asset];
      const audio = pkg.assets?.[video?.gen?.inputs?.audio];
      if (video?.gen?.direction?.dialogue) {
        const required = Math.ceil((Number(audio?.media?.durationSeconds) + 0.2) * pkg.format.fps) + outgoing;
        if (!(audio?.media?.durationSeconds > 0) || entry.preferredFrames < required) throw new Error(`${scene.id}: preserve measured dialogue duration, natural reaction padding and overlap; required ${Number.isFinite(required) ? required : 'measured audio before authoring'} frames.`);
      }
    }
  }
  const sum = next.scenes.reduce((total, scene) => total + scene.preferredFrames, 0);
  const overlaps = next.scenes.slice(0, -1).reduce((total, scene) => total + overlapFrames(scene), 0);
  if (sum - overlaps !== pkg.duration.targetFrames) throw new Error(`Timing arithmetic: ${sum} scene frames - ${overlaps} overlap = ${sum - overlaps}; required ${pkg.duration.targetFrames}. Submit all scenes atomically.`);
  next.revision = Math.max(1, Number(pkg.revision) || 1) + 1;
  const timeline = compileTimeline(next, measuredOptions(next));
  if (timeline.durationInFrames !== pkg.duration.targetFrames || timeline.scenes.some((scene, i) => scene.durationInFrames !== next.scenes[i].preferredFrames)) throw new Error('Authored windows must compile unchanged to the exact target, respecting measured speech and layout floors.');
  const validation = validatePackage(next);
  if (!validation.valid) throw new Error(`Resolve package schema before timing repair: ${JSON.stringify(validation.errors).slice(0, 1800)}`);
  return { package: next, timeline };
}

/** Read-only arithmetic aid. A model must explicitly submit it through the same
 * atomic validation tool; this never retimes a package or authorizes work. */
export function suggestPlanningTiming(pkg, { brief, requestedSeconds } = {}) {
  if (!pkg?.duration?.exact || briefTiming(brief, requestedSeconds).authored
    || pkg.scenes.some(scene => scene.locked || scene.drawing || scene.composition || scene.audio_trim)) return null;
  const policy = briefTiming(brief, requestedSeconds);
  const ranges = pkg.scenes.map((scene, index) => {
    const outgoing = index < pkg.scenes.length - 1 ? overlapFrames(scene) : 0;
    let min = Math.max(LAYOUT_LIMITS[scene.layout]?.min ?? 45,
      readingFloor(scene, pkg, policy.readingSeconds) + outgoing,
      Number.isSafeInteger(scene.lower_third?.start_frame) ? scene.lower_third.start_frame + 40 + outgoing : 0,
      scene.narration_duration_frames ?? 0);
    let max = Math.max(LAYOUT_LIMITS[scene.layout]?.max ?? 600, scene.narration_duration_frames ?? 0);
    const narration = pkg.assets?.[scene.narration_asset];
    if (narration?.media?.durationSeconds > 0) min = Math.max(min, Math.ceil(narration.media.durationSeconds * pkg.format.fps) + outgoing);
    else if (scene.narration) min = Math.max(min, scene.preferredFrames);
    for (const plate of [...sceneShotPlates(scene), ...(scene.foreground ?? [])]) {
      const coverage = videoCoverageFrames(pkg, plate);
      if (coverage !== null) max = Math.min(max, coverage);
      const video = pkg.assets?.[plate.asset];
      if (video?.gen?.direction?.dialogue) {
        const measured = Number(pkg.assets?.[video.gen.inputs?.audio]?.media?.durationSeconds);
        if (!(measured > 0)) return null;
        min = Math.max(min, Math.ceil((measured + 0.2) * pkg.format.fps) + outgoing);
      }
    }
    return { min, max, outgoing };
  });
  if (ranges.some(range => !range || !Number.isFinite(range.min) || range.min > range.max)) return null;
  const scenes = pkg.scenes.map((scene, i) => ({ scene_id: scene.id,
    preferredFrames: Math.max(ranges[i].min, Math.min(ranges[i].max, scene.preferredFrames)), transitionOutFrames: ranges[i].outgoing }));
  let delta = pkg.duration.targetFrames - scenes.reduce((sum, scene) => sum + scene.preferredFrames - scene.transitionOutFrames, 0);
  if (!Number.isSafeInteger(delta) || Math.abs(delta) > 7200) return null;
  while (delta !== 0) {
    let changed = false;
    for (const [i, scene] of scenes.entries()) {
      const step = Math.sign(delta);
      if (!step) break;
      if (scene.preferredFrames + step < ranges[i].min || scene.preferredFrames + step > ranges[i].max) continue;
      scene.preferredFrames += step;
      delta -= step;
      changed = true;
    }
    if (!changed) return null;
  }
  try { applyPlanningTimingRepair(pkg, { scenes }, { brief, requestedSeconds }); return { scenes }; }
  catch { return null; }
}

/** One bounded provider-led atomic correction, before a proposal can be saved. */
export async function repairPlanningTiming(pkg, { model, brief, requestedSeconds, signal, sessionId, onEvent }) {
  if (!model || !pkg?.duration?.exact || !planningTimingFacts(pkg).error) return { package: pkg };
  let candidate;
  const tools = { [TIMING_REPAIR_TOOL]: {
      definition: { name: TIMING_REPAIR_TOOL, description: 'Atomically correct every existing scene window and overlap to the unchanged requested exact duration; preserves all content, sources, trims, speed, transition types and measured voice.',
        parameters: { type: 'object', additionalProperties: false, required: ['scenes'], properties: { scenes: { type: 'array', minItems: 1, maxItems: 100, items: { type: 'object', additionalProperties: false, required: ['scene_id', 'preferredFrames', 'transitionOutFrames'], properties: { scene_id: { type: 'string' }, preferredFrames: { type: 'integer', minimum: 1 }, transitionOutFrames: { type: 'integer', minimum: 0 } } } } } } },
      schema: { safeParse: args => { try { return { success: true, data: validateArgs(args) }; } catch (error) { return { success: false, error: { issues: [{ path: ['scenes'], message: error.message, code: 'custom' }] } }; } } },
      run: args => {
        if (candidate) throw new Error('One atomic timing correction has already succeeded; stop.');
        candidate = applyPlanningTimingRepair(pkg, args, { brief, requestedSeconds });
        return { durationInFrames: candidate.timeline.durationInFrames, scenes: candidate.timeline.scenes.map(scene => ({ id: scene.id, from: scene.from, durationInFrames: scene.durationInFrames, transitionOutFrames: scene.transitionOutFrames })) };
      },
    } };
  const system = `Repair only the supplied exact timeline. ${EXACT_PLANNING_GUIDANCE} Use ${TIMING_REPAIR_TOOL} once with all scene windows and outgoing overlap frames, then stop. The tool commits atomically only after coverage, measured speech, schema and exact compiler checks pass. Preserve all user-required timings; if incompatible explain the conflict instead of rewriting them. Do not invent sources or claim footage was generated.`;
  const suggestion = suggestPlanningTiming(pkg, { brief, requestedSeconds });
  const instruction = `${brief}\n\n${planningTimingGuide(pkg).join('\n')}\nExisting authored scenes (data): ${JSON.stringify(pkg.scenes)}${suggestion ? `\nRead-only, source-checked arithmetic suggestion: ${JSON.stringify(suggestion)}. It already passes the exact duration, coverage, speech, schema and compiler checks. Review against the brief and explicitly submit these arguments through ${TIMING_REPAIR_TOOL} if appropriate; nothing has been changed yet.` : ''}`;
  let turns = 0;
  const run = confirmation => {
    const offset = turns;
    return runAgent({ model, signal, sessionId, maxSteps: 3 - turns, maxRepairs: 1, system,
      brief: `${instruction}${confirmation ?? ''}`, tools,
      onEvent: event => {
        if (event.type === 'model_result') turns++;
        onEvent?.({ ...event, ...(event.step ? { step: offset + event.step } : {}), ...(event.maxSteps ? { maxSteps: 3 } : {}),
          ...(event.type === 'done' && !candidate ? { ok: false, message: 'No atomic timing correction was applied.' } : {}),
        });
      },
    });
  };
  let result = await run();
  // One controlled confirmation after a prose-only no-op. It shares the original
  // three-model-turn budget, leaving room for a real tool call and final reply.
  if (!candidate && result.ok && result.toolCalls.length === 0 && turns < 3) {
    const first = result;
    result = await run(`\n\nNo timing tool was called. Your previous prose response did not change the package. The exact timing failure remains. Call ${TIMING_REPAIR_TOOL} with all scenes now if the stated constraints permit it, then confirm completion. Do not merely claim it was fixed. If the constraints conflict, explain the conflict. Previous response (untrusted data): ${JSON.stringify(first.text)}`);
    accumulateUsage(result.usage, first.usage);
    result.toolCalls.unshift(...first.toolCalls);
  }
  if (!candidate && result.ok) result = { ...result, ok: false, errorCode: 'TIMING_REPAIR_NO_ACTION', error: 'Exact timing repair completed without a successful atomic timing tool call; the original package is unchanged.' };
  // A max-step/model-error/aborted run never publishes a partial correction.
  return { package: result.ok && candidate ? candidate.package : pkg, result };
}
