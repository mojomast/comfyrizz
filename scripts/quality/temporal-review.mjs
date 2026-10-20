/**
 * Q05 - temporal artifact verdict for a take.
 *
 * Source: docs/research/MOCKUMENTARY_QUALITY_REVIEW_20261020.md section 3 (P0
 * temporal review) and docs/specs/QUALITY_FIXES.md Q05.
 *
 * Observations are per-sample reviewer/vision notes:
 *   { t, bodyCount, characters[], feetGrounded?, scale?, propHolder?, cameraMove? }
 *
 * `t` is seconds on the take's own clock (0 at the take start) or a clock
 * string such as "04:36.5". `take.startS` is the take's offset in the film and
 * is used only to display film timestamps; it does not shift `t`.
 *
 * Failures (blocking):
 *   BODY_COUNT_CHANGE    visible body count differs between samples
 *   IDENTITY_CHANGE      the visible character set differs between samples
 *   SCALE_JUMP           relative scale change exceeds scaleJumpRatio
 *   UNGROUNDED           feet off the floor with no licensed action covering t
 *   PROP_TELEPORT        a prop changes holder with no licensed handoff
 *   UNINTENDED_CAMERA    observed camera move differs from the declared intent
 *
 * Optional `pixelDiff` / `flowDiff` values are triage only. They mark samples
 * for inspection and never pass or fail a take. A missing or purely triage
 * observation set is `not_reviewed`, never `passed`.
 *
 * Pure module: no I/O, no clock, no network, no side effects at import time.
 * Inputs are never mutated.
 */

export const REVIEW_STATUSES = Object.freeze(['passed', 'failed', 'not_reviewed']);

export const FAILURE_CODES = Object.freeze({
  BODY_COUNT_CHANGE: 'BODY_COUNT_CHANGE',
  IDENTITY_CHANGE: 'IDENTITY_CHANGE',
  SCALE_JUMP: 'SCALE_JUMP',
  UNGROUNDED: 'UNGROUNDED',
  PROP_TELEPORT: 'PROP_TELEPORT',
  UNINTENDED_CAMERA: 'UNINTENDED_CAMERA',
});

export const DEFAULT_THRESHOLDS = Object.freeze({
  scaleJumpRatio: 0.25,
  triagePixelDiff: 0.35,
  triageFlowDiff: 0.35,
});

const CLOCK_PATTERN = /^(\d{1,4}):(\d{2})(?:\.(\d+))?$/;
const REVIEW_FIELDS = Object.freeze([
  'bodyCount',
  'characters',
  'feetGrounded',
  'scale',
  'propHolder',
  'cameraMove',
]);
const HANDOFF_KINDS = new Set([
  'handoff',
  'hand_off',
  'pass',
  'prop_handoff',
  'prop_transfer',
  'transfer',
]);
const CAMERA_KINDS = new Set(['camera', 'camera_move', 'reframe']);

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function numeric(value) {
  return isFiniteNumber(value) ? value : null;
}

function firstNumber(...values) {
  for (const value of values) {
    const n = numeric(value);
    if (n !== null) return n;
  }
  return null;
}

function firstString(...values) {
  for (const value of values) {
    if (isNonEmptyString(value)) return value.trim();
  }
  return null;
}

function stringArray(value) {
  if (!Array.isArray(value)) return null;
  const out = value.filter(isNonEmptyString).map((entry) => entry.trim());
  return out.length > 0 ? out : [];
}

function uniqueSorted(values) {
  return [...new Set(values)].sort((a, b) => a - b);
}

function trimFraction(text) {
  return text.includes('.') ? text.replace(/0+$/, '').replace(/\.$/, '') : text;
}

/**
 * Format a film timestamp as MM:SS with an optional fractional part.
 * 274 -> "04:34", 276.5 -> "04:36.5".
 */
export function formatClock(seconds) {
  if (!isFiniteNumber(seconds)) return null;
  const total = Math.round(Math.max(0, seconds) * 1000) / 1000;
  const minutes = Math.floor(total / 60);
  const secs = total - minutes * 60;
  const [whole, fraction] = trimFraction(secs.toFixed(3)).split('.');
  const clock = `${String(minutes).padStart(2, '0')}:${whole.padStart(2, '0')}`;
  return fraction ? `${clock}.${fraction}` : clock;
}

/**
 * Parse a numeric timestamp or a clock string ("04:36.5", "1:02:03.25").
 * Returns seconds or null.
 */
export function parseTime(value) {
  if (isFiniteNumber(value) && value >= 0) return value;
  if (!isNonEmptyString(value)) return null;
  const text = value.trim();

  if (/^\d+(?:\.\d+)?$/.test(text)) {
    const direct = Number(text);
    if (Number.isFinite(direct) && direct >= 0) return direct;
  }

  const full = /^(\d{1,4}):(\d{2}):(\d{2}(?:\.\d+)?)$/.exec(text);
  if (full) {
    const hours = Number(full[1]);
    const minutes = Number(full[2]);
    const seconds = Number(full[3]);
    if (minutes < 60 && seconds < 60) return hours * 3600 + minutes * 60 + seconds;
  }

  const short = CLOCK_PATTERN.exec(text);
  if (short) {
    const minutes = Number(short[1]);
    const seconds = Number(short[2]);
    const fraction = short[3] ? Number(`0.${short[3]}`) : 0;
    if (seconds < 60) return minutes * 60 + seconds + fraction;
  }

  return null;
}

function normalizeCharacters(value) {
  const list = stringArray(value);
  if (list === null) return null;
  return [...new Set(list.map((name) => name.toLowerCase()))].sort();
}

function normalizeCameraMove(value) {
  if (!isNonEmptyString(value)) return null;
  return value.trim().toLowerCase().replace(/[\s-]+/g, '_');
}

function actionKind(entry) {
  return firstString(entry.kind, entry.action, entry.type, entry.name)?.toLowerCase().replace(/[\s-]+/g, '_') ?? null;
}

function normalizeActions(take) {
  const raw = take.licensedActions ?? take.licenses ?? take.allowedActions ?? [];
  if (!Array.isArray(raw)) return [];
  const fps = firstNumber(take.fps);

  return raw
    .filter(isPlainObject)
    .map((entry) => {
      const start = firstNumber(
        entry.startS,
        entry.start,
        entry.from,
        entry.startFrame !== undefined && fps ? entry.startFrame / fps : null,
      );
      const end = firstNumber(
        entry.endS,
        entry.end,
        entry.to,
        entry.endFrame !== undefined && fps ? entry.endFrame / fps : null,
      );
      if (start === null || end === null) return null;
      return {
        startS: Math.min(start, end),
        endS: Math.max(start, end),
        kind: actionKind(entry),
        prop: firstString(entry.prop, entry.propId, entry.asset),
        props: stringArray(entry.props) ?? [],
        cameraMove: normalizeCameraMove(firstString(entry.cameraMove, entry.move)),
        licensesFeet: entry.licensesFeet !== false,
        licenses: stringArray(entry.licenses) ?? [],
      };
    })
    .filter(Boolean);
}

function configOf(take) {
  const thresholds = {
    ...DEFAULT_THRESHOLDS,
    ...(isPlainObject(take.thresholds) ? take.thresholds : {}),
    ...(isPlainObject(take.review?.thresholds) ? take.review.thresholds : {}),
    ...(isPlainObject(take.config?.thresholds) ? take.config.thresholds : {}),
  };
  const scaleJumpRatio = firstNumber(
    take.scaleJumpRatio,
    thresholds.scaleJumpRatio,
    DEFAULT_THRESHOLDS.scaleJumpRatio,
  );
  const triagePixelDiff = firstNumber(
    take.triagePixelDiff,
    thresholds.triagePixelDiff,
    DEFAULT_THRESHOLDS.triagePixelDiff,
  );
  const triageFlowDiff = firstNumber(
    take.triageFlowDiff,
    thresholds.triageFlowDiff,
    DEFAULT_THRESHOLDS.triageFlowDiff,
  );

  const cameraAllowed = [
    ...(stringArray(take.allowedCameraMoves) ?? []),
    ...(stringArray(take.camera?.allowed) ?? []),
    ...(stringArray(take.cameraIntent?.allowed) ?? []),
  ].map(normalizeCameraMove).filter(Boolean);

  return {
    startS: firstNumber(take.startS, take.start, take.offsetS) ?? 0,
    scaleJumpRatio: scaleJumpRatio > 0 ? scaleJumpRatio : DEFAULT_THRESHOLDS.scaleJumpRatio,
    triagePixelDiff,
    triageFlowDiff,
    cameraIntent: normalizeCameraMove(
      firstString(
        take.cameraIntent,
        take.intendedCamera,
        take.intendedCameraMove,
        take.camera?.intent,
        take.camera?.move,
      ),
    ),
    cameraAllowed,
    expectedBodyCount: firstNumber(take.expectedBodyCount, take.bodyCount),
    expectedCharacters: normalizeCharacters(take.expectedCharacters ?? take.characters),
    actions: normalizeActions(take),
  };
}

function observationTime(observation) {
  if (!isPlainObject(observation)) return null;
  return parseTime(observation.t ?? observation.time ?? observation.timestamp ?? observation.clock);
}

function normalizeObservation(observation, index) {
  const t = observationTime(observation);
  if (t === null) return null;

  const characters = normalizeCharacters(observation.characters);
  const propHolder = isPlainObject(observation.propHolder) ? observation.propHolder : null;
  const cameraMove = normalizeCameraMove(observation.cameraMove);

  return {
    index,
    t,
    bodyCount: numeric(observation.bodyCount),
    characters,
    feetGrounded: typeof observation.feetGrounded === 'boolean' ? observation.feetGrounded : null,
    scale: numeric(observation.scale),
    propHolder,
    cameraMove,
    pixelDiff: numeric(observation.pixelDiff),
    flowDiff: numeric(observation.flowDiff),
    note: isNonEmptyString(observation.note) ? observation.note.trim() : null,
  };
}

function observationHasReviewSignal(observation) {
  return REVIEW_FIELDS.some((field) => observation[field] !== null && observation[field] !== undefined);
}

function makeFailure(code, startS, endS, samples, message, config) {
  const filmStartS = startS + config.startS;
  const filmEndS = endS + config.startS;
  return {
    code,
    startS,
    endS,
    filmStartS,
    filmEndS,
    startClock: formatClock(filmStartS),
    endClock: formatClock(filmEndS),
    samples: uniqueSorted(samples.map((sample) => Number(sample.toFixed(6)))),
    message,
  };
}

function pairFailure(code, previous, current, message, config) {
  return makeFailure(code, previous.t, current.t, [previous.t, current.t], message, config);
}

function actionCovers(action, fromS, toS) {
  return action.startS <= fromS && action.endS >= toS;
}

function actionLicensesFeet(action) {
  if (!action.licensesFeet) return false;
  if (action.licenses.length === 0) return true;
  return action.licenses.some((license) =>
    ['UNGROUNDED', 'feet', 'feet_off_floor'].includes(license),
  );
}

function actionLicensesProp(action, prop) {
  if (action.licenses.includes('PROP_TELEPORT') || action.licenses.includes('prop_handoff')) {
    return true;
  }
  if (action.kind && HANDOFF_KINDS.has(action.kind)) return true;
  if (action.prop && action.prop === prop) return true;
  return action.props.includes(prop);
}

function actionLicensesCamera(action, move) {
  if (action.kind && CAMERA_KINDS.has(action.kind)) return true;
  return action.cameraMove !== null && action.cameraMove === move;
}

function isFeetLicensed(config, t) {
  return config.actions.some((action) => actionLicensesFeet(action) && action.startS <= t && action.endS >= t);
}

function isPropLicensed(config, fromS, toS, prop) {
  return config.actions.some(
    (action) => actionCovers(action, fromS, toS) && actionLicensesProp(action, prop),
  );
}

function isCameraLicensed(config, t, move) {
  if (config.cameraAllowed.includes(move) || config.cameraAllowed.includes('any')) return true;
  return config.actions.some(
    (action) => action.startS <= t && action.endS >= t && actionLicensesCamera(action, move),
  );
}

function detectBodyCount(observations, failures, config) {
  let previous = null;
  for (const observation of observations) {
    if (observation.bodyCount === null) continue;
    if (previous !== null && observation.bodyCount !== previous.bodyCount) {
      failures.push(
        pairFailure(
          FAILURE_CODES.BODY_COUNT_CHANGE,
          previous,
          observation,
          `Body count changed from ${previous.bodyCount} to ${observation.bodyCount} between ${formatClock(previous.t + config.startS)} and ${formatClock(observation.t + config.startS)}`,
          config,
        ),
      );
    }
    previous = observation;
  }

  if (config.expectedBodyCount !== null) {
    for (const observation of observations) {
      if (observation.bodyCount === null || observation.bodyCount === config.expectedBodyCount) continue;
      failures.push(
        makeFailure(
          FAILURE_CODES.BODY_COUNT_CHANGE,
          observation.t,
          observation.t,
          [observation.t],
          `Body count is ${observation.bodyCount} at ${formatClock(observation.t + config.startS)}; the take declares ${config.expectedBodyCount}`,
          config,
        ),
      );
    }
  }
}

function detectIdentity(observations, failures, config) {
  let previous = null;
  for (const observation of observations) {
    if (observation.characters === null) continue;
    if (previous !== null) {
      const before = new Set(previous.characters);
      const after = new Set(observation.characters);
      const added = observation.characters.filter((name) => !before.has(name));
      const missing = previous.characters.filter((name) => !after.has(name));
      if (added.length > 0 || missing.length > 0) {
        const detail = [
          added.length > 0 ? `entered: ${added.join(', ')}` : null,
          missing.length > 0 ? `left: ${missing.join(', ')}` : null,
        ].filter(Boolean).join('; ');
        failures.push(
          pairFailure(
            FAILURE_CODES.IDENTITY_CHANGE,
            previous,
            observation,
            `Character identity changed between ${formatClock(previous.t + config.startS)} and ${formatClock(observation.t + config.startS)} (${detail})`,
            config,
          ),
        );
      }
    }
    previous = observation;
  }

  if (config.expectedCharacters !== null) {
    for (const observation of observations) {
      if (observation.characters === null) continue;
      const actual = new Set(observation.characters);
      const expected = new Set(config.expectedCharacters);
      const added = observation.characters.filter((name) => !expected.has(name));
      const missing = config.expectedCharacters.filter((name) => !actual.has(name));
      if (added.length > 0 || missing.length > 0) {
        failures.push(
          makeFailure(
            FAILURE_CODES.IDENTITY_CHANGE,
            observation.t,
            observation.t,
            [observation.t],
            `Character identity at ${formatClock(observation.t + config.startS)} does not match the declared cast`,
            config,
          ),
        );
      }
    }
  }
}

function detectScale(observations, failures, config) {
  let previous = null;
  for (const observation of observations) {
    if (observation.scale === null || observation.scale <= 0) continue;
    if (previous !== null) {
      const ratio = Math.abs(observation.scale / previous.scale - 1);
      if (ratio > config.scaleJumpRatio) {
        const percent = Math.round(ratio * 1000) / 10;
        const limit = Math.round(config.scaleJumpRatio * 1000) / 10;
        failures.push(
          pairFailure(
            FAILURE_CODES.SCALE_JUMP,
            previous,
            observation,
            `Scale changed by ${percent}% between ${formatClock(previous.t + config.startS)} and ${formatClock(observation.t + config.startS)}, above the ${limit}% limit`,
            config,
          ),
        );
      }
    }
    previous = observation;
  }
}

function detectUngrounded(observations, failures, config) {
  let run = [];

  const flush = () => {
    if (run.length === 0) return;
    const first = run[0];
    const last = run[run.length - 1];
    const start = first.t;
    const end = last.t;
    const where = start === end
      ? `at ${formatClock(start + config.startS)}`
      : `from ${formatClock(start + config.startS)} to ${formatClock(end + config.startS)}`;
    failures.push(
      makeFailure(
        FAILURE_CODES.UNGROUNDED,
        start,
        end,
        run.map((entry) => entry.t),
        `Feet off the floor ${where} without a licensed action`,
        config,
      ),
    );
    run = [];
  };

  for (const observation of observations) {
    if (observation.feetGrounded === false && !isFeetLicensed(config, observation.t)) {
      run.push(observation);
    } else {
      flush();
    }
  }
  flush();
}

function propValuesDiffer(before, after) {
  const beforeValue = firstString(before);
  const afterValue = firstString(after);
  if (beforeValue === null || afterValue === null) return false;
  return beforeValue.toLowerCase() !== afterValue.toLowerCase();
}

function detectPropTeleport(observations, failures, config) {
  let previous = null;
  for (const observation of observations) {
    if (observation.propHolder === null) continue;
    if (previous !== null) {
      const before = previous.propHolder;
      const after = observation.propHolder;
      const props = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
      for (const prop of props) {
        if (!Object.prototype.hasOwnProperty.call(before, prop)) continue;
        if (!Object.prototype.hasOwnProperty.call(after, prop)) continue;
        if (!propValuesDiffer(before[prop], after[prop])) continue;
        if (isPropLicensed(config, previous.t, observation.t, prop)) continue;
        failures.push(
          pairFailure(
            FAILURE_CODES.PROP_TELEPORT,
            previous,
            observation,
            `Prop "${prop}" moved from "${before[prop]}" to "${after[prop]}" between ${formatClock(previous.t + config.startS)} and ${formatClock(observation.t + config.startS)} without a licensed handoff`,
            config,
          ),
        );
      }
    }
    previous = observation;
  }
}

function detectCamera(observations, failures, config) {
  if (config.cameraIntent === null) return;
  for (const observation of observations) {
    if (observation.cameraMove === null) continue;
    if (observation.cameraMove === config.cameraIntent) continue;
    if (isCameraLicensed(config, observation.t, observation.cameraMove)) continue;
    failures.push(
      makeFailure(
        FAILURE_CODES.UNINTENDED_CAMERA,
        observation.t,
        observation.t,
        [observation.t],
        `Camera move "${observation.cameraMove}" at ${formatClock(observation.t + config.startS)} does not match the intended "${config.cameraIntent}"`,
        config,
      ),
    );
  }
}

function triageSamples(observations, config) {
  const inspection = [];
  for (const observation of observations) {
    const signals = [];
    if (
      observation.pixelDiff !== null
      && config.triagePixelDiff !== null
      && observation.pixelDiff >= config.triagePixelDiff
    ) {
      signals.push({
        name: 'pixelDiff',
        value: observation.pixelDiff,
        threshold: config.triagePixelDiff,
      });
    }
    if (
      observation.flowDiff !== null
      && config.triageFlowDiff !== null
      && observation.flowDiff >= config.triageFlowDiff
    ) {
      signals.push({
        name: 'flowDiff',
        value: observation.flowDiff,
        threshold: config.triageFlowDiff,
      });
    }
    if (signals.length > 0) {
      inspection.push({
        t: observation.t,
        clock: formatClock(observation.t + config.startS),
        reasons: signals.map((signal) => signal.name),
        signals,
      });
    }
  }
  return inspection;
}

function takeAndObservations(take, observations) {
  let takeMeta = isPlainObject(take) ? take : {};
  let notes = observations;

  if (isPlainObject(takeMeta.take)) {
    takeMeta = { ...takeMeta.take, ...(takeMeta.startS !== undefined ? { startS: takeMeta.startS } : {}) };
  }
  if (notes === undefined || notes === null) {
    notes = isPlainObject(take) ? take.observations ?? takeMeta.observations : undefined;
  }
  if (isPlainObject(notes) && Array.isArray(notes.observations)) notes = notes.observations;

  return { take: takeMeta, observations: Array.isArray(notes) ? notes : [] };
}

/**
 * Review one take against per-sample reviewer/vision notes.
 *
 * @param {object} take take metadata (`startS`, `fps`, `cameraIntent`,
 *   `licensedActions`, `thresholds`, optional expected body/cast)
 * @param {Array<object>} observations per-sample notes
 * @returns {{
 *   status: 'passed'|'failed'|'not_reviewed',
 *   failures: Array<object>,
 *   inspection: Array<object>,
 *   reviewedSamples: number,
 *   sampleCount: number
 * }}
 */
export function reviewTake(take, observations) {
  const extracted = takeAndObservations(take, observations);
  const config = configOf(extracted.take);

  const normalized = extracted.observations
    .map((observation, index) => normalizeObservation(observation, index))
    .filter(Boolean)
    .sort((a, b) => a.t - b.t || a.index - b.index);

  const inspection = triageSamples(normalized, config);
  const reviewed = normalized.filter(observationHasReviewSignal);
  const failures = [];

  if (reviewed.length > 0) {
    detectBodyCount(reviewed, failures, config);
    detectIdentity(reviewed, failures, config);
    detectScale(reviewed, failures, config);
    detectUngrounded(reviewed, failures, config);
    detectPropTeleport(reviewed, failures, config);
    detectCamera(reviewed, failures, config);
  }

  const status = reviewed.length === 0
    ? 'not_reviewed'
    : failures.length > 0
      ? 'failed'
      : 'passed';

  return {
    status,
    failures,
    inspection,
    reviewedSamples: reviewed.length,
    sampleCount: normalized.length,
  };
}

export default reviewTake;
