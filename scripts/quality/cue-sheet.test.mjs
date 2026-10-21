import { test, describe } from "node:test";
import { validateCueSheet, checkCues } from "./cue-sheet.mjs";

const sheet = {
  stems: ["room_tone", "foley", "music", "dialogue"],
  cues: [
    { id: "cue_kettle", stem: "foley", sound: "kettle", shot: "shot_01", eventFrame: 100, visualEvent: "kettle_boil", gainDb: -20 },
    { id: "cue_brush", stem: "foley", sound: "brush", shot: "shot_02", eventFrame: 200, visualEvent: "brush_stroke", gainDb: -25 },
    { id: "cue_bell_off", stem: "foley", sound: "bell", shot: "shot_03", eventFrame: 300, visualEvent: "bell_ring", gainDb: -30 },
    { id: "cue_drip", stem: "foley", sound: "ceiling_drip", shot: "shot_04", eventFrame: 400, visualEvent: "ceiling_drip", gainDb: -35 },
    { id: "cue_music_01", stem: "music", sound: "work_stoppage", shot: "shot_05", eventFrame: 500, visualEvent: "work_stop", gainDb: -10 },
    { id: "cue_music_over_pause", stem: "music", sound: "kettle", shot: "shot_01", eventFrame: 220, visualEvent: "kettle_boil", gainDb: -15 }
  ],
  pauses: [
    { id: "pause_reaction", startFrame: 210, endFrame: 230, reason: "reaction pause after dialogue" }
  ],
  shots: {
    shot_01: { visualEventFrames: { kettle_boil: 100 }, reactionPause: [210, 230] },
    shot_02: { visualEventFrames: { brush_stroke: 200 } },
    shot_03: { visualEventFrames: { bell_ring: 310 } },
    shot_04: { visualEventFrames: { ceiling_drip: 400 } },
    shot_05: { visualEventFrames: { work_stop: 500 } },
    shot_06: { visualEventFrames: { ceiling_drip: 410 } }
  }
};

describe("Q15 cue-sheet", () => {
  describe("validateCueSheet", () => {
    test("accepts a valid cue sheet", () => {
      const result = validateCueSheet(sheet);
      if (!result.ok) {
        throw new Error(`validateCueSheet should pass for valid fixture, got errors: ${JSON.stringify(result.errors)}`);
      }
    });
  });

  describe("checkCues", () => {
    test("flags bell cue 10 frames off its event", () => {
      const findings = checkCues(sheet, sheet.shots);
      const bellFindings = findings.filter(
        (f) => f.type === "FOLEY_FRAME_MISMATCH" && f.cueId === "cue_bell_off"
      );
      if (bellFindings.length !== 1) {
        throw new Error(`bell cue 10 frames off should be flagged, got ${bellFindings.length} findings`);
      }
      if (bellFindings[0].framesOff !== 10) {
        throw new Error(`should be exactly 10 frames off, got ${bellFindings[0].framesOff}`);
      }
    });

    test("flags music cue filling a reaction pause", () => {
      const findings = checkCues(sheet, sheet.shots);
      const musicFindings = findings.filter(
        (f) => f.type === "MUSIC_FILLS_REACTION_PAUSE"
      );
      if (musicFindings.length < 1) {
        throw new Error("music over reaction pause should be flagged");
      }
      const pauseRelated = musicFindings.find(
        (f) => f.pauseId === "pause_reaction"
      );
      if (!pauseRelated) {
        throw new Error("music over reaction pause should reference pause_reaction");
      }
    });

    test("flags MISSING_FOLEY for scene with drip event and no cue", () => {
      const findings = checkCues(sheet, sheet.shots);
      const missingFindings = findings.filter(
        (f) => f.type === "MISSING_FOLEY"
      );
      if (missingFindings.length < 1) {
        throw new Error("MISSING_FOLEY for drip scene should be flagged");
      }
      const dripMissing = missingFindings.find(
        (f) => f.shotId === "shot_06" || f.missingSounds.includes("ceiling_drip")
      );
      if (!dripMissing) {
        throw new Error("MISSING_FOLEY should mention ceiling_drip or shot_06");
      }
    });

    test("valid fixture with kettle/brush/bell/drip events partially validates", () => {
      const findings = checkCues(sheet, sheet.shots);
      const frameMismatches = findings.filter(
        (f) => f.type === "FOLEY_FRAME_MISMATCH"
      );
      const bellMismatch = frameMismatches.find(
        (f) => f.cueId === "cue_bell_off"
      );
      if (!bellMismatch) {
        throw new Error("bell frame mismatch should exist");
      }

      const musicPause = findings.find(
        (f) => f.type === "MUSIC_FILLS_REACTION_PAUSE"
      );
      if (!musicPause) {
        throw new Error("music over reaction pause should be flagged");
      }

      const missingFoley = findings.find(
        (f) => f.type === "MISSING_FOLEY"
      );
      if (!missingFoley) {
        throw new Error("MISSING_FOLEY should be flagged");
      }
    });
  });
});