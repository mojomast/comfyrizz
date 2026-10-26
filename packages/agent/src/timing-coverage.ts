
export type TimingState = 'estimated' | 'measured' | 'stale';
export type CoverageState = 'unbounded' | 'covered' | 'under-covered' | 'over-covered';
export type TimingMatch = 'unconstrained' | 'within-tolerance' | 'mismatch';

export interface ClipCoverageInput {
  sourceSeconds: number;
  speed?: number;
  trimInSeconds?: number;
  trimOutSeconds?: number;
  holds?: ReadonlyArray<number | { seconds: number }>;
  targetSeconds?: number;
}

export interface ClipCoverage {
  sourceSeconds: number;
  effectiveSourceSeconds: number;
  speed: number;
  playbackSeconds: number;
  holdSeconds: number;
  coverageSeconds: number;
  targetSeconds: number | null;
  gapSeconds: number;
  surplusSeconds: number;
  state: CoverageState;
}

export interface RequestedDurationInput {
  seconds?: number;
  frames?: number;
  toleranceSeconds?: number;
  toleranceFrames?: number;
}

export interface DurationConstraint {
  mode: 'target';
  requestedFrames: number;
  toleranceFrames: number;
  minFrames: number;
  maxFrames: number;
}

export interface TimingSceneLike {
  id?: string;
  layout?: string;
  preferredFrames?: number;
  narration?: string;
  narration_asset?: string;
  narration_duration_frames?: number;
  provisional?: boolean;
  durationInFrames?: number;
}

export interface TimingPackageLike {
  revision?: number;
  format?: { fps?: number };
  duration?: {
    mode?: string;
    targetFrames?: number;
    minFrames?: number;
    maxFrames?: number;
  };
  voice?: { enabled?: boolean };
  scenes?: TimingSceneLike[];
}

export interface TimelineLike {
  fps?: number;
  durationInFrames?: number;
  scenes?: TimingSceneLike[];
}

export interface TimingReportOptions {
  measuredRevision?: number;
  currentRevision?: number;
  requestedScenes?: Readonly<Record<string, number>>;
  staleSceneIds?: Iterable<string>;
}

export interface TimingRequest {
  mode: 'target';
  frames: number;
  seconds: number;
  toleranceFrames: number;
  toleranceSeconds: number;
}

export interface SceneTiming {
  sceneId: string;
  layout: string;
  state: TimingState;
  requestedSeconds: number | null;
  compiledFrames: number;
  compiledSeconds: number;
  narrationWords: number;
  overflowWords: number;
}

export interface TimingCoverageCounts {
  total: number;
  measured: number;
  estimated: number;
  stale: number;
}

export interface TimingReport {
  requested: TimingRequest | null;
  compiled: { frames: number; seconds: number; fps: number };
  match: TimingMatch;
  deviationFrames: number;
  requiresAcceptance: boolean;
  coverage: TimingCoverageCounts;
  scenes: SceneTiming[];
  warnings: string[];
}

export type TimingRefusalCode = 'TIMING_MISMATCH' | 'TIMING_STALE' | 'NARRATION_OVERFLOW';

export interface TimingRefusal {
  code: TimingRefusalCode;
  message: string;
  sceneId?: string;
}

export interface TimingGate {
  ok: boolean;
  refusals: TimingRefusal[];
}

const MAX_FRAMES = 108000;
const DEFAULT_FPS = 30;
const DEFAULT_TOLERANCE_SECONDS = 0.5;
const NARRATION_WORDS_PER_SECOND = 2.3;

function finite(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function round(value: number, digits = 6): number {
  if (!Number.isFinite(value)) return 0;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function frameRate(value: unknown): number {
  const fps = finite(value);
  return fps !== null && fps > 0 ? fps : DEFAULT_FPS;
}

function wordsIn(text: unknown): number {
  if (typeof text !== 'string') return 0;
  const trimmed = text.trim();
  return trimmed ? trimmed.split(/\s+/).length : 0;
}

function holdSeconds(value: number | { seconds: number }): number {
  const seconds = typeof value === 'number' ? value : value?.seconds;
  const parsed = finite(seconds);
  return parsed !== null && parsed > 0 ? parsed : 0;
}

export function clipCoverage(input: ClipCoverageInput): ClipCoverage {
  const sourceSeconds = Math.max(0, finite(input?.sourceSeconds) ?? 0);
  const speed = Math.max(0.01, finite(input?.speed) ?? 1);
  const trimIn = clamp(finite(input?.trimInSeconds) ?? 0, 0, sourceSeconds);
  const trimOut = clamp(finite(input?.trimOutSeconds) ?? 0, 0, sourceSeconds - trimIn);
  const effectiveSourceSeconds = Math.max(0, sourceSeconds - trimIn - trimOut);
  const playbackSeconds = round(effectiveSourceSeconds / speed);
  const holds: ReadonlyArray<number | { seconds: number }> = input?.holds ?? [];
  let held = 0;
  for (const value of holds) held += holdSeconds(value);
  held = round(held);
  const coverageSeconds = round(playbackSeconds + held);
  const target = finite(input?.targetSeconds);
  const targetSeconds = target !== null && target >= 0 ? round(target) : null;
  const gapSeconds = targetSeconds === null ? 0 : round(Math.max(0, targetSeconds - coverageSeconds));
  const surplusSeconds = targetSeconds === null ? 0 : round(Math.max(0, coverageSeconds - targetSeconds));
  const state: CoverageState = targetSeconds === null
    ? 'unbounded'
    : gapSeconds > 0 ? 'under-covered' : surplusSeconds > 0 ? 'over-covered' : 'covered';
  return {
    sourceSeconds,
    effectiveSourceSeconds,
    speed,
    playbackSeconds,
    holdSeconds: held,
    coverageSeconds,
    targetSeconds,
    gapSeconds,
    surplusSeconds,
    state,
  };
}

export function durationConstraint(input: RequestedDurationInput, fps = DEFAULT_FPS): DurationConstraint {
  const rate = frameRate(fps);
  const seconds = finite(input?.seconds);
  const frames = finite(input?.frames);
  const requested = frames !== null
    ? Math.round(frames)
    : seconds !== null ? Math.round(seconds * rate) : 1;
  const requestedFrames = clamp(requested, 1, MAX_FRAMES);
  const toleranceSeconds = Math.max(0, finite(input?.toleranceSeconds) ?? DEFAULT_TOLERANCE_SECONDS);
  const explicitFrames = finite(input?.toleranceFrames);
  const toleranceFrames = Math.max(0, Math.round(explicitFrames !== null ? explicitFrames : toleranceSeconds * rate));
  return {
    mode: 'target',
    requestedFrames,
    toleranceFrames,
    minFrames: Math.max(1, requestedFrames - toleranceFrames),
    maxFrames: Math.min(MAX_FRAMES, requestedFrames + toleranceFrames),
  };
}

function requestedFromPackage(pkg: TimingPackageLike, fps: number): TimingRequest | null {
  const duration = pkg?.duration;
  if (!duration || duration.mode !== 'target') return null;
  const frames = finite(duration.targetFrames);
  const minFrames = finite(duration.minFrames);
  const maxFrames = finite(duration.maxFrames);
  if (frames === null || minFrames === null || maxFrames === null || maxFrames < minFrames) return null;
  const requested = Math.round(frames);
  const toleranceFrames = Math.max(0, Math.round(Math.max(requested - minFrames, maxFrames - requested)));
  return {
    mode: 'target',
    frames: requested,
    seconds: round(requested / fps),
    toleranceFrames,
    toleranceSeconds: round(toleranceFrames / fps),
  };
}

function sceneTimingState(scene: TimingSceneLike, pkg: TimingPackageLike, options: TimingReportOptions): TimingState {
  const stale = options?.staleSceneIds ? new Set(options.staleSceneIds) : null;
  if (stale?.has(scene.id ?? '')) return 'stale';
  const measuredFrames = finite(scene.narration_duration_frames);
  if (measuredFrames !== null && measuredFrames > 0) {
    const current = finite(options?.currentRevision) ?? finite(pkg.revision);
    const measured = finite(options?.measuredRevision);
    if (current !== null && measured !== null && current !== measured) return 'stale';
    return 'measured';
  }
  const hasNarration = wordsIn(scene.narration) > 0;
  if (hasNarration && pkg.voice?.enabled === true) return 'stale';
  return 'estimated';
}

export function timingReportFor(
  pkg: TimingPackageLike,
  timeline: TimelineLike,
  options: TimingReportOptions = {},
): TimingReport {
  const fps = frameRate(timeline?.fps ?? pkg?.format?.fps);
  const compiledFrames = Math.max(0, Math.round(finite(timeline?.durationInFrames) ?? 0));
  const requested = requestedFromPackage(pkg, fps);
  const deviationFrames = requested === null ? 0 : compiledFrames - requested.frames;
  const match: TimingMatch = requested === null
    ? 'unconstrained'
    : Math.abs(deviationFrames) <= requested.toleranceFrames ? 'within-tolerance' : 'mismatch';
  const packageScenes = Array.isArray(pkg?.scenes) ? pkg.scenes : [];
  const timelineScenes = Array.isArray(timeline?.scenes) ? timeline.scenes : [];
  const byId = new Map(packageScenes.map(scene => [scene.id ?? '', scene]));
  const coverage: TimingCoverageCounts = { total: 0, measured: 0, estimated: 0, stale: 0 };
  const warnings: string[] = [];
  const scenes = timelineScenes.map(timelineScene => {
    const scene = byId.get(timelineScene.id ?? '') ?? timelineScene;
    const state = sceneTimingState(scene, pkg, options);
    coverage.total += 1;
    coverage[state] += 1;
    const compiled = Math.max(0, Math.round(finite(timelineScene.durationInFrames) ?? 0));
    const compiledSeconds = round(compiled / fps);
    const requestedSeconds = finite(options?.requestedScenes?.[scene.id ?? '']);
    const narrationWords = wordsIn(scene.narration);
    const allowedWords = (requestedSeconds ?? compiledSeconds) * NARRATION_WORDS_PER_SECOND;
    const overflowWords = narrationWords > allowedWords
      ? Math.max(0, Math.ceil(narrationWords - allowedWords))
      : 0;
    if (state === 'stale') {
      warnings.push(`${scene.id ?? 'scene'}: narration timing is stale; re-measure before treating the duration as final.`);
    }
    if (overflowWords > 0) {
      warnings.push(`${scene.id ?? 'scene'}: ${narrationWords} narration words do not fit ${round(requestedSeconds ?? compiledSeconds, 2)}s; shorten the copy or extend the scene.`);
    }
    return {
      sceneId: scene.id ?? timelineScene.id ?? '',
      layout: scene.layout ?? timelineScene.layout ?? '',
      state,
      requestedSeconds: requestedSeconds === null ? null : round(requestedSeconds),
      compiledFrames: compiled,
      compiledSeconds,
      narrationWords,
      overflowWords,
    };
  });
  if (match === 'mismatch' && requested) {
    warnings.push(`Compiled ${compiledFrames} frames (${round(compiledFrames / fps, 2)}s) misses the requested ${requested.frames} frames (${requested.seconds}s) by ${Math.abs(deviationFrames)} frames; tolerance is ${requested.toleranceFrames} frames.`);
  }
  return {
    requested,
    compiled: { frames: compiledFrames, seconds: round(compiledFrames / fps), fps },
    match,
    deviationFrames,
    requiresAcceptance: match === 'mismatch',
    coverage,
    scenes,
    warnings,
  };
}

export function buildTimingGate(report: TimingReport): TimingGate {
  const refusals: TimingRefusal[] = [];
  if (report.match === 'mismatch' && report.requested) {
    refusals.push({
      code: 'TIMING_MISMATCH',
      message: `compiled ${report.compiled.frames} frames misses the requested ${report.requested.frames} frames (±${report.requested.toleranceFrames})`,
    });
  }
  for (const scene of report.scenes) {
    if (scene.state === 'stale') {
      refusals.push({
        code: 'TIMING_STALE',
        message: `${scene.sceneId} needs a current narration measurement before build`,
        sceneId: scene.sceneId,
      });
    }
    if (scene.overflowWords > 0) {
      refusals.push({
        code: 'NARRATION_OVERFLOW',
        message: `${scene.sceneId} has ${scene.narrationWords} narration words for ${scene.compiledSeconds}s; shorten or extend`,
        sceneId: scene.sceneId,
      });
    }
  }
  return { ok: refusals.length === 0, refusals };
}
