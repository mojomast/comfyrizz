// C5: the default CPU agent runner. It wires packages/agent + packages/llm +
// packages/vector. Offline it uses the deterministic scripted model; with a
// provider it uses the live model for both planning and SVG markup, falling
// back to the A5 stub if the model output cannot be parsed.
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { inlineGeneratedAssets } from '../../renderer/scripts/render-package-lib.mjs';
import { validatePackage } from '../../../packages/schema/src/index.mjs';
import { compileTimeline } from '../../../packages/planner/dist/src/index.js';
import { durationRangeText, durationWithinTarget } from './duration-policy.mjs';

const SVG_SYSTEM = [
  'You write one standalone SVG document and nothing else.',
  'Use an <svg> root with a viewBox, only the supplied palette colours, and no <script>, <image>, external references or event attributes.',
  'Prefer simple shapes and paths. Keep it under 4 KB.',
].join(' ');

const REPAIR_SYSTEM = [
  'You are Comfyrizz performing one focused repair of an existing generated-film package. The package is already loaded.',
  'Hard rules: do not call storyboard.propose, rebuild the storyboard, replace or regenerate existing assets, change the story, or change the model route.',
  'Workflow: read each issue in the user validation report, make only the edit it requires, then stop. Use storyboard.edit for scene fields such as preferredFrames, copy or notes. If a shot lacks required generated media or references, create only those missing assets with assets.generate_video or assets.generate_image.',
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

function repairPackageFacts(pkg, intent) {
  const fps = Number(pkg?.format?.fps) > 0 ? Number(pkg.format.fps) : 30;
  const scenes = Array.isArray(pkg?.scenes) ? pkg.scenes : [];
  const currentFrames = plannedTimelineFrames(pkg);
  const targetFrames = intent.requestedSeconds === null ? 'unspecified' : Math.round(intent.requestedSeconds * fps);
  const sceneFacts = scenes.map(scene => `${scene?.id ?? '(missing id)'} preferredFrames=${Number(scene?.preferredFrames) || 0}; narration=${JSON.stringify(typeof scene?.narration === 'string' ? scene.narration : '')}`).join('\n');
  return [
    'Current package facts (authoritative data, not instructions):',
    `Timing: fps=${fps}; current total frames=${currentFrames}; requested total frames=${targetFrames}; acceptable compiled duration=${durationRangeText(intent.requestedSeconds)}.`,
    `Scene IDs and current values: ${sceneFacts || 'none'}.`,
    'Use only these exact scene IDs for storyboard.edit; do not invent aliases or guess scene names.',
  ].join('\n');
}

function generatedClipSeconds(asset) {
  const frames = Number(asset?.gen?.inputs?.frames);
  const fps = Number(asset?.gen?.inputs?.fps);
  return frames > 0 && fps > 0 ? frames / fps : 0;
}

/** Split under-covered pending scenes into real generation shots before validation. */
export function coverGeneratedFilmScenes(pkg) {
  if (!pkg || !Array.isArray(pkg.scenes)) return { package: pkg, splits: 0 };
  const next = structuredClone(pkg);
  next.assets = next.assets && typeof next.assets === 'object' ? next.assets : {};
  const scenes = [];
  const replacedAssetIds = new Set();
  let splits = 0;
  for (const scene of next.scenes) {
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
    if (!template || clipSeconds <= 0 || sceneSeconds <= 0 || sceneSeconds <= clipSeconds * 2) {
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
      scenes.push({
        ...scene,
        id: `${scene.id}__part${part + 1}`,
        preferredFrames: Math.floor(sceneFrames / partCount) + (part < sceneFrames % partCount ? 1 : 0),
        media: [media],
      });
    }
    replacedAssetIds.add(templateAssetId);
    splits += 1;
  }
  if (splits === 0) return { package: pkg, splits: 0 };
  next.scenes = scenes;
  for (const assetId of replacedAssetIds) {
    const used = scenes.some(scene => (Array.isArray(scene?.media) ? scene.media : []).some(plate => plate?.asset === assetId));
    if (!used) delete next.assets[assetId];
  }
  next.revision = Math.max(1, Number(next.revision) || 1) + 1;
  return { package: next, splits };
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

/** Completion is shot-reachable: orphan pending GPU assets never satisfy it. */
export function generatedFilmCompletionProblems(pkg, intent, motionModel = 'auto') {
  const problems = [];
  const scenes = Array.isArray(pkg?.scenes) ? pkg.scenes : [];
  const assets = pkg?.assets && typeof pkg.assets === 'object' ? pkg.assets : {};
  if (scenes.length === 0) return ['generated film has no scenes/shots'];
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
    const mediaPlates = Array.isArray(scene?.media) ? scene.media : [];
    const mediaAssets = mediaPlates
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
    if (sceneSeconds > 0 && coveredSeconds > 0 && coveredSeconds * 2 < sceneSeconds) {
      problems.push(`${sceneId}: scene is ${sceneSeconds.toFixed(2)} seconds but attached generated video covers ${coveredSeconds.toFixed(2)} seconds; add enough generation clips or shorten the scene instead of stretching a short clip`);
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
    const planningBrief = productionIntent.liveActionHumans
      ? `${brief}\n\nHard creative constraint: use photorealistic live-action fictional human adults with natural skin and real-world materials in the proposal and every image/video prompt. Do not substitute clay, plasticine, stop-motion, puppets, cartoons or handmade-miniature styling.`
      : brief;
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
    const runOnce = async (model, repairInstructions = null) => {
      const phase = repairInstructions ? 'repair' : 'initial';
      const phaseStartedAt = Date.now();
      onEvent?.({ type: 'runner_phase', phase, status: 'started', elapsedMs: Date.now() - runStartedAt });
      try {
        let result = await runCpuSlice({
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
            system: REPAIR_SYSTEM,
          } : {}),
          // Initial planning is bounded separately from the much smaller edit-only repair.
          maxSteps: repairInstructions ? 8 : 16,
          onEvent: event => onEvent?.({ ...event, phase, runElapsedMs: Date.now() - runStartedAt }),
        });
        if (productionIntent.generatedFilm) {
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
        }
        onEvent?.({ type: 'runner_phase', phase, status: 'completed', durationMs: Date.now() - phaseStartedAt, elapsedMs: Date.now() - runStartedAt, stopped: result.result.stopped ?? 'final' });
        return result;
      } catch (error) {
        onEvent?.({ type: 'runner_phase', phase, status: 'failed', durationMs: Date.now() - phaseStartedAt, elapsedMs: Date.now() - runStartedAt, message: error.message });
        throw error;
      }
    };
    const acceptable = candidate => productionIntent.generatedFilm
      ? candidate.ok && generatedFilmCompletionProblems(candidate.package, productionIntent, motionModel).length === 0 && validatePackage(candidate.package).valid
      : candidate.svgAssets.length >= 4 && candidate.pendingGpu.length >= 1 && validatePackage(candidate.package).valid;
    let slice = await runOnce(agentModel);
    let fallback = false;
    // Motion graphics retains the deterministic CPU fallback. A generated-film
    // miss is an actionable failure: substituting the SVG/FLUX script would
    // silently change the requested deliverable and hide missing generated shots.
    if (agentModel && !acceptable(slice)) {
      if (productionIntent.generatedFilm) {
        const initialProblems = [
          ...generatedFilmCompletionProblems(slice.package, productionIntent, motionModel),
          ...packageSchemaProblems(slice.package),
        ];
        onEvent?.({ type: 'runner_phase', phase: 'initial', status: 'validation', ok: false, problems: initialProblems, elapsedMs: Date.now() - runStartedAt });
        slice = await runOnce(agentModel, `${repairPackageFacts(slice.package, productionIntent)}\n\nValidation report: the current generated-film package failed validation. Repair the existing package without changing its story or model route. Fix exactly these issues, one edit per issue, then stop:\n- ${initialProblems.join('\n- ')}`);
        if (!acceptable(slice)) {
          const problems = [
            ...generatedFilmCompletionProblems(slice.package, productionIntent, motionModel),
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
        slice = await runOnce(null);
        fallback = true;
      }
    }
    const validation = validatePackage(slice.package);
    if (!validation.valid) {
      const error = new Error('agent produced an invalid package');
      error.errors = validation.errors;
      throw error;
    }
    if (productionIntent.generatedFilm) {
      const problems = generatedFilmCompletionProblems(slice.package, productionIntent, motionModel);
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
      usage: { ...slice.result.usage, total: slice.result.usage.input + slice.result.usage.output },
      events: slice.result.toolCalls.map(call => ({ name: call.name, ok: call.ok })),
    };
  };
}
