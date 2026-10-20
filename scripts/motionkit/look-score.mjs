// M14: the look-quality score.
//
// scoreLook(pkg, recipe, { frameQa }) answers one question: does this package read as the look
// the recipe describes? It is the number the agent's critique loop acts on (spec section 8):
// below 70 the agent revises the scenes the findings name.
//
// The score is the sum of six weighted parts (spec section 8):
//
//   adherence 30  share of scene motion tokens that stay inside the recipe's sets
//   rhythm     20  scene-length variance plus a build-up that is not still before the hero
//   variety    15  entry entropy inside the recipe's entry budget
//   contrast   20  WCAG contrast of the text colours against the palette background
//   finish      5  the finishing stack plus a background pattern the renderer can show today
//   qa         10  frame-qa findings (deducted only when a report is supplied)
//
// Pure module: no filesystem, no network, no clock, no randomness. The same inputs always
// produce the same output. `parts` holds the weighted points of each part (they add up to the
// score); `ratios` holds the same parts as 0..1 quality ratios.

/** The six weighted parts of the look score (spec section 8). */
export const LOOK_SCORE_WEIGHTS = Object.freeze({
  adherence: 30,
  rhythm: 20,
  variety: 15,
  contrast: 20,
  finish: 5,
  qa: 10,
});

/** The score below which the agent is expected to revise the scenes the findings name. */
export const LOOK_SCORE_REVISION_THRESHOLD = 70;

/** Frame-qa deductions, in points, taken from the 10-point qa part. */
export const QA_DEDUCTION = Object.freeze({ error: 4, warning: 2 });

/** WCAG AA contrast thresholds used for the contrast part. */
export const CONTRAST_THRESHOLD = Object.freeze({ primary: 4.5, secondary: 3 });

const HEX = /^#([0-9a-f]{6})$/i;

const isObj = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const isStr = (value) => typeof value === "string" && value.length > 0;
const isNum = (value) => typeof value === "number" && Number.isFinite(value);
const clamp01 = (value) => (Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0);
const round = (value, digits = 2) => {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
};

function parseHex(value) {
  if (!isStr(value)) return null;
  const match = HEX.exec(value.trim());
  if (!match) return null;
  const int = Number.parseInt(match[1], 16);
  return [(int >> 16) & 255, (int >> 8) & 255, int & 255];
}

/** WCAG relative luminance of an sRGB hex colour (0..1). */
export function relativeLuminance(hex) {
  const rgb = parseHex(hex);
  if (!rgb) return null;
  const channel = (value) => {
    const s = value / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(rgb[0]) + 0.7152 * channel(rgb[1]) + 0.0722 * channel(rgb[2]);
}

/** WCAG contrast ratio (1..21) between two hex colours; null when a colour is unusable. */
export function contrastRatio(a, b) {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  if (la === null || lb === null) return null;
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** Map a contrast ratio onto a 0..1 quality: full marks at 7:1, linear down to the threshold. */
export function contrastQuality(ratio, threshold) {
  if (!isNum(ratio)) return 0;
  if (ratio >= 7) return 1;
  if (ratio >= threshold) return 0.85 + 0.15 * ((ratio - threshold) / (7 - threshold));
  return clamp01(ratio / threshold) * 0.85;
}

function sceneLabel(scene, index) {
  return isStr(scene?.id) ? scene.id : `scene ${index + 1}`;
}

function findPalette(recipe, role) {
  const palette = Array.isArray(recipe?.palette) ? recipe.palette : [];
  const hit = palette.find((entry) => isObj(entry) && entry.role === role);
  return hit && isStr(hit.hex) ? hit.hex : null;
}

function finding(code, part, message, { severity = "warning", scene = null } = {}) {
  return { code, severity, part, scene, message };
}

function emptyResult(reason) {
  const parts = {};
  for (const key of Object.keys(LOOK_SCORE_WEIGHTS)) parts[key] = 0;
  return {
    score: 0,
    parts,
    ratios: Object.fromEntries(Object.keys(LOOK_SCORE_WEIGHTS).map((key) => [key, 0])),
    findings: [finding("SCORE_INPUT", "adherence", reason, { severity: "error" })],
  };
}

/* ------------------------------------------------------------------ adherence ---------- */

/**
 * One check per scene motion token the recipe has an opinion about. A token that is absent
 * from the package is skipped (the renderer then uses its own default); a token that is
 * present must be inside the recipe's set.
 */
function adherenceChecks(scenes, pkg, recipe, findings) {
  const entries = new Set((Array.isArray(recipe?.entries) ? recipe.entries : []).filter(isStr));
  const emphasis = new Set((Array.isArray(recipe?.emphasis) ? recipe.emphasis : []).filter(isStr));
  const transitions = new Set(
    [
      recipe?.transitions?.primary,
      ...(Array.isArray(recipe?.transitions?.accent) ? recipe.transitions.accent : []),
    ].filter(isStr),
  );
  const easingEntry = isStr(recipe?.easing?.entry) ? recipe.easing.entry : null;
  const easingSpring = isStr(recipe?.easing?.spring) ? recipe.easing.spring : null;
  const energy = isStr(recipe?.taxonomy?.energy) ? recipe.taxonomy.energy : null;
  const story = isStr(recipe?.storyRecipe) ? recipe.storyRecipe : null;
  const packageEnergy = isStr(pkg?.motion?.energy) ? pkg.motion.energy : null;

  let total = 0;
  let passed = 0;

  const record = (scene, index, ok, code, message) => {
    total += 1;
    if (ok) {
      passed += 1;
      return;
    }
    findings.push(finding(code, "adherence", message, { severity: "warning", scene: sceneLabel(scene, index) }));
  };

  scenes.forEach((scene, index) => {
    const motion = isObj(scene?.motion) ? scene.motion : {};

    if (isStr(motion.entry) && entries.size > 0) {
      const ok = entries.has(motion.entry);
      record(scene, index, ok, "ADHERENCE_ENTRY", `entry ${motion.entry} is outside the recipe's entries (${[...entries].join(", ")})`);
    }
    if (isStr(motion.emphasis) && motion.emphasis !== "none" && emphasis.size > 0) {
      const ok = emphasis.has(motion.emphasis);
      record(scene, index, ok, "ADHERENCE_EMPHASIS", `emphasis ${motion.emphasis} is outside the recipe's emphasis set (${[...emphasis].join(", ")})`);
    }
    if (isStr(motion.ease) && easingEntry) {
      const ok = motion.ease === easingEntry;
      record(scene, index, ok, "ADHERENCE_EASE", `ease ${motion.ease} is not the recipe's entry ease ${easingEntry}`);
    }
    if (isStr(motion.spring) && easingSpring) {
      const ok = motion.spring === easingSpring;
      record(scene, index, ok, "ADHERENCE_SPRING", `spring ${motion.spring} is not the recipe's spring ${easingSpring}`);
    }
    const transitionType = isStr(scene?.transitionOut?.type) ? scene.transitionOut.type : null;
    if (transitionType && transitions.size > 0 && transitionType !== "none" && transitionType !== "cut") {
      const ok = transitions.has(transitionType);
      record(scene, index, ok, "ADHERENCE_TRANSITION", `transition ${transitionType} is outside the recipe's transition set (${[...transitions].join(", ")})`);
    }
    const sceneEnergy = isStr(motion.energy) ? motion.energy : packageEnergy;
    if (sceneEnergy && energy) {
      const ok = sceneEnergy === energy;
      record(scene, index, ok, "ADHERENCE_ENERGY", `energy ${sceneEnergy} is not the recipe's energy ${energy}`);
    }
    if (isStr(motion.recipe) && story) {
      const ok = motion.recipe === story;
      record(scene, index, ok, "ADHERENCE_STORY", `story recipe ${motion.recipe} is not the recipe's story recipe ${story}`);
    }
  });

  if (total === 0) {
    if (scenes.length === 0) {
      findings.push(finding("ADHERENCE_NO_SCENES", "adherence", "the package has no scenes", { severity: "error" }));
      return { ratio: 0, checks: 0 };
    }
    findings.push(
      finding("ADHERENCE_NO_MOTION", "adherence", "no scene declares the motion the recipe asks for", { severity: "warning" }),
    );
    return { ratio: 0.5, checks: 0 };
  }
  return { ratio: passed / total, checks: total };
}

/* ---------------------------------------------------------------------- rhythm ---------- */

/** Score for how much the scene lengths differ. Flat films are dull, uneven films are worse. */
function lengthVarietyScore(cv) {
  if (!isNum(cv)) return 0.5;
  if (cv <= 0.05) return 0.2;
  if (cv < 0.12) return 0.2 + (0.8 * (cv - 0.05)) / 0.07;
  if (cv <= 0.45) return 1;
  if (cv < 0.9) return 1 - (0.5 * (cv - 0.45)) / 0.45;
  return 0.5;
}

function rhythmScore(scenes, pkg, findings) {
  const fps = isNum(pkg?.format?.fps) && pkg.format.fps > 0 ? pkg.format.fps : 30;
  const frames = scenes.map((scene) => (isNum(scene?.preferredFrames) && scene.preferredFrames > 0 ? scene.preferredFrames : null));
  const known = frames.filter((value) => value !== null);
  let variance = 0.5;
  if (known.length >= 2) {
    const seconds = known.map((value) => value / fps);
    const mean = seconds.reduce((sum, value) => sum + value, 0) / seconds.length;
    const varianceRaw = seconds.reduce((sum, value) => sum + (value - mean) ** 2, 0) / seconds.length;
    const cv = mean > 0 ? Math.sqrt(varianceRaw) / mean : 0;
    variance = lengthVarietyScore(cv);
    if (variance < 0.5) {
      findings.push(
        finding("RHYTHM_UNIFORM_LENGTH", "rhythm", `scene lengths barely differ (${round(cv, 3)} spread); the film reads flat`, {
          severity: "warning",
        }),
      );
    }
  }

  const heroes = [];
  scenes.forEach((scene, index) => {
    if (isObj(scene?.motion) && scene.motion.emphasis === "hero") heroes.push(index);
  });

  let heroScore = 1;
  if (heroes.length === 0) {
    heroScore = 0.6;
    findings.push(
      finding("RHYTHM_NO_HERO", "rhythm", "no scene carries the hero emphasis; a film builds to one moment", { severity: "warning" }),
    );
  } else if (heroes.length > 1) {
    heroScore = 0.5;
    for (const index of heroes.slice(0, -1)) {
      findings.push(
        finding("RHYTHM_HERO_MULTIPLE", "rhythm", "a second hero emphasis competes with the film's one hero moment", {
          severity: "warning",
          scene: sceneLabel(scenes[index], index),
        }),
      );
    }
  }

  const heroIndex = heroes.length ? heroes[heroes.length - 1] : null;
  if (heroIndex !== null && heroIndex === 0 && scenes.length >= 3) {
    heroScore *= 0.5;
    findings.push(
      finding("RHYTHM_HERO_EARLY", "rhythm", "the hero moment is spent in the first scene; there is no build-up", {
        severity: "warning",
        scene: sceneLabel(scenes[heroIndex], heroIndex),
      }),
    );
  }

  if (heroIndex !== null && heroIndex > 0 && known.length >= 2) {
    const seconds = known.map((value) => value / fps);
    const mean = seconds.reduce((sum, value) => sum + value, 0) / seconds.length;
    const preHero = scenes.slice(0, heroIndex);
    const preFrames = frames.slice(0, heroIndex);
    let longest = 0;
    let dead = 0;
    preHero.forEach((scene, index) => {
      const value = preFrames[index];
      if (value !== null && mean > 0) longest = Math.max(longest, value / fps / mean);
      if (isObj(scene?.motion) && scene.motion.entry === "none") dead += 1;
    });
    if (longest > 1.4) {
      heroScore *= Math.max(0.4, 1.4 / longest);
      const worst = preHero.findIndex((scene, index) => {
        const value = preFrames[index];
        return value !== null && mean > 0 && value / fps / mean === longest;
      });
      findings.push(
        finding("RHYTHM_STILL_BEFORE_HERO", "rhythm", "a scene before the hero runs much longer than the rest; the build-up is still", {
          severity: "warning",
          scene: sceneLabel(preHero[worst] ?? preHero[0], worst < 0 ? 0 : worst),
        }),
      );
    }
    if (dead > 0) {
      heroScore *= 1 - (0.4 * dead) / preHero.length;
      for (let index = 0; index < preHero.length; index += 1) {
        if (isObj(preHero[index]?.motion) && preHero[index].motion.entry === "none") {
          findings.push(
            finding("RHYTHM_DEAD_SCENE", "rhythm", "no entry animation before the hero; the scene is still", {
              severity: "warning",
              scene: sceneLabel(preHero[index], index),
            }),
          );
        }
      }
    }
  }

  return clamp01(0.5 * variance + 0.5 * heroScore);
}

/* --------------------------------------------------------------------- variety ---------- */

function shannonEntropy(counts) {
  const total = counts.reduce((sum, value) => sum + value, 0);
  if (total === 0) return 0;
  let entropy = 0;
  for (const count of counts) {
    if (count <= 0) continue;
    const p = count / total;
    entropy -= p * Math.log(p);
  }
  return entropy;
}

function varietyScore(scenes, recipe, findings) {
  const allowed = (Array.isArray(recipe?.entries) ? recipe.entries : []).filter(isStr);
  const entries = scenes.map((scene) => (isStr(scene?.motion?.entry) ? scene.motion.entry : null));

  const counts = new Map();
  for (const entry of entries) counts.set(entry ?? "none", (counts.get(entry ?? "none") ?? 0) + 1);
  const entropy = shannonEntropy([...counts.values()]);
  const ceiling = Math.log(Math.max(2, Math.min(entries.length, Math.max(2, allowed.length))));
  const entropyRatio = entries.length < 2 ? 0 : clamp01(entropy / ceiling);
  if (entries.length >= 2 && entropyRatio < 0.5) {
    findings.push(
      finding("VARIETY_LOW_ENTROPY", "variety", `the scenes share ${Math.max(...counts.values())} of ${entries.length} entries; the entries do not vary`, {
        severity: "warning",
      }),
    );
  }

  let inBudget = 1;
  if (allowed.length > 0) {
    const inside = entries.filter((entry) => entry !== null && allowed.includes(entry)).length;
    inBudget = entries.length ? inside / entries.length : 0;
    for (let index = 0; index < entries.length; index += 1) {
      const entry = entries[index];
      if (entry === null || allowed.includes(entry)) continue;
      findings.push(
        finding("VARIETY_ENTRY_OUTSIDE_BUDGET", "variety", `entry ${entry} is not in the recipe's entry budget`, {
          severity: "warning",
          scene: sceneLabel(scenes[index], index),
        }),
      );
    }
  }

  let healthy = 0;
  let index = 0;
  while (index < entries.length) {
    let run = 1;
    while (index + run < entries.length && entries[index + run] === entries[index]) run += 1;
    if (run >= 3) {
      findings.push(
        finding("VARIETY_REPEATED_ENTRY", "variety", `${run} scenes in a row share the entry ${entries[index]}`, {
          severity: "warning",
          scene: sceneLabel(scenes[index], index),
        }),
      );
    } else {
      healthy += run;
    }
    index += run;
  }
  const runHealth = entries.length ? healthy / entries.length : 0;

  const transitionTypes = new Set();
  scenes.forEach((scene) => {
    const type = scene?.transitionOut?.type;
    if (isStr(type) && type !== "none" && type !== "cut") transitionTypes.add(type);
  });
  const cutCount = Math.max(1, scenes.length - 1);
  const transitionDiversity = clamp01(transitionTypes.size / Math.min(3, cutCount));
  if (scenes.length >= 3 && transitionTypes.size <= 1) {
    findings.push(
      finding("VARIETY_TRANSITION_FLAT", "variety", "every cut uses the same transition; the film has one rhythm only", {
        severity: "warning",
      }),
    );
  }

  const ratio = clamp01(0.45 * entropyRatio + 0.2 * inBudget + 0.2 * runHealth + 0.15 * transitionDiversity);
  return ratio;
}

/* ------------------------------------------------------------------- contrast ---------- */

function contrastPart(scenes, pkg, recipe, findings) {
  const background = isStr(pkg?.theme?.palette?.[0]) ? pkg.theme.palette[0] : findPalette(recipe, "background");
  const primaryText = isStr(pkg?.theme?.text) ? pkg.theme.text : findPalette(recipe, "text");
  const mutedText = isStr(pkg?.theme?.text_muted) ? pkg.theme.text_muted : findPalette(recipe, "muted");
  const accent = findPalette(recipe, "accent");
  const onAccent = isStr(pkg?.theme?.text_on_accent)
    ? pkg.theme.text_on_accent
    : isStr(pkg?.theme?.text)
      ? pkg.theme.text
      : findPalette(recipe, "text");

  if (!background || !primaryText) {
    findings.push(
      finding("CONTRAST_NO_COLOURS", "contrast", "the package and the recipe do not name both a background and a text colour", {
        severity: "warning",
      }),
    );
    return { ratio: 0.3, primary: null };
  }

  const primaryRatio = contrastRatio(primaryText, background);
  const primaryQuality = contrastQuality(primaryRatio, CONTRAST_THRESHOLD.primary);
  if (primaryRatio === null || primaryRatio < CONTRAST_THRESHOLD.primary) {
    findings.push(
      finding(
        "CONTRAST_LOW",
        "contrast",
        `text ${primaryText} on ${background} is ${primaryRatio === null ? "unreadable" : `${round(primaryRatio)}:1`} (need ${CONTRAST_THRESHOLD.primary}:1)`,
        { severity: "warning" },
      ),
    );
  }

  let ratio = primaryQuality * 0.6;
  let weight = 0.6;

  if (mutedText) {
    const mutedRatio = contrastRatio(mutedText, background);
    const quality = contrastQuality(mutedRatio, CONTRAST_THRESHOLD.secondary);
    ratio += quality * 0.15;
    weight += 0.15;
    if (mutedRatio !== null && mutedRatio < CONTRAST_THRESHOLD.secondary) {
      findings.push(
        finding(
          "CONTRAST_LOW_MUTED",
          "contrast",
          `muted text ${mutedText} on ${background} is ${round(mutedRatio)}:1 (need ${CONTRAST_THRESHOLD.secondary}:1)`,
          { severity: "warning" },
        ),
      );
    }
  }

  if (accent && onAccent) {
    const accentRatio = contrastRatio(onAccent, accent);
    const quality = contrastQuality(accentRatio, CONTRAST_THRESHOLD.secondary);
    ratio += quality * 0.25;
    weight += 0.25;
    if (accentRatio !== null && accentRatio < CONTRAST_THRESHOLD.secondary) {
      findings.push(
        finding(
          "CONTRAST_LOW_ON_ACCENT",
          "contrast",
          `text ${onAccent} on accent ${accent} is ${round(accentRatio)}:1 (need ${CONTRAST_THRESHOLD.secondary}:1)`,
          { severity: "warning" },
        ),
      );
    }
  }

  return { ratio: clamp01(weight > 0 ? ratio / weight : 0), primary: primaryRatio };
}

/* --------------------------------------------------------------------- finish ---------- */

function finishPart(scenes, recipe, findings) {
  const finish = (Array.isArray(recipe?.finish) ? recipe.finish : [])
    .map((entry) => (isStr(entry) ? entry : isObj(entry) && isStr(entry.id) ? entry.id : null))
    .filter(isStr);
  if (finish.length === 0) {
    findings.push(finding("FINISH_EMPTY", "finish", "the recipe has no finishing stack", { severity: "warning" }));
  }
  const distinct = new Set(finish);
  const stack = clamp01(
    Math.min(1, finish.length / 2) * 0.7 + Math.min(1, distinct.size / 2) * 0.2 + (finish.length >= 3 ? 0.1 : 0),
  );

  const pattern = isStr(recipe?.background?.pattern) ? recipe.background.pattern : null;
  let matching = 0;
  let counted = 0;
  scenes.forEach((scene) => {
    const used = scene?.background?.procedural?.pattern;
    if (!isStr(used)) return;
    counted += 1;
    if (pattern && used === pattern) matching += 1;
  });
  let patternScore = 0.5;
  if (counted > 0) {
    patternScore = matching / counted;
    if (pattern && patternScore < 1) {
      findings.push(
        finding("FINISH_PATTERN_MISMATCH", "finish", `only ${matching} of ${counted} scenes use the recipe's ${pattern} background pattern`, {
          severity: "warning",
        }),
      );
    }
  }

  return clamp01(0.6 * stack + 0.4 * patternScore);
}

/* ------------------------------------------------------------------------- qa ---------- */

function qaPart(frameQa, findings) {
  const list = Array.isArray(frameQa?.findings) ? frameQa.findings : [];
  let deduction = 0;
  for (const item of list) {
    if (!isObj(item)) continue;
    const severity = item.severity === "error" ? "error" : item.severity === "warning" ? "warning" : null;
    if (!severity) continue;
    const cost = QA_DEDUCTION[severity] ?? 0;
    deduction += cost;
    findings.push(
      finding(
        isStr(item.code) ? item.code : `QA_${severity.toUpperCase()}`,
        "qa",
        isStr(item.message) ? item.message : `frame-qa reported a ${severity}`,
        { severity, scene: isStr(item.sceneId) ? item.sceneId : null },
      ),
    );
  }
  const points = Math.max(0, LOOK_SCORE_WEIGHTS.qa - deduction);
  return points / LOOK_SCORE_WEIGHTS.qa;
}

/* ------------------------------------------------------------------------ API ---------- */

/**
 * Score a package against the look recipe it claims to follow.
 *
 * @param {unknown} pkg a comfyrizz.package/v1 document
 * @param {unknown} recipe a comfyrizz.recipe/v1 document
 * @param {{ frameQa?: { ok?: boolean, findings?: Array<{severity?: string, code?: string, message?: string, sceneId?: string|null}> } }} [options]
 * @returns {{ score: number, parts: Record<string, number>, ratios: Record<string, number>, findings: Array<{code: string, severity: string, part: string, scene: string|null, message: string}> }}
 */
export function scoreLook(pkg, recipe, options = {}) {
  if (!isObj(pkg) || !isObj(recipe)) {
    return emptyResult("scoreLook needs both a package and a recipe");
  }
  const scenes = Array.isArray(pkg.scenes) ? pkg.scenes.filter(isObj) : [];
  const findings = [];

  const adherence = adherenceChecks(scenes, pkg, recipe, findings);
  const rhythm = rhythmScore(scenes, pkg, findings);
  const variety = varietyScore(scenes, recipe, findings);
  const contrast = contrastPart(scenes, pkg, recipe, findings);
  const finish = finishPart(scenes, recipe, findings);
  const qa = options && options.frameQa ? qaPart(options.frameQa, findings) : 1;

  const ratios = {
    adherence: adherence.ratio,
    rhythm,
    variety,
    contrast: contrast.ratio,
    finish,
    qa,
  };

  const parts = {};
  for (const [key, weight] of Object.entries(LOOK_SCORE_WEIGHTS)) {
    parts[key] = round(ratios[key] * weight, 2);
  }
  const score = Math.max(0, Math.min(100, Math.round(Object.values(parts).reduce((sum, value) => sum + value, 0))));

  return {
    score,
    parts,
    ratios: Object.fromEntries(Object.entries(ratios).map(([key, value]) => [key, round(value, 4)])),
    findings,
  };
}

export default scoreLook;
