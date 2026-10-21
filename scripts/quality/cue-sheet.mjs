/**
 * Q15: Foley and ambience cue sheet validator
 * comfyrizz.cue-sheet/v1: stems room_tone|foley|music|dialogue;
 * cues[{id, stem, sound, shot, eventFrame, visualEvent, gainDb}];
 * pauses[{id, startFrame, endFrame, reason}].
 * 
 * Deterministic, pure .mjs: no side effects at import time, injected deps (fs, exec, clock).
 * No network, GPU or ffmpeg needed. No new npm dependencies.
 */

const CUE_SHEET_SCHEMA = {
  stems: ["room_tone", "foley", "music", "dialogue"],
};

const FOLEY_SOUNDS = new Set(["kettle", "brush", "bell", "ceiling_drip", "work_stoppage"]);

export function validateCueSheet(sheet) {
  const errors = [];

  if (!sheet || typeof sheet !== "object") {
    errors.push({ code: "INVALID_SCHEMA", message: "Cue sheet is not a valid object" });
    return { ok: false, errors };
  }

  if (!Array.isArray(sheet.cues)) {
    errors.push({ code: "MISSING_CUES", message: "cues array is required" });
    return { ok: false, errors };
  }

  if (!Array.isArray(sheet.pauses)) {
    errors.push({ code: "MISSING_PAUSES", message: "pauses array is required" });
    return { ok: false, errors };
  }

  if (!sheet.shots || typeof sheet.shots !== "object") {
    errors.push({ code: "MISSING_SHOTS", message: "shots object is required" });
    return { ok: false, errors };
  }

  // Validate stems
  const validStems = new Set(CUE_SHEET_SCHEMA.stems);
  for (const cue of sheet.cues) {
    if (cue.stem && !validStems.has(cue.stem)) {
      errors.push({
        code: "INVALID_STEM",
        message: `Invalid stem "${cue.stem}" in cue ${cue.id}`,
        location: cue.id,
      });
    }
  }

  // Validate cue structure
  const validStemValues = new Set(["room_tone", "foley", "music", "dialogue"]);
  for (const cue of sheet.cues) {
    if (cue.stem && !validStemValues.has(cue.stem)) {
      errors.push({
        code: "INVALID_STEM_VALUE",
        message: `Invalid stem value "${cue.stem}" in cue ${cue.id}`,
        location: cue.id,
      });
    }
    if (cue.stem === "foley" && cue.sound && !FOLEY_SOUNDS.has(cue.sound)) {
      errors.push({
        code: "UNFOUNDED_SOUND",
        message: `Unfounded foley sound "${cue.sound}" in cue ${cue.id}`,
        location: cue.id,
      });
    }
  }

  return { ok: errors.length === 0, errors };
}

export function checkCues(sheet, shots) {
  const findings = [];

  if (!sheet || !shots) {
    return findings;
  }

  const cues = sheet.cues || [];
  const pauses = sheet.pauses || [];

  // Build a map of shot -> visual event frames
  const shotVisualFrames = {};
  for (const [shotId, shotData] of Object.entries(shots)) {
    shotVisualFrames[shotId] = shotData.visualEventFrames || {};
  }

  // Rule 1: Each foley cue must sit on its shot's declared visual event (+-2 frames)
  for (const cue of cues) {
    if (cue.stem !== "foley") continue;

    const shotId = cue.shot;
    const shotFrames = shotVisualFrames[shotId];
    const visualEvent = cue.visualEvent;

    if (!shotId || !shotFrames || !visualEvent) {
      findings.push({
        type: "MISSING_SHOT_FRAMES",
        severity: "error",
        message: `Foley cue ${cue.id} (sound: ${cue.sound}) has no shot or frame reference`,
        cueId: cue.id,
      });
      continue;
    }

    const eventFrame = shotFrames[visualEvent];
    if (eventFrame === undefined) {
      findings.push({
        type: "UNKNOWN_VISUAL_EVENT",
        severity: "error",
        message: `Foley cue ${cue.id} references visualEvent "${visualEvent}" not found in shot ${shotId}`,
        cueId: cue.id,
      });
      continue;
    }

    const diff = Math.abs(cue.eventFrame - eventFrame);
    if (diff > 2) {
      findings.push({
        type: "FOLEY_FRAME_MISMATCH",
        severity: "error",
        message: `Foley cue ${cue.id} (sound: ${cue.sound}) eventFrame ${cue.eventFrame} is ${diff} frames off from shot ${shotId} visual event frame ${eventFrame}`,

        cueId: cue.id,
        framesOff: diff,
      });
    }
  }

  // Rule 2: No music cue may fill a declared reaction pause
  for (const cue of cues) {
    if (cue.stem !== "music") continue;

    for (const pause of pauses) {
      const inPause =
        cue.eventFrame >= pause.startFrame && cue.eventFrame <= pause.endFrame;
      if (inPause) {
        findings.push({
          type: "MUSIC_FILLS_REACTION_PAUSE",
          severity: "error",
          message: `Music cue ${cue.id} (sound: ${cue.sound}) fills reaction pause ${pause.id} (frames ${pause.startFrame}-${pause.endFrame})`,
          cueId: cue.id,
          pauseId: pause.id,
        });
      }
    }
  }

  // Rule 3: Every scene with a listed sound event has a foley cue (MISSING_FOLEY)
  const foleySoundsPerShot = {};
  for (const cue of cues) {
    if (cue.stem === "foley" && cue.sound) {
      if (!foleySoundsPerShot[cue.shot]) {
        foleySoundsPerShot[cue.shot] = new Set();
      }
      foleySoundsPerShot[cue.shot].add(cue.sound);
    }
  }

  for (const [shotId, shotData] of Object.entries(shots)) {
    const eventFrames = shotData.visualEventFrames || {};
    const hasSoundEvent = Object.values(eventFrames).some(
      (frame) => frame !== undefined
    );

    if (!hasSoundEvent) continue;

    const neededSounds = new Set(
      Object.keys(eventFrames).filter(
        (key) => eventFrames[key] !== undefined
      )
    );

    const hasFoley = neededSounds.size > 0 &&
      [...neededSounds].some(
        (sound) => foleySoundsPerShot[shotId] && foleySoundsPerShot[shotId].has(sound)
      );

    if (!hasFoley) {
      const missing = [...neededSounds].filter(
        (s) => !foleySoundsPerShot[shotId] || !foleySoundsPerShot[shotId].has(s)
      );
      findings.push({
        type: "MISSING_FOLEY",
        severity: "error",
        message: `Scene ${shotId} has sound events but no foley cue for: ${missing.join(", ")}`,
        shotId,
        missingSounds: missing,
      });
    }
  }

  return findings;
}