// C5: the default CPU agent runner. It wires packages/agent + packages/llm +
// packages/vector. Offline it uses the deterministic scripted model; with a
// provider it uses the live model for both planning and SVG markup, falling
// back to the A5 stub if the model output cannot be parsed.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { inlineGeneratedAssets } from '../../renderer/scripts/render-package-lib.mjs';
import { validatePackage } from '../../../packages/schema/src/index.mjs';
import { compileTimeline } from '../../../packages/planner/dist/src/index.js';
import { aspectFromSize, extractBrief } from '../../../packages/agent/dist/src/index.js';
import { durationRangeText, durationWithinTarget } from './duration-policy.mjs';

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
  'Workflow: read each issue in the user validation report, make only the edit it requires, then stop. Use assets.generate_svg for each missing ready llm-svg asset and assets.generate_image for the missing scene-referenced planned GPU still. Use storyboard.edit only for scene fields named in the issues.',
  'SVG floor: keep at least 4 ready llm-svg assets in the package; never replace or drop one while adding the pending still.',
  'Pending still floor: the package needs at least 1 scene-referenced planned GPU still. Call assets.generate_image with a scene_id and a scene kind such as illustration, texture or background. Reference, identity, cast, portrait or start-frame kinds are reference-only and do not attach the still to a scene, so they do not satisfy this floor. Do not pass refs for this still: a ref edit without a cast member is reference-only too.',
  'Tool errors: for invalid_arguments, correct only the fields named in issues[].path and resend; for tool_failed, supply the prerequisite the message names. Never resend identical arguments.',
  'When the listed issues are fixed, stop calling tools and reply with one short sentence.',
].join('\n');

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

function repairPackageFacts(pkg, intent, briefAspect) {
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
  facts.push('Use only these exact scene IDs for storyboard.edit; do not invent aliases or guess scene names.');
  return facts.join('\n');
}

/**
 * A narration-timed brief can still say the picture has no native dialogue.
 * That is a sound constraint, not a request to drop narration; only an
 * explicit wordless/no-narration request suppresses narration-timed planning.
 */
function explicitlyWordless(brief) {
  return /\bwordless\b|\bno\b[^.!?\n]{0,70}\b(?:narration|speech|voice[\s-]?over)\b|\bwithout\s+(?:narration|speech|voice[\s-]?over)\b/i.test(String(brief ?? ''));
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
  if (!intent.requiresNarrationCues) return [];
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
  if (!codes.has('SVG_ASSET_FLOOR') && !codes.has('PENDING_GPU_MISSING')) return [];
  const svgAssets = Array.isArray(slice?.svgAssets) ? slice.svgAssets : [];
  const sceneReferenced = sceneReferencedPendingStills(slice?.pendingGpu);
  const targetScene = Array.isArray(slice?.package?.scenes) && slice.package.scenes[0]?.id ? slice.package.scenes[0].id : 's1';
  const lines = ['Motion-graphics repair floors (hard requirements from the validation report):'];
  if (svgAssets.length < 4) {
    lines.push(`- SVG floor: call assets.generate_svg until at least 4 ready llm-svg assets exist; got ${svgAssets.length}.`);
  } else {
    lines.push('- SVG floor: keep at least 4 ready llm-svg assets; do not replace or drop one.');
  }
  if (sceneReferenced.length < 1) {
    lines.push(`- Pending GPU still repair: call assets.generate_image with scene_id "${targetScene}" and a scene kind such as illustration, texture or background. Do not pass refs and do not use reference, identity, cast, portrait or start-frame kinds; those are reference-only and do not satisfy this floor.`);
  }
  return lines;
}

/** Completion is shot-reachable: orphan pending GPU assets never satisfy it. */
export function generatedFilmCompletionProblems(pkg, intent, motionModel = 'auto') {
  const problems = [];
  const scenes = Array.isArray(pkg?.scenes) ? pkg.scenes : [];
  const assets = pkg?.assets && typeof pkg.assets === 'object' ? pkg.assets : {};
  if (scenes.length === 0) return ['generated film has no scenes/shots'];
  for (const still of sourceStillFormatProblems(pkg)) problems.push(still.message);
  const proposal = pkg?.proposal;
  for (const field of ['logline', 'look', 'soundtrack']) {
    if (typeof proposal?.[field] !== 'string' || proposal[field].trim().length < 3) {
      problems.push(`proposal.${field} is required: give the user a specific, concise creative direction`);
    }
  }
  if (proposal?.logline === 'A story built from your idea.') problems.push('proposal.logline must describe the actual story, not a generic fallback');
  const fps = Number(pkg?.format?.fps) > 0 ? Number(pkg.format.fps) : 30;
  const plannedSeconds = plannedTimelineFrames(pkg) / fps;
  if (intent.requestedSeconds !== null && !durationWithinTarget(plannedSeconds, intent.requestedSeconds)) {
    problems.push(`brief requests ${intent.requestedSeconds} seconds but the plan is ${plannedSeconds.toFixed(2)} seconds; acceptable range is ${durationRangeText(intent.requestedSeconds)}; adjust scene frames before production`);
  }
  if (motionModel === 'klein' && !/stills \+ code motion/i.test((pkg?.compliance?.warnings ?? []).join(' '))) {
    problems.push('Klein proposal must explicitly say stills + code motion');
  }
  for (const scene of scenes) {
    const sceneId = scene?.id ?? '(unknown scene)';
    if (intent.requiresNarrationCues) {
      if (typeof scene?.narration !== 'string' || !scene.narration.trim()) {
        problems.push(`${sceneId}: narration-timed motion graphics require a concise scene.narration sentence`);
      } else if (!Array.isArray(scene?.motion?.cue_phrases) || scene.motion.cue_phrases.filter(phrase => typeof phrase === 'string' && phrase.trim()).length === 0) {
        problems.push(`${sceneId}: narration-timed motion graphics require motion.cue_phrases copied verbatim from this scene's narration`);
      } else if (scene.motion.cue_phrases.some(phrase => typeof phrase !== 'string' || !phrase.trim() || !scene.narration.includes(phrase))) {
        problems.push(`${sceneId}: every motion.cue_phrases entry must be copied verbatim from this scene's narration`);
      }
    }
    const mediaAssets = (Array.isArray(scene?.media) ? scene.media : [])
      .map(plate => typeof plate?.asset === 'string' ? assets[plate.asset] : null)
      .filter(Boolean);
    const videos = mediaAssets.filter(asset => asset.kind === 'video' && ['fasth3-omni', 'ltx25'].includes(asset.gen?.generator));
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
    for (const asset of videos) {
      const generator = asset.gen.generator;
      if (motionModel !== 'auto' && ((motionModel === 'h3' && generator !== 'fasth3-omni') || (motionModel === 'ltx' && generator !== 'ltx25'))) {
        problems.push(`${sceneId}: configured motionModel ${motionModel} cannot be completed by ${generator}; do not substitute models`);
      }
      if (generator === 'fasth3-omni') {
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

export function motionGraphicsCompletionProblems(slice) {
  const problems = [];
  const svgAssets = Array.isArray(slice?.svgAssets) ? slice.svgAssets : [];
  if (svgAssets.length < 4) {
    problems.push({
      code: 'SVG_ASSET_FLOOR',
      message: `motion graphics requires at least 4 ready llm-svg assets, got ${svgAssets.length}`,
      path: 'assets',
      count: svgAssets.length,
      required: 4,
    });
  }
  const sceneReferencedPending = sceneReferencedPendingStills(slice?.pendingGpu);
  if (sceneReferencedPending.length < 1) {
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
    if (code === 'SVG_ASSET_FLOOR') continue;
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

function createLlmSvgGenerator(model, sessionId) {
  return async ({ intent, attempt, errors }) => {
    const prompt = [
      `Draw a ${intent.kind} SVG for: ${intent.prompt}`,
      intent.palette?.length ? `Palette: ${intent.palette.join(', ')}.` : '',
      attempt > 1 && errors.length ? `The previous attempt failed: ${errors.map(error => error.message).join('; ')}. Return a complete corrected SVG that fixes exactly these errors and keeps the same drawing.` : '',
    ].filter(Boolean).join('\n');
    let text = '';
    for await (const chunk of model.stream({
      system: SVG_SYSTEM,
      messages: [{ role: 'user', content: prompt }],
      tools: [],
      signal: new AbortController().signal,
      sessionId,
    })) {
      if (chunk.type === 'text') text += chunk.delta;
      if (chunk.type === 'error') throw new Error(`${chunk.code}${chunk.message ? `: ${chunk.message}` : ''}`);
    }
    const svg = extractSvg(text);
    if (!svg) throw new Error('model did not return an <svg> document');
    return svg;
  };
}

export function createCpuAgentRunner({ runtimeDir, now = () => new Date().toISOString(), providers = {}, resolveProviderConfig, motionModel: defaultMotionModel = 'auto' } = {}) {
  const packagesDir = join(runtimeDir, 'packages');
  const assetsDir = join(packagesDir, 'assets');
  return async function runCpuAgent({ brief, brand, provider, model: modelName, motionModel: requestedMotionModel, sessionId = 'cpu-slice', onEvent } = {}) {
    if (typeof brief !== 'string' || brief.trim().length === 0) {
      const error = new Error('brief is required');
      error.status = 400;
      throw error;
    }
    const brandKit = brand?.kit ?? null;
    const brandAssets = brand?.assets ?? null;
    const { runCpuSlice, classifyProductionIntent, parseMotionModel } = await import('../../../packages/agent/dist/src/index.js');
    const productionIntent = classifyProductionIntent(brief);
    const intent = narrationTimedIntent(productionIntent, brief);
    const planningBrief = planningBriefForNarration(brief, productionIntent);
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
      agentModel = createOpenAICompatibleModel(resolved);
      live = true;
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
    // The live model builds the package draft (the C5-live goal). Live SVG markup
    // is opt-in: each live SVG is a full reasoning stream and one run can take
    // minutes, so the default keeps SVG on the deterministic A5 stub.
    const liveSvg = live && process.env.COMFYRIZZ_LIVE_SVG === '1';
    const generateSvg = async intent => {
      const llmGenerator = liveSvg ? createLlmSvgGenerator(agentModel, `${sessionId}-svg`) : null;
      let result;
      let source = 'stub';
      if (llmGenerator) {
        try {
          const attempt = await vector.autoFix(llmGenerator, intent, 2, { width: 512 });
          if (attempt.ok) {
            result = attempt;
            source = 'llm';
          }
        } catch {
          // fall through to the deterministic stub
        }
      }
      if (!result) {
        result = await vector.autoFix(vector.stubGenerator, intent, 2, { width: 512 });
        source = 'stub';
      }
      if (!result.ok) throw new Error(result.errors.map(error => `${error.code}: ${error.message}`).join('; '));
      const check = vector.renderCheck(result.svg, { width: 512, palette: intent.palette });
      return {
        svg: result.svg,
        attempts: result.attempts,
        repairs: result.repairs,
        source,
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
    const runOnce = async (model, repairInstructions = null, repairSystem = REPAIR_SYSTEM) => {
      const phase = repairInstructions ? 'repair' : 'initial';
      const phaseStartedAt = Date.now();
      onEvent?.({ type: 'runner_phase', phase, status: 'started', elapsedMs: Date.now() - runStartedAt });
      try {
        const result = await runCpuSlice({
          brief: repairInstructions ? `${planningBrief}\n\n${repairInstructions}` : planningBrief,
          ...(repairInstructions ? { initialPackage: slice.package } : {}),
          ...(model ? { model } : {}),
          ...(brandKit ? { brand: brandKit } : {}),
          ...(brandAssets ? { brandAssets } : {}),
          generateSvg,
          persistSvg,
          persistAudio,
          motionModel,
          sessionId,
          now,
          ...(repairInstructions ? {
            system: repairSystem,
          } : {}),
          // Initial planning is bounded separately from the much smaller edit-only repair.
          maxSteps: repairInstructions ? 8 : 16,
          onEvent: event => onEvent?.({ ...event, phase, runElapsedMs: Date.now() - runStartedAt }),
        });
        onEvent?.({ type: 'runner_phase', phase, status: 'completed', durationMs: Date.now() - phaseStartedAt, elapsedMs: Date.now() - runStartedAt, stopped: result.result.stopped ?? 'final' });
        return result;
      } catch (error) {
        onEvent?.({ type: 'runner_phase', phase, status: 'failed', durationMs: Date.now() - phaseStartedAt, elapsedMs: Date.now() - runStartedAt, message: error.message });
        throw error;
      }
    };
    const acceptable = candidate => intent.generatedFilm
      ? candidate.ok && generatedFilmCompletionProblems(candidate.package, intent, motionModel).length === 0 && validatePackage(candidate.package).valid
      : motionGraphicsCompletionProblems(candidate).length === 0;
    const aggregateUsage = { input: 0, output: 0 };
    const absorbUsage = result => {
      aggregateUsage.input += Number(result?.usage?.input) || 0;
      aggregateUsage.output += Number(result?.usage?.output) || 0;
    };
    let slice = await runOnce(agentModel);
    absorbUsage(slice.result);
    const fallback = false;
    if (agentModel && !acceptable(slice)) {
      if (intent.generatedFilm) {
        const initialProblems = [
          ...generatedFilmCompletionProblems(slice.package, intent, motionModel),
          ...packageSchemaProblems(slice.package),
        ];
        onEvent?.({ type: 'runner_phase', phase: 'initial', status: 'validation', ok: false, problems: initialProblems, elapsedMs: Date.now() - runStartedAt });
        const narrationGuide = narrationRepairGuide(slice.package, intent, brief);
        slice = await runOnce(agentModel, [
          repairPackageFacts(slice.package, intent, briefAspect),
          ...(narrationGuide.length ? [narrationGuide.join('\n')] : []),
          `Validation report: the current generated-film package failed validation. Repair the existing package without changing its story or model route. Fix exactly these issues, one edit per issue, then stop:\n- ${initialProblems.join('\n- ')}`,
        ].join('\n\n'));
        absorbUsage(slice.result);
        if (!acceptable(slice)) {
          const problems = [
            ...generatedFilmCompletionProblems(slice.package, intent, motionModel),
            ...packageSchemaProblems(slice.package),
          ];
          onEvent?.({ type: 'runner_phase', phase: 'repair', status: 'validation', ok: false, problems, elapsedMs: Date.now() - runStartedAt });
          const error = new Error(`generated-film plan is incomplete: ${problems.join('; ') || slice.result.error || 'live agent did not finish'}`);
          error.status = 422;
          error.code = 'GENERATED_FILM_INCOMPLETE';
          error.errors = problems;
          throw error;
        }
      } else {
        const initialProblems = motionGraphicsCompletionProblems(slice);
        onEvent?.({ type: 'runner_phase', phase: 'initial', status: 'validation', ok: false, problems: problemLines(initialProblems), elapsedMs: Date.now() - runStartedAt });
        const repairGuide = motionGraphicsRepairGuide(slice, initialProblems);
        slice = await runOnce(agentModel, [
          repairPackageFacts(slice.package, intent, briefAspect),
          ...(repairGuide.length ? [repairGuide.join('\n')] : []),
          `Validation report: the current motion-graphics package is incomplete. Repair the existing package without changing its story or model route. Fix exactly these issues, one edit per issue, then stop:\n- ${problemLines(initialProblems).join('\n- ')}`,
        ].join('\n\n'), MOTION_GRAPHICS_REPAIR_SYSTEM);
        absorbUsage(slice.result);
        if (!acceptable(slice)) {
          const problems = motionGraphicsCompletionProblems(slice);
          const lines = problemLines(problems);
          onEvent?.({ type: 'runner_phase', phase: 'repair', status: 'validation', ok: false, problems: lines, elapsedMs: Date.now() - runStartedAt });
          const svgProblem = problems.find(problem => problem.code === 'SVG_ASSET_FLOOR');
          const pendingProblem = problems.find(problem => problem.code === 'PENDING_GPU_MISSING');
          const error = new Error(`motion graphics is incomplete after one repair: ${lines.join('; ') || slice.result.error || 'live agent did not finish'}`);
          error.status = 422;
          error.code = 'MOTION_GRAPHICS_INCOMPLETE';
          error.errors = lines;
          error.details = {
            codes: problems.map(problem => problem.code),
            svgCount: svgProblem?.count ?? (Array.isArray(slice.svgAssets) ? slice.svgAssets.length : 0),
            requiredSvgCount: 4,
            pendingGpuCount: pendingProblem?.count ?? (Array.isArray(slice.pendingGpu) ? slice.pendingGpu.length : 0),
            requiredPendingGpuCount: 1,
            problems: lines,
          };
          throw error;
        }
      }
    }
    const validation = validatePackage(slice.package);
    if (!validation.valid) {
      const error = new Error('agent produced an invalid package');
      error.errors = validation.errors;
      throw error;
    }
    if (intent.generatedFilm) {
      const problems = generatedFilmCompletionProblems(slice.package, intent, motionModel);
      if (problems.length) {
        const error = new Error(`generated-film plan is incomplete: ${problems.join('; ')}`);
        error.status = 422;
        error.code = 'GENERATED_FILM_INCOMPLETE';
        error.errors = problems;
        throw error;
      }
    }
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
      svgAssets: slice.svgAssets,
      usage: { input: aggregateUsage.input, output: aggregateUsage.output, total: aggregateUsage.input + aggregateUsage.output },
      events: slice.result.toolCalls.map(call => ({ name: call.name, ok: call.ok })),
    };
  };
}
