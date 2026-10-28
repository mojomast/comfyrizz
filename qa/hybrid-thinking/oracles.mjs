// Hybrid trigger oracles. They wrap planning-stress judges and add Remotion /
// collateral / generation-guard checks. Existing planning-stress oracles are
// not modified and are not weakened.
import { evaluateFixture, observePackage } from '../planning-stress/oracles.mjs';
import {
  SKIP_CORRECTION_CODES,
  decideCorrectionAction,
} from '../../apps/server/src/hybrid-planning-correction.mjs';
import { hybridWantsRemotion } from './fixtures.mjs';

const FILM_GENERATORS = ['fasth3-omni', 'ltx25', 'flux3-klein'];

export function mapFailureCode(message) {
  const text = String(message ?? '');
  if (/transport or provider infrastructure/i.test(text)) return 'INFRASTRUCTURE';
  if (/fallback/i.test(text)) return 'FALLBACK';
  if (/planning response was not live/i.test(text)) return 'NOT_LIVE';
  if (/provider or model/i.test(text)) return 'PROVIDER_MISMATCH';
  if (/scene count/i.test(text)) return 'SCENE_COUNT';
  if (/compiled duration|positive duration/i.test(text)) return 'DURATION_OUT_OF_RANGE';
  if (/headline/i.test(text)) return 'HEADLINE_MISSING';
  if (/a scene is missing narration/i.test(text)) return 'NARRATION_MISSING';
  if (/contains narration/i.test(text)) return 'NARRATION_FORBIDDEN';
  if (/cue phrase|narration cues/i.test(text)) return 'CUE_PHRASE_INVALID';
  if (/media route|forbidden generator/i.test(text)) return 'MEDIA_ROUTE';
  if (/SVG asset count/i.test(text)) return 'SVG_FLOOR';
  if (/planned still is missing/i.test(text)) return 'PENDING_STILL';
  if (/layout .+ is missing/i.test(text)) return 'LAYOUT_MISSING';
  if (/dataset|Example data|percentage|user or derived/i.test(text)) return 'DATASET_MISMATCH';
  if (/mascot/i.test(text)) return 'SHARED_MASCOT';
  if (/opening title/i.test(text)) return 'OPENING_TITLE';
  if (/generated shot media/i.test(text)) return 'SCENE_MEDIA_MISSING';
  if (/source image aspect|output is /i.test(text)) return 'FORMAT_MISMATCH';
  if (/number .+ truncated/i.test(text)) return 'PRESERVE_NUMBERS';
  if (/six-item list/i.test(text)) return 'LIST_ITEMS';
  if (/no-caption plan contains copy|contains a lower third/i.test(text)) return 'COPY_FORBIDDEN';
  if (/Kokoro voice/i.test(text)) return 'VOICE_ENABLE';
  if (/real-human|clay|plasticine|live-action/i.test(text)) return 'LIVE_ACTION_HUMANS';
  if (/schema|invalid package/i.test(text)) return 'SCHEMA_INVALID';
  if (/expected HTTP 200/i.test(text)) return 'QUALITY_OTHER';
  return 'QUALITY_OTHER';
}

export function observeHybrid(pkg, fixture) {
  const base = observePackage(pkg, fixture);
  const scenes = Array.isArray(pkg?.scenes) ? pkg.scenes : [];
  const assets = pkg?.assets && typeof pkg.assets === 'object' ? pkg.assets : {};
  const filmIndex = scenes
    .map((scene, index) => {
      const plates = (Array.isArray(scene?.media) ? scene.media : []).map(plate => assets[plate?.asset]).filter(Boolean);
      const film = plates.some(asset => FILM_GENERATORS.includes(asset?.gen?.generator));
      return film ? index : -1;
    })
    .filter(index => index >= 0);
  const first = filmIndex.length ? scenes[filmIndex[0]] : scenes[0];
  const last = filmIndex.length ? scenes[filmIndex[filmIndex.length - 1]] : scenes.at(-1);
  return {
    ...base,
    packageId: typeof pkg?.id === 'string' ? pkg.id : null,
    sceneIds: scenes.map(scene => scene?.id).filter(id => typeof id === 'string'),
    assetIds: Object.keys(assets),
    remotionOpener: Boolean(first && first.layout === 'title' && first.variant === 'centered'),
    remotionOutro: Boolean(last && last.layout === 'title' && last.variant === 'outro'),
    firstSceneId: typeof first?.id === 'string' ? first.id : null,
    lastSceneId: typeof last?.id === 'string' ? last.id : null,
  };
}

export function remotionFailures(fixture, observation) {
  if (!hybridWantsRemotion(fixture)) return [];
  const failures = [];
  if (observation.remotionOpener !== true) {
    failures.push({
      code: 'REMOTION_OPENER',
      detail: 'first AI-footage shot is missing layout:title variant:centered',
      sceneId: observation.firstSceneId ?? undefined,
    });
  }
  if (observation.remotionOutro !== true) {
    failures.push({
      code: 'REMOTION_OUTRO',
      detail: 'last AI-footage shot is missing layout:title variant:outro',
      sceneId: observation.lastSceneId ?? undefined,
    });
  }
  return failures;
}

export function triggerFromJudge(fixture, judged, observation = {}) {
  const infrastructure = judged.outcome === 'infrastructure';
  const mapped = (judged.failures ?? []).map(detail => ({
    code: mapFailureCode(detail),
    detail: String(detail).slice(0, 500),
  }));
  const extra = judged.outcome === 'pass' || judged.outcome === 'expected_refusal_pass' || judged.outcome === 'fail' || judged.outcome === 'missing_actionable_refusal'
    ? remotionFailures(fixture, observation)
    : [];
  const merged = [];
  const seen = new Set();
  for (const item of [...mapped, ...extra]) {
    const key = `${item.code}:${item.detail}:${item.sceneId ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(item);
  }
  const quality = merged.filter(item => !SKIP_CORRECTION_CODES.has(item.code) && item.code !== 'INFRASTRUCTURE');
  const decision = decideCorrectionAction({
    expect: fixture.expect,
    infrastructure,
    failures: quality,
  });
  return {
    outcome: judged.outcome,
    infrastructure,
    failures: quality,
    allFailures: merged,
    decision,
    remotionOpener: observation.remotionOpener ?? null,
    remotionOutro: observation.remotionOutro ?? null,
  };
}

export function evaluateHybrid(fixture, http, expected = {}) {
  const judged = evaluateFixture(fixture, http);
  if (expected.provider && expected.model) {
    judged.failures = (judged.failures ?? []).filter(detail => !/provider or model does not match/i.test(detail));
    const actualProvider = http?.provider ?? http?.body?.provider ?? null;
    const actualModel = http?.model ?? http?.body?.model ?? null;
    if (judged.outcome === 'pass' || judged.outcome === 'fail') {
      if (actualProvider !== expected.provider || actualModel !== expected.model) {
        judged.failures.push('response provider or model does not match the experiment pair');
        judged.outcome = 'fail';
      } else if (judged.outcome === 'fail' && judged.failures.length === 0) {
        judged.outcome = 'pass';
      }
    }
  }
  const pkg = http?.body?.package && typeof http.body.package === 'object' ? http.body.package : null;
  const observation = pkg ? observeHybrid(pkg, fixture) : {
    remotionOpener: false,
    remotionOutro: false,
    sceneIds: [],
    assetIds: [],
    packageId: null,
  };
  const trigger = triggerFromJudge(fixture, judged, observation);
  const remotionFailed = trigger.failures.some(item => item.code === 'REMOTION_OPENER' || item.code === 'REMOTION_OUTRO');
  let outcome = judged.outcome;
  if (outcome === 'pass' && remotionFailed) outcome = 'fail';
  return {
    ...judged,
    outcome,
    trigger,
    observation: {
      packageId: observation.packageId,
      sceneIds: observation.sceneIds,
      assetIds: observation.assetIds,
      remotionOpener: observation.remotionOpener,
      remotionOutro: observation.remotionOutro,
    },
  };
}

export function collateralDamage(before, after) {
  const beforeFailed = new Set((before?.failures ?? []).map(item => item.code));
  const newlyFailed = (after?.failures ?? [])
    .filter(item => !beforeFailed.has(item.code) && !SKIP_CORRECTION_CODES.has(item.code))
    .map(item => item.code);
  const introducedCodes = [...new Set(newlyFailed)];
  return { introducedCodes, count: introducedCodes.length };
}

export function outOfScopeIdChanges(beforeObservation, afterObservation, failures = []) {
  const allowedScenes = new Set(failures.map(item => item.sceneId).filter(Boolean));
  const allowedAssets = new Set(failures.map(item => item.assetId).filter(Boolean));
  const beforeScenes = new Set(beforeObservation?.sceneIds ?? []);
  const afterScenes = new Set(afterObservation?.sceneIds ?? []);
  const beforeAssets = new Set(beforeObservation?.assetIds ?? []);
  const afterAssets = new Set(afterObservation?.assetIds ?? []);
  const removedScenes = [...beforeScenes].filter(id => !afterScenes.has(id));
  const addedScenes = [...afterScenes].filter(id => !beforeScenes.has(id));
  const removedAssets = [...beforeAssets].filter(id => !afterAssets.has(id));
  const addedAssets = [...afterAssets].filter(id => !beforeAssets.has(id));
  const packageIdChanged = Boolean(beforeObservation?.packageId && afterObservation?.packageId
    && beforeObservation.packageId !== afterObservation.packageId);
  const unrelatedSceneChange = [...removedScenes, ...addedScenes].some(id => !allowedScenes.has(id));
  const unrelatedAssetChange = [...removedAssets, ...addedAssets].some(id => !allowedAssets.has(id));
  return {
    packageIdChanged,
    removedScenes,
    addedScenes,
    removedAssets,
    addedAssets,
    outOfScope: packageIdChanged || unrelatedSceneChange || unrelatedAssetChange,
  };
}
