// MS2: shared lintMotion cases. Each case is one mutation of the valid motion-fields fixture
// (which lints clean) plus the findings it must raise; test/motion.test.mjs runs them through
// the TypeScript linter, and through the Python mirror for the conformance check.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
export const MOTION_BASE_FILE = join(here, "..", "fixtures", "valid", "motion-fields.json");
export const motionBase = () => JSON.parse(readFileSync(MOTION_BASE_FILE, "utf8"));

const set = (doc, path, value) => {
  const parts = path.split(".");
  let node = doc;
  for (const part of parts.slice(0, -1)) node = node[/^\d+$/.test(part) ? Number(part) : part];
  const last = parts.at(-1);
  if (value === undefined) delete node[last];
  else node[/^\d+$/.test(last) ? Number(last) : last] = value;
  return doc;
};

/** { name, mutate(doc), expect: [[code, severity, sceneId|null]], options? } */
export const MOTION_CASES = [
  { name: "clean", mutate: (d) => d, expect: [] },
  {
    name: "legacy package without motion fields",
    mutate: (d) => {
      delete d.motion;
      for (const s of d.scenes) delete s.motion;
      for (const s of d.scenes.slice(0, -1)) s.transitionOut = { type: "fade", frames: 15 };
      return d;
    },
    expect: [],
  },
  { name: "cut with frames", mutate: (d) => set(d, "scenes.1.transitionOut", { type: "cut", frames: 8 }), expect: [["MOTION_CUT_HAS_FRAMES", "error", "s2"]] },
  { name: "direction on a fade", mutate: (d) => set(d, "scenes.1.transitionOut", { type: "fade", frames: 15, direction: "left" }), expect: [["MOTION_DIRECTION_UNUSED", "warning", "s2"]] },
  { name: "zoom going left", mutate: (d) => set(d, "scenes.2.transitionOut.direction", "left"), expect: [["MOTION_DIRECTION_AXIS", "error", "s3"]] },
  { name: "push going in", mutate: (d) => set(d, "scenes.0.transitionOut.direction", "in"), expect: [["MOTION_DIRECTION_AXIS", "error", "s1"]] },
  { name: "zoom too slow", mutate: (d) => set(d, "scenes.2.transitionOut.frames", 40), expect: [["MOTION_TRANSITION_DURATION", "warning", "s3"]] },
  { name: "push too fast", mutate: (d) => set(d, "scenes.0.transitionOut.frames", 3), expect: [["MOTION_TRANSITION_DURATION", "warning", "s1"]] },
  {
    name: "default fade out of band at 60 fps",
    mutate: (d) => {
      set(d, "format.fps", 60);
      delete d.motion;
      for (const s of d.scenes) delete s.motion;
      for (const s of d.scenes) s.preferredFrames *= 2;
      delete d.scenes[0].transitionOut;
      d.scenes[1].transitionOut = { type: "fade", frames: 24 };
      d.scenes[2].transitionOut = { type: "none", frames: 0 };
      return d;
    },
    expect: [["MOTION_TRANSITION_DURATION", "warning", "s1"]],
  },
  {
    // push, push, zoom, wipe, fade: four types; push/zoom/wipe are kept (ties go to first use),
    // so the fade becomes the primary push.
    name: "four transition types",
    mutate: (d) => {
      const extra = [structuredClone(d.scenes[1]), structuredClone(d.scenes[1])];
      extra[0].id = "s5";
      extra[1].id = "s6";
      d.scenes.push(...extra);
      d.scenes[3].transitionOut = { type: "wipe", frames: 12 };
      d.scenes[4].transitionOut = { type: "fade", frames: 15 };
      delete d.scenes[5].transitionOut;
      return d;
    },
    expect: [["MOTION_TRANSITION_BUDGET", "warning", "s5"]],
  },
  {
    name: "direction ping-pong",
    mutate: (d) => set(d, "scenes.1.transitionOut.direction", "right"),
    expect: [["MOTION_DIRECTION_PINGPONG", "warning", "s2"]],
  },
  {
    name: "against the current",
    mutate: (d) => {
      set(d, "scenes.0.transitionOut", { type: "fade", frames: 15 });
      set(d, "scenes.1.transitionOut.direction", "right");
      return d;
    },
    expect: [["MOTION_AGAINST_CURRENT", "info", "s2"]],
  },
  {
    name: "two heroes",
    mutate: (d) => set(d, "scenes.1.motion.emphasis", "hero"),
    expect: [["MOTION_HERO_MULTIPLE", "warning", "s2"]],
  },
  {
    name: "hero in the first scene",
    mutate: (d) => {
      set(d, "scenes.2.motion.emphasis", undefined);
      set(d, "scenes.0.motion.emphasis", "hero");
      return d;
    },
    expect: [["MOTION_HERO_EARLY", "info", "s1"]],
  },
  { name: "no hero", mutate: (d) => set(d, "scenes.2.motion.emphasis", undefined), expect: [["MOTION_NO_HERO", "info", null]] },
  {
    name: "elastic twice",
    mutate: (d) => {
      set(d, "scenes.0.motion.spring", "elastic");
      set(d, "scenes.3.motion.spring", "elastic");
      return d;
    },
    expect: [["MOTION_ELASTIC_REPEAT", "warning", "s4"]],
  },
  { name: "linear entry", mutate: (d) => set(d, "scenes.1.motion.ease", "linear"), expect: [["MOTION_LINEAR_ENTRY", "warning", "s2"]] },
  { name: "keyword without highlight", mutate: (d) => set(d, "scenes.0.motion.highlight", undefined), expect: [["MOTION_HIGHLIGHT_MISSING", "error", "s1"]] },
  { name: "highlight not in copy", mutate: (d) => set(d, "scenes.0.motion.highlight", "two boxes"), expect: [["MOTION_HIGHLIGHT_NOT_IN_COPY", "error", "s1"]] },
  { name: "countUp without data", mutate: (d) => set(d, "scenes.1.motion.entry", "countUp"), expect: [["MOTION_ENTRY_MISMATCH", "warning", "s2"]] },
  { name: "drawOn without vector art", mutate: (d) => set(d, "scenes.0.motion.entry", "drawOn"), expect: [["MOTION_ENTRY_MISMATCH", "warning", "s1"]] },
  { name: "drawOn over a vector-anim", mutate: (d) => set(d, "scenes.1.motion.entry", "drawOn"), expect: [] },
  { name: "reading hold too short", mutate: (d) => set(d, "scenes.1.preferredFrames", 90), expect: [["MOTION_READING_HOLD", "warning", "s2"]] },
  { name: "final hold too short", mutate: (d) => set(d, "scenes.3.preferredFrames", 60), expect: [["MOTION_FINAL_HOLD", "warning", "s4"]] },
  {
    name: "compiled timeline wins over preferredFrames",
    mutate: (d) => d,
    options: { timeline: { scenes: [{ id: "s2", durationInFrames: 90 }] } },
    expect: [["MOTION_READING_HOLD", "warning", "s2"]],
  },
  {
    name: "calm energy makes a zoom an energy mismatch",
    mutate: (d) => {
      set(d, "motion.energy", "calm");
      set(d, "scenes.2.motion.energy", undefined);
      return d;
    },
    expect: [["MOTION_ENERGY_MISMATCH", "info", "s1"], ["MOTION_ENERGY_MISMATCH", "info", "s2"], ["MOTION_ENERGY_MISMATCH", "info", "s3"]],
  },
];

export function caseDoc(c) {
  return c.mutate(motionBase());
}
