/**
 * Q16: Ducking and rests from editorial beats
 *
 * duckingPlan(utterances, pauses, {duckDb=-8, attackMs=80, releaseMs=300, fps=30})
 * -> music gain automation points: duck under dialogue, rest (no new notes)
 * inside reaction pauses, restore after. Pure data; no audio is rendered.
 *
 * ffmpegVolumeExpr(points) builds a deterministic `volume` filter expression
 * for a separate music stem (no execution, no ffmpeg needed at test time).
 *
 * Deterministic, pure .mjs: no side effects at import time, injected deps
 * (fs, exec, clock). No network, GPU or ffmpeg needed. No new npm dependencies.
 */

const REST_DB_DEFAULT = -60;
const EPS = 1e-9;

function toSeconds(interval, fps) {
  if (!interval || typeof interval !== "object") return null;
  let startS;
  let endS;
  if (typeof interval.startS === "number" && typeof interval.endS === "number") {
    startS = interval.startS;
    endS = interval.endS;
  } else if (
    typeof interval.startFrame === "number" &&
    typeof interval.endFrame === "number"
  ) {
    startS = interval.startFrame / fps;
    endS = interval.endFrame / fps;
  } else {
    return null;
  }
  if (!Number.isFinite(startS) || !Number.isFinite(endS) || endS <= startS) {
    return null;
  }
  return { startS, endS };
}

function mergeIntervals(intervals, filmS) {
  const clamped = [];
  for (const iv of intervals) {
    const a = Math.max(0, Math.min(iv.startS, filmS));
    const b = Math.max(0, Math.min(iv.endS, filmS));
    if (b - a > EPS) clamped.push({ startS: a, endS: b });
  }
  clamped.sort((x, y) => x.startS - y.startS || x.endS - y.endS);
  const merged = [];
  for (const iv of clamped) {
    const last = merged[merged.length - 1];
    if (last && iv.startS <= last.endS + EPS) {
      last.endS = Math.max(last.endS, iv.endS);
    } else {
      merged.push({ ...iv });
    }
  }
  return merged;
}

function levelAt(t, speech, rest, duckDb, restDb) {
  for (const iv of rest) {
    if (t >= iv.startS - EPS && t <= iv.endS + EPS) return restDb;
  }
  for (const iv of speech) {
    if (t >= iv.startS - EPS && t <= iv.endS + EPS) return duckDb;
  }
  return 0;
}

/**
 * Build music gain automation points for a music stem.
 *
 * @param {Array<{id?:string, startS?:number, endS?:number, startFrame?:number, endFrame?:number}>} utterances
 * @param {Array<{id?:string, startS?:number, endS?:number, startFrame?:number, endFrame?:number, reason?:string}>} pauses
 * @param {{duckDb?:number, attackMs?:number, releaseMs?:number, fps?:number, restDb?:number, filmS?:number}} [opts]
 * @returns {{schema:string, points:Array<{tS:number, gainDb:number, level:string}>, rests:Array<{id:string, startS:number, endS:number, reason?:string}>, options:object}}
 */
export function duckingPlan(utterances = [], pauses = [], opts = {}) {
  const {
    duckDb = -8,
    attackMs = 80,
    releaseMs = 300,
    fps = 30,
    restDb = REST_DB_DEFAULT,
  } = opts;

  const attackS = Math.max(0, attackMs / 1000);
  const releaseS = Math.max(0, releaseMs / 1000);

  const speechRaw = [];
  for (const u of utterances) {
    const iv = toSeconds(u, fps);
    if (iv) speechRaw.push(iv);
  }
  const restRaw = [];
  const restWindows = [];
  let pauseIndex = 0;
  for (const p of pauses) {
    const iv = toSeconds(p, fps);
    if (!iv) continue;
    restRaw.push(iv);
    restWindows.push({
      id: p.id || `pause_${pauseIndex}`,
      startS: iv.startS,
      endS: iv.endS,
      reason: p.reason,
    });
    pauseIndex += 1;
  }

  let maxEnd = 0;
  for (const iv of [...speechRaw, ...restRaw]) {
    maxEnd = Math.max(maxEnd, iv.endS);
  }
  const filmS =
    typeof opts.filmS === "number" && Number.isFinite(opts.filmS) && opts.filmS > 0
      ? opts.filmS
      : maxEnd;

  const options = {
    duckDb,
    restDb,
    attackS,
    releaseS,
    fps,
    filmS,
  };

  if (filmS <= 0 || (speechRaw.length === 0 && restRaw.length === 0)) {
    return { schema: "comfyrizz.ducking-plan/v1", points: [], rests: [], options };
  }

  const speech = mergeIntervals(speechRaw, filmS);
  const rest = mergeIntervals(restRaw, filmS);

  const bounds = new Set([0, filmS]);
  for (const iv of speech) {
    bounds.add(Math.max(0, Math.min(iv.startS, filmS)));
    bounds.add(Math.max(0, Math.min(iv.endS, filmS)));
  }
  for (const iv of rest) {
    bounds.add(Math.max(0, Math.min(iv.startS, filmS)));
    bounds.add(Math.max(0, Math.min(iv.endS, filmS)));
  }
  const sortedBounds = [...bounds].sort((a, b) => a - b);

  const segments = [];
  for (let i = 0; i < sortedBounds.length - 1; i += 1) {
    const a = sortedBounds[i];
    const b = sortedBounds[i + 1];
    if (b - a <= EPS) continue;
    const mid = (a + b) / 2;
    segments.push({ a, b, level: levelAt(mid, speech, rest, duckDb, restDb) });
  }

  const points = [];
  const push = (tS, gainDb, level) => {
    const t = Math.max(0, Math.min(tS, filmS));
    const last = points[points.length - 1];
    if (last && Math.abs(last.tS - t) <= EPS) {
      // Same instant: keep the deeper cut (rest over duck over unity).
      if (gainDb < last.gainDb - EPS) {
        last.gainDb = gainDb;
        last.level = level;
      }
      return;
    }
    points.push({ tS: t, gainDb, level });
  };

  let prevLevel = null;
  for (const seg of segments) {
    if (prevLevel === null) {
      push(0, seg.level, levelName(seg.level, duckDb, restDb));
      prevLevel = seg.level;
      continue;
    }
    if (Math.abs(seg.level - prevLevel) <= EPS) continue;
    if (seg.level < prevLevel) {
      // Entering duck/rest: attack ramp ends exactly at the boundary.
      const idealStart = seg.a - attackS;
      const rampStart = Math.max(0, idealStart);
      const last = points[points.length - 1];
      const lastT = last ? last.tS : 0;
      if (rampStart > lastT + EPS) {
        push(rampStart, prevLevel, levelName(prevLevel, duckDb, restDb));
      } else if (last && idealStart < lastT - EPS) {
        // Attack reaches back past the previous point (speech starts within
        // attackMs of it): hold full gain no longer — the previous point sits
        // mid-attack.
        const span = attackS > EPS ? attackS : EPS;
        const f = Math.min(1, Math.max(0, (lastT - idealStart) / span));
        last.gainDb = prevLevel + (seg.level - prevLevel) * f;
        last.level = levelName(last.gainDb, duckDb, restDb);
      }
      push(seg.a, seg.level, levelName(seg.level, duckDb, restDb));
    } else {
      // Leaving duck/rest: release ramp starts exactly at the boundary.
      push(seg.a, prevLevel, levelName(prevLevel, duckDb, restDb));
      const rampEnd = Math.min(filmS, seg.a + releaseS);
      push(rampEnd, seg.level, levelName(seg.level, duckDb, restDb));
    }
    prevLevel = seg.level;
  }
  push(filmS, prevLevel ?? 0, levelName(prevLevel ?? 0, duckDb, restDb));

  points.sort((a, b) => a.tS - b.tS);

  return {
    schema: "comfyrizz.ducking-plan/v1",
    points,
    rests: restWindows,
    options,
  };
}

function levelName(level, duckDb, restDb) {
  if (Math.abs(level - restDb) <= EPS) return "rest";
  if (Math.abs(level - duckDb) <= EPS) return "duck";
  return "unity";
}

/**
 * Evaluate the automation envelope at tS (piecewise-linear in dB).
 * Deterministic helper for tests and QA checks.
 */
export function gainAt(points, tS) {
  if (!Array.isArray(points) || points.length === 0) return 0;
  if (tS <= points[0].tS + EPS) return points[0].gainDb;
  const last = points[points.length - 1];
  if (tS >= last.tS - EPS) return last.gainDb;
  for (let i = 0; i < points.length - 1; i += 1) {
    const p0 = points[i];
    const p1 = points[i + 1];
    if (tS >= p0.tS - EPS && tS <= p1.tS + EPS) {
      const span = p1.tS - p0.tS;
      if (span <= EPS) return p1.gainDb;
      const f = (tS - p0.tS) / span;
      return p0.gainDb + (p1.gainDb - p0.gainDb) * f;
    }
  }
  return last.gainDb;
}

function dbToAmp(db) {
  return Math.pow(10, db / 20);
}

function fmt(n) {
  const s = Number(n.toFixed(6)).toString();
  return s;
}

/**
 * Build a deterministic ffmpeg `volume` filter expression from automation
 * points, for use on a separate music stem:
 *   ffmpeg -i music.wav -af "volume='<expr>':eval=frame" ...
 * Interpolates linearly in amplitude between consecutive points. Returns the
 * expression string only; nothing is executed.
 */
export function ffmpegVolumeExpr(points) {
  if (!Array.isArray(points) || points.length === 0) return "1";

  const amps = [];
  for (const p of points) {
    if (!p || !Number.isFinite(p.tS) || !Number.isFinite(p.gainDb)) continue;
    const a = { t: p.tS, amp: dbToAmp(p.gainDb) };
    const last = amps[amps.length - 1];
    if (last && Math.abs(last.t - a.t) <= EPS) {
      last.amp = a.amp;
      continue;
    }
    amps.push(a);
  }
  if (amps.length === 0) return "1";
  if (amps.length === 1) return fmt(amps[0].amp);

  const build = (i) => {
    if (i >= amps.length - 1) return fmt(amps[amps.length - 1].amp);
    const p0 = amps[i];
    const p1 = amps[i + 1];
    const span = p1.t - p0.t;
    const next = build(i + 1);
    if (span <= EPS) return next;
    const seg = `(${fmt(p0.amp)} + (${fmt(p1.amp)} - ${fmt(p0.amp)}) * (t - ${fmt(p0.t)}) / ${fmt(span)})`;
    return `if(lt(t,${fmt(p1.t)}),${seg},${next})`;
  };

  return build(0);
}
