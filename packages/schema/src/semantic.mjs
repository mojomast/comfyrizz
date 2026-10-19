// B1: shared semantic checks for comfyrizz.package/v1.
//
// This file and pipeline-py/comfyrizz_pipeline/schema.py implement the SAME rule
// set over the same fixture corpus; test/conformance.test.mjs asserts the two
// implementations agree code-for-code, so a rule can never be added on one side only.
//
// Every check is defensive: it never throws on malformed input and never reports a
// code outside SEMANTIC_CODES.

export const SEMANTIC_CODES = Object.freeze([
  "SEM_DUPLICATE_SCENE_ID",
  "SEM_ID_PATTERN",
  "SEM_REF_UNRESOLVED",
  "SEM_PATH_NOT_RELATIVE",
  "SEM_NUMBER_NOT_FINITE",
  "SEM_LAYOUT_VARIANT",
  "SEM_LAYOUT_REQUIRES_DATA",
  "SEM_COPY_REQUIRED",
  "SEM_COPY_TOO_LONG",
  "SEM_LICENSE_MISSING",
  "SEM_LICENSE_CONFLICT",
  "SEM_MODEL_LICENSE_MISSING",
  "SEM_SVG_PROVENANCE",
  "SEM_RENDER_CHECK_FAILED",
  "SEM_GEN_MISSING_GENERATOR",
  "SEM_READY_WITHOUT_FILE",
  "SEM_DURATION_TARGET_REQUIRED",
  "SEM_FLEXIBLE_OVER_CEILING",
  "SEM_NARRATION_EMPTY",
  "SEM_VOICE_INCOMPLETE",
  "SEM_DATASET_UNAPPROVED",
  "SEM_BACKGROUND_AMBIGUOUS",
  "SEM_MEDIA_ONLY_NO_MEDIA",
  "SEM_ASSET_VARIANT_SHAPE",
  "SEM_ASSET_VARIANT_NAME",
  "SEM_ASSET_VARIANT_NO_FILE",
  "SEM_ASSET_VARIANT_SAME_FILE",
  "SEM_ASSET_VARIANT_PATH",
  "SEM_ASSET_VARIANT_NOT_BIGGER",
  "SEM_LOWER_THIRD_EMPTY",
  "SEM_CUTOUT_KIND",
  "SEM_PRESENTER_NO_PORTRAIT",
  "SEM_PRESENTER_UNKNOWN_SCENE",
  "SEM_A2V_NO_AUDIO",
  "SEM_A2V_AUDIO_NOT_AUDIO",
  "SEM_A2V_AUDIO_NOT_READY",
  "SEM_CAST_REF_UNREADY",
  "SEM_CAST_UNKNOWN",
  "SEM_DUPLICATE_CAST_ID",
  "SEM_AUDIO_ASSET_UNKNOWN",
  "SEM_AUDIO_ASSET_NOT_AUDIO",
  "SEM_AUDIO_ASSET_NOT_READY",
  "SEM_AUDIO_UNKNOWN_SCENE",
  "SEM_LAYOUT_REQUIRES_MEDIA",
  "SEM_CODE_REQUIRED",
]);

// Published layout contract (PLAN.md A5 / SPEC.md 6.3). The schema holds the loose
// syntax bounds; these are the readability limits, and exceeding one is a fail
// state (never silent clipping).
export const LAYOUTS = Object.freeze({
  title: { variants: ["centered", "outro"], requiresHeadline: true, limits: { headline: 48, sub: 90 } },
  hero: { variants: ["full-bleed", "split"], requiresHeadline: true, limits: { headline: 64, sub: 120, body: 240 } },
  stat: { variants: [], requiresData: true, requiresHeadline: true, limits: { headline: 48, sub: 90, body: 40 } },
  chart: { variants: ["bar"], requiresData: true, limits: { headline: 64, sub: 120, footnote: 120 } },
  list: { variants: ["bullets", "quote"], limits: { headline: 64, quote: 200, attribution: 80 } },
  // LP2: two plates (media length 2). Copy is optional; a headline, when present, stays short.
  split: { variants: [], requiresMedia: 2, limits: { headline: 48, sub: 90 } },
  compare: { variants: [], requiresMedia: 2, limits: { headline: 48, sub: 90 } },
  // LP2: a typed code block. No headline. Overflow is a layout lint, not a copy-length error.
  code: { variants: [], requiresCode: true, limits: { headline: 64 } },
});

export const GENERATED_OUTPUT_LICENSE = Object.freeze({ id: "CC0-1.0", redistributable: true });
export const MODEL_GENERATORS = Object.freeze(["flux3-klein", "ltx25", "ltx25-a2v", "kokoro", "qwen3-tts"]);

/**
 * The licence of each model the pipeline can run, as the shipped example packages record it.
 *
 * A ready generated asset needs `model_license` separately from its output licence
 * (SEM_MODEL_LICENSE_MISSING), and a run that produced a file must be able to say which model terms
 * it carries (GPU test 3, N6: apply left it empty). One map, so the examples and the run agree.
 */
export const MODEL_LICENSES = Object.freeze({
  "flux3-klein": Object.freeze({
    id: "LicenseRef-FLUX.3-Image-Klein",
    url: "https://huggingface.co/black-forest-labs/flux-3-image-klein",
  }),
  ltx25: Object.freeze({
    id: "LicenseRef-LTX-2.5",
    url: "https://huggingface.co/Lightricks/LTX-2.5",
  }),
  // the presenter is the same weights, the same licence, a different graph (H17)
  "ltx25-a2v": Object.freeze({
    id: "LicenseRef-LTX-2.5",
    url: "https://huggingface.co/Lightricks/LTX-2.5",
  }),
  kokoro: Object.freeze({
    id: "Apache-2.0",
    url: "https://huggingface.co/hexgrad/Kokoro-82M",
  }),
  "qwen3-tts": Object.freeze({
    id: "Apache-2.0",
    url: "https://huggingface.co/Qwen/Qwen3-TTS-12Hz-1.7B-Base",
  }),
});
export const FLEXIBLE_CEILING_FRAMES = 2700;

const SCENE_ID_RE = /^s[A-Za-z0-9_-]{0,63}$/;
const ASSET_ID_RE = /^a[A-Za-z0-9_-]{0,63}$/;
const DATASET_ID_RE = /^d[A-Za-z0-9_-]{0,63}$/;
const CAST_ID_RE = /^c[A-Za-z0-9_-]{0,63}$/;
const NON_REDISTRIBUTABLE_LICENSE_RE = /(^|[-_ ])(NC|ND|NONCOMMERCIAL|NON-COMMERCIAL|NODERIV|NO-DERIV)([-_ ]|$)/i;

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const isNum = (v) => typeof v === "number";
const isStr = (v) => typeof v === "string";

function isFiniteNumber(v) {
  return typeof v === "number" && Number.isFinite(v);
}

/** Paths shipped in a package must be repository-relative POSIX paths. */
export function pathProblem(value) {
  if (!isStr(value) || value.length === 0) return "empty path";
  if (value.includes("\\")) return "backslash separator";
  if (value.startsWith("/")) return "absolute path";
  if (value.startsWith("~")) return "home-relative path";
  if (/^[A-Za-z]:/.test(value)) return "Windows drive path";
  if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(value)) return "URL where a relative path is expected";
  if (value.split("/").some((seg) => seg === "..")) return "parent-directory traversal";
  if (value.split("/").some((seg) => seg === "")) return "empty path segment";
  if (/^\.\//.test(value)) return "leading ./ is noise; use a clean relative path";
  return null;
}

const PATH_FIELDS = Object.freeze([
  ["/file", "asset file"],
  ["/gen/workflow", "workflow"],
]);

function error(code, path, message) {
  return { code, path, message, source: "semantic" };
}

/**
 * Run every semantic rule. Returns { errors, warnings }; entries are
 * { code, path, message, source: "semantic" }.
 */
export function semanticCheck(doc) {
  const errors = [];
  const warnings = [];
  if (!isObj(doc)) return { errors: [error("SEM_NUMBER_NOT_FINITE", "", "document is not an object")], warnings };

  errors.push(...checkFinite(doc));
  const { scenes, assets, datasets } = collect(doc, errors);
  checkIds(doc, scenes, assets, datasets, errors);
  checkRefs(doc, scenes, assets, datasets, errors);
  checkPaths(doc, assets, errors);
  checkDuration(doc, errors);
  checkVoice(doc, errors);
  checkScenes(scenes, assets, datasets, errors);
  checkAssets(assets, errors);
  checkPresenter(doc, scenes, assets, errors);
  checkCast(doc, scenes, assets, errors);
  checkAudio(doc, scenes, assets, errors);
  checkDatasets(datasets, errors);
  checkUnusedAssets(doc, scenes, assets, datasets, warnings);
  return { errors: dedupe(errors), warnings: dedupe(warnings) };
}

function dedupe(list) {
  const seen = new Set();
  const out = [];
  for (const item of list) {
    const key = `${item.code}|${item.path}|${item.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out.sort((a, b) => (a.path === b.path ? a.code.localeCompare(b.code) : a.path.localeCompare(b.path)));
}

function checkFinite(doc) {
  const out = [];
  walk(doc, "", (value, path) => {
    if (!isNum(value)) return;
    if (!Number.isFinite(value)) {
      out.push(error("SEM_NUMBER_NOT_FINITE", path, "number is not finite"));
    } else if (Math.abs(value) > 1e15) {
      out.push(error("SEM_NUMBER_NOT_FINITE", path, "number is outside the representable bound 1e15"));
    }
  });
  return out;
}

function walk(value, path, visit) {
  visit(value, path);
  if (Array.isArray(value)) {
    value.forEach((v, i) => walk(v, `${path}/${i}`, visit));
  } else if (isObj(value)) {
    for (const [k, v] of Object.entries(value)) walk(v, `${path}/${k}`, visit);
  }
}

function collect(doc, errors) {
  const scenes = Array.isArray(doc.scenes) ? doc.scenes.filter(isObj) : [];
  const assets = isObj(doc.assets) ? doc.assets : {};
  const datasets = isObj(doc.datasets) ? doc.datasets : {};
  if (Array.isArray(doc.scenes) && doc.scenes.length !== scenes.length) {
    errors.push(error("SEM_ID_PATTERN", "/scenes", "scenes must be objects with an id"));
  }
  return { scenes, assets, datasets };
}

function checkIds(doc, scenes, assets, datasets, errors) {
  const seen = new Set();
  scenes.forEach((scene, i) => {
    const id = scene.id;
    if (!isStr(id) || !SCENE_ID_RE.test(id)) {
      errors.push(error("SEM_ID_PATTERN", `/scenes/${i}/id`, `scene id must match ^s[A-Za-z0-9_-]{0,63}$ (got ${JSON.stringify(id)})`));
    } else if (seen.has(id)) {
      errors.push(error("SEM_DUPLICATE_SCENE_ID", `/scenes/${i}/id`, `duplicate scene id ${id}`));
    } else {
      seen.add(id);
    }
  });
  for (const key of Object.keys(assets)) {
    if (!ASSET_ID_RE.test(key)) {
      errors.push(error("SEM_ID_PATTERN", `/assets/${key}`, "asset id must match ^a[A-Za-z0-9_-]{0,63}$"));
    }
  }
  for (const key of Object.keys(datasets)) {
    if (!DATASET_ID_RE.test(key)) {
      errors.push(error("SEM_ID_PATTERN", `/datasets/${key}`, "dataset id must match ^d[A-Za-z0-9_-]{0,63}$"));
    }
  }
  if (isObj(doc.theme) && doc.theme.logo_asset !== undefined && !isObj(assets[doc.theme.logo_asset])) {
    errors.push(error("SEM_REF_UNRESOLVED", "/theme/logo_asset", `unknown asset ${JSON.stringify(doc.theme.logo_asset)}`));
  }
}

function requireAsset(assets, id, path, errors) {
  if (id === undefined) return;
  if (!isStr(id) || !isObj(assets[id])) {
    errors.push(error("SEM_REF_UNRESOLVED", path, `unknown asset ${JSON.stringify(id)}`));
  }
}

function checkRefs(doc, scenes, assets, datasets, errors) {
  scenes.forEach((scene, i) => {
    const bg = scene.background;
    if (isObj(bg) && bg.asset !== undefined) requireAsset(assets, bg.asset, `/scenes/${i}/background/asset`, errors);
    if (Array.isArray(scene.foreground)) {
      scene.foreground.forEach((fg, j) => {
        if (isObj(fg)) requireAsset(assets, fg.asset, `/scenes/${i}/foreground/${j}/asset`, errors);
      });
    }
    if (Array.isArray(scene.media)) {
      scene.media.forEach((plate, j) => {
        if (isObj(plate) && plate.asset !== undefined) requireAsset(assets, plate.asset, `/scenes/${i}/media/${j}/asset`, errors);
      });
    }
    if (isObj(scene.data) && scene.data.dataset !== undefined) {
      if (!isStr(scene.data.dataset) || !isObj(datasets[scene.data.dataset])) {
        errors.push(error("SEM_REF_UNRESOLVED", `/scenes/${i}/data/dataset`, `unknown dataset ${JSON.stringify(scene.data.dataset)}`));
      }
    }
    if (scene.narration_asset !== undefined) {
      requireAsset(assets, scene.narration_asset, `/scenes/${i}/narration_asset`, errors);
    }
  });
  for (const [id, asset] of Object.entries(assets)) {
    if (!isObj(asset) || !isObj(asset.gen) || !isObj(asset.gen.inputs)) continue;
    for (const [key, value] of Object.entries(asset.gen.inputs)) {
      if (key === "image" || key === "mask" || key === "reference" || key === "audio" || /^reference_\d+$/.test(key)) {
        if (isStr(value) && !isObj(assets[value])) {
          errors.push(error("SEM_REF_UNRESOLVED", `/assets/${id}/gen/inputs/${key}`, `unknown asset ${JSON.stringify(value)}`));
        }
      }
    }
  }
}

function checkPaths(doc, assets, errors) {
  for (const [id, asset] of Object.entries(assets)) {
    if (!isObj(asset)) continue;
    for (const [field] of PATH_FIELDS) {
      const value = field.split("/").slice(1).reduce((acc, key) => (isObj(acc) ? acc[key] : undefined), asset);
      if (value === undefined) continue;
      const problem = pathProblem(value);
      if (problem) {
        errors.push(error("SEM_PATH_NOT_RELATIVE", `/assets/${id}${field}`, `${problem}: ${JSON.stringify(value)}`));
      }
    }
  }
  if (isArrayOfObjects(doc.renders)) {
    doc.renders.forEach((render, i) => {
      if (!isObj(render)) return;
      const problem = pathProblem(render.file);
      if (problem) errors.push(error("SEM_PATH_NOT_RELATIVE", `/renders/${i}/file`, `${problem}: ${JSON.stringify(render.file)}`));
    });
  }
  if (isObj(doc.theme) && Array.isArray(doc.theme.fonts)) {
    doc.theme.fonts.forEach((font, i) => {
      if (!isObj(font)) return;
      const problem = pathProblem(font.file);
      if (problem) errors.push(error("SEM_PATH_NOT_RELATIVE", `/theme/fonts/${i}/file`, `${problem}: ${JSON.stringify(font.file)}`));
    });
  }
}

function isArrayOfObjects(v) {
  return Array.isArray(v);
}

function checkDuration(doc, errors) {
  const d = doc.duration;
  if (!isObj(d)) return;
  if (d.mode === "target" && !isFiniteNumber(d.targetFrames)) {
    errors.push(error("SEM_DURATION_TARGET_REQUIRED", "/duration/targetFrames", "mode target requires targetFrames"));
  }
  if (d.mode === "flexible") {
    for (const key of ["targetFrames", "maxFrames"]) {
      if (isFiniteNumber(d[key]) && d[key] > FLEXIBLE_CEILING_FRAMES) {
        errors.push(error("SEM_FLEXIBLE_OVER_CEILING", `/duration/${key}`, `flexible mode ceiling is ${FLEXIBLE_CEILING_FRAMES} frames (got ${d[key]})`));
      }
    }
  }
}

function checkVoice(doc, errors) {
  const v = doc.voice;
  if (!isObj(v) || v.enabled !== true) return;
  const voiced = v.engine === "kokoro" || v.engine === "qwen3-tts";
  if (!voiced || !isStr(v.voice) || v.voice.length === 0) {
    errors.push(error("SEM_VOICE_INCOMPLETE", "/voice", "voice.enabled requires engine kokoro or qwen3-tts and a non-empty voice"));
  }
  if (v.engine === 'qwen3-tts') {
    if ((v.speed ?? 1) !== 1) errors.push(error('SEM_VOICE_INCOMPLETE', '/voice/speed', 'Qwen requires speed=1; use delivery direction for pacing'));
    if (v.blend) errors.push(error('SEM_VOICE_INCOMPLETE', '/voice/blend', 'Voice blending is only supported by Kokoro'));
    if (v.qwen_mode === 'custom' && !['ryan', 'aiden', 'vivian', 'serena', 'uncle_fu', 'dylan', 'eric', 'ono_anna', 'sohee'].includes(String(v.voice).toLowerCase())) errors.push(error('SEM_VOICE_INCOMPLETE', '/voice/voice', 'Unknown Qwen CustomVoice speaker'));
  }
  if (Array.isArray(v.blend) && new Set(v.blend.map(part => isObj(part) ? String(part.voice ?? '')[0] : undefined)).size > 1) errors.push(error('SEM_VOICE_INCOMPLETE', '/voice/blend', 'Kokoro blend voices must use the same language/accent'));
  const assets = isObj(doc.assets) ? doc.assets : {};
  if (isStr(v.ref_asset) && !isObj(assets[v.ref_asset])) {
    errors.push(error("SEM_REF_UNRESOLVED", "/voice/ref_asset", `unknown asset ${JSON.stringify(v.ref_asset)}`));
  }
}

function checkScenes(scenes, assets, datasets, errors) {
  scenes.forEach((scene, i) => {
    const at = `/scenes/${i}`;
    const layout = scene.layout;
    const spec = isStr(layout) ? LAYOUTS[layout] : undefined;
    if (spec) {
      if (scene.variant !== undefined) {
        const variants = spec.variants || [];
        if (!variants.includes(scene.variant)) {
          errors.push(error("SEM_LAYOUT_VARIANT", `${at}/variant`, `layout ${layout} allows ${variants.length ? variants.join(", ") : "no variant"} (got ${JSON.stringify(scene.variant)})`));
        }
      }
      const copy = isObj(scene.copy) ? scene.copy : {};
      if (spec.requiresData && !(isObj(scene.data) && isStr(scene.data.dataset))) {
        errors.push(error("SEM_LAYOUT_REQUIRES_DATA", `${at}/data`, `layout ${layout} requires data.dataset`));
      }
      if (spec.requiresHeadline && !nonEmpty(copy.headline)) {
        errors.push(error("SEM_COPY_REQUIRED", `${at}/copy/headline`, `layout ${layout} requires copy.headline`));
      }
      if (layout === "list" && scene.variant === "bullets" && (!Array.isArray(copy.items) || copy.items.length < 2)) {
        errors.push(error("SEM_COPY_REQUIRED", `${at}/copy/items`, "list variant bullets requires copy.items with 2 to 6 entries"));
      }
      if (layout === "list" && scene.variant === "quote" && !nonEmpty(copy.quote)) {
        errors.push(error("SEM_COPY_REQUIRED", `${at}/copy/quote`, "list variant quote requires copy.quote"));
      }
      if (spec.requiresMedia && (!Array.isArray(scene.media) || scene.media.length !== spec.requiresMedia)) {
        errors.push(error("SEM_LAYOUT_REQUIRES_MEDIA", `${at}/media`, `layout ${layout} requires media with ${spec.requiresMedia} plates`));
      }
      if (spec.requiresCode) {
        const block = isObj(scene.code) ? scene.code : {};
        if (!nonEmpty(block.language) || !nonEmpty(block.code)) {
          errors.push(error("SEM_CODE_REQUIRED", `${at}/code`, `layout ${layout} requires code.language and code.code`));
        }
      }
      for (const [field, limit] of Object.entries(spec.limits || {})) {
        const value = copy[field];
        if (isStr(value) && value.length > limit) {
          errors.push(error("SEM_COPY_TOO_LONG", `${at}/copy/${field}`, `layout ${layout} allows ${limit} characters for ${field} (got ${value.length})`));
        }
      }
    }
    if (scene.copy !== undefined && isObj(scene.copy) && nonEmpty(scene.copy.headline) === false && scene.copy.headline !== undefined) {
      errors.push(error("SEM_COPY_REQUIRED", `${at}/copy/headline`, "copy.headline must not be blank"));
    }
    if ("narration" in scene && isStr(scene.narration) && scene.narration.trim().length === 0) {
      errors.push(error("SEM_NARRATION_EMPTY", `${at}/narration`, "narration is present but blank"));
    }
    if ("narration_spoken" in scene && isStr(scene.narration_spoken) && scene.narration_spoken.trim().length === 0) {
      errors.push(error("SEM_NARRATION_EMPTY", `${at}/narration_spoken`, "narration_spoken is present but blank"));
    }
    if ("spoken_text" in scene && isStr(scene.spoken_text) && scene.spoken_text.trim().length === 0) {
      errors.push(error("SEM_NARRATION_EMPTY", `${at}/spoken_text`, "spoken_text is present but blank"));
    }
    const bg = scene.background;
    if (isObj(bg)) {
      const hasAsset = bg.asset !== undefined;
      const hasProcedural = isObj(bg.procedural);
      if (hasAsset === hasProcedural) {
        errors.push(error("SEM_BACKGROUND_AMBIGUOUS", `${at}/background`, "background must set exactly one of asset or procedural"));
      }
    }
    if (Array.isArray(scene.media)) {
      scene.media.forEach((plate, j) => {
        if (!isObj(plate)) return;
        const hasAsset = plate.asset !== undefined;
        const hasProcedural = isObj(plate.procedural);
        if (hasAsset === hasProcedural) {
          errors.push(error("SEM_BACKGROUND_AMBIGUOUS", `${at}/media/${j}`, "media plate must set exactly one of asset or procedural"));
        }
      });
    }
    if (Array.isArray(scene.foreground)) {
      // asset resolution for foreground items is reported by checkRefs, which owns
      // the unresolved-reference code; nothing extra to check here.
    }
    // Media layer (H-fix1, from Pi's P-fix1 proposal): a scene can skip its layout and show
    // only media, with an optional lower third. Two ways that goes wrong, both caught here.
    if (isObj(scene.lower_third) && scene.lower_third.text !== undefined && !nonEmpty(scene.lower_third.text)) {
      errors.push(error("SEM_LOWER_THIRD_EMPTY", `${at}/lower_third/text`, "lower_third.text must not be blank"));
    }
    if (scene.media_only === true) {
      const hasMediaBackground = isObj(scene.background) && isStr(scene.background.asset);
      const hasForeground = Array.isArray(scene.foreground) && scene.foreground.length > 0;
      if (!hasMediaBackground && !hasForeground) {
        errors.push(
          error(
            "SEM_MEDIA_ONLY_NO_MEDIA",
            `${at}/media_only`,
            "media_only skips the layout, so it needs a media background (background.asset) or at least one foreground item; this scene would render an empty frame",
          ),
        );
      }
    }
  });
}

function nonEmpty(v) {
  return isStr(v) && v.trim().length > 0;
}

/** A presenter portrait that names a cast id rather than an asset (CAST1 hook). */
function portraitIsCastId(portrait, assets) {
  return isStr(portrait) && CAST_ID_RE.test(portrait) && !isObj(assets[portrait]);
}

/**
 * CAST1: fictional cast members and the ready still each one is conditioned on.
 *
 * A package with no cast and no cast references is not judged here. A ref_asset that is missing,
 * not ready, or not a still is SEM_CAST_REF_UNREADY. A scene, asset, or presenter that names an
 * unknown cast id is SEM_CAST_UNKNOWN.
 */
function checkCast(doc, scenes, assets, errors) {
  const members = Array.isArray(doc.cast) ? doc.cast.filter(isObj) : [];
  const byId = new Map();
  members.forEach((member, i) => {
    const id = member.id;
    if (!isStr(id) || !CAST_ID_RE.test(id)) {
      errors.push(error("SEM_ID_PATTERN", `/cast/${i}/id`, `cast id must match ^c[A-Za-z0-9_-]{0,63}$ (got ${JSON.stringify(id)})`));
    } else if (byId.has(id)) {
      errors.push(error("SEM_DUPLICATE_CAST_ID", `/cast/${i}/id`, `duplicate cast id ${id}`));
    } else {
      byId.set(id, member);
    }
    const ref = member.ref_asset;
    const asset = isStr(ref) ? assets[ref] : undefined;
    if (!isStr(ref) || !isObj(asset)) {
      errors.push(error("SEM_CAST_REF_UNREADY", `/cast/${i}/ref_asset`, `cast ref_asset ${JSON.stringify(ref)} is missing`));
      return;
    }
    const still = asset.kind === "image" || asset.kind === "svg";
    const ready = asset.status === "ready" && isStr(asset.file) && isStr(asset.sha256);
    if (!still || !ready) {
      errors.push(
        error(
          "SEM_CAST_REF_UNREADY",
          `/cast/${i}/ref_asset`,
          `cast ref_asset ${JSON.stringify(ref)} is not a ready still (kind ${JSON.stringify(asset.kind)}, status ${JSON.stringify(asset.status ?? "pending")}): a Klein reference edit needs an image or svg file and its sha256`,
        ),
      );
    }
  });

  const requireCast = (id, path) => {
    if (!isStr(id) || !byId.has(id)) {
      errors.push(error("SEM_CAST_UNKNOWN", path, `unknown cast ${JSON.stringify(id)}`));
    }
  };

  scenes.forEach((scene, i) => {
    if (!isObj(scene) || !Array.isArray(scene.cast)) return;
    scene.cast.forEach((id, j) => requireCast(id, `/scenes/${i}/cast/${j}`));
  });
  for (const [id, asset] of Object.entries(assets)) {
    if (isObj(asset) && asset.cast !== undefined) requireCast(asset.cast, `/assets/${id}/cast`);
  }
  const presenter = isObj(doc.presenter) ? doc.presenter : null;
  if (presenter) {
    if (presenter.cast !== undefined) requireCast(presenter.cast, "/presenter/cast");
    if (portraitIsCastId(presenter.portrait, assets)) requireCast(presenter.portrait, "/presenter/portrait");
  }
}

/**
 * H17: the presenter and its audio-to-video jobs (research section 2.2).
 *
 * The presenter is opt-in, so a package without it is not judged here at all. What is checked when it
 * is on: it has the portrait everything is conditioned on, the scene ids it names exist, and every
 * a2v asset it asks for has the *ready* audio it is generated from - an a2v job with no narration is
 * a talking head with nothing to say, and the GPU would find that out after the session started.
 */
function checkPresenter(doc, scenes, assets, errors) {
  const presenter = isObj(doc.presenter) ? doc.presenter : null;
  const sceneIds = new Set(scenes.map((scene) => (isObj(scene) ? scene.id : null)).filter((id) => isStr(id)));

  if (presenter) {
    if (presenter.portrait !== undefined && !portraitIsCastId(presenter.portrait, assets)) {
      requireAsset(assets, presenter.portrait, "/presenter/portrait", errors);
    }
    if (presenter.enabled === true && !isStr(presenter.portrait)) {
      errors.push(
        error(
          "SEM_PRESENTER_NO_PORTRAIT",
          "/presenter/portrait",
          "a presenter needs the portrait still its clips are conditioned on (research 2.2: the same portrait at strength 1.0 holds the identity)",
        ),
      );
    }
    if (Array.isArray(presenter.scenes)) {
      presenter.scenes.forEach((id, i) => {
        if (!sceneIds.has(id)) {
          errors.push(error("SEM_PRESENTER_UNKNOWN_SCENE", `/presenter/scenes/${i}`, `unknown scene ${JSON.stringify(id)}`));
        }
      });
    }
  }

  scenes.forEach((scene, i) => {
    if (!isObj(scene)) return;
    if (scene.presenter_asset !== undefined) requireAsset(assets, scene.presenter_asset, `/scenes/${i}/presenter_asset`, errors);
  });

  for (const [id, asset] of Object.entries(assets)) {
    if (!isObj(asset) || !isObj(asset.gen) || asset.gen.generator !== "ltx25-a2v") continue;
    const inputs = isObj(asset.gen.inputs) ? asset.gen.inputs : {};
    const audio = inputs.audio;
    if (!isStr(audio)) {
      errors.push(
        error("SEM_A2V_NO_AUDIO", `/assets/${id}/gen/inputs/audio`, "an ltx25-a2v asset is generated from a scene's narration: gen.inputs.audio has to name it"),
      );
      continue;
    }
    const source = assets[audio];
    if (!isObj(source)) continue; // the unknown-asset error is already recorded by checkRefs
    if (source.kind !== "audio") {
      errors.push(
        error("SEM_A2V_AUDIO_NOT_AUDIO", `/assets/${id}/gen/inputs/audio`, `${JSON.stringify(audio)} is a ${source.kind ?? "?"} asset, not audio`),
      );
    } else if (source.status !== "ready") {
      errors.push(
        error(
          "SEM_A2V_AUDIO_NOT_READY",
          `/assets/${id}/gen/inputs/audio`,
          `${JSON.stringify(audio)} is ${source.status ?? "pending"}: the narration is synthesized before the presenter is generated (research 2.2, timing)`,
        ),
      );
    }
  }
}

/**
 * M1: music bed + sound effects with auto-ducking.
 *
 * A package with no audio block is not judged here. When it is present, the mix has to name files
 * that exist and are rendered: a music bed or a whoosh that is not ready is a silent hole in the
 * finished film, which is exactly what the GPU session would find after spending the units. An sfx
 * also names the scene whose seam it belongs to.
 */
function checkAudio(doc, scenes, assets, errors) {
  const audio = isObj(doc.audio) ? doc.audio : null;
  if (!audio) return;
  const sceneIds = new Set(scenes.map((scene) => (isObj(scene) ? scene.id : null)).filter((id) => isStr(id)));
  const requireAudio = (id, path, what) => {
    if (!isStr(id) || !isObj(assets[id])) {
      errors.push(error("SEM_AUDIO_ASSET_UNKNOWN", path, `${what} ${JSON.stringify(id)} is not a known asset`));
      return;
    }
    const asset = assets[id];
    if (asset.kind !== "audio") {
      errors.push(error("SEM_AUDIO_ASSET_NOT_AUDIO", path, `${what} ${JSON.stringify(id)} is a ${asset.kind ?? "?"} asset, not audio`));
    } else if (asset.status !== "ready") {
      errors.push(error("SEM_AUDIO_ASSET_NOT_READY", path, `${what} ${JSON.stringify(id)} is ${asset.status ?? "pending"}: the mix needs a rendered file`));
    }
  };
  if (isObj(audio.music)) requireAudio(audio.music.asset, "/audio/music/asset", "the music bed");
  if (Array.isArray(audio.sfx)) {
    audio.sfx.forEach((sfx, i) => {
      if (!isObj(sfx)) return;
      requireAudio(sfx.asset, `/audio/sfx/${i}/asset`, "the sound effect");
      if (!sceneIds.has(sfx.scene)) {
        errors.push(error("SEM_AUDIO_UNKNOWN_SCENE", `/audio/sfx/${i}/scene`, `unknown scene ${JSON.stringify(sfx.scene)}`));
      }
    });
  }
}

function checkAssets(assets, errors) {
  for (const [id, asset] of Object.entries(assets)) {
    if (!isObj(asset)) continue;
    const at = `/assets/${id}`;
    const ready = asset.status === "ready";
    if (asset.origin === "generated") {
      if (!isObj(asset.gen) || !isStr(asset.gen.generator)) {
        errors.push(error("SEM_GEN_MISSING_GENERATOR", `${at}/gen/generator`, "origin generated requires gen.generator (llm-svg | flux3-klein | ltx25 | ltx25-a2v | kokoro | qwen3-tts)"));
      }
      if (ready && !isStr(asset.license?.id)) {
        errors.push(error("SEM_LICENSE_MISSING", `${at}/license/id`, "a ready generated asset needs an output licence; generated output defaults to CC0-1.0"));
      }
    }
    if (asset.cutout === true && asset.kind !== "image") {
      errors.push(error("SEM_CUTOUT_KIND", `${at}/cutout`, `cutout is an image flag (got kind ${JSON.stringify(asset.kind)})`));
    }
    if (ready && (!isStr(asset.file) || !isStr(asset.sha256))) {
      errors.push(error("SEM_READY_WITHOUT_FILE", at, "status ready requires both file and sha256"));
    }
    const generator = isObj(asset.gen) ? asset.gen.generator : undefined;
    if (isStr(generator) && generator === "llm-svg") {
      const hasSanitizer = isObj(asset.gen) && isStr(asset.gen.sanitizer_version);
      const hasCheck = isObj(asset.gen) && isObj(asset.gen.render_check);
      if (!hasSanitizer || !hasCheck) {
        errors.push(error("SEM_SVG_PROVENANCE", `${at}/gen`, "llm-svg assets record gen.sanitizer_version and gen.render_check"));
      } else if (ready && asset.gen.render_check.ok !== true) {
        errors.push(error("SEM_RENDER_CHECK_FAILED", `${at}/gen/render_check/ok`, "a ready llm-svg asset must pass the CPU render-check"));
      }
      if (ready && (!isStr(asset.license?.id) || asset.license.id !== GENERATED_OUTPUT_LICENSE.id)) {
        errors.push(error("SEM_LICENSE_CONFLICT", `${at}/license/id`, "generated vector output ships as CC0-1.0 unless a reviewer changes the default on purpose"));
      }
    }
    if (isStr(generator) && MODEL_GENERATORS.includes(generator) && ready && !isStr(asset.model_license?.id)) {
      errors.push(error("SEM_MODEL_LICENSE_MISSING", `${at}/model_license/id`, `generator ${generator} needs model_license (separate from the output licence)`));
    }
    if (asset.redistributable === true) {
      const licId = isObj(asset.license) ? asset.license.id : undefined;
      const blocked = isObj(asset.license) && asset.license.blocked === true;
      if (blocked || (isStr(licId) && NON_REDISTRIBUTABLE_LICENSE_RE.test(licId))) {
        errors.push(error("SEM_LICENSE_CONFLICT", `${at}/redistributable`, `licence ${JSON.stringify(licId)} must not be marked redistributable`));
      }
    }
    checkAssetVariants(asset, at, errors);
  }
}

/**
 * H12: an asset may carry alternates of itself (`variants.upscaled` is the x2 upscale a 1920x1080
 * export prefers). Three things have to hold, and all three are things a run can get wrong:
 *   - a variant needs something to be a variant *of*, so the base file must be there;
 *   - the variant is a different file, never the same path as the base;
 *   - it is bigger than the base (that is the only reason to keep both), which also catches an
 *     applied run whose measured x2 came out at or below the 1x file it was made from.
 */
function checkAssetVariants(asset, at, errors) {
  const variants = asset.variants;
  if (variants === undefined) return;
  if (!isObj(variants)) {
    errors.push(error("SEM_ASSET_VARIANT_SHAPE", `${at}/variants`, "variants must be an object of named renditions (upscaled)"));
    return;
  }
  if (!isStr(asset.file)) {
    errors.push(error("SEM_ASSET_VARIANT_NO_FILE", at, "an asset with variants needs its own file: a variant is an alternate of it"));
  }
  for (const [name, variant] of Object.entries(variants)) {
    const variantAt = `${at}/variants/${name}`;
    if (name !== "upscaled") {
      errors.push(error("SEM_ASSET_VARIANT_NAME", variantAt, `unknown variant ${JSON.stringify(name)} (only "upscaled" is defined)`));
      continue;
    }
    if (!isObj(variant) || !isStr(variant.file) || !Number.isInteger(variant.width) || !Number.isInteger(variant.height)) {
      errors.push(error("SEM_ASSET_VARIANT_SHAPE", variantAt, "an upscaled variant needs file, width and height"));
      continue;
    }
    if (isStr(asset.file) && variant.file === asset.file) {
      errors.push(error("SEM_ASSET_VARIANT_SAME_FILE", `${variantAt}/file`, "a variant must be a different file from the asset it belongs to"));
    }
    if (isStr(variant.file) && (variant.file.startsWith("/") || variant.file.split("/").includes(".."))) {
      errors.push(error("SEM_ASSET_VARIANT_PATH", `${variantAt}/file`, `variant files are relative to the package (got ${JSON.stringify(variant.file)})`));
    }
    const base = isObj(asset.media) ? asset.media : null;
    if (base && Number.isInteger(base.width) && Number.isInteger(base.height)) {
      if (variant.width <= base.width || variant.height <= base.height) {
        errors.push(
          error(
            "SEM_ASSET_VARIANT_NOT_BIGGER",
            variantAt,
            `an upscaled variant must be larger than the asset's media (${base.width}x${base.height}, got ${variant.width}x${variant.height})`,
          ),
        );
      }
    }
  }
}

function checkDatasets(datasets, errors) {
  for (const [id, dataset] of Object.entries(datasets)) {
    if (!isObj(dataset)) continue;
    if (dataset.source === "example" && dataset.approved !== true) {
      errors.push(error("SEM_DATASET_UNAPPROVED", `/datasets/${id}/approved`, "invented example data must be approved before it can be rendered as fact"));
    }
  }
}

function checkUnusedAssets(doc, scenes, assets, datasets, warnings) {
  const used = new Set();
  if (isObj(doc.theme) && isStr(doc.theme.logo_asset)) used.add(doc.theme.logo_asset);
  if (isObj(doc.voice) && isStr(doc.voice.ref_asset)) used.add(doc.voice.ref_asset);
  if (Array.isArray(doc.cast)) {
    for (const member of doc.cast) if (isObj(member) && isStr(member.ref_asset)) used.add(member.ref_asset);
  }
  if (isObj(doc.audio)) {
    if (isObj(doc.audio.music) && isStr(doc.audio.music.asset)) used.add(doc.audio.music.asset);
    if (Array.isArray(doc.audio.sfx)) {
      for (const sfx of doc.audio.sfx) if (isObj(sfx) && isStr(sfx.asset)) used.add(sfx.asset);
    }
  }
  for (const scene of scenes) {
    const bg = scene.background;
    if (isObj(bg) && isStr(bg.asset)) used.add(bg.asset);
    if (Array.isArray(scene.foreground)) {
      for (const fg of scene.foreground) if (isObj(fg) && isStr(fg.asset)) used.add(fg.asset);
    }
    if (Array.isArray(scene.media)) {
      for (const plate of scene.media) if (isObj(plate) && isStr(plate.asset)) used.add(plate.asset);
    }
    if (isStr(scene.narration_asset)) used.add(scene.narration_asset);
  }
  for (const asset of Object.values(assets)) {
    if (isObj(asset) && isObj(asset.gen) && isObj(asset.gen.inputs)) {
      for (const value of Object.values(asset.gen.inputs)) if (isStr(value) && isObj(assets[value])) used.add(value);
    }
  }
  for (const id of Object.keys(assets)) {
    if (!used.has(id)) warnings.push({ code: "WARN_ASSET_UNUSED", path: `/assets/${id}`, message: "asset is not referenced by any scene", source: "semantic" });
  }
  if (isObj(doc.theme) && Array.isArray(doc.theme.fonts)) {
    for (const font of doc.theme.fonts) if (isObj(font)) void font;
  }
  for (const id of Object.keys(datasets)) {
    const referenced = scenes.some((s) => isObj(s.data) && s.data.dataset === id);
    if (!referenced) warnings.push({ code: "WARN_DATASET_UNUSED", path: `/datasets/${id}`, message: "dataset is not referenced by any scene", source: "semantic" });
  }
}

const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

function resolveRef(schema, sub) {
  if (sub && sub.$ref) {
    const m = /^#\/\$defs\/(.+)$/.exec(sub.$ref);
    if (m) return { ...(schema.$defs?.[m[1]] || {}), ...Object.fromEntries(Object.entries(sub).filter(([k]) => k !== "$ref")) };
  }
  return sub;
}

/**
 * Apply declared defaults: schema `default` keywords plus the generated-first
 * output licence default (CC0-1.0 + redistributable true). Pure: returns a copy.
 *
 * Deliberately a small, explicit walk rather than a library defaults pass, because
 * pipeline-py/comfyrizz_pipeline/schema.py implements the identical algorithm and
 * the conformance test compares the two outputs.
 */
export function applyDefaults(doc, schema) {
  if (!isObj(doc) || !isObj(schema)) return doc;
  const out = structuredClone(doc);
  fillDefaults(out, schema, schema);
  for (const asset of Object.values(isObj(out.assets) ? out.assets : {})) {
    if (!isObj(asset)) continue;
    if (asset.origin === "generated" || asset.origin === undefined) {
      if (!isObj(asset.license)) asset.license = { id: GENERATED_OUTPUT_LICENSE.id };
      if (asset.redistributable === undefined) asset.redistributable = GENERATED_OUTPUT_LICENSE.redistributable;
    }
  }
  return out;
}

function fillDefaults(value, sub, schema) {
  if (!isObj(sub) && !Array.isArray(sub)) return;
  sub = resolveRef(schema, sub);
  if (!isObj(sub)) return;
  const branches = Array.isArray(sub.oneOf) ? sub.oneOf : Array.isArray(sub.anyOf) ? sub.anyOf : null;
  if (branches) {
    for (const branch of branches) {
      const resolved = resolveRef(schema, branch);
      if (!isObj(resolved)) continue;
      const kind = Array.isArray(value) ? "array" : value === null ? "null" : typeof value;
      if (resolved.type === "null" || resolved.type === undefined) continue;
      if (resolved.type !== kind && !(resolved.type === "integer" && kind === "number")) continue;
      fillDefaults(value, resolved, schema);
    }
    return;
  }
  if (isObj(value)) {
    if (isObj(sub.properties)) {
      for (const [key, child] of Object.entries(sub.properties)) {
        const resolved = resolveRef(schema, child);
        if (!hasOwn(value, key)) {
          if (isObj(resolved) && "default" in resolved) {
            value[key] = structuredClone(resolved.default);
          }
        } else {
          fillDefaults(value[key], resolved, schema);
        }
      }
    }
    for (const [key, item] of Object.entries(value)) {
      if (isObj(sub.properties) && hasOwn(sub.properties, key)) continue; // visited above
      for (const [pattern, child] of Object.entries(sub.patternProperties || {})) {
        if (new RegExp(pattern).test(key)) fillDefaults(item, child, schema);
      }
      if (isObj(sub.additionalProperties)) fillDefaults(item, sub.additionalProperties, schema);
    }
  } else if (Array.isArray(value)) {
    if (isObj(sub.items)) value.forEach((item) => fillDefaults(item, sub.items, schema));
  }
}
