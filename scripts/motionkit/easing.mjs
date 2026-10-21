import { MOTION_VOCABULARY } from "../../packages/schema/src/motion.mjs";

function cubicBezier(x1, y1, x2, y2) {
  const cx = 3 * x1;
  const bx = 3 * (x2 - x1) - cx;
  const ax = 1 - cx - bx;
  const cy = 3 * y1;
  const by = 3 * (y2 - y1) - cy;
  const ay = 1 - cy - by;
  function sampleX(t) { return ((ax * t + bx) * t + cx) * t; }
  function sampleY(t) { return ((ay * t + by) * t + cy) * t; }
  function sampleDx(t) { return (3 * ax * t + 2 * bx) * t + cx; }
  return function (x) {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    let t = x;
    for (let i = 0; i < 8; i++) {
      const dx = sampleDx(t);
      if (Math.abs(dx) < 1e-12) break;
      const err = sampleX(t) - x;
      t -= err / dx;
      if (t < 0) t = 0;
      if (t > 1) t = 1;
    }
    if (Math.abs(sampleX(t) - x) > 1e-6) {
      let lo = 0, hi = 1;
      for (let i = 0; i < 60; i++) {
        const mid = (lo + hi) / 2;
        if (sampleX(mid) < x) lo = mid; else hi = mid;
      }
      t = (lo + hi) / 2;
    }
    return sampleY(t);
  };
}

const curves = {
  expoOut: cubicBezier(0.16, 1, 0.3, 1),
  emphasizedDecel: cubicBezier(0.05, 0.7, 0.1, 1),
  backOut: cubicBezier(0.34, 1.56, 0.64, 1),
  sineInOut: cubicBezier(0.37, 0, 0.63, 1),
  circOut: cubicBezier(0, 0.55, 0.45, 1),
  anticipate: cubicBezier(0.36, 0, 0.66, -0.56),
  linearStep: (x) => (x <= 0 ? 0 : x >= 1 ? 1 : Math.floor(x * 12) / 12),
};

function spring({ stiffness = 100, damping = 10, mass = 1 } = {}) {
  const dt = 1 / 60;
  const frames = [];
  let x = 0, v = 0;
  const target = 1;
  let settled = null;
  for (let i = 0; i < 240; i++) {
    const f = -stiffness * (x - target) - damping * v;
    const a = f / mass;
    v += a * dt;
    x += v * dt;
    const overshoot = x - target;
    frames.push(x);
    if (settled === null && i > 5 && Math.abs(x - target) < 0.02 && Math.abs(v) < 0.02) {
      settled = i + 1;
    }
  }
  return { frames, settleFrame: settled ?? frames.length };
}

const PERSONALITIES = Object.freeze({
  snappy: { entryCurve: "expoOut", exitCurve: "expoIn", durationScale: 0.8, overshoot: 0, nearestToken: "snap" },
  editorial: { entryCurve: "emphasizedDecel", exitCurve: "emphasizedDecel", durationScale: 1.0, overshoot: 0, nearestToken: "settle" },
  elastic: { entryCurve: "backOut", exitCurve: "backOut", durationScale: 0.9, overshoot: 0.08, nearestToken: "elastic" },
  floaty: { entryCurve: "sineInOut", exitCurve: "sineInOut", durationScale: 1.3, overshoot: 0, nearestToken: "settle" },
  mechanical: { entryCurve: "linearStep", exitCurve: "linear", durationScale: 1.0, overshoot: 0, nearestToken: "snap" },
  heavy: { entryCurve: "circOut", exitCurve: "circOut", durationScale: 1.2, overshoot: 0.02, nearestToken: "heavy" },
  anticipate: { entryCurve: "anticipate", exitCurve: "expoOut", durationScale: 1.0, overshoot: 0.05, nearestToken: "pop" },
});

export { cubicBezier, curves, spring, PERSONALITIES, MOTION_VOCABULARY };
export default { cubicBezier, curves, spring, PERSONALITIES };
