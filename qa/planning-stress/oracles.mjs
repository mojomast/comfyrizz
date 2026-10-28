// Planning oracles. They score an in-memory package view and return short
// validation strings. They do not persist packages, prompts, or model text.
import { durationAcceptance, durationWithinTarget } from '../../apps/server/src/duration-policy.mjs';
import { generatedFilmCompletionProblems, packageSchemaProblems } from '../../apps/server/src/agent-runner.mjs';
import { classifyProductionIntent } from '../../packages/agent/dist/src/index.js';
import { compileTimeline } from '../../packages/planner/dist/src/index.js';
import { PLANNING_MODEL, PLANNING_PROVIDER } from './fixtures.mjs';

const FILM_GENERATORS = ['fasth3-omni', 'ltx25', 'flux3-klein'];
const INFRA_STATUS = new Set([0, 401, 403, 408, 429, 502, 503, 504]);

export function detailText(body) {
  if (!body || typeof body !== 'object') return '';
  const parts = [];
  if (typeof body.error === 'string') parts.push(body.error);
  if (typeof body.message === 'string') parts.push(body.message);
  if (Array.isArray(body.details)) {
    for (const detail of body.details) {
      if (typeof detail === 'string') parts.push(detail);
      else if (detail && typeof detail === 'object') {
        const path = detail.path ?? detail.instancePath ?? '';
        const message = detail.message ?? '';
        parts.push(`${path} ${message}`.trim());
      }
    }
  }
  return parts.join('\n').slice(0, 4000);
}

function textOf(value) {
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return String(value);
  if (Array.isArray(value)) return value.map(textOf).join('\n');
  if (value && typeof value === 'object') return Object.values(value).map(textOf).join('\n');
  return '';
}

function hasCopy(copy) {
  return Boolean(copy) && typeof copy === 'object' && Object.values(copy).some(value =>
    Array.isArray(value) ? value.length > 0 : typeof value === 'string' ? value.trim().length > 0 : value != null,
  );
}

function compiledSeconds(pkg) {
  const fps = Number(pkg?.format?.fps) > 0 ? Number(pkg.format.fps) : 30;
  const scenes = Array.isArray(pkg?.scenes) ? pkg.scenes : [];
  const preferred = scenes.reduce((sum, scene) => sum + (Number(scene?.preferredFrames) || 0), 0) / fps;
  try {
    const frames = Number(compileTimeline(pkg).durationInFrames);
    if (Number.isFinite(frames) && frames >= 0) {
      return { seconds: frames / fps, source: 'compiled' };
    }
  } catch {
    // Preferred frames still describe the plan when the package cannot compile.
  }
  return { seconds: Number.isFinite(preferred) ? preferred : null, source: 'preferred-frames' };
}

function datasetList(pkg) {
  const datasets = pkg?.datasets && typeof pkg.datasets === 'object' ? pkg.datasets : {};
  return Object.entries(datasets).map(([id, dataset]) => ({
    id,
    source: dataset?.source ?? null,
    values: Array.isArray(dataset?.values)
      ? dataset.values.map(entry => ({ label: String(entry?.label ?? ''), value: Number(entry?.value) }))
      : [],
  }));
}

/** Extract oracle facts from a package. The package itself is not returned. */
export function observePackage(pkg, fixture) {
  const scenes = Array.isArray(pkg?.scenes) ? pkg.scenes : [];
  const assets = pkg?.assets && typeof pkg.assets === 'object' ? pkg.assets : {};
  const intent = classifyProductionIntent(fixture?.brief ?? '');
  const motionModel = fixture?.motionModel ?? 'auto';
  const duration = compiledSeconds(pkg);
  const observedScenes = scenes.map(scene => {
    const plates = (Array.isArray(scene?.media) ? scene.media : [])
      .map(plate => assets[plate?.asset])
      .filter(Boolean);
    const generators = plates.map(asset => asset?.gen?.generator).filter(generator => typeof generator === 'string');
    return {
      id: scene?.id ?? null,
      layout: scene?.layout ?? null,
      headline: typeof scene?.copy?.headline === 'string' ? scene.copy.headline : '',
      narration: typeof scene?.narration === 'string' ? scene.narration : '',
      narrationAsset: typeof scene?.narration_asset === 'string' ? scene.narration_asset : '',
      cuePhrases: Array.isArray(scene?.motion?.cue_phrases) ? scene.motion.cue_phrases.filter(phrase => typeof phrase === 'string') : [],
      hasCopy: hasCopy(scene?.copy),
      hasLowerThird: Boolean(scene?.lower_third),
      generators,
      frames: Number(scene?.preferredFrames) || 0,
      items: Array.isArray(scene?.copy?.items) ? scene.copy.items.filter(item => typeof item === 'string') : [],
      datasetId: typeof scene?.data?.dataset === 'string' ? scene.data.dataset : null,
    };
  });
  const cast = Array.isArray(pkg?.cast) ? pkg.cast : [];
  return {
    schemaProblems: packageSchemaProblems(pkg).slice(0, 12),
    completionProblems: fixture?.oracle?.kind === 'generated-film'
      ? generatedFilmCompletionProblems(pkg, intent, motionModel).slice(0, 12)
      : [],
    sceneCount: scenes.length,
    durationSeconds: duration.seconds,
    durationSource: duration.source,
    format: {
      width: Number(pkg?.format?.width) || null,
      height: Number(pkg?.format?.height) || null,
      fps: Number(pkg?.format?.fps) || null,
    },
    scenes: observedScenes,
    generators: Object.values(assets).map(asset => asset?.gen?.generator).filter(generator => typeof generator === 'string'),
    svgCount: Object.values(assets).filter(asset => asset?.kind === 'svg' || asset?.kind === 'vector-anim' || asset?.gen?.generator === 'llm-svg').length,
    pendingStillCount: Object.values(assets).filter(asset => asset?.kind === 'image' && asset?.status === 'pending').length,
    datasets: datasetList(pkg),
    castCount: cast.length,
    sharedCast: cast.length > 0 && scenes.length > 0 && scenes.every(scene => Array.isArray(scene?.cast) && scene.cast.includes(cast[0]?.id)),
    sourceDimensions: Object.values(assets)
      .filter(asset => asset?.kind === 'image')
      .map(asset => ({
        width: Number(asset?.gen?.inputs?.width ?? asset?.media?.width) || null,
        height: Number(asset?.gen?.inputs?.height ?? asset?.media?.height) || null,
      }))
      .filter(size => size.width && size.height),
    copyText: scenes.map(scene => textOf(scene?.copy)).join('\n'),
    openingTitle: observedScenes.length > 0 && (observedScenes[0].headline.trim().length > 0 || observedScenes[0].hasLowerThird),
    everySceneHasMedia: observedScenes.length > 0 && observedScenes.every(scene => scene.generators.some(generator => FILM_GENERATORS.includes(generator))),
    intentKind: intent.kind,
  };
}

function numberPresent(text, number) {
  const digits = String(number);
  return new RegExp(`(?<![0-9])${digits}(?![0-9])`).test(text);
}

function datasetMatches(observation, expected) {
  const failures = [];
  const datasets = observation.datasets ?? [];
  const matched = datasets.find(dataset => expected.values.every(value =>
    dataset.values.some(entry => entry.label === value.label && entry.value === value.value),
  ));
  if (!matched) {
    failures.push('user dataset values are missing or were altered');
    return failures;
  }
  if (expected.source && matched.source !== expected.source) failures.push(`dataset source is ${matched.source ?? 'missing'}; expected ${expected.source}`);
  if (expected.exclusive && (datasets.length !== 1 || matched.values.length !== expected.values.length)) {
    failures.push('dataset contains extra categories or an extra dataset');
  }
  if (expected.shared) {
    const refs = (observation.scenes ?? []).map(scene => scene.datasetId);
    if (refs.length === 0 || refs.some(id => id !== matched.id)) failures.push('chart, stat and comparison scenes do not share one dataset');
  }
  return failures;
}

function sceneGenerator(scene) {
  return (scene.generators ?? []).find(generator => FILM_GENERATORS.includes(generator)) ?? null;
}

/**
 * Score one fixture. `observation` is a package view plus HTTP facts.
 * Return value never includes the package, brief, or raw model text.
 */
export function judge(fixture, observation) {
  const oracle = fixture.oracle ?? {};
  const status = Number(observation.httpStatus) || 0;
  const failures = [];
  if (INFRA_STATUS.has(status) || observation.transport) {
    return finish(fixture, observation, 'infrastructure', ['transport or provider infrastructure failure']);
  }
  if (fixture.expect === 'refusal') return judgeRefusal(fixture, observation, status);

  if (status !== 200) {
    failures.push(`expected HTTP 200, received ${status || 'no response'}`);
    const details = String(observation.details ?? '').split('\n').filter(Boolean).slice(0, 6);
    failures.push(...details);
    return finish(fixture, observation, 'fail', failures);
  }
  if (observation.live !== true) failures.push('planning response was not live');
  if (observation.fallback === true) failures.push('scripted fallback substituted for the live plan');
  if (observation.provider !== PLANNING_PROVIDER || observation.model !== PLANNING_MODEL) {
    failures.push('response provider or model does not match opencode-go / deepseek-v4.1-flash');
  }
  if (oracle.kind && observation.intentKind && observation.intentKind !== oracle.kind) {
    failures.push(`package intent classified as ${observation.intentKind}; expected ${oracle.kind}`);
  }
  if (Number.isInteger(oracle.sceneCount) && observation.sceneCount !== oracle.sceneCount) {
    failures.push(`scene count is ${observation.sceneCount}; expected ${oracle.sceneCount}`);
  }
  if (Number.isFinite(oracle.targetSeconds)) {
    const acceptance = durationAcceptance(oracle.targetSeconds);
    if (!Number.isFinite(observation.durationSeconds) || !durationWithinTarget(observation.durationSeconds, oracle.targetSeconds)) {
      const actual = Number.isFinite(observation.durationSeconds) ? Number(observation.durationSeconds).toFixed(2) : 'missing';
      failures.push(`compiled duration ${actual}s is outside ${acceptance.minSeconds.toFixed(2)}–${acceptance.maxSeconds.toFixed(2)}s`);
    }
  } else if (oracle.positiveDuration && !(Number(observation.durationSeconds) > 0)) {
    failures.push('plan has no positive duration');
  }
  if (oracle.fps && observation.format?.fps !== oracle.fps) failures.push(`fps is ${observation.format?.fps}; expected ${oracle.fps}`);
  if (oracle.output) {
    if (observation.format?.width !== oracle.output.width || observation.format?.height !== oracle.output.height) {
      failures.push(`output is ${observation.format?.width}x${observation.format?.height}; expected ${oracle.output.width}x${oracle.output.height}`);
    }
  }
  if (oracle.sourceMatchesOutput) {
    const sources = observation.sourceDimensions ?? [];
    if (sources.length === 0) failures.push('no source image dimensions were recorded');
    for (const source of sources) {
      if (source.width !== observation.format?.width || source.height !== observation.format?.height) {
        failures.push('a source image aspect does not match the output format');
        break;
      }
    }
  }
  const headlines = (observation.scenes ?? []).map(scene => scene.headline);
  if (Array.isArray(oracle.headlines)) {
    if (oracle.headlineOrder) {
      oracle.headlines.forEach((headline, index) => {
        if (headlines[index] !== headline) failures.push(`scene ${index + 1} headline is not the requested text`);
      });
    } else {
      for (const headline of oracle.headlines) {
        if (!headlines.includes(headline)) failures.push('a requested headline is missing');
      }
    }
  }
  if (Array.isArray(oracle.copyIncludes)) {
    const copy = observation.copyText ?? '';
    for (const text of oracle.copyIncludes) {
      if (!copy.includes(text)) failures.push('requested exact copy is missing');
    }
  }
  if (oracle.narration === 'forbidden' && (observation.scenes ?? []).some(scene => scene.narration?.trim() || scene.narrationAsset)) {
    failures.push('wordless or no-narration plan contains narration');
  }
  if (oracle.narration === 'required' && (observation.scenes ?? []).some(scene => !scene.narration?.trim())) {
    failures.push('a scene is missing narration');
  }
  if (oracle.cuePhrases) {
    for (const scene of observation.scenes ?? []) {
      if (!scene.narration?.trim() || !Array.isArray(scene.cuePhrases) || scene.cuePhrases.length === 0) {
        failures.push('narration cues are missing');
        break;
      }
      if (scene.cuePhrases.some(phrase => !phrase.trim() || !scene.narration.includes(phrase))) {
        failures.push('a cue phrase is not a case-sensitive substring of its scene narration');
        break;
      }
    }
  }
  if (oracle.voice && observation.voiceEnabled !== true) failures.push('Kokoro voice was not enabled after planning');
  if (oracle.noCopy && (observation.scenes ?? []).some(scene => scene.hasCopy)) failures.push('no-caption plan contains copy');
  if (oracle.noLowerThird && (observation.scenes ?? []).some(scene => scene.hasLowerThird)) failures.push('no-caption plan contains a lower third');
  if (Array.isArray(oracle.sceneGenerators)) {
    const actual = (observation.scenes ?? []).map(sceneGenerator);
    if (actual.join(',') !== oracle.sceneGenerators.join(',')) failures.push(`media route is ${actual.filter(Boolean).join(',') || 'missing'}`);
  }
  if (Array.isArray(oracle.forbiddenGenerators)) {
    const hit = (observation.generators ?? []).find(generator => oracle.forbiddenGenerators.includes(generator));
    if (hit) failures.push(`forbidden generator ${hit} was planned`);
  }
  if (Number.isInteger(oracle.svgMin) && (observation.svgCount ?? 0) < oracle.svgMin) {
    failures.push(`SVG asset count is ${observation.svgCount ?? 0}; expected at least ${oracle.svgMin}`);
  }
  if (Number.isInteger(oracle.pendingStillMin) && (observation.pendingStillCount ?? 0) < oracle.pendingStillMin) {
    failures.push('planned still is missing');
  }
  if (Array.isArray(oracle.layouts)) {
    const layouts = new Set((observation.scenes ?? []).map(scene => scene.layout));
    for (const layout of oracle.layouts) {
      if (!layouts.has(layout)) failures.push(`layout ${layout} is missing`);
    }
  }
  if (Number.isInteger(oracle.listItems)) {
    const lists = (observation.scenes ?? []).filter(scene => scene.layout === 'list' || scene.items.length > 0);
    if (!lists.some(scene => scene.items.length === oracle.listItems)) failures.push(`six-item list was not preserved (${oracle.listItems} items)`);
  }
  if (Array.isArray(oracle.preserveNumbers)) {
    const haystack = `${observation.copyText ?? ''}\n${JSON.stringify(observation.datasets ?? [])}`;
    for (const number of oracle.preserveNumbers) {
      if (!numberPresent(haystack, number)) failures.push(`number ${number} was truncated or dropped`);
    }
  }
  if (oracle.dataset) failures.push(...datasetMatches(observation, oracle.dataset));
  if (oracle.exampleData) {
    const labelled = (observation.datasets ?? []).some(dataset => dataset.source === 'example')
      || /Example data/.test(observation.copyText ?? '');
    if (!labelled) failures.push('numbers are not labelled Example data');
  }
  if (oracle.noUserDataset && (observation.datasets ?? []).some(dataset => dataset.source === 'user' || dataset.source === 'derived')) {
    failures.push('plan invented a user or derived dataset');
  }
  if (oracle.noPercentages && /%/.test(observation.copyText ?? '')) failures.push('plan introduced a percentage that the brief did not supply');
  if (oracle.sharedMascot && observation.sharedCast !== true) failures.push('scenes do not share one mascot');
  if (oracle.openingTitle && observation.openingTitle !== true) failures.push('opening title is not on the first shot');
  if (oracle.everySceneHasMedia && observation.everySceneHasMedia !== true) failures.push('a scene has no generated shot media');
  if (oracle.kind === 'generated-film') {
    for (const problem of observation.completionProblems ?? []) failures.push(problem);
  }
  for (const problem of (observation.schemaProblems ?? []).slice(0, 4)) failures.push(problem);
  return finish(fixture, observation, failures.length ? 'fail' : 'pass', failures);
}

function judgeRefusal(fixture, observation, status) {
  const pattern = new RegExp(fixture.oracle?.detailPattern ?? 'required|invalid|contradict', 'i');
  const details = String(observation.details ?? '').trim();
  const actionable = details.length >= 12 && pattern.test(details) && !/^internal server error$/i.test(details);
  if (status === 200 || observation.fallback === true) {
    return finish(fixture, observation, 'missing_actionable_refusal', ['positive plan or silent fallback was returned for an expected refusal']);
  }
  if ((status === 400 || status === 422) && actionable) {
    return finish(fixture, observation, 'expected_refusal_pass', []);
  }
  if (status === 500 || status === 400 || status === 422) {
    return finish(fixture, observation, 'missing_actionable_refusal', ['refusal was missing a clear actionable detail']);
  }
  return finish(fixture, observation, 'fail', [`expected an actionable 400 or 422, received ${status || 'no response'}`]);
}

function finish(fixture, observation, outcome, failures) {
  const target = fixture.oracle?.targetSeconds;
  const routes = (observation.scenes ?? []).map(scene => sceneGenerator(scene)).filter(Boolean);
  return {
    fixture: fixture.id,
    category: fixture.category,
    expected: fixture.expect,
    outcome,
    failures: [...new Set(failures)].slice(0, 12),
    routes,
    durationSeconds: Number.isFinite(observation.durationSeconds) ? Number(observation.durationSeconds.toFixed(3)) : null,
    durationAcceptance: Number.isFinite(target) ? durationAcceptance(target) : null,
    validation: [...new Set([...(observation.schemaProblems ?? []), ...(observation.completionProblems ?? [])])].slice(0, 12),
    fallback: observation.fallback === true,
    live: observation.live === true,
    provider: observation.provider ?? null,
    model: observation.model ?? null,
    repaired: observation.repaired === true,
    usage: observation.usage ?? null,
  };
}

export function evaluateFixture(fixture, http) {
  const body = http?.body && typeof http.body === 'object' ? http.body : {};
  const packageView = body.package && typeof body.package === 'object' ? observePackage(body.package, fixture) : {
    scenes: [],
    datasets: [],
    generators: [],
    schemaProblems: [],
    completionProblems: [],
    format: {},
    intentKind: classifyProductionIntent(fixture.brief).kind,
  };
  return judge(fixture, {
    ...packageView,
    httpStatus: http?.status ?? 0,
    transport: http?.transport === true,
    live: http?.live ?? body.live,
    fallback: http?.fallback ?? body.fallback,
    provider: http?.provider ?? body.provider ?? null,
    model: http?.model ?? body.model ?? null,
    voiceEnabled: http?.voiceEnabled === true,
    details: http?.details ?? detailText(body),
    usage: http?.usage ?? body.usage ?? null,
    repaired: http?.repaired === true,
  });
}
