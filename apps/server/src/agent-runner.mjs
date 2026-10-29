// C5: the default CPU agent runner. It wires packages/agent + packages/llm +
// packages/vector. Offline it uses the deterministic scripted model; with a
// provider it uses the live model for both planning and SVG markup.
import { createHash } from 'node:crypto';
import { piRequest, accumulateUsage } from '../../../packages/agent/dist/src/pi-runtime.js';
import { plannedModelContribution, modelContributionPlanProblem, assertGenerationBrief, MODEL_CONTRIBUTION_PROMPT, MODEL_CONTRIBUTION_MESSAGE } from '../../../packages/jobs/src/model-contribution.mjs';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { inlineGeneratedAssets } from '../../renderer/scripts/render-package-lib.mjs';
import { validatePackage } from '../../../packages/schema/src/index.mjs';
import { compileTimeline } from '../../../packages/planner/dist/src/index.js';
import { aspectFromSize, extractBrief, isVideoType } from '../../../packages/agent/dist/src/index.js';
import { classifyAudioIntent } from '../../../packages/agent/dist/src/production-intent.js';
import { durationRangeText, durationWithinTarget } from './duration-policy.mjs';
import { finalizeGeneratedFilmEditorial } from './editorial-finalizer.mjs';
import { finalizeSketchAudio } from './sketch-audio.mjs';
import { isConversationId, loadConversationContext } from './conversation-context.mjs';
import { reviseNarration } from './narration-revision.mjs';
import { reviseProposal } from './proposal-revision.mjs';
import { csvWallProblems, repairCsvWallScenes, recoverCsvWallScene, visualClaimProblems } from './csv-wall-contract.mjs';
import { adoptProductWalkthroughAttachments } from './product-walkthrough.mjs';
import { adoptSuppliedFont } from './supplied-font.mjs';
import {
  adoptMusicVideoAttachments,
  normalizeMusicVideoLyrics,
  requireMusicVideoLyricsOverlap,
  resolveMusicVideoSong,
} from './music-video.mjs';

const SVG_SYSTEM = [
  'You write one standalone SVG document and nothing else.',
  'Use an <svg> root with a viewBox, only the supplied palette colours, and no <script>, <image>, external references or event attributes.',
  'Prefer simple shapes and paths. Keep it under 4 KB.',
].join(' ');

const REPAIR_SYSTEM = [
  'You are Comfyrizz performing one focused repair of an existing generated-film package. The package is already loaded.',
  'Hard rules: do not call storyboard.propose, rebuild the storyboard, replace or regenerate existing assets, change the story, or change the model route.',
  'Workflow: read each issue in the user validation report, make only the edit it requires, then stop. Use storyboard.edit for scene fields such as preferredFrames, copy, notes, narration or motion.cue_phrases. If a shot lacks required generated media or references, create only those missing assets with assets.generate_video or assets.generate_image.',
  'Narration-timed motion: when the brief asks for cue-timed motion, every scene needs a concise scene.narration and motion.cue_phrases copied verbatim from that scene narration.',
  'Never remove or blank scene.narration or motion.cue_phrases while fixing another field: add the narration first, then copy each cue phrase verbatim from it in the same storyboard.edit call.',
  'When the user report supplies an exact narration sentence and cue phrases, copy them exactly: they are already brief-derived, concise and verbatim. Do not paraphrase or invent a replacement line.',
  'A narration-timed scene with empty or whitespace-only narration, or cue_phrases that are not substrings, still fails completion even when its media, timing and aspect are correct.',
  'Explicit Klein medium: every shot needs its own scene-referenced FLUX 3 Image Klein still before the film is accepted. Plan it with assets.generate_video using motion_model klein; keep stills + code motion and never create H3/LTX jobs.',
  'Aspect and format: the package format must match the brief aspect and output size. When the repair facts report a brief/draft aspect mismatch, correct the package format without changing the story or model route.',
  'Source aspect: when the repair facts report a scene-referenced still whose dimensions do not match the package output, re-plan that still with assets.generate_image at the output size and pass the new asset to assets.generate_video. Never keep a mismatched still as the shot source or plan a 16:9 source for a portrait/square output.',
  'Tool errors: for invalid_arguments, correct only the fields named in issues[].path and resend; for tool_failed, supply the prerequisite the message names. Never resend identical arguments.',
  'When the listed issues are fixed, stop calling tools and reply with one short sentence.',
].join('\n');

const MOTION_GRAPHICS_REPAIR_SYSTEM = [
  'You are Comfyrizz performing one focused repair of an existing motion-graphics package. The package is already loaded.',
  'Hard rules: do not call storyboard.propose, rebuild the storyboard, replace existing ready assets, change the story, or change the model route.',
  'Workflow: read each issue in the user validation report. Use storyboard.add_scene to append missing scenes before drawing them; preserve existing scenes and the requested evolving subject. Use storyboard.draw or storyboard.extend_drawing for their geometry, and storyboard.edit for scene fields. Meet the compiled duration including transition overlaps; add meaningful story scenes instead of stretching an incomplete scene. Create assets only when the report explicitly requires them; never substitute GPU assets for a required drawing.',
  'For a data story, use storyboard.csv_dataset to bind grouped chart counts to the scoped CSV and storyboard.csv_tile_wall for a requested one-mark-per-source-row wall. Explicitly map essential categories, use require_categories, and review uncategorized results. Inspect only source rows and query results needed to verify claims; batch independent CSV queries, scene edits and asset calls. Do not page through the entire CSV or restart research already supported by the supplied context. Leave time within the step budget to complete the requested visual and finish.',
  'For unapproved example datasets, use storyboard.remove_example_dataset with truthful, source-backed replacement copy and narration for every dependent scene. Do not approve invented values or relabel them as user data. Remove unsupported claims elsewhere too. Preserve the existing package and assets.',
  'Tool errors: for invalid_arguments, correct only the fields named in issues[].path and resend; for tool_failed, supply the prerequisite the message names. Never resend identical arguments.',
  'When the listed issues are fixed, stop calling tools and reply with one short sentence.',
].join('\n');

// One admission retry: initial planning restricts it to the first turn; repair
// can use it on any one turn. Never replay any response containing output.
function withAdmissionRetry(model, { firstTurnOnly, wait = (ms, signal) => new Promise(resolve => {
  if (signal.aborted) return resolve();
  const timer = setTimeout(done, ms);
  function done() { clearTimeout(timer); signal.removeEventListener('abort', done); resolve(); }
  signal.addEventListener('abort', done, { once: true });
}), onRetry } = {}) {
  let available = true;
  return {
    id: model.id, imageInput: model.imageInput, capabilities: model.capabilities,
    contextWindow: model.contextWindow,
    async *stream(request) {
      const eligible = available;
      if (firstTurnOnly) available = false;
      if (!eligible) { yield* model.stream(request); return; }
      let error = null;
      let output = false;
      const buffered = [];
      for await (const chunk of model.stream(request)) {
        if (chunk.type === 'error' && !error) error = chunk;
        else if (chunk.type !== 'done') output = true;
        if (error) buffered.push(chunk);
        else yield chunk;
      }
      const seconds = /\bafter\s+(\d+(?:\.\d+)?)\s*s(?:ec(?:onds?)?)?\b/i.exec(error?.message ?? '');
      const delays = [seconds ? Number(seconds[1]) * 1000 : undefined, error?.retryAfterMs]
        .filter(value => typeof value === 'number' && Number.isFinite(value));
      const delayMs = delays.length ? Math.max(...delays) : NaN;
      if (!output && error?.code === 'http_429' && /\bttft_admission_refused\b/i.test(error.message ?? '')
        && Number.isFinite(delayMs) && delayMs > 0 && delayMs <= 30000 && !request.signal.aborted
        && (firstTurnOnly || available)) {
        available = false;
        onRetry?.(delayMs);
        await wait(delayMs, request.signal);
        if (!request.signal.aborted) { yield* model.stream(request); return; }
      }
      yield* buffered;
    },
  };
}

export function withInitialAdmissionRetry(model, options = {}) {
  return withAdmissionRetry(model, { ...options, firstTurnOnly: true });
}

export function withRepairAdmissionRetry(model, options = {}) {
  return withAdmissionRetry(model, { ...options, firstTurnOnly: false });
}

function extractSvg(text) {
  const match = /<svg[\s\S]*?<\/svg>/i.exec(text);
  return match ? match[0] : null;
}

const FASTH3_WORKFLOW = 'workflows/fasth3_omni_ref2va.api.json';
const LTX_I2V_WORKFLOW = 'workflows/ltx25_i2v_2stage.api.json';

function hasCopy(copy) {
  return Boolean(copy) && typeof copy === 'object' && Object.values(copy).some(value =>
    Array.isArray(value) ? value.length > 0 : typeof value === 'string' ? value.trim().length > 0 : value != null,
  );
}

export function packageSchemaProblems(pkg) {
  const validation = validatePackage(pkg);
  if (validation.valid) return [];
  return validation.errors.map((issue, index) => {
    if (typeof issue === 'string') return issue;
    const path = issue.path ?? issue.instancePath ?? `package[${index}]`;
    const message = issue.message ?? JSON.stringify(issue).slice(0, 300);
    return `${path}: ${message}${issue.code ? ` [${issue.code}]` : ''}`;
  });
}

function plannedTimelineFrames(pkg) {
  const scenes = Array.isArray(pkg?.scenes) ? pkg.scenes : [];
  const fallback = scenes.reduce((sum, scene) => sum + (Number(scene?.preferredFrames) || 0), 0);
  try {
    const frames = Number(compileTimeline(pkg).durationInFrames);
    return Number.isFinite(frames) && frames >= 0 ? frames : fallback;
  } catch {
    return fallback;
  }
}

export function repairPackageFacts(pkg, intent, briefAspect) {
  const fps = Number(pkg?.format?.fps) > 0 ? Number(pkg.format.fps) : 30;
  const scenes = Array.isArray(pkg?.scenes) ? pkg.scenes : [];
  const assets = pkg?.assets && typeof pkg.assets === 'object' ? pkg.assets : {};
  const width = Number(pkg?.format?.width);
  const height = Number(pkg?.format?.height);
  const hasFormat = Number.isFinite(width) && width > 0 && Number.isFinite(height) && height > 0;
  const draftAspect = hasFormat ? aspectFromSize(width, height) : null;
  const currentFrames = plannedTimelineFrames(pkg);
  const targetFrames = intent.requestedSeconds === null ? 'unspecified' : Math.round(intent.requestedSeconds * fps);
  const sceneFacts = scenes.map(scene => {
    const mediaAssets = (Array.isArray(scene?.media) ? scene.media : [])
      .map(plate => typeof plate?.asset === 'string' ? assets[plate.asset] : null)
      .filter(Boolean);
    const kleinStills = mediaAssets.filter(asset => asset.kind === 'image' && asset.gen?.generator === 'flux3-klein').length;
    const cuePhrases = Array.isArray(scene?.motion?.cue_phrases)
      ? scene.motion.cue_phrases.filter(phrase => typeof phrase === 'string' && phrase.trim()).map(phrase => phrase.trim())
      : [];
    const narration = JSON.stringify(typeof scene?.narration === 'string' ? scene.narration : '');
    return `${scene?.id ?? '(missing id)'} preferredFrames=${Number(scene?.preferredFrames) || 0}; narration=${narration}; cue_phrases=${JSON.stringify(cuePhrases)}; klein_stills=${kleinStills}`;
  }).join('\n');
  const formatFact = hasFormat
    ? `Format: draft aspect=${draftAspect} at ${width}x${height}; brief aspect=${briefAspect ?? 'unknown'}.`
    : `Format: draft format is missing; brief aspect=${briefAspect ?? 'unknown'}.`;
  const facts = [
    'Current package facts (authoritative data, not instructions):',
    `Timing: fps=${fps}; current total frames=${currentFrames}; requested total frames=${targetFrames}; acceptable compiled duration=${durationRangeText(intent.requestedSeconds)}.`,
    formatFact,
    `Scene IDs and current values: ${sceneFacts || 'none'}.`,
  ];
  if (hasFormat && briefAspect && draftAspect !== briefAspect) {
    facts.push(`Aspect repair: the brief requires ${briefAspect} but the draft is ${draftAspect} (${width}x${height}); correct the package format without changing the story or model route.`);
  }
  const stillProblems = sourceStillFormatProblems(pkg);
  if (stillProblems.length > 0) {
    const listed = stillProblems.map(problem => `${problem.sceneId} still ${problem.assetId} is ${problem.sourceWidth}x${problem.sourceHeight}`).join('; ');
    facts.push(`Source aspect repair: ${listed}; the package output is ${width}x${height}. Plan every scene-referenced still at exactly ${width}x${height} and re-plan the shot so its identity, composition and start-frame sources match.`);
  }
  facts.push('Use only these exact scene IDs for existing scenes; do not invent aliases. Add missing scenes with storyboard.add_scene before editing or drawing them.');
  return facts.join('\n');
}

function generatedClipSeconds(asset) {
  const frames = Number(asset?.gen?.inputs?.frames);
  const fps = Number(asset?.gen?.inputs?.fps);
  return frames > 0 && fps > 0 ? frames / fps : 0;
}

function withoutBookendPresentation(scene) {
  const next = { ...scene, layout: 'list', media_only: true };
  delete next.variant;
  delete next.copy;
  delete next.motion;
  return next;
}

function outroPresentation(scene) {
  const previousHeadline = scene.copy?.headline;
  return {
    ...scene,
    variant: 'outro',
    copy: {
      ...(scene.copy ?? {}),
      ...(previousHeadline && !scene.copy?.kicker ? { kicker: previousHeadline } : {}),
      headline: 'The End',
    },
    motion: { ...(scene.motion ?? {}), recipe: scene.motion?.recipe ?? 'kinetic', entry: 'fadeUp' },
  };
}

/** Split under-covered pending scenes into real generation shots before validation. */
export function coverGeneratedFilmScenes(pkg) {
  if (!pkg || !Array.isArray(pkg.scenes)) return { package: pkg, splits: 0 };
  const next = structuredClone(pkg);
  next.assets = next.assets && typeof next.assets === 'object' ? next.assets : {};
  const scenes = [];
  const replacedAssetIds = new Set();
  let splits = 0;
  const originalSceneCount = next.scenes.length;
  for (let sceneIndex = 0; sceneIndex < next.scenes.length; sceneIndex += 1) {
    const scene = next.scenes[sceneIndex];
    const fps = Number(next.format?.fps) > 0 ? Number(next.format.fps) : 30;
    const sceneFrames = Number(scene?.preferredFrames) || 0;
    const sceneSeconds = sceneFrames / fps;
    const plates = Array.isArray(scene?.media) ? scene.media : [];
    const videoPlates = plates.filter(plate => {
      const asset = next.assets?.[plate?.asset];
      return asset?.status === 'pending' && asset?.kind === 'video' && ['fasth3-omni', 'ltx25'].includes(asset?.gen?.generator);
    });
    const uniqueAssetIds = [...new Set(videoPlates.map(plate => plate.asset))];
    const template = uniqueAssetIds.length === 1 ? next.assets[uniqueAssetIds[0]] : null;
    const clipSeconds = generatedClipSeconds(template);
    const sourceFps = Number(template?.gen?.inputs?.fps) > 0 ? Number(template.gen.inputs.fps) : 24;
    if (!template || clipSeconds <= 0 || sceneSeconds <= 0 || sceneSeconds <= clipSeconds + 1 / sourceFps) {
      scenes.push(scene);
      continue;
    }
    const partCount = Math.min(40, Math.ceil(sceneSeconds / clipSeconds));
    const templateAssetId = uniqueAssetIds[0];
    const templatePlate = videoPlates[0];
    for (let part = 0; part < partCount; part += 1) {
      const suffix = `${scene.id}:${templateAssetId}:${part + 1}`;
      const digest = createHash('sha256').update(suffix).digest('hex').slice(0, 16);
      const assetId = `a_vid_${digest}`;
      const asset = structuredClone(template);
      if (Number.isFinite(Number(asset.gen?.inputs?.seed))) asset.gen.inputs.seed = Number(asset.gen.inputs.seed) + part;
      next.assets[assetId] = asset;
      const media = { ...templatePlate, asset: assetId };
      delete media.speed;
      delete media.holdFrames;
      let partScene = {
        ...scene,
        id: `${scene.id}__part${part + 1}`,
        preferredFrames: Math.floor(sceneFrames / partCount) + (part < sceneFrames % partCount ? 1 : 0),
        media: [media],
      };
      if (part > 0) {
        // A long editorial line belongs to the first part only. Continuations
        // remain footage-only instead of synthesizing the same sentence again.
        delete partScene.narration;
        delete partScene.narration_asset;
        delete partScene.narration_duration_frames;
        if (partScene.motion) {
          partScene.motion = { ...partScene.motion };
          delete partScene.motion.cue_phrases;
        }
      }
      const centered = scene.layout === 'title' && scene.variant === 'centered';
      const outro = scene.layout === 'title' && scene.variant === 'outro';
      const originalFirst = sceneIndex === 0;
      const originalLast = sceneIndex === originalSceneCount - 1;
      if (centered && originalFirst && originalLast && partCount > 1 && part === partCount - 1) {
        partScene = outroPresentation(partScene);
      } else if ((centered || outro)
        && !((centered && originalFirst && part === 0) || (outro && originalLast && part === partCount - 1))) {
        partScene = withoutBookendPresentation(partScene);
      }
      scenes.push(partScene);
    }
    replacedAssetIds.add(templateAssetId);
    splits += 1;
  }
  if (splits === 0) return { package: pkg, splits: 0 };
  next.scenes = scenes;
  if (next.scenes.length > 0) delete next.scenes[next.scenes.length - 1].transitionOut;
  for (const assetId of replacedAssetIds) {
    const used = scenes.some(scene => (Array.isArray(scene?.media) ? scene.media : []).some(plate => plate?.asset === assetId));
    if (!used) delete next.assets[assetId];
  }
  next.revision = Math.max(1, Number(next.revision) || 1) + 1;
  return { package: next, splits };
}

function liveActionText(value) {
  return String(value)
    .replace(/handmade\s+plasticine/gi, 'photorealistic live-action')
    .replace(/plasticine/gi, 'natural human')
    .replace(/stop[\s-]motion/gi, 'live-action')
    .replace(/claymation/gi, 'live-action')
    .replace(/clay\s+figures?/gi, 'fictional human adult')
    .replace(/clay/gi, 'real-world')
    .replace(/puppets?/gi, 'human')
    .replace(/cartoons?/gi, 'live-action')
    .replace(/handmade/gi, 'real-world')
    .replace(/miniatures?/gi, 'full-scale set')
    .replace(/3D\s+render/gi, 'cinematic photography');
}

function sanitizeLiveActionValue(value) {
  if (typeof value === 'string') return liveActionText(value);
  if (Array.isArray(value)) return value.map(sanitizeLiveActionValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, sanitizeLiveActionValue(item)]));
  }
  return value;
}

/** Correct a model's forbidden style substitution instead of rejecting it forever. */
export function enforceLiveActionHumans(pkg) {
  if (!pkg || typeof pkg !== 'object') return { package: pkg, changed: false };
  const next = sanitizeLiveActionValue(pkg);
  next.title = liveActionText(next.title ?? 'Live-action film');
  if (next.proposal && typeof next.proposal === 'object') {
    next.proposal.look = 'Photorealistic live-action humans, natural skin and real-world materials.';
  }
  for (const asset of Object.values(next.assets ?? {})) {
    if (typeof asset?.gen?.inputs?.prompt === 'string') {
      asset.gen.inputs.prompt = `Photorealistic live-action fictional human adults with natural skin and real-world materials. ${asset.gen.inputs.prompt}`;
    }
    if (typeof asset?.gen?.direction?.subject === 'string') {
      asset.gen.direction.subject = `Photorealistic fictional human adult: ${asset.gen.direction.subject}`;
    }
  }
  const changed = JSON.stringify(next) !== JSON.stringify(pkg);
  if (changed) next.revision = Math.max(1, Number(next.revision) || 1) + 1;
  return { package: changed ? next : pkg, changed };
}

function liveActionStyleConflict(pkg) {
  const texts = [pkg?.title, pkg?.proposal?.look];
  for (const asset of Object.values(pkg?.assets ?? {})) {
    texts.push(asset?.gen?.inputs?.prompt, asset?.gen?.direction?.subject, asset?.gen?.direction?.composition);
  }
  const pattern = /\b(?:clay(?:mation)?|plasticine|stop[\s-]motion|puppets?|cartoons?|handmade(?:\s+miniatures?)?)\b/ig;
  for (const text of texts.filter(value => typeof value === 'string')) {
    for (const match of text.matchAll(pattern)) {
      const prefix = text.slice(Math.max(0, (match.index ?? 0) - 30), match.index);
      if (!/\b(?:no|not|without|avoid)\s+(?:[\w-]+\s+){0,2}$/i.test(prefix)) return match[0];
    }
  }
  return null;
}

/**
 * A narration-timed brief can still say the picture has no native dialogue.
 * That is a sound constraint, not a request to drop narration; only an
 * explicit wordless/no-narration request suppresses narration-timed planning.
 */
function explicitlyWordless(brief) {
  // A no-native-dialogue constraint can coexist with separate voiceover.
  // Every explicit speech prohibition or full-silence request still wins.
  return classifyAudioIntent(String(brief ?? '').replace(/\b(?:no|without)\s+(?:native\s+)?dialogue\b/gi, '')).wordless;
}

/** The brief the tools actually receive; keep narration on narration-timed briefs. */
function planningBriefForNarration(brief, intent) {
  if (!intent.requiresNarrationCues || explicitlyWordless(brief) || !intent.wordless) return brief;
  return brief
    .replace(/\bno\s+native\s+dialogue\b/gi, 'picture-only audio')
    .replace(/\bno\s+(?:dialogue|speech|voice[\s-]?over)\b/gi, 'picture-only audio');
}

/** Narration-timed wording wins over a no-native-dialogue sound constraint. */
function narrationTimedIntent(intent, brief) {
  if (!intent.requiresNarrationCues || explicitlyWordless(brief) || !intent.wordless) return intent;
  return { ...intent, wordless: false };
}

/** A concise, brief-derived sentence the model can copy verbatim. */
function conciseNarration(text) {
  const normalized = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (!normalized) return '';
  const sentence = /^[^.!?]{1,180}[.!?]/.exec(normalized)?.[0]?.trim() ?? normalized.slice(0, 180).trim();
  return /[.!?]$/.test(sentence) ? sentence : `${sentence}.`;
}

/** Cue phrases stay substrings of the narration, so they can be copied verbatim. */
function cuePhrasesFromNarration(narration, index) {
  const words = narration.split(/\s+/).filter(Boolean);
  const phrase = words.length <= 2
    ? narration
    : index % 2 === 0
      ? words.slice(0, 2).join(' ')
      : words.slice(-2).join(' ');
  const cleaned = phrase.replace(/^[^\w]+|[^\w]+$/g, '').trim();
  return cleaned ? [cleaned.slice(0, 600)] : [];
}

function briefNarrationFallback(brief) {
  const sentences = String(brief ?? '').split(/(?<=[.!?])\s+/).map(sentence => sentence.trim()).filter(Boolean);
  const descriptive = sentences.find(sentence => !/^(?:create|make|generate|render|produce|draw|plan)\b/i.test(sentence)
    && !/narration-timed|cue_phrases|finishing sound plan|no narration|wordless|no dialogue|no captions/i.test(sentence));
  if (!descriptive) return '';
  const topic = descriptive
    .replace(/^(?:one|two|three|four|five|six|seven|eight|nine|ten|\d+)\s+/i, '')
    .replace(/\bscenery[\s-]+only\b/gi, 'scenery')
    .replace(/\bshots?\b/gi, '')
    .replace(/\bno people\b/gi, '')
    .replace(/[,.;]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (topic.split(' ').filter(Boolean).length < 3) return '';
  return conciseNarration(`${topic.charAt(0).toUpperCase()}${topic.slice(1)} unfolds in this shot`);
}

/** The exact narration/cues a repair should use when a scene is still blank. */
function narrationSuggestion(brief, pkg, scene, index) {
  const existing = typeof scene?.narration === 'string' ? scene.narration.trim() : '';
  if (existing) return { narration: existing, cuePhrases: cuePhrasesFromNarration(existing, index) };
  const logline = conciseNarration(pkg?.proposal?.logline ?? '');
  const usableLogline = logline && !/^A story built from your idea\.?$/i.test(logline) ? logline : '';
  const fallback = usableLogline
    || briefNarrationFallback(brief)
    || conciseNarration(`${String(pkg?.title ?? 'The story').trim()} continues in this shot`);
  return { narration: fallback, cuePhrases: cuePhrasesFromNarration(fallback, index) };
}

/** A narration-timed repair must fix narration and cue phrases together, per scene. */
function narrationRepairGuide(pkg, intent, brief) {
  if (!intent.requiresNarrationCues || intent.wordless) return [];
  const scenes = Array.isArray(pkg?.scenes) ? pkg.scenes : [];
  const lines = ['Narration-timed repair (hard requirement from the brief): every scene needs scene.narration plus motion.cue_phrases copied verbatim from that narration.'];
  for (const [index, scene] of scenes.entries()) {
    const sceneId = scene?.id ?? '(missing id)';
    const narration = typeof scene?.narration === 'string' ? scene.narration.trim() : '';
    const cuePhrases = Array.isArray(scene?.motion?.cue_phrases)
      ? scene.motion.cue_phrases.filter(phrase => typeof phrase === 'string' && phrase.trim())
      : [];
    const suggestion = narrationSuggestion(brief, pkg, scene, index);
    const edit = `{scene_id:${JSON.stringify(sceneId)},patch:{narration:${JSON.stringify(suggestion.narration)},motion:{cue_phrases:${JSON.stringify(suggestion.cuePhrases)}}}}`;
    if (!narration) {
      lines.push(`- ${sceneId}: scene.narration is missing. Call storyboard.edit ${edit} before any asset call. That sentence is concise and brief-derived, and each cue phrase is already a verbatim substring.`);
    } else if (cuePhrases.length === 0) {
      lines.push(`- ${sceneId}: motion.cue_phrases is missing. Keep the narration unchanged and copy exact phrases from it; for example use motion:{cue_phrases:${JSON.stringify(suggestion.cuePhrases)}} (verbatim).`);
    } else if (cuePhrases.some(phrase => !narration.includes(phrase))) {
      lines.push(`- ${sceneId}: every motion.cue_phrases entry must be copied verbatim from its scene.narration; keep the narration unchanged. Replace them with motion:{cue_phrases:${JSON.stringify(suggestion.cuePhrases)}} (verbatim).`);
    }
  }
  if (lines.length === 1) return [];
  lines.push('Do not remove or blank scene.narration or motion.cue_phrases when fixing any other field.');
  return lines;
}

/** M10: the brief can require one shared fictional mascot across every scene. */
const SHARED_MASCOT_BRIEF_RE = /use the same mascot in every scene/i;
const CAST_ID_RE = /^c[A-Za-z0-9_-]{0,63}$/;

function briefRequiresSharedMascot(brief) {
  return SHARED_MASCOT_BRIEF_RE.test(String(brief ?? ''));
}

/** The existing fictional mascot id, never a newly invented real person. */
function sharedMascotCastId(pkg) {
  const members = (Array.isArray(pkg?.cast) ? pkg.cast : [])
    .filter(member => member && typeof member.id === 'string' && CAST_ID_RE.test(member.id));
  if (members.length > 0) return members[0].id;
  const counts = new Map();
  for (const scene of Array.isArray(pkg?.scenes) ? pkg.scenes : []) {
    for (const id of Array.isArray(scene?.cast) ? scene.cast : []) {
      if (typeof id === 'string' && CAST_ID_RE.test(id)) counts.set(id, (counts.get(id) ?? 0) + 1);
    }
  }
  let best = null;
  for (const [id, count] of counts) if (!best || count > best.count) best = { id, count };
  // PS01's shared mascot id is the last-resort fictional default, never a person.
  return best?.id ?? 'c_pip';
}

/** Missing or divergent scene.cast under a shared-mascot brief. */
function sharedMascotGap(pkg, brief) {
  if (!briefRequiresSharedMascot(brief)) return null;
  const scenes = Array.isArray(pkg?.scenes) ? pkg.scenes : [];
  if (scenes.length === 0) return null;
  const castId = sharedMascotCastId(pkg);
  const castRecorded = (Array.isArray(pkg?.cast) ? pkg.cast : [])
    .some(member => member && member.id === castId);
  const sceneIds = scenes
    .filter(scene => !(Array.isArray(scene?.cast) && scene.cast.includes(castId)))
    .map(scene => scene?.id ?? '(unknown scene)');
  if (castRecorded && sceneIds.length === 0) return null;
  return { castId, castRecorded, sceneIds };
}

function sharedMascotProblem(gap) {
  const edits = gap.sceneIds
    .map(sceneId => `{scene_id:${JSON.stringify(sceneId)},patch:{cast:[${JSON.stringify(gap.castId)}]}}`)
    .join(', ');
  const listed = gap.sceneIds.length > 0 ? `; missing from ${gap.sceneIds.join(', ')}` : '';
  const subject = gap.castRecorded
    ? `shared mascot cast ${JSON.stringify(gap.castId)} must appear in every scene${listed}`
    : `the brief requires the same mascot in every scene but the package records no shared fictional cast ${JSON.stringify(gap.castId)}${listed || '; every scene already names it, so restore that cast entry'}`;
  const instruction = edits
    ? ` Call storyboard.edit with ${edits} so every scene shares that exact fictional cast id; never substitute a real person.`
    : ' Keep that exact fictional cast id on every scene and restore its cast entry; never substitute a real person.';
  return `${subject}.${instruction}`;
}

/** A shared-mascot repair must restore one fictional cast id on every scene. */
function sharedMascotRepairGuide(pkg, brief) {
  const gap = sharedMascotGap(pkg, brief);
  if (!gap) return [];
  return [
    'Shared-mascot repair (hard requirement from the brief): every scene must carry the same one fictional mascot cast id; never a real person or user photo.',
    `- SHARED_CAST_MISSING: ${sharedMascotProblem(gap)}`,
    'Do not remove or blank the shared cast id from any scene while fixing another field.',
  ];
}

function sceneReferencedPendingStills(pendingGpu) {
  return (Array.isArray(pendingGpu) ? pendingGpu : []).filter(item => typeof item?.sceneId === 'string' && item.sceneId.length > 0);
}

/** Pending source stills a scene actually depends on, including shot input references. */
function sourceImageIdsForScene(scene, assets) {
  const ids = new Set();
  const addImage = value => {
    if (typeof value !== 'string') return;
    if (assets[value]?.kind === 'image') ids.add(value);
  };
  const addReferenced = value => {
    if (typeof value !== 'string') return;
    const asset = assets[value];
    if (asset?.kind === 'video') {
      for (const input of Object.values(asset?.gen?.inputs ?? {})) addImage(input);
    } else {
      addImage(value);
    }
  };
  for (const plate of Array.isArray(scene?.media) ? scene.media : []) addReferenced(plate?.asset);
  addReferenced(scene?.background?.asset);
  for (const item of Array.isArray(scene?.foreground) ? scene.foreground : []) addReferenced(item?.asset);
  addReferenced(scene?.presenter_asset);
  return ids;
}

/** Every source still must match the output exactly; otherwise i2v crops the shot. */
function sourceStillFormatProblems(pkg) {
  const width = Number(pkg?.format?.width);
  const height = Number(pkg?.format?.height);
  if (!(Number.isFinite(width) && width > 0 && Number.isFinite(height) && height > 0)) return [];
  const scenes = Array.isArray(pkg?.scenes) ? pkg.scenes : [];
  const assets = pkg?.assets && typeof pkg.assets === 'object' ? pkg.assets : {};
  const problems = [];
  for (const scene of scenes) {
    const sceneId = scene?.id ?? '(unknown scene)';
    for (const assetId of sourceImageIdsForScene(scene, assets)) {
      const asset = assets[assetId];
      if (asset?.status !== 'pending') continue;
      const sourceWidth = Number(asset?.gen?.inputs?.width ?? asset?.media?.width);
      const sourceHeight = Number(asset?.gen?.inputs?.height ?? asset?.media?.height);
      if (!(sourceWidth > 0 && sourceHeight > 0)) continue;
      if (sourceWidth === width && sourceHeight === height) continue;
      problems.push({
        sceneId,
        assetId,
        sourceWidth,
        sourceHeight,
        outputWidth: width,
        outputHeight: height,
        message: `${sceneId}: source still ${assetId} is ${sourceWidth}x${sourceHeight}, but the package output is ${width}x${height}; plan it at exactly ${width}x${height}`,
      });
    }
  }
  return problems;
}

function motionGraphicsRepairGuide(slice, problems) {
  const codes = new Set(problems.map(problem => problem.code));
  const unapproved = Object.entries(slice?.package?.datasets ?? {}).filter(([, dataset]) => dataset?.source === 'example' && dataset.approved !== true);
  const plateIssues = problems.flatMap(problem => {
    if (problem.code !== 'PACKAGE_SCHEMA') return [];
    const match = /^\/scenes\/(\d+)\/media:.*\[SEM_LAYOUT_REQUIRES_MEDIA\]$/.exec(problem.message);
    const scene = match && slice?.package?.scenes?.[Number(match[1])];
    return scene?.id ? [scene] : [];
  });
  if (!codes.has('PENDING_GPU_MISSING') && unapproved.length === 0 && plateIssues.length === 0) return [];
  const sceneReferenced = sceneReferencedPendingStills(slice?.pendingGpu);
  const targetScene = Array.isArray(slice?.package?.scenes) && slice.package.scenes[0]?.id ? slice.package.scenes[0].id : 's1';
  const lines = ['Motion-graphics repair guidance (hard requirements from the validation report):'];
  for (const scene of plateIssues) {
    lines.push(`- Scene ${JSON.stringify(scene.id)} uses ${JSON.stringify(scene.layout)}, which requires two actual media plates when this scene has no drawing. A background, SVG overlay or drawing in another scene is not two plates. If a drawing is intended here, use storyboard.draw or storyboard.csv_tile_wall on this scene; a drawing replaces its layout. Otherwise call storyboard.edit with scene_id ${JSON.stringify(scene.id)} and patch {"layout":"list"}, or choose another suitable existing layout with its required fields. If two plates are essential, attach two appropriate real plates. Preserve source bindings, data, narration, timing and story; do not invent or duplicate media to satisfy validation.`);
  }
  for (const [id] of unapproved) {
    const references = (slice.package.scenes ?? []).filter(scene => scene?.data?.dataset === id).map(scene => scene.id);
    lines.push(`- Unapproved example dataset ${JSON.stringify(id)}: call storyboard.remove_example_dataset for it with replacements for exactly these dependent scenes: ${JSON.stringify(references)}. Use only facts supported by the brief or supplied source; omit unsupported numbers and claims. Rewrite affected narration as needed. Do not set approved or change provenance.`);
  }
  if (codes.has('PENDING_GPU_MISSING') && sceneReferenced.length < 1) {
    lines.push(`- Pending GPU still repair: call assets.generate_image with scene_id "${targetScene}" and a scene kind such as illustration, texture or background. Do not pass refs and do not use reference, identity, cast, portrait or start-frame kinds; those are reference-only and do not satisfy this floor.`);
  }
  return lines;
}

/** Completion is shot-reachable: orphan pending GPU assets never satisfy it. */
export function generatedFilmCompletionProblems(pkg, intent, motionModel = 'auto', brief = null) {
  const problems = [];
  const scenes = Array.isArray(pkg?.scenes) ? pkg.scenes : [];
  const assets = pkg?.assets && typeof pkg.assets === 'object' ? pkg.assets : {};
  if (scenes.length === 0) return ['generated film has no scenes/shots'];
  const sharedGap = sharedMascotGap(pkg, brief);
  if (sharedGap) problems.push(`SHARED_CAST_MISSING: ${sharedMascotProblem(sharedGap)}`);
  for (const still of sourceStillFormatProblems(pkg)) problems.push(still.message);
  const proposal = pkg?.proposal;
  for (const field of ['logline', 'look', 'soundtrack']) {
    if (typeof proposal?.[field] !== 'string' || proposal[field].trim().length < 3) {
      problems.push(`proposal.${field} is required: give the user a specific, concise creative direction`);
    }
  }
  if (proposal?.logline === 'A story built from your idea.') problems.push('proposal.logline must describe the actual story, not a generic fallback');
  if (intent.liveActionHumans) {
    const conflict = liveActionStyleConflict(pkg);
    if (conflict) problems.push(`live-action real-human brief conflicts with ${conflict} styling; use photorealistic fictional humans, natural skin and real-world materials in the proposal and every asset prompt`);
  }
  const fps = Number(pkg?.format?.fps) > 0 ? Number(pkg.format.fps) : 30;
  if (pkg?.duration?.exact) {
    try { compileTimeline(pkg); } catch (error) { problems.push(error.message); }
  }
  const plannedSeconds = plannedTimelineFrames(pkg) / fps;
  if (intent.requestedSeconds !== null && !durationWithinTarget(plannedSeconds, intent.requestedSeconds)) {
    problems.push(`brief requests ${intent.requestedSeconds} seconds but the plan is ${plannedSeconds.toFixed(2)} seconds; acceptable range is ${durationRangeText(intent.requestedSeconds)}; adjust scene frames before production`);
  }
  const narrated = scenes.some(scene => typeof scene?.narration === 'string' && scene.narration.trim());
  if (intent.narrationRequested && !intent.wordless && !narrated) {
    problems.push('brief requests Kokoro voiceover but scene.narration is missing; add concise scene-specific narration before production');
  }
  if (narrated && !intent.wordless && (pkg?.voice?.enabled !== true || !pkg?.voice?.engine || pkg.voice.engine === 'none')) {
    problems.push('narrated film requires an enabled finishing voice (Kokoro by default) before production');
  }
  if (intent.musicRequested) {
    const musicId = pkg?.audio?.music?.asset;
    const music = typeof musicId === 'string' ? assets[musicId] : null;
    if (!music || music.kind !== 'audio' || music.status !== 'ready' || typeof music.file !== 'string' || typeof music.sha256 !== 'string') {
      problems.push('brief requests music but no ready whole-film music asset is configured; add the deterministic instrumental finishing stem before production');
    }
  }
  if (intent.bookends) {
    const first = scenes[0];
    const last = scenes.at(-1);
    if (first?.layout !== 'title' || first?.variant !== 'centered' || first?.media_only === true || !hasCopy(first?.copy)) {
      problems.push('generated film requires a visible editable Remotion opening title');
    }
    if (last?.layout !== 'title' || last?.variant !== 'outro' || last?.media_only === true || !hasCopy(last?.copy)) {
      problems.push('generated film requires a visible editable Remotion closing title');
    }
  }
  if (motionModel === 'klein' && !/stills \+ code motion/i.test((pkg?.compliance?.warnings ?? []).join(' '))) {
    problems.push('Klein proposal must explicitly say stills + code motion');
  }
  for (const scene of scenes) {
    const sceneId = scene?.id ?? '(unknown scene)';
    const narrationContinuation = /__part[2-9]\d*$/.test(sceneId) && !scene?.narration;
    if (intent.requiresNarrationCues && !intent.wordless && !narrationContinuation) {
      if (typeof scene?.narration !== 'string' || !scene.narration.trim()) {
        problems.push(`${sceneId}: narration-timed motion graphics require a concise scene.narration sentence`);
      } else if (!Array.isArray(scene?.motion?.cue_phrases) || scene.motion.cue_phrases.filter(phrase => typeof phrase === 'string' && phrase.trim()).length === 0) {
        problems.push(`${sceneId}: narration-timed motion graphics require motion.cue_phrases copied verbatim from this scene's narration`);
      } else if (scene.motion.cue_phrases.some(phrase => typeof phrase !== 'string' || !phrase.trim() || !scene.narration.includes(phrase))) {
        problems.push(`${sceneId}: every motion.cue_phrases entry must be copied verbatim from this scene's narration`);
      }
    }
    const mediaPlates = Array.isArray(scene?.media) ? scene.media : [];
    const mediaAssets = mediaPlates
      .map(plate => typeof plate?.asset === 'string' ? assets[plate.asset] : null)
      .filter(Boolean);
    const videos = mediaAssets.filter(asset => asset.kind === 'video' && ['fasth3-omni', 'ltx25'].includes(asset.gen?.generator));
    if (hasCopy(scene?.copy) && scene?.media_only === true) {
      problems.push(`${sceneId}: meaningful Remotion copy is hidden by media_only; use a visible full layout or move the words to lower_third`);
    }
    const h3Ambience = videos.filter(asset => asset.gen?.generator === 'fasth3-omni' && !asset.gen?.direction?.dialogue);
    if (!intent.silent && h3Ambience.length > 0 && (!pkg?.audio?.ambience || typeof pkg.audio.ambience !== 'object' || pkg.audio.ambience.enabled === false)) {
      problems.push(`${sceneId}: H3 native soundscape requires an enabled ambience bus; do not mute the only native-audio route`);
    }
    if (motionModel === 'klein') {
      const stills = mediaAssets.filter(asset => asset.kind === 'image' && asset.gen?.generator === 'flux3-klein');
      if (stills.length === 0) problems.push(`${sceneId}: explicit Klein medium requires a scene-referenced FLUX 3 Image Klein still for every shot`);
      if (videos.length > 0) problems.push(`${sceneId}: explicit Klein medium forbids H3/LTX substitution; use stills + code motion only`);
      for (const asset of stills) {
        if (!['workflows/flux3_klein_t2i.api.json', 'workflows/flux3_klein_ref_edit.api.json'].includes(asset.gen.workflow)) {
          problems.push(`${sceneId}: Klein keyframe uses an unexpected workflow ${asset.gen.workflow}`);
        }
        if (!/stills \+ code motion/i.test(asset.notes ?? '') || !/finishing sound plan:/i.test(asset.notes ?? '')) {
          problems.push(`${sceneId}: Klein still must say stills + code motion and carry an explicit finishing sound plan`);
        }
      }
      if (!scene?.motion || !/stills \+ code motion/i.test(scene?.notes ?? '') || !/finishing sound plan/i.test(scene?.notes ?? '')) {
        problems.push(`${sceneId}: Klein shot needs Remotion motion plus stills + code motion/finishing metadata`);
      }
      if (intent.wordless && (scene?.narration || scene?.narration_asset)) problems.push(`${sceneId}: wordless film cannot add narration`);
      if (intent.noCaptions && (hasCopy(scene?.copy) || scene?.lower_third)) problems.push(`${sceneId}: no-captions brief forbids headlines, copy and lower thirds`);
      continue;
    }
    if (videos.length === 0) {
      const fluxOnly = mediaAssets.some(asset => asset.gen?.generator === 'flux3-klein')
        || Object.values(assets).some(asset => asset.gen?.generator === 'flux3-klein');
      problems.push(`${sceneId}: ${fluxOnly ? 'FLUX stills are not generated-film completion; ' : ''}attach a planned/ready H3 or LTX video through scene.media`);
      continue;
    }
    const sceneSeconds = Number(scene?.preferredFrames) > 0 ? Number(scene.preferredFrames) / fps : 0;
    const coveredSeconds = Array.from(new Set(videos)).reduce((total, asset) => {
      const plate = mediaPlates.find(item => assets[item?.asset] === asset);
      const frames = Number(asset.gen?.inputs?.frames);
      const mediaFps = Number(asset.gen?.inputs?.fps);
      if (!(frames > 0) || !(mediaFps > 0)) return total;
      const speed = Number(plate?.speed) > 0 ? Number(plate.speed) : 1;
      const holdFrames = Number.isFinite(plate?.holdFrames) ? Math.max(0, Number(plate.holdFrames)) : 0;
      return total + (frames / mediaFps) / speed + holdFrames / fps;
    }, 0);
    if (sceneSeconds > 0 && coveredSeconds > 0 && coveredSeconds + 1 / 24 < sceneSeconds) {
      problems.push(`${sceneId}: scene is ${sceneSeconds.toFixed(2)} seconds but attached generated video covers ${coveredSeconds.toFixed(2)} seconds; add enough generation clips or shorten the scene instead of stretching a short clip`);
    }
    for (const asset of videos) {
      const generator = asset.gen.generator;
      if (motionModel !== 'auto' && ((motionModel === 'h3' && generator !== 'fasth3-omni') || (motionModel === 'ltx' && generator !== 'ltx25'))) {
        problems.push(`${sceneId}: configured motionModel ${motionModel} cannot be completed by ${generator}; do not substitute models`);
      }
      if (generator === 'fasth3-omni') {
        if (intent.silent && asset.media?.audio !== 'muted') problems.push(`${sceneId}: a silent film must mute H3 native audio`);
        if (asset.gen.workflow !== FASTH3_WORKFLOW) problems.push(`${sceneId}: H3 shot must use ${FASTH3_WORKFLOW}`);
        if (typeof asset.gen.direction?.soundscape !== 'string' || !asset.gen.direction.soundscape.trim()) {
          problems.push(`${sceneId}: H3 shot lacks its native soundscape direction (wordless does not mean no audio)`);
        }
        const audio = assets[asset.gen.inputs?.audio];
        if (!audio || audio.kind !== 'audio' || audio.status !== 'ready' || typeof audio.file !== 'string') {
          problems.push(`${sceneId}: H3 shot lacks required ready audio conditioning; wordless shots must use the deterministic silent WAV`);
        }
        if (!asset.gen.inputs?.image || !asset.gen.inputs?.reference) problems.push(`${sceneId}: H3 shot lacks its identity/composition image references`);
      } else {
        if (asset.gen.workflow !== LTX_I2V_WORKFLOW) problems.push(`${sceneId}: LTX shot must use ${LTX_I2V_WORKFLOW}`);
        if (!asset.gen.inputs?.image) problems.push(`${sceneId}: LTX i2v shot lacks its required start-frame image`);
        if (asset.gen.inputs?.audio) problems.push(`${sceneId}: LTX i2v has no native audio input; move sound to the explicit finishing plan`);
        if (!['none', 'muted'].includes(asset.media?.audio)) problems.push(`${sceneId}: LTX output must be marked picture-only (media.audio none)`);
        if (!/finishing sound plan:/i.test(asset.notes ?? '') || !/LTX finishing sound plan/i.test(scene?.notes ?? '')) {
          problems.push(`${sceneId}: LTX shot lacks an explicit finishing sound plan`);
        }
      }
    }
    if (intent.wordless && (scene?.narration || scene?.narration_asset)) {
      problems.push(`${sceneId}: wordless film cannot add narration (native H3 soundscape is still allowed)`);
    }
    if (intent.noCaptions && (hasCopy(scene?.copy) || scene?.lower_third)) {
      problems.push(`${sceneId}: no-captions brief forbids headlines, copy and lower thirds`);
    }
  }
  return problems;
}

// A static hold is motion direction, not a request to generate an image.
// Match image nouns or explicit image-making requests, rather than bare "still".
function requestsStillImage(brief) {
  // Consume only media-noun lists, so a subsequent "add a still" is a new request.
  const media = '(?:(?:any|generated|stock|native|GPU|still|texture|background|photographic)\\s+)*(?:images?|stills?|photos?|photographs?|frames?|keyframes?|footage|assets?|videos?|audio|music)';
  const separator = '\\s*(?:,\\s*(?:(?:or|and)\\s+)?|\\b(?:or|and)\\s+)';
  const prohibitedList = new RegExp(`\\b(?:no|not|without|avoid|exclude|never)\\s+(?:(?:include|add|create|generate|use|plan|render)\\s+)?${media}(?:${separator}${media})*\\b`, 'gi');
  const text = String(brief ?? '').replace(prohibitedList, ' ');
  const pattern = /\b(?:stills|keyframes?|still[\s-]+(?:images?|photos?|photographs?|frames?)|(?:generated|texture|background|photographic)\s+still)\b|\b(?:include|add|create|generate|use|plan|render|want|need|request)\s+(?:(?:a|an|one|two|three|some|several|\d+|generated|gpu|texture|background|photographic)\s+){0,4}still\b/gi;
  for (const match of text.matchAll(pattern)) {
    const prefix = text.slice(Math.max(0, match.index - 60), match.index);
    if (/\b(?:no|not|without|avoid|exclude|never)\s+(?:[\w-]+\s+){0,4}$/i.test(prefix)) continue;
    return true;
  }
  return false;
}

export function motionGraphicsCompletionProblems(slice, brief = null, intent = null, requiredScenes = [], csvAttachments = []) {
  const problems = [];
  if (!plannedModelContribution(slice?.package).length) problems.push({ code: 'COMFY_MODEL_CONTRIBUTION_REQUIRED', message: modelContributionPlanProblem(slice?.package), path: 'scenes' });
  const pkg = slice?.package;
  for (const message of csvWallProblems(pkg, brief, csvAttachments)) problems.push({ code: 'CSV_WALL_MISSING', message, path: 'scenes[].drawing' });
  for (const message of visualClaimProblems(pkg, csvAttachments)) problems.push({ code: 'VISUAL_CLAIM_UNSUPPORTED', message, path: 'scenes' });
  const scenesForTiming = Array.isArray(pkg?.scenes) ? pkg.scenes : [];
  const fps = Number(pkg?.format?.fps) > 0 ? Number(pkg.format.fps) : 30;
  if (pkg?.duration?.exact) {
    try { compileTimeline(pkg); } catch (error) { problems.push({ code: 'DURATION_MISMATCH', message: error.message, path: 'scenes' }); }
  }
  const seconds = plannedTimelineFrames(pkg) / fps;
  if (intent?.requestedSeconds != null && !durationWithinTarget(seconds, intent.requestedSeconds)) {
    problems.push({ code: 'DURATION_MISMATCH', message: `brief requests ${intent.requestedSeconds} seconds but compiled timeline is ${seconds.toFixed(2)} seconds; acceptable range is ${durationRangeText(intent.requestedSeconds)}. Add the missing story scenes and adjust frames accounting for transition overlaps.`, path: 'scenes' });
  }
  if (intent?.narrationRequested && !intent.wordless && !scenesForTiming.some(scene => typeof scene.narration === 'string' && scene.narration.trim())) {
    problems.push({ code: 'NARRATION_MISSING', message: 'Brief requests narration; add scene-specific narration with storyboard.edit.', path: 'scenes[].narration' });
  }
  if (intent?.wordless && scenesForTiming.some(scene => (typeof scene?.narration === 'string' && scene.narration.trim()) || scene?.narration_asset)) {
    problems.push({ code: 'NARRATION_PROHIBITED', message: 'The brief prohibits speech; remove narration and its audio bindings.', path: 'scenes[].narration' });
  }
  for (const id of requiredScenes) {
    const scene = scenesForTiming.find(item => item.id === id);
    if (!scene) problems.push({ code: 'SCENE_MISSING', message: `Scene ${id} was targeted by a failed drawing call but does not exist; add it with storyboard.add_scene, then draw it.`, path: `scenes.${id}` });
    else if (!scene.drawing) problems.push({ code: 'DRAWING_MISSING', message: `Scene ${id} was targeted by a failed drawing call and still needs a drawing.`, path: `scenes.${id}.drawing` });
  }
  const sharedGap = sharedMascotGap(slice?.package, brief);
  if (sharedGap) {
    problems.push({
      code: 'SHARED_CAST_MISSING',
      message: sharedMascotProblem(sharedGap),
      path: 'scenes[].cast',
      castId: sharedGap.castId,
      sceneIds: sharedGap.sceneIds,
    });
  }
  const scenes = Array.isArray(slice?.package?.scenes) ? slice.package.scenes : [];
  const entirelyDrawn = scenes.length > 0 && scenes.every(scene => scene?.drawing);
  // Continuous drawing is a contract only when stated, not merely because one
  // scene happens to use a drawing. The second form covers an evolving sheet
  // explicitly requested in the brief, without treating every sketch as one.
  const text = [typeof brief === 'string' ? brief : '', slice?.package?.proposal?.logline ?? '', slice?.package?.proposal?.look ?? ''].join('\n');
  const continuous = /\b(?:every|each|all)\s+(?:of\s+the\s+)?scenes?\b[^.\n]{0,100}\b(?:draw|sketch)/i.test(text)
    || /\b(?:draw|sketch)[^.\n]{0,100}\b(?:every|each|all)\s+(?:of\s+the\s+)?scenes?\b/i.test(text)
    || /\b(?:continuous|same|single)\s+(?:evolving\s+)?(?:drawing|sketch)\b[^.\n]{0,80}\b(?:throughout|across|every|each|all)\b/i.test(text)
    || (/\b(?:drawing|structure|sketch)\s+(?:grows|builds|evolves|continues)\b/i.test(text) && /\b(?:finish|end|hold)\b[^.\n]{0,100}\b(?:sheet|drawing|sketch)\b/i.test(text));
  if (continuous) {
    for (const scene of scenes) if (!scene?.drawing) problems.push({ code: 'DRAWING_MISSING', message: `${scene?.id ?? '(unknown scene)'}: the requested continuous drawing is missing; draw or extend the evolving subject in this scene`, path: `scenes.${scene?.id ?? '?'}.drawing` });
    const shapeKey = element => {
      if (!element || typeof element !== 'object') return '';
      const { start, end, marker, erase, ...shape } = element;
      return JSON.stringify(shape);
    };
    for (let i = 1; i < scenes.length; i++) {
      const previous = scenes[i - 1]?.drawing?.elements;
      const current = scenes[i]?.drawing?.elements;
      if (!Array.isArray(previous) || !Array.isArray(current) || !previous.length || !current.length) continue;
      const priorShapes = new Set(previous.filter(element => !element?.erase).map(shapeKey));
      if (priorShapes.size && !current.some(element => priorShapes.has(shapeKey(element)))) {
        problems.push({ code: 'DRAWING_DISCONTINUITY', message: `${scenes[i].id}: no geometry carries over from ${scenes[i - 1].id}; extend the held drawing or preserve its evolving geometry`, path: `scenes.${scenes[i].id}.drawing` });
      }
    }
  }
  const sceneReferencedPending = sceneReferencedPendingStills(slice?.pendingGpu);
  const stillRequested = requestsStillImage(brief);
  const assets = pkg?.assets ?? {};
  const hasReadyStill = scenes.some(scene => [...sourceImageIdsForScene(scene, assets)].some(id => assets[id]?.status === 'ready'));
  if (!continuous && !entirelyDrawn && stillRequested && sceneReferencedPending.length < 1 && !hasReadyStill) {
    problems.push({
      code: 'PENDING_GPU_MISSING',
      message: `motion graphics requires at least 1 scene-referenced planned GPU still, got ${sceneReferencedPending.length}`,
      path: 'scenes[].media',
      count: sceneReferencedPending.length,
      required: 1,
    });
  }
  for (const problem of Array.isArray(slice?.problems) ? slice.problems : []) {
    const code = typeof problem?.code === 'string' ? problem.code : 'CPU_SLICE_PROBLEM';
    problems.push({
      code,
      message: typeof problem?.message === 'string' ? problem.message : String(problem),
      path: 'package',
    });
  }
  for (const message of packageSchemaProblems(slice?.package)) {
    problems.push({ code: 'PACKAGE_SCHEMA', message, path: 'package' });
  }
  return problems;
}

function problemLines(problems) {
  return problems.map(problem => `${problem.code}: ${problem.message}`);
}

const SVG_MAX_REQUESTS = 12;
const SVG_MAX_TOKENS = 2048;
const SVG_REQUEST_TIMEOUT_MS = 45000;

function createLlmSvgGenerator(model, sessionId, signal, accounting, onEvent) {
  return async ({ intent, attempt, errors }) => {
    signal?.throwIfAborted();
    if (typeof intent.prompt !== 'string' || intent.prompt.length > 4000) throw new Error('SVG intent must be at most 4000 characters');
    if (accounting.requests >= SVG_MAX_REQUESTS) throw new Error(`SVG generation request budget (${SVG_MAX_REQUESTS}) exhausted`);
    accounting.requests++;
    const prompt = [
      `Draw a ${intent.kind} SVG for: ${intent.prompt}`,
      intent.palette?.length ? `Palette: ${intent.palette.join(', ')}.` : '',
      attempt > 1 && errors.length ? `The previous attempt failed: ${errors.map(error => error.message).join('; ').slice(0, 2000)}. Return a complete corrected SVG that fixes exactly these errors and keeps the same drawing.` : '',
    ].filter(Boolean).join('\n');
    let text = '';
    let reported = false;
    const requestUsage = { input: 0, output: 0 };
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(new Error(`SVG generation timed out after ${SVG_REQUEST_TIMEOUT_MS}ms`)), SVG_REQUEST_TIMEOUT_MS);
    const requestSignal = signal ? AbortSignal.any([signal, timeout.signal]) : timeout.signal;
    try {
      await piRequest(model, {
        system: SVG_SYSTEM,
        messages: [{ role: 'user', content: prompt }],
        tools: [],
        signal: requestSignal,
        sessionId,
      }, chunk => {
        if (chunk.type === 'text') {
          text += chunk.delta;
          if (text.length > 65536) throw new Error('SVG model response exceeded 65536 characters');
        }
        if (chunk.type === 'usage') {
          reported = true;
          accumulateUsage(requestUsage, chunk);
        }
        if (chunk.type === 'error') throw new Error(`${chunk.code}${chunk.message ? `: ${chunk.message}` : ''}`);
      });
    } finally {
      clearTimeout(timer);
      accumulateUsage(accounting, requestUsage);
      if (reported) accounting.reportedRequests++;
      onEvent?.({ type: 'svg_generation_usage', attempt, usage: reported ? requestUsage : null, requests: accounting.requests, maxRequests: SVG_MAX_REQUESTS });
    }
    const svg = extractSvg(text);
    if (!svg) throw new Error('model did not return an <svg> document');
    return svg;
  };
}

export function createCpuAgentRunner({ runtimeDir, now = () => new Date().toISOString(), providers = {}, resolveProviderConfig, motionModel: defaultMotionModel = 'auto' } = {}) {
  const packagesDir = join(runtimeDir, 'packages');
  const assetsDir = join(packagesDir, 'assets');
  return async function runCpuAgent({ brief, brand, provider, model: modelName, motionModel: requestedMotionModel, thinking, videoType, conversationId, songTrim, performanceBackend, lyricsStyle, lyrics, sessionId = 'cpu-slice', signal, onEvent, contextSnapshot, narrationRevision, proposalRevision } = {}) {
    assertGenerationBrief(brief);
    if (typeof brief !== 'string' || brief.trim().length === 0) {
      const error = new Error('brief is required');
      error.status = 400;
      throw error;
    }
    if (thinking !== undefined && thinking !== 'enabled' && thinking !== 'disabled') {
      const error = new Error('thinking must be enabled or disabled');
      error.status = 400;
      throw error;
    }
    if (videoType !== undefined && !isVideoType(videoType)) {
      const error = new Error('unknown videoType');
      error.status = 400;
      error.code = 'INVALID_VIDEO_TYPE';
      throw error;
    }
    if (conversationId !== undefined && !isConversationId(conversationId)) {
      const error = new Error('conversationId must be a valid chat id');
      error.status = 400;
      error.code = 'INVALID_CONVERSATION_ID';
      throw error;
    }
    if (performanceBackend !== undefined && !['fasth3', 'ltx'].includes(performanceBackend)) {
      const error = new Error('performanceBackend must be fasth3 or ltx');
      error.status = 400;
      error.code = 'INVALID_PERFORMANCE_BACKEND';
      throw error;
    }
    if (lyricsStyle !== undefined && !['off', 'caption', 'reel'].includes(lyricsStyle)) {
      const error = new Error('lyricsStyle must be off, caption or reel');
      error.status = 400;
      error.code = 'INVALID_LYRICS_STYLE';
      throw error;
    }
    if (videoType !== 'music-video' && (songTrim !== undefined || performanceBackend !== undefined
      || lyricsStyle !== undefined || lyrics !== undefined)) {
      const error = new Error('songTrim, performanceBackend and lyric fields are available only for Music Video');
      error.status = 400;
      error.code = 'INVALID_MUSIC_OPTIONS';
      throw error;
    }
    const lyricInput = videoType === 'music-video'
      ? normalizeMusicVideoLyrics({ lyricsStyle, lyrics }, { status: 400 })
      : null;
    const conversation = contextSnapshot ?? (conversationId === undefined
      ? null
      : loadConversationContext({ runtimeDir, conversationId, editorialScope: videoType ?? 'custom' }));
    let editorialSong = null;
    if (videoType === 'music-video') {
      if (!conversationId) {
        const error = new Error('Music Video requires one editorial song upload.');
        error.status = 422;
        error.code = 'SONG_REQUIRED';
        throw error;
      }
      editorialSong = resolveMusicVideoSong({ runtimeDir, conversationId });
      if (songTrim !== undefined) {
        const validObject = songTrim && typeof songTrim === 'object' && !Array.isArray(songTrim)
          && Object.keys(songTrim).every(key => ['startSeconds', 'endSeconds'].includes(key));
        const start = songTrim?.startSeconds;
        const end = songTrim?.endSeconds;
        if (!validObject || !Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start
          || !Number.isFinite(editorialSong.durationSec) || end > editorialSong.durationSec) {
          const error = new Error('songTrim must satisfy 0 <= startSeconds < endSeconds <= the probed song duration');
          error.status = 422;
          error.code = 'SONG_TRIM_INVALID';
          throw error;
        }
      }
    }
    if (!provider && conversation?.requiresLivePlanner) {
      const error = new Error('Planning-context attachments require a connected AI agent. Reference-only media, editorial notes, documents and URL snapshots are not interpreted by the offline planner.');
      error.status = 422;
      error.code = 'CONTEXT_REQUIRES_MODEL';
      throw error;
    }
    const brandKit = brand?.kit ?? null;
    const brandAssets = brand?.assets ?? null;
    const { runCpuSlice, classifyProductionIntent, getVideoType, parseMotionModel } = await import('../../../packages/agent/dist/src/index.js');
    const preset = videoType === undefined ? undefined : getVideoType(videoType);
    const productionIntent = classifyProductionIntent(brief, preset?.fallbackKind);
    const intent = narrationTimedIntent(productionIntent, brief);
    if (videoType === 'music-video') {
      const requestedSeconds = intent.requestedSeconds ?? 30;
      const effectiveTrim = {
        startSeconds: songTrim?.startSeconds ?? 0,
        endSeconds: songTrim?.endSeconds ?? Math.min(editorialSong.durationSec, requestedSeconds),
      };
      // Canonical times stay on the untrimmed song clock. Reject an empty
      // caption/reel window before provider resolution or any model execution.
      requireMusicVideoLyricsOverlap(lyricInput, effectiveTrim);
    }
    const narrationPlanningBrief = planningBriefForNarration(brief, productionIntent);
    const planningBrief = productionIntent.liveActionHumans
      ? `${narrationPlanningBrief}\n\nHard creative constraint: use photorealistic live-action fictional human adults with natural skin and real-world materials in the proposal and every image/video prompt. Do not substitute clay, plasticine, stop-motion, puppets, cartoons or handmade-miniature styling.`
      : narrationPlanningBrief;
    const briefSize = /\b(\d{2,5})\s*[x×]\s*(\d{2,5})\b/i.exec(brief);
    const briefAspect = briefSize ? aspectFromSize(Number(briefSize[1]), Number(briefSize[2])) : extractBrief(brief).aspect;
    let motionModel;
    try {
      motionModel = parseMotionModel(requestedMotionModel ?? defaultMotionModel, 'auto');
    } catch (cause) {
      const error = new Error(cause.message);
      error.status = 400;
      throw error;
    }
    const vector = await import('../../../packages/vector/dist/src/index.js');
    let agentModel;
    let initialModel;
    let svgModel;
    let live = false;
    let resolved;
    if (provider) {
      const { resolveProvider } = await import('../../../packages/llm/dist/src/index.js');
      const { createOpenAICompatibleModel } = await import('../../../packages/llm/dist/src/index.js');
      // `custom` is the bring-your-own OpenAI-compatible preset (spec 5.4); a local
      // base URL can be supplied by the server process or by a test.
      const override = providers[provider] ?? {};
      resolved = resolveProviderConfig
        ? resolveProviderConfig(provider, modelName)
        : resolveProvider(provider, { ...override, ...(modelName ? { model: modelName } : {}) });
      agentModel = createOpenAICompatibleModel({
        ...resolved,
        ...(thinking === 'disabled' ? { thinking, reasoningEffort: undefined } : thinking === 'enabled' ? { thinking } : {}),
      });
      initialModel = createOpenAICompatibleModel({
        ...resolved, maxRetries: 0,
        ...(thinking === 'disabled' ? { thinking, reasoningEffort: undefined } : thinking === 'enabled' ? { thinking } : {}),
      });
      svgModel = createOpenAICompatibleModel({
        ...resolved,
        maxRetries: 0,
        maxTokens: Math.min(resolved.maxTokens ?? SVG_MAX_TOKENS, SVG_MAX_TOKENS),
        ...(thinking === 'disabled' ? { thinking, reasoningEffort: undefined } : thinking === 'enabled' ? { thinking } : {}),
      });
      live = true;
    }
    if (!live && /\bsvgs?\b/i.test(brief) && !/\b(?:no|without|avoid)\s+(?:any\s+)?svgs?\b/i.test(brief)) {
      throw Object.assign(new Error('SVG generation requires a configured model; offline planning cannot create the requested SVGs.'), { status: 422, code: 'SVG_GENERATION_REQUIRES_MODEL' });
    }
    if (narrationRevision) {
      const revised = await reviseNarration({ pkg: narrationRevision.package, brief: narrationRevision.originalBrief, note: narrationRevision.note,
        source: narrationRevision.source, model: initialModel, signal, sessionId, onEvent });
      return { ...revised, live: true, provider, model: resolved?.model, contextSnapshot: narrationRevision.contextSnapshot };
    }
    if (proposalRevision) {
      const revised = await reviseProposal({ pkg: proposalRevision.package, brief: proposalRevision.originalBrief, note: proposalRevision.note,
        source: proposalRevision.source, csvAttachments: proposalRevision.contextSnapshot?.csvAttachments, model: initialModel, signal, sessionId, onEvent });
      return { ...revised, live: true, provider, model: resolved?.model, contextSnapshot: proposalRevision.contextSnapshot };
    }
    const persistSvg = (assetId, svg) => {
      mkdirSync(assetsDir, { recursive: true });
      writeFileSync(join(assetsDir, `${assetId}.svg`), svg);
      return `assets/${assetId}.svg`;
    };
    const persistAudio = (assetId, wav) => {
      mkdirSync(assetsDir, { recursive: true });
      writeFileSync(join(assetsDir, `${assetId}.wav`), wav);
      return `assets/${assetId}.wav`;
    };
    const svgUsage = { input: 0, output: 0, requests: 0, reportedRequests: 0 };
    const generateSvg = async intent => {
      signal?.throwIfAborted();
      if (!agentModel) throw new Error('SVG generation requires a configured model; no placeholder will be substituted');
      const llmGenerator = createLlmSvgGenerator(svgModel, `${sessionId}-svg`, signal, svgUsage, onEvent);
      const result = await vector.autoFix(llmGenerator, intent, 2, { width: 512 });
      signal?.throwIfAborted();
      if (!result.ok) throw new Error(result.errors.map(error => `${error.code}: ${error.message}${error.detail ? ` ${error.detail}` : ''}`).join('; '));
      const check = vector.renderCheck(result.svg, { width: 512, palette: intent.palette });
      return {
        svg: result.svg,
        attempts: result.attempts,
        repairs: result.repairs,
        source: 'llm',
        sanitizerVersion: result.sanitizerVersion,
        renderCheck: {
          ok: check.ok,
          version: result.sanitizerVersion,
          width: check.width,
          height: check.height,
          opaqueFraction: check.opaqueFraction,
          outOfPaletteFraction: check.outOfPaletteFraction,
        },
      };
    };
    const runStartedAt = Date.now();
    const runOnce = async (model, repairInstructions = null, repairSystem = REPAIR_SYSTEM, repairWithoutGpu = false) => {
      const phase = repairInstructions ? 'repair' : 'initial';
      const phaseStartedAt = Date.now();
      onEvent?.({ type: 'runner_phase', phase, status: 'started', elapsedMs: Date.now() - runStartedAt });
      try {
        let result = await runCpuSlice({
          brief: repairInstructions ? `${planningBrief}\n\n${repairInstructions}` : planningBrief,
          ...(repairInstructions ? { initialPackage: slice.package } : {}),
          ...(repairWithoutGpu ? { repairWithoutGpu: true } : {}),
          ...(model ? { model: repairInstructions ? withRepairAdmissionRetry(model, {
            onRetry: delayMs => onEvent?.({ type: 'runner_phase', phase, status: 'admission_retry', delayMs, elapsedMs: Date.now() - runStartedAt }),
          }) : withInitialAdmissionRetry(initialModel, {
            onRetry: delayMs => onEvent?.({ type: 'runner_phase', phase, status: 'admission_retry', delayMs, elapsedMs: Date.now() - runStartedAt }),
          }) } : {}),
          ...(brandKit ? { brand: brandKit } : {}),
          ...(brandAssets ? { brandAssets } : {}),
          ...(agentModel ? { generateSvg } : {}),
          persistSvg,
          persistAudio,
          motionModel,
          initialIntent: intent,
          ...(videoType !== undefined ? { videoType } : {}),
          sessionId,
          signal,
          now,
          systemSuffix: MODEL_CONTRIBUTION_PROMPT,
          ...(repairInstructions ? {
            system: preset
              ? `${repairSystem}\n\nSelected video type: ${preset.label} (${preset.id}). Preserve its creative requirements during repair:\n${preset.plannerPrompt}\nThe focused repair rules above take precedence over any instruction to rebuild the package.`
              : repairSystem,
          } : {}),
          ...(conversation?.contextSystem ? { contextSystem: conversation.contextSystem } : {}),
          ...(conversation?.csvAttachments?.length ? { csvAttachments: conversation.csvAttachments } : {}),
          // A repair can need one tool turn per scene plus a final model turn.
          // Keep the phase bounded, and require that final turn before acceptance.
          maxSteps: 16,
          // Permit distinct schema corrections without expanding malformed-turn retries.
          maxInvalidArgumentRepairs: 6,
          onEvent: event => onEvent?.({ ...event, phase, runElapsedMs: Date.now() - runStartedAt }),
        });
        signal?.throwIfAborted();
        // A planner can finish after a failed tool call. Do not turn that into a
        // successful plan with the requested visual silently absent.
        const unresolvedSvg = new Map();
        for (const call of result.result.toolCalls ?? []) {
          if (call.name !== 'assets.generate_svg') continue;
          const key = JSON.stringify([call.args?.scene_id, call.args?.intent]);
          if (call.ok) unresolvedSvg.delete(key);
          else unresolvedSvg.set(key, call);
        }
        if (unresolvedSvg.size) {
          const failed = [...unresolvedSvg.values()][0];
          throw Object.assign(new Error(`SVG generation failed for scene ${failed.args?.scene_id ?? 'unknown'}: ${failed.error ?? 'generation failed'}`), { status: 422, code: 'SVG_GENERATION_FAILED', svgUsage: { ...svgUsage } });
        }
        if (intent.generatedFilm) {
          if (intent.liveActionHumans) {
            const corrected = enforceLiveActionHumans(result.package);
            if (corrected.changed) {
              result = { ...result, package: corrected.package };
              onEvent?.({ type: 'runner_phase', phase, status: 'creative_constraint', constraint: 'live_action_humans', elapsedMs: Date.now() - runStartedAt });
            }
          }
          const covered = coverGeneratedFilmScenes(result.package);
          if (covered.splits > 0) {
            const pendingGpu = result.pendingGpu.filter(item => item.generator === 'flux3-klein');
            const seen = new Set();
            for (const scene of covered.package.scenes) {
              for (const plate of Array.isArray(scene?.media) ? scene.media : []) {
                const asset = covered.package.assets?.[plate?.asset];
                if (seen.has(plate?.asset) || asset?.status !== 'pending' || !['fasth3-omni', 'ltx25'].includes(asset?.gen?.generator)) continue;
                seen.add(plate.asset);
                pendingGpu.push({ assetId: plate.asset, generator: asset.gen.generator, ...(asset.gen.workflow ? { workflow: asset.gen.workflow } : {}), sceneId: scene.id });
              }
            }
            result = { ...result, package: covered.package, pendingGpu };
            onEvent?.({ type: 'runner_phase', phase, status: 'coverage', splits: covered.splits, scenes: covered.package.scenes.length, elapsedMs: Date.now() - runStartedAt });
          }
          const finalized = finalizeGeneratedFilmEditorial(result.package, { intent, brief, assetsDir });
          result = { ...result, package: finalized.package };
          if (finalized.musicAdded || finalized.narrationEnabled || finalized.ambienceEnabled) {
            onEvent?.({ type: 'runner_phase', phase, status: 'editorial', musicAdded: finalized.musicAdded, narrationEnabled: finalized.narrationEnabled, ambienceEnabled: finalized.ambienceEnabled, elapsedMs: Date.now() - runStartedAt });
          }
        }
        if (videoType !== 'music-video' && intent.exactDuration && intent.requestedSeconds > 0) {
          const fps = Number(result.package?.format?.fps) > 0 ? Math.floor(result.package.format.fps) : 30;
          const frames = intent.requestedSeconds * fps;
          if (Math.abs(frames - Math.round(frames)) > 1e-7) {
            throw Object.assign(new Error(`Exact duration ${intent.requestedSeconds} seconds is not representable at ${fps} fps; choose a duration on a frame boundary.`), { status: 422, code: 'EXACT_DURATION_UNREPRESENTABLE' });
          }
          result = { ...result, package: { ...result.package, duration: { mode: 'target', targetFrames: Math.round(frames), exact: true } } };
        }
        onEvent?.({ type: 'runner_phase', phase, status: 'completed', durationMs: Date.now() - phaseStartedAt, elapsedMs: Date.now() - runStartedAt, stopped: result.result.stopped ?? 'final' });
        return result;
      } catch (error) {
        onEvent?.({ type: 'runner_phase', phase, status: 'failed', durationMs: Date.now() - phaseStartedAt, elapsedMs: Date.now() - runStartedAt, message: error.message });
        throw error;
      }
    };
    // Music Video's explicit song trim establishes its final duration after adoption.
    const motionIntent = videoType === 'music-video' ? { ...intent, requestedSeconds: null } : intent;
    let requiredScenes = [];
    const acceptable = candidate => intent.generatedFilm
      ? candidate.result.ok && generatedFilmCompletionProblems(candidate.package, intent, motionModel, brief).length === 0 && validatePackage(candidate.package).valid
      : candidate.result.ok && motionGraphicsCompletionProblems(candidate, brief, motionIntent, requiredScenes, conversation?.csvAttachments).length === 0;
    const aggregateUsage = { input: 0, output: 0 };
    const absorbUsage = result => {
      accumulateUsage(aggregateUsage, result?.usage ?? { input: 0, output: 0 });
    };
    let slice = await runOnce(agentModel);
    requiredScenes = [...new Set((slice.result.toolCalls ?? []).flatMap(call => {
      if (call.ok || !['storyboard.draw', 'storyboard.extend_drawing'].includes(call.name)) return [];
      const missing = /^scene (.+?) not found(?:;|$)/.exec(call.error ?? '')?.[1];
      return missing ? [missing] : [];
    }))];
    absorbUsage(slice.result);
    const fallback = false;
    if (agentModel && !acceptable(slice)) {
      if (intent.generatedFilm) {
        const initialProblems = [
          ...generatedFilmCompletionProblems(slice.package, intent, motionModel, brief),
          ...packageSchemaProblems(slice.package),
        ];
        onEvent?.({ type: 'runner_phase', phase: 'initial', status: 'validation', ok: false, problems: initialProblems, elapsedMs: Date.now() - runStartedAt });
        const narrationGuide = narrationRepairGuide(slice.package, intent, brief);
        const sharedCastGuide = sharedMascotRepairGuide(slice.package, brief);
        slice = await runOnce(agentModel, [
          repairPackageFacts(slice.package, intent, briefAspect),
          ...(narrationGuide.length ? [narrationGuide.join('\n')] : []),
          ...(sharedCastGuide.length ? [sharedCastGuide.join('\n')] : []),
          `Validation report: the current generated-film package failed validation. Repair the existing package without changing its story or model route. Fix exactly these issues, one edit per issue, then stop:\n- ${initialProblems.join('\n- ')}`,
        ].join('\n\n'));
        absorbUsage(slice.result);
        if (!acceptable(slice)) {
          const problems = [
            ...generatedFilmCompletionProblems(slice.package, intent, motionModel, brief),
            ...packageSchemaProblems(slice.package),
          ];
          onEvent?.({ type: 'runner_phase', phase: 'repair', status: 'validation', ok: false, problems, elapsedMs: Date.now() - runStartedAt });
          const error = new Error(`generated-film plan is incomplete: ${[...problems, ...(slice.result.error ? [`repair stopped: ${slice.result.error}`] : [])].join('; ') || 'live agent did not finish'}`);
          error.status = 422;
          error.code = 'GENERATED_FILM_INCOMPLETE';
          error.errors = problems;
          throw error;
        }
      } else {
        const initialProblems = motionGraphicsCompletionProblems(slice, brief, motionIntent, requiredScenes, conversation?.csvAttachments);
        onEvent?.({ type: 'runner_phase', phase: 'initial', status: 'validation', ok: false, problems: problemLines(initialProblems), elapsedMs: Date.now() - runStartedAt });
        const repairGuide = motionGraphicsRepairGuide(slice, initialProblems);
        const sharedCastGuide = sharedMascotRepairGuide(slice.package, brief);
        slice = await runOnce(agentModel, [
          repairPackageFacts(slice.package, intent, briefAspect),
          ...(repairGuide.length ? [repairGuide.join('\n')] : []),
          ...(sharedCastGuide.length ? [sharedCastGuide.join('\n')] : []),
          `Validation report: the current motion-graphics package is incomplete. Repair the existing package without changing its story or model route. Fix exactly these issues, one edit per issue, then stop:\n- ${problemLines(initialProblems).join('\n- ')}`,
        ].join('\n\n'), MOTION_GRAPHICS_REPAIR_SYSTEM, !initialProblems.some(problem => ['PENDING_GPU_MISSING', 'SHARED_CAST_MISSING', 'COMFY_MODEL_CONTRIBUTION_REQUIRED'].includes(problem.code)));
        absorbUsage(slice.result);
        const wallRepair = repairCsvWallScenes(slice.package, brief, conversation?.csvAttachments);
        if (wallRepair.sceneIds.length) {
          slice = { ...slice, package: wallRepair.package };
          onEvent?.({ type: 'runner_phase', phase: 'repair', status: 'csv_wall_replay', sceneIds: wallRepair.sceneIds, elapsedMs: Date.now() - runStartedAt });
        }
        let wallRecoveryReason;
        const afterRepairProblems = motionGraphicsCompletionProblems(slice, brief, motionIntent, requiredScenes, conversation?.csvAttachments);
        if (!wallRepair.sceneIds.length && afterRepairProblems.length && afterRepairProblems.every(problem => problem.code === 'CSV_WALL_MISSING')) {
          const failedWalls = (slice.result.toolCalls ?? []).filter(call => call.name === 'storyboard.csv_tile_wall' && !call.ok);
          const targetSceneIds = [...new Set(failedWalls.map(call => call.args?.scene_id))];
          const recovered = await recoverCsvWallScene({ pkg: slice.package, brief, attachments: conversation?.csvAttachments, model: agentModel, signal, sessionId, onEvent, targetSceneIds });
          absorbUsage(recovered);
          wallRecoveryReason = recovered.reason;
          if (recovered.sceneIds?.length) {
            const resolvedInvalid = slice.result.errorCode === 'unresolved_invalid_arguments' && slice.result.error === `Unresolved invalid arguments for: storyboard.csv_tile_wall (scene ${recovered.sceneIds[0]})`;
            slice = { ...slice, package: recovered.package, ...(resolvedInvalid ? { result: { ...slice.result, ok: true, error: undefined } } : {}) };
          }
        }
        if (!acceptable(slice)) {
          const problems = motionGraphicsCompletionProblems(slice, brief, motionIntent, requiredScenes, conversation?.csvAttachments);
          const lines = problemLines(problems);
          const layoutGuide = motionGraphicsRepairGuide(slice, problems).filter(line => line.includes('requires two actual media plates'));
          onEvent?.({ type: 'runner_phase', phase: 'repair', status: 'validation', ok: false, problems: lines, elapsedMs: Date.now() - runStartedAt });
          const pendingProblem = problems.find(problem => problem.code === 'PENDING_GPU_MISSING');
          const sharedCastProblem = problems.find(problem => problem.code === 'SHARED_CAST_MISSING');
          const error = new Error(`motion graphics is incomplete after one repair: ${[...lines, ...layoutGuide, ...(wallRecoveryReason ? [`Source wall recovery: ${wallRecoveryReason} Supply the intended scene, source, filters and category colors to repair it.`] : []), ...(slice.result.error ? [`repair stopped: ${slice.result.error}`] : [])].join('; ') || 'live agent did not finish'}`);
          error.status = 422;
          error.code = 'MOTION_GRAPHICS_INCOMPLETE';
          error.errors = [...lines, ...layoutGuide];
          error.details = {
            codes: problems.map(problem => problem.code),
            svgCount: Array.isArray(slice.svgAssets) ? slice.svgAssets.length : 0,
            pendingGpuCount: pendingProblem?.count ?? (Array.isArray(slice.pendingGpu) ? slice.pendingGpu.length : 0),
            requiredPendingGpuCount: 1,
            castId: sharedCastProblem?.castId ?? null,
            sceneIds: sharedCastProblem?.sceneIds ?? [],
            problems: [...lines, ...layoutGuide],
          };
          throw error;
        }
      }
    }
    if (!agentModel && !acceptable(slice)) {
      const problems = intent.generatedFilm ? generatedFilmCompletionProblems(slice.package, intent, motionModel, brief) : problemLines(motionGraphicsCompletionProblems(slice, brief, motionIntent, requiredScenes, conversation?.csvAttachments));
      const error = new Error(`plan is incomplete: ${problems.join('; ') || slice.result.error || 'planner did not finish'}`);
      error.status = 422;
      error.code = intent.generatedFilm ? 'GENERATED_FILM_INCOMPLETE' : 'MOTION_GRAPHICS_INCOMPLETE';
      error.errors = problems;
      throw error;
    }
    if (conversationId) {
      slice = { ...slice, package: adoptSuppliedFont({ runtimeDir, conversationId, package: slice.package, assetsDir }) };
    }
    if (conversationId && ((videoType === 'product-walkthrough' && !intent.generatedFilm) || videoType === undefined)) {
      const custom = videoType === undefined;
      const attachments = await adoptProductWalkthroughAttachments({
        runtimeDir,
        conversationId,
        package: slice.package,
        imagesOnly: custom,
      });
      if (attachments.skipped.length > 0) {
        const problems = attachments.skipped.map(item => `${item.code}: ${item.reason}`);
        const error = new Error(`${custom ? 'Custom' : 'Product Walkthrough'} attachments could not be placed: ${problems.join('; ')}`);
        error.status = 422;
        error.code = custom ? 'CUSTOM_ATTACHMENTS_INCOMPLETE' : 'PRODUCT_ATTACHMENTS_INCOMPLETE';
        error.errors = problems;
        throw error;
      }
      slice = { ...slice, package: attachments.package };
      if (attachments.adopted.length > 0) {
        onEvent?.({
          type: 'runner_phase',
          phase: 'attachments',
          status: 'adopted',
          count: attachments.adopted.length,
          elapsedMs: Date.now() - runStartedAt,
        });
      }
    }
    if (videoType === 'music-video' && conversationId) {
      const music = await adoptMusicVideoAttachments({
        runtimeDir,
        conversationId,
        package: slice.package,
        requestedSeconds: intent.requestedSeconds ?? 30,
        ...(songTrim !== undefined ? { songTrim } : {}),
        ...(performanceBackend !== undefined ? { performanceBackend } : {}),
        lyricsStyle: lyricInput.lyricsStyle,
        lyrics: lyricInput.lyrics,
      });
      const failures = music.skipped.filter(item => item.code !== 'NO_EDITORIAL_IMAGE');
      if (failures.length > 0) {
        const problems = failures.map(item => `${item.code}: ${item.reason}`);
        const error = new Error(`Music Video could not be prepared: ${problems.join('; ')}`);
        error.status = 422;
        error.code = 'MUSIC_VIDEO_INCOMPLETE';
        error.errors = problems;
        throw error;
      }
      slice = { ...slice, package: music.package, pendingGpu: music.pendingGpu };
      onEvent?.({
        type: 'runner_phase',
        phase: 'music',
        status: 'adopted',
        performance: music.performance?.generator ?? null,
        elapsedMs: Date.now() - runStartedAt,
      });
    }
    if (!intent.generatedFilm && videoType !== 'music-video' && intent.narrationRequested && !intent.wordless && (slice.package.scenes ?? []).some(scene => typeof scene.narration === 'string' && scene.narration.trim()) && (!slice.package.voice?.enabled || slice.package.voice.engine === 'none')) {
        slice = { ...slice, package: { ...slice.package, voice: { enabled: true, engine: 'kokoro', language: 'en-us', speed: 0.98, voice: 'af_heart', chunking: 'paragraph' } } };
    }
    if (videoType === 'sketch-build' && !intent.generatedFilm) {
      const finished = finalizeSketchAudio(slice.package, { brief, assetsDir });
      if (finished.added) {
        slice = { ...slice, package: finished.package };
        onEvent?.({ type: 'runner_phase', phase: 'audio', status: 'created', elapsedMs: Date.now() - runStartedAt });
      }
    }
    // Motion-graphics proposals are creative text, not an audio production plan.
    // Do not present a model-invented score as part of a silent deliverable.
    // Music Video has its own supplied-master contract, applied above; generated
    // films may still receive native sound from pending video generation.
    if (!intent.generatedFilm && videoType !== 'music-video' && !slice.package.audio) {
      const narrated = slice.package.voice?.enabled === true
        && slice.package.voice?.engine !== 'none'
        && (slice.package.scenes ?? []).some(scene => typeof scene.narration === 'string' && scene.narration.trim());
      const hasVideo = Object.values(slice.package.assets ?? {}).some(asset => asset?.kind === 'video');
      if (!hasVideo && slice.package.proposal) {
        slice = { ...slice, package: { ...slice.package, proposal: {
          ...slice.package.proposal,
          soundtrack: narrated
            ? 'Narration planned; no music or sound effects included.'
            : 'Silent preview; no music or sound effects included.',
        } } };
      }
    }
    if (!live) {
      const previous = slice.package.proposal;
      slice.package = { ...slice.package, proposal: {
        logline: previous?.logline ?? 'An offline outline built from the supplied brief.',
        look: 'Offline outline; no SVG visuals generated.',
        soundtrack: previous?.soundtrack ?? 'Soundtrack not specified.',
      } };
    }
    const validation = validatePackage(slice.package);
    if (!validation.valid) {
      const error = new Error('agent produced an invalid package');
      error.errors = validation.errors;
      throw error;
    }
    if (intent.generatedFilm) {
      const problems = generatedFilmCompletionProblems(slice.package, intent, motionModel, brief);
      if (problems.length) {
        const error = new Error(`generated-film plan is incomplete: ${problems.join('; ')}`);
        error.status = 422;
        error.code = 'GENERATED_FILM_INCOMPLETE';
        error.errors = problems;
        throw error;
      }
    }
    const modelContribution = plannedModelContribution(slice.package);
    if (!modelContribution.length) throw Object.assign(new Error(MODEL_CONTRIBUTION_MESSAGE), { status: 422, code: 'COMFY_MODEL_CONTRIBUTION_REQUIRED' });
    const generatedAssets = inlineGeneratedAssets(slice.package, packagesDir);
    return {
      ok: slice.ok,
      live,
      fallback,
      motionModel,
      provider: resolved?.name ?? 'scripted',
      model: resolved?.model ?? 'scripted',
      package: slice.package,
      timeline: null,
      generatedAssets,
      routes: slice.routes,
      pendingGpu: slice.pendingGpu,
      modelContribution: { state: 'planned', uses: modelContribution, requiresApproval: true },
      svgAssets: slice.svgAssets,
      usage: (() => { const usage = { ...aggregateUsage }; accumulateUsage(usage, svgUsage); return { ...usage, total: usage.input + usage.output, svg: { ...svgUsage } }; })(),
      events: slice.result.toolCalls.map(call => ({ name: call.name, ok: call.ok })),
    };
  };
}
