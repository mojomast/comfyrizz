"""comfyrizz.package/v1 validation for pipeline-py.

Mirrors packages/schema/src/semantic.mjs rule-for-rule and code-for-code: the same
fixture corpus is run through both implementations by
packages/schema/test/conformance.test.mjs and tests/test_conformance.py, so a rule
cannot exist on one side only.

Structural validation is JSON Schema 2020-12 via ``jsonschema``; the schema file
lives in packages/schema/package-v1.schema.json and is the single source of truth.
"""

from __future__ import annotations

import json
import math
import os
import re
from pathlib import Path
from typing import Any

import jsonschema

__all__ = [
    "SEMANTIC_CODES",
    "LAYOUTS",
    "GENERATED_OUTPUT_LICENSE",
    "MODEL_GENERATORS",
    "FLEXIBLE_CEILING_FRAMES",
    "path_problem",
    "semantic_check",
    "apply_defaults",
    "validate_package",
    "validate_jobs",
    "load_jobs_schema",
    "jobs_schema_path",
    "load_schema",
    "schema_path",
    "SCHEMA_VERSION",
]

SCHEMA_VERSION = 1

SEMANTIC_CODES = (
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
    "SEM_PRESENTER_NO_PORTRAIT",
    "SEM_PRESENTER_UNKNOWN_SCENE",
    "SEM_A2V_NO_AUDIO",
    "SEM_A2V_AUDIO_NOT_AUDIO",
    "SEM_A2V_AUDIO_NOT_READY",
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
    "SEM_LOWER_THIRD_EMPTY",
    "SEM_CUTOUT_KIND",
    "SEM_ASSET_VARIANT_SHAPE",
    "SEM_ASSET_VARIANT_NAME",
    "SEM_ASSET_VARIANT_NO_FILE",
    "SEM_ASSET_VARIANT_SAME_FILE",
    "SEM_ASSET_VARIANT_PATH",
    "SEM_ASSET_VARIANT_NOT_BIGGER",
    "SEM_CAST_REF_UNREADY",
    "SEM_CAST_UNKNOWN",
    "SEM_DUPLICATE_CAST_ID",
)

# Published layout contract (PLAN.md A5 / SPEC.md 6.3); the schema holds the loose
# syntax bounds, these are the readability limits that make copy a fail state.
LAYOUTS: dict[str, dict[str, Any]] = {
    "title": {"variants": ["centered", "outro"], "requiresHeadline": True, "limits": {"headline": 48, "sub": 90}},
    "hero": {"variants": ["full-bleed", "split"], "requiresHeadline": True, "limits": {"headline": 64, "sub": 120, "body": 240}},
    "stat": {"variants": [], "requiresData": True, "requiresHeadline": True, "limits": {"headline": 48, "sub": 90, "body": 40}},
    "chart": {"variants": ["bar"], "requiresData": True, "limits": {"headline": 64, "sub": 120, "footnote": 120}},
    "list": {"variants": ["bullets", "quote"], "limits": {"headline": 64, "quote": 200, "attribution": 80}},
}

GENERATED_OUTPUT_LICENSE = {"id": "CC0-1.0", "redistributable": True}
MODEL_GENERATORS = ("flux3-klein", "ltx25", "ltx25-a2v", "kokoro", "qwen3-tts")
FLEXIBLE_CEILING_FRAMES = 2700

SCENE_ID_RE = re.compile(r"^s[A-Za-z0-9_-]{0,63}$")
CAST_ID_RE = re.compile(r"^c[A-Za-z0-9_-]{0,63}$")
ASSET_ID_RE = re.compile(r"^a[A-Za-z0-9_-]{0,63}$")
DATASET_ID_RE = re.compile(r"^d[A-Za-z0-9_-]{0,63}$")
NON_REDISTRIBUTABLE_LICENSE_RE = re.compile(
    r"(^|[-_ ])(NC|ND|NONCOMMERCIAL|NON-COMMERCIAL|NODERIV|NO-DERIV)([-_ ]|$)", re.IGNORECASE
)
URL_RE = re.compile(r"^[A-Za-z][A-Za-z0-9+.-]*://")
DRIVE_RE = re.compile(r"^[A-Za-z]:")


def repo_root() -> Path:
    """Walk up from this file to the repository root (the directory with packages/)."""
    here = Path(__file__).resolve()
    for parent in [here.parent, *here.parents]:
        if (parent / "packages" / "schema" / "package-v1.schema.json").is_file():
            return parent
    raise RuntimeError("cannot locate packages/schema/package-v1.schema.json")


def schema_path() -> Path:
    override = os.environ.get("COMFYRIZZ_SCHEMA")
    if override:
        return Path(override)
    return repo_root() / "packages" / "schema" / "package-v1.schema.json"


_SCHEMA_CACHE: dict[str, Any] | None = None
_VALIDATOR_CACHE: jsonschema.Draft202012Validator | None = None


def load_schema() -> dict[str, Any]:
    global _SCHEMA_CACHE
    if _SCHEMA_CACHE is None:
        with open(schema_path(), encoding="utf-8") as fh:
            _SCHEMA_CACHE = json.load(fh)
    return _SCHEMA_CACHE


def _validator() -> jsonschema.Draft202012Validator:
    global _VALIDATOR_CACHE
    if _VALIDATOR_CACHE is None:
        _VALIDATOR_CACHE = jsonschema.Draft202012Validator(
            load_schema(), format_checker=jsonschema.FormatChecker()
        )
    return _VALIDATOR_CACHE


def _is_obj(value: Any) -> bool:
    return isinstance(value, dict)


def _is_str(value: Any) -> bool:
    return isinstance(value, str)


def _is_number(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool)


def _is_int(value: Any) -> bool:
    """An integer, and not a bool (JSON true is not a width). Mirrors Number.isInteger in TS."""
    return isinstance(value, int) and not isinstance(value, bool)


def path_problem(value: Any) -> str | None:
    """Relative-path check. Same order of checks and same wording as the TS side."""
    if not _is_str(value) or value == "":
        return "empty path"
    if "\\" in value:
        return "backslash separator"
    if value.startswith("/"):
        return "absolute path"
    if value.startswith("~"):
        return "home-relative path"
    if DRIVE_RE.match(value):
        return "Windows drive path"
    if URL_RE.match(value):
        return "URL where a relative path is expected"
    if ".." in value.split("/"):
        return "parent-directory traversal"
    if "" in value.split("/"):
        return "empty path segment"
    if value.startswith("./"):
        return "leading ./ is noise; use a clean relative path"
    return None


def _err(code: str, path: str, message: str) -> dict[str, Any]:
    return {"code": code, "path": path, "message": message, "source": "semantic"}


def _dedupe(items: list[dict[str, Any]]) -> list[dict[str, Any]]:
    seen: set[tuple[str, str, str]] = set()
    out: list[dict[str, Any]] = []
    for item in items:
        key = (item["code"], item["path"], item["message"])
        if key in seen:
            continue
        seen.add(key)
        out.append(item)
    out.sort(key=lambda i: (i["path"], i["code"]))
    return out


def semantic_check(doc: Any) -> dict[str, list[dict[str, Any]]]:
    """Run every semantic rule; returns {'errors': [...], 'warnings': [...]}."""
    errors: list[dict[str, Any]] = []
    warnings: list[dict[str, Any]] = []
    if not _is_obj(doc):
        return {"errors": [_err("SEM_NUMBER_NOT_FINITE", "", "document is not an object")], "warnings": []}

    errors.extend(_check_finite(doc))
    scenes, assets, datasets = _collect(doc, errors)
    _check_ids(doc, scenes, assets, datasets, errors)
    _check_refs(scenes, assets, datasets, errors)
    _check_paths(doc, assets, errors)
    _check_duration(doc, errors)
    _check_voice(doc, errors)
    _check_scenes(scenes, assets, datasets, errors)
    _check_assets(assets, errors)
    _check_presenter(doc, scenes, assets, errors)
    _check_cast(doc, scenes, assets, errors)
    _check_datasets(datasets, errors)
    _check_unused(doc, scenes, assets, datasets, warnings)
    return {"errors": _dedupe(errors), "warnings": _dedupe(warnings)}


def _walk(value: Any, path: str, visit) -> None:
    visit(value, path)
    if isinstance(value, list):
        for i, item in enumerate(value):
            _walk(item, f"{path}/{i}", visit)
    elif _is_obj(value):
        for key, item in value.items():
            _walk(item, f"{path}/{key}", visit)


def _check_finite(doc: Any) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []

    def visit(value: Any, path: str) -> None:
        if not _is_number(value):
            return
        number = float(value)
        if not math.isfinite(number):
            out.append(_err("SEM_NUMBER_NOT_FINITE", path, "number is not finite"))
        elif abs(number) > 1e15:
            out.append(_err("SEM_NUMBER_NOT_FINITE", path, "number is outside the representable bound 1e15"))

    _walk(doc, "", visit)
    return out


def _collect(doc: dict[str, Any], errors: list[dict[str, Any]]):
    raw_scenes = doc.get("scenes")
    scenes = [s for s in raw_scenes if _is_obj(s)] if isinstance(raw_scenes, list) else []
    if isinstance(raw_scenes, list) and len(raw_scenes) != len(scenes):
        errors.append(_err("SEM_ID_PATTERN", "/scenes", "scenes must be objects with an id"))
    assets = doc.get("assets") if _is_obj(doc.get("assets")) else {}
    datasets = doc.get("datasets") if _is_obj(doc.get("datasets")) else {}
    return scenes, assets, datasets


def _check_ids(doc, scenes, assets, datasets, errors) -> None:
    seen: set[str] = set()
    for i, scene in enumerate(scenes):
        sid = scene.get("id")
        if not _is_str(sid) or not SCENE_ID_RE.fullmatch(sid):
            errors.append(
                _err("SEM_ID_PATTERN", f"/scenes/{i}/id", f"scene id must match ^s[A-Za-z0-9_-]{{0,63}}$ (got {json.dumps(sid)})")
            )
        elif sid in seen:
            errors.append(_err("SEM_DUPLICATE_SCENE_ID", f"/scenes/{i}/id", f"duplicate scene id {sid}"))
        else:
            seen.add(sid)
    for key in assets:
        if not ASSET_ID_RE.fullmatch(str(key)):
            errors.append(_err("SEM_ID_PATTERN", f"/assets/{key}", "asset id must match ^a[A-Za-z0-9_-]{0,63}$"))
    for key in datasets:
        if not DATASET_ID_RE.fullmatch(str(key)):
            errors.append(_err("SEM_ID_PATTERN", f"/datasets/{key}", "dataset id must match ^d[A-Za-z0-9_-]{0,63}$"))
    theme = doc.get("theme")
    if _is_obj(theme) and "logo_asset" in theme and not _is_obj(assets.get(theme.get("logo_asset"))):
        errors.append(_err("SEM_REF_UNRESOLVED", "/theme/logo_asset", f"unknown asset {json.dumps(theme.get('logo_asset'))}"))


def _require_asset(assets, asset_id, path, errors) -> None:
    if asset_id is None:
        return
    if not _is_str(asset_id) or not _is_obj(assets.get(asset_id)):
        errors.append(_err("SEM_REF_UNRESOLVED", path, f"unknown asset {json.dumps(asset_id)}"))


def _check_refs(scenes, assets, datasets, errors) -> None:
    for i, scene in enumerate(scenes):
        bg = scene.get("background")
        if _is_obj(bg) and "asset" in bg:
            _require_asset(assets, bg.get("asset"), f"/scenes/{i}/background/asset", errors)
        fg_list = scene.get("foreground")
        if isinstance(fg_list, list):
            for j, fg in enumerate(fg_list):
                if _is_obj(fg):
                    _require_asset(assets, fg.get("asset"), f"/scenes/{i}/foreground/{j}/asset", errors)
        data = scene.get("data")
        if _is_obj(data) and "dataset" in data:
            if not _is_str(data.get("dataset")) or not _is_obj(datasets.get(data.get("dataset"))):
                errors.append(
                    _err("SEM_REF_UNRESOLVED", f"/scenes/{i}/data/dataset", f"unknown dataset {json.dumps(data.get('dataset'))}")
                )
        if "narration_asset" in scene:
            _require_asset(assets, scene.get("narration_asset"), f"/scenes/{i}/narration_asset", errors)
    for asset_id, asset in assets.items():
        gen = asset.get("gen") if _is_obj(asset) else None
        inputs = gen.get("inputs") if _is_obj(gen) else None
        if not _is_obj(inputs):
            continue
        for key, value in inputs.items():
            if _is_asset_ref_input(key) and _is_str(value) and not _is_obj(assets.get(value)):
                errors.append(
                    _err("SEM_REF_UNRESOLVED", f"/assets/{asset_id}/gen/inputs/{key}", f"unknown asset {json.dumps(value)}")
                )


def _check_paths(doc, assets, errors) -> None:
    for asset_id, asset in assets.items():
        if not _is_obj(asset):
            continue
        file_value = asset.get("file")
        if file_value is not None:
            problem = path_problem(file_value)
            if problem:
                errors.append(_err("SEM_PATH_NOT_RELATIVE", f"/assets/{asset_id}/file", f"{problem}: {json.dumps(file_value)}"))
        gen = asset.get("gen")
        workflow = gen.get("workflow") if _is_obj(gen) else None
        if workflow is not None:
            problem = path_problem(workflow)
            if problem:
                errors.append(_err("SEM_PATH_NOT_RELATIVE", f"/assets/{asset_id}/gen/workflow", f"{problem}: {json.dumps(workflow)}"))
    renders = doc.get("renders")
    if isinstance(renders, list):
        for i, render in enumerate(renders):
            if not _is_obj(render):
                continue
            problem = path_problem(render.get("file"))
            if problem:
                errors.append(_err("SEM_PATH_NOT_RELATIVE", f"/renders/{i}/file", f"{problem}: {json.dumps(render.get('file'))}"))
    theme = doc.get("theme")
    if _is_obj(theme) and isinstance(theme.get("fonts"), list):
        for i, font in enumerate(theme["fonts"]):
            if not _is_obj(font):
                continue
            problem = path_problem(font.get("file"))
            if problem:
                errors.append(_err("SEM_PATH_NOT_RELATIVE", f"/theme/fonts/{i}/file", f"{problem}: {json.dumps(font.get('file'))}"))


def _check_duration(doc, errors) -> None:
    duration = doc.get("duration")
    if not _is_obj(duration):
        return
    if duration.get("mode") == "target" and not _is_number(duration.get("targetFrames")):
        errors.append(_err("SEM_DURATION_TARGET_REQUIRED", "/duration/targetFrames", "mode target requires targetFrames"))
    if duration.get("mode") == "flexible":
        for key in ("targetFrames", "maxFrames"):
            value = duration.get(key)
            if _is_number(value) and value > FLEXIBLE_CEILING_FRAMES:
                errors.append(
                    _err("SEM_FLEXIBLE_OVER_CEILING", f"/duration/{key}", f"flexible mode ceiling is {FLEXIBLE_CEILING_FRAMES} frames (got {value})")
                )


def _check_voice(doc, errors) -> None:
    voice = doc.get("voice")
    if not _is_obj(voice) or voice.get("enabled") is not True:
        return
    voice_id = voice.get("voice")
    voiced = voice.get("engine") in ("kokoro", "qwen3-tts")
    if not voiced or not _is_str(voice_id) or voice_id == "":
        errors.append(_err("SEM_VOICE_INCOMPLETE", "/voice", "voice.enabled requires engine kokoro or qwen3-tts and a non-empty voice"))
    assets = doc.get("assets") if _is_obj(doc.get("assets")) else {}
    ref_asset = voice.get("ref_asset")
    if _is_str(ref_asset) and not _is_obj(assets.get(ref_asset)):
        errors.append(_err("SEM_REF_UNRESOLVED", "/voice/ref_asset", f"unknown asset {ref_asset!r}"))


def _non_empty(value: Any) -> bool:
    return _is_str(value) and value.strip() != ""


def _check_scenes(scenes, assets, datasets, errors) -> None:
    for i, scene in enumerate(scenes):
        at = f"/scenes/{i}"
        layout = scene.get("layout")
        spec = LAYOUTS.get(layout) if _is_str(layout) else None
        if spec:
            if "variant" in scene:
                variants = spec.get("variants", [])
                if scene.get("variant") not in variants:
                    allowed = ", ".join(variants) if variants else "no variant"
                    errors.append(
                        _err("SEM_LAYOUT_VARIANT", f"{at}/variant", f"layout {layout} allows {allowed} (got {json.dumps(scene.get('variant'))})")
                    )
            copy = scene.get("copy") if _is_obj(scene.get("copy")) else {}
            if spec.get("requiresData") and not (_is_obj(scene.get("data")) and _is_str(scene["data"].get("dataset"))):
                errors.append(_err("SEM_LAYOUT_REQUIRES_DATA", f"{at}/data", f"layout {layout} requires data.dataset"))
            if spec.get("requiresHeadline") and not _non_empty(copy.get("headline")):
                errors.append(_err("SEM_COPY_REQUIRED", f"{at}/copy/headline", f"layout {layout} requires copy.headline"))
            if layout == "list" and scene.get("variant") == "bullets":
                items = copy.get("items")
                if not isinstance(items, list) or len(items) < 2:
                    errors.append(
                        _err("SEM_COPY_REQUIRED", f"{at}/copy/items", "list variant bullets requires copy.items with 2 to 6 entries")
                    )
            if layout == "list" and scene.get("variant") == "quote" and not _non_empty(copy.get("quote")):
                errors.append(_err("SEM_COPY_REQUIRED", f"{at}/copy/quote", "list variant quote requires copy.quote"))
            for field, limit in (spec.get("limits") or {}).items():
                value = copy.get(field)
                if _is_str(value) and len(value) > limit:
                    errors.append(
                        _err("SEM_COPY_TOO_LONG", f"{at}/copy/{field}", f"layout {layout} allows {limit} characters for {field} (got {len(value)})")
                    )
        copy = scene.get("copy")
        if _is_obj(copy) and "headline" in copy and not _non_empty(copy.get("headline")):
            errors.append(_err("SEM_COPY_REQUIRED", f"{at}/copy/headline", "copy.headline must not be blank"))
        if "narration" in scene and _is_str(scene.get("narration")) and scene["narration"].strip() == "":
            errors.append(_err("SEM_NARRATION_EMPTY", f"{at}/narration", "narration is present but blank"))
        if "narration_spoken" in scene and _is_str(scene.get("narration_spoken")) and scene["narration_spoken"].strip() == "":
            errors.append(_err("SEM_NARRATION_EMPTY", f"{at}/narration_spoken", "narration_spoken is present but blank"))
        if "spoken_text" in scene and _is_str(scene.get("spoken_text")) and scene["spoken_text"].strip() == "":
            errors.append(_err("SEM_NARRATION_EMPTY", f"{at}/spoken_text", "spoken_text is present but blank"))
        bg = scene.get("background")
        if _is_obj(bg):
            has_asset = "asset" in bg
            has_procedural = _is_obj(bg.get("procedural"))
            if has_asset == has_procedural:
                errors.append(_err("SEM_BACKGROUND_AMBIGUOUS", f"{at}/background", "background must set exactly one of asset or procedural"))
        # Media layer (H-fix1, from Pi's P-fix1 proposal): a scene can skip its layout and show
        # only media, with an optional lower third. Two ways that goes wrong, both caught here.
        lower_third = scene.get("lower_third")
        if _is_obj(lower_third) and "text" in lower_third and not _non_empty(lower_third.get("text")):
            errors.append(_err("SEM_LOWER_THIRD_EMPTY", f"{at}/lower_third/text", "lower_third.text must not be blank"))
        if scene.get("media_only") is True:
            has_media_background = _is_obj(bg) and _is_str(bg.get("asset"))
            has_foreground = isinstance(scene.get("foreground"), list) and len(scene["foreground"]) > 0
            if not has_media_background and not has_foreground:
                errors.append(
                    _err(
                        "SEM_MEDIA_ONLY_NO_MEDIA",
                        f"{at}/media_only",
                        "media_only skips the layout, so it needs a media background (background.asset) or at least one "
                        "foreground item; this scene would render an empty frame",
                    )
                )


def _check_presenter(doc, scenes, assets, errors) -> None:
    """H17: the presenter and its audio-to-video jobs (research section 2.2), byte-for-byte the rules
    `packages/schema/src/semantic.mjs` applies - the conformance test compares the two verdicts."""
    presenter = doc.get("presenter") if _is_obj(doc.get("presenter")) else None
    scene_ids = {scene.get("id") for scene in scenes if _is_obj(scene) and _is_str(scene.get("id"))}

    if presenter is not None:
        portrait = presenter.get("portrait")
        portrait_is_cast = _portrait_is_cast_id(portrait, assets)
        if portrait is not None and not portrait_is_cast and not (isinstance(portrait, str) and _is_obj(assets.get(portrait))):
            errors.append(_err("SEM_REF_UNRESOLVED", "/presenter/portrait", f"unknown asset {portrait!r}"))
        if presenter.get("enabled") is True and not _is_str(portrait):
            errors.append(
                _err(
                    "SEM_PRESENTER_NO_PORTRAIT",
                    "/presenter/portrait",
                    "a presenter needs the portrait still its clips are conditioned on (research 2.2: the same portrait at strength 1.0 holds the identity)",
                )
            )
        chosen = presenter.get("scenes")
        if isinstance(chosen, list):
            for index, scene_id in enumerate(chosen):
                if scene_id not in scene_ids:
                    errors.append(_err("SEM_PRESENTER_UNKNOWN_SCENE", f"/presenter/scenes/{index}", f"unknown scene {scene_id!r}"))

    for index, scene in enumerate(scenes):
        if not _is_obj(scene):
            continue
        asset_id = scene.get("presenter_asset")
        if asset_id is None:
            continue
        if not (isinstance(asset_id, str) and _is_obj(assets.get(asset_id))):
            errors.append(_err("SEM_REF_UNRESOLVED", f"/scenes/{index}/presenter_asset", f"unknown asset {asset_id!r}"))

    for asset_id, asset in assets.items():
        if not _is_obj(asset):
            continue
        gen = asset.get("gen") if _is_obj(asset.get("gen")) else {}
        if gen.get("generator") != "ltx25-a2v":
            continue
        inputs = gen.get("inputs") if _is_obj(gen.get("inputs")) else {}
        audio = inputs.get("audio")
        at = f"/assets/{asset_id}/gen/inputs/audio"
        if not _is_str(audio):
            errors.append(
                _err("SEM_A2V_NO_AUDIO", at, "an ltx25-a2v asset is generated from a scene's narration: gen.inputs.audio has to name it")
            )
            continue
        source = assets.get(audio)
        if not _is_obj(source):
            continue  # the unknown-asset error is already recorded by _check_refs
        if source.get("kind") != "audio":
            errors.append(_err("SEM_A2V_AUDIO_NOT_AUDIO", at, f"{audio!r} is a {source.get('kind') or '?'} asset, not audio"))
        elif source.get("status") != "ready":
            errors.append(
                _err(
                    "SEM_A2V_AUDIO_NOT_READY",
                    at,
                    f"{audio!r} is {source.get('status') or 'pending'}: the narration is synthesized before the presenter is generated (research 2.2, timing)",
                )
            )


def _check_assets(assets, errors) -> None:
    for asset_id, asset in assets.items():
        if not _is_obj(asset):
            continue
        at = f"/assets/{asset_id}"
        ready = asset.get("status") == "ready"
        gen = asset.get("gen") if _is_obj(asset.get("gen")) else {}
        generator = gen.get("generator")
        if asset.get("origin") == "generated" and not _is_str(generator):
            errors.append(
                _err("SEM_GEN_MISSING_GENERATOR", f"{at}/gen/generator", "origin generated requires gen.generator (llm-svg | flux3-klein | ltx25 | ltx25-a2v | kokoro | qwen3-tts)")
            )
        if asset.get("origin") == "generated" and ready:
            license_obj = asset.get("license") if _is_obj(asset.get("license")) else {}
            if not _is_str(license_obj.get("id")):
                errors.append(
                    _err("SEM_LICENSE_MISSING", f"{at}/license/id", "a ready generated asset needs an output licence; generated output defaults to CC0-1.0")
                )
        if asset.get("cutout") is True and asset.get("kind") != "image":
            errors.append(_err("SEM_CUTOUT_KIND", f"{at}/cutout", f"cutout is an image flag (got kind {json.dumps(asset.get('kind'))})"))
        if ready and (not _is_str(asset.get("file")) or not _is_str(asset.get("sha256"))):
            errors.append(_err("SEM_READY_WITHOUT_FILE", at, "status ready requires both file and sha256"))
        if generator == "llm-svg":
            has_sanitizer = _is_str(gen.get("sanitizer_version"))
            has_check = _is_obj(gen.get("render_check"))
            if not has_sanitizer or not has_check:
                errors.append(_err("SEM_SVG_PROVENANCE", f"{at}/gen", "llm-svg assets record gen.sanitizer_version and gen.render_check"))
            elif ready and gen["render_check"].get("ok") is not True:
                errors.append(_err("SEM_RENDER_CHECK_FAILED", f"{at}/gen/render_check/ok", "a ready llm-svg asset must pass the CPU render-check"))
            license_obj = asset.get("license") if _is_obj(asset.get("license")) else {}
            if ready and license_obj.get("id") != GENERATED_OUTPUT_LICENSE["id"]:
                errors.append(
                    _err("SEM_LICENSE_CONFLICT", f"{at}/license/id", "generated vector output ships as CC0-1.0 unless a reviewer changes the default on purpose")
                )
        if generator in MODEL_GENERATORS and ready:
            model_license = asset.get("model_license") if _is_obj(asset.get("model_license")) else {}
            if not _is_str(model_license.get("id")):
                errors.append(
                    _err("SEM_MODEL_LICENSE_MISSING", f"{at}/model_license/id", f"generator {generator} needs model_license (separate from the output licence)")
                )
        _check_asset_variants(asset, at, errors)
        if asset.get("redistributable") is True:
            license_obj = asset.get("license") if _is_obj(asset.get("license")) else {}
            license_id = license_obj.get("id")
            blocked = license_obj.get("blocked") is True
            if blocked or (_is_str(license_id) and NON_REDISTRIBUTABLE_LICENSE_RE.search(license_id)):
                errors.append(
                    _err("SEM_LICENSE_CONFLICT", f"{at}/redistributable", f"licence {json.dumps(license_id)} must not be marked redistributable")
                )


def _is_asset_ref_input(key: str) -> bool:
    if key in ("image", "mask", "reference", "audio"):
        return True
    if key.startswith("reference_"):
        return key[len("reference_") :].isdigit()
    return False


def _portrait_is_cast_id(portrait, assets) -> bool:
    """A presenter portrait that names a cast id rather than an asset (CAST1 hook)."""
    return isinstance(portrait, str) and CAST_ID_RE.fullmatch(portrait) is not None and not _is_obj(assets.get(portrait))


def _check_cast(doc, scenes, assets, errors) -> None:
    """CAST1: fictional cast members and the ready still each one is conditioned on.

    A package with no cast and no cast references is not judged here. A ref_asset that is missing,
    not ready, or not a still is SEM_CAST_REF_UNREADY. A scene, asset, or presenter that names an
    unknown cast id is SEM_CAST_UNKNOWN.
    """
    raw = doc.get("cast")
    members = [member for member in raw if _is_obj(member)] if isinstance(raw, list) else []
    by_id: dict[str, dict[str, Any]] = {}
    for index, member in enumerate(members):
        cast_id = member.get("id")
        if not _is_str(cast_id) or CAST_ID_RE.fullmatch(cast_id) is None:
            errors.append(
                _err("SEM_ID_PATTERN", f"/cast/{index}/id", f"cast id must match ^c[A-Za-z0-9_-]{{0,63}}$ (got {json.dumps(cast_id)})")
            )
        elif cast_id in by_id:
            errors.append(_err("SEM_DUPLICATE_CAST_ID", f"/cast/{index}/id", f"duplicate cast id {cast_id}"))
        else:
            by_id[cast_id] = member
        ref = member.get("ref_asset")
        asset = assets.get(ref) if _is_str(ref) else None
        if not _is_str(ref) or not _is_obj(asset):
            errors.append(_err("SEM_CAST_REF_UNREADY", f"/cast/{index}/ref_asset", f"cast ref_asset {json.dumps(ref)} is missing"))
            continue
        still = asset.get("kind") in ("image", "svg")
        ready = asset.get("status") == "ready" and _is_str(asset.get("file")) and _is_str(asset.get("sha256"))
        if not still or not ready:
            errors.append(
                _err(
                    "SEM_CAST_REF_UNREADY",
                    f"/cast/{index}/ref_asset",
                    f"cast ref_asset {json.dumps(ref)} is not a ready still (kind {json.dumps(asset.get('kind'))}, status {json.dumps(asset.get('status') or 'pending')}): a Klein reference edit needs an image or svg file and its sha256",
                )
            )

    def require_cast(cast_id, path) -> None:
        if not _is_str(cast_id) or cast_id not in by_id:
            errors.append(_err("SEM_CAST_UNKNOWN", path, f"unknown cast {json.dumps(cast_id)}"))

    for index, scene in enumerate(scenes):
        if not _is_obj(scene) or not isinstance(scene.get("cast"), list):
            continue
        for j, cast_id in enumerate(scene["cast"]):
            require_cast(cast_id, f"/scenes/{index}/cast/{j}")
    for asset_id, asset in assets.items():
        if _is_obj(asset) and "cast" in asset:
            require_cast(asset.get("cast"), f"/assets/{asset_id}/cast")
    presenter = doc.get("presenter") if _is_obj(doc.get("presenter")) else None
    if presenter is not None:
        if "cast" in presenter:
            require_cast(presenter.get("cast"), "/presenter/cast")
        if _portrait_is_cast_id(presenter.get("portrait"), assets):
            require_cast(presenter.get("portrait"), "/presenter/portrait")


def _check_datasets(datasets, errors) -> None:
    for dataset_id, dataset in datasets.items():
        if not _is_obj(dataset):
            continue
        if dataset.get("source") == "example" and dataset.get("approved") is not True:
            errors.append(
                _err("SEM_DATASET_UNAPPROVED", f"/datasets/{dataset_id}/approved", "invented example data must be approved before it can be rendered as fact")
            )


def _check_unused(doc, scenes, assets, datasets, warnings) -> None:
    used: set[str] = set()
    theme = doc.get("theme")
    if _is_obj(theme) and _is_str(theme.get("logo_asset")):
        used.add(theme["logo_asset"])
    voice = doc.get("voice")
    if _is_obj(voice) and _is_str(voice.get("ref_asset")):
        used.add(voice["ref_asset"])
    if isinstance(doc.get("cast"), list):
        for member in doc["cast"]:
            if _is_obj(member) and _is_str(member.get("ref_asset")):
                used.add(member["ref_asset"])
    for scene in scenes:
        bg = scene.get("background")
        if _is_obj(bg) and _is_str(bg.get("asset")):
            used.add(bg["asset"])
        if isinstance(scene.get("foreground"), list):
            for fg in scene["foreground"]:
                if _is_obj(fg) and _is_str(fg.get("asset")):
                    used.add(fg["asset"])
        if _is_str(scene.get("narration_asset")):
            used.add(scene["narration_asset"])
    for asset in assets.values():
        gen = asset.get("gen") if _is_obj(asset) else None
        inputs = gen.get("inputs") if _is_obj(gen) else None
        if _is_obj(inputs):
            for value in inputs.values():
                if _is_str(value) and _is_obj(assets.get(value)):
                    used.add(value)
    for asset_id in assets:
        if asset_id not in used:
            warnings.append(_err("WARN_ASSET_UNUSED", f"/assets/{asset_id}", "asset is not referenced by any scene"))
    for dataset_id in datasets:
        referenced = any(_is_obj(s.get("data")) and s["data"].get("dataset") == dataset_id for s in scenes)
        if not referenced:
            warnings.append(_err("WARN_DATASET_UNUSED", f"/datasets/{dataset_id}", "dataset is not referenced by any scene"))


# --------------------------------------------------------------------------- defaults


def _resolve_ref(schema: dict[str, Any], sub: Any) -> Any:
    if _is_obj(sub) and "$ref" in sub:
        ref = sub["$ref"]
        if isinstance(ref, str) and ref.startswith("#/$defs/"):
            name = ref[len("#/$defs/"):]
            merged = dict(schema.get("$defs", {}).get(name, {}))
            merged.update({k: v for k, v in sub.items() if k != "$ref"})
            return merged
    return sub


def apply_defaults(doc: Any, schema: dict[str, Any] | None = None) -> Any:
    """Fill schema `default` keywords plus the generated-first output licence default.

    Same algorithm as packages/schema/src/semantic.mjs ``applyDefaults``; the
    conformance test compares the two outputs on fixtures/valid/defaults-unfilled.json.
    """
    if not _is_obj(doc):
        return doc
    schema = schema or load_schema()
    out = json.loads(json.dumps(doc))
    _fill_defaults(out, schema, schema)
    for asset in (out.get("assets") or {}).values():
        if not _is_obj(asset):
            continue
        if asset.get("origin", "generated") == "generated":
            if not _is_obj(asset.get("license")):
                asset["license"] = {"id": GENERATED_OUTPUT_LICENSE["id"]}
            if "redistributable" not in asset:
                asset["redistributable"] = GENERATED_OUTPUT_LICENSE["redistributable"]
    return out


def _fill_defaults(value: Any, sub: Any, schema: dict[str, Any]) -> None:
    sub = _resolve_ref(schema, sub)
    if not _is_obj(sub):
        return
    branches = sub.get("oneOf") if isinstance(sub.get("oneOf"), list) else sub.get("anyOf")
    if isinstance(branches, list):
        if isinstance(value, list):
            kind = "array"
        elif value is None:
            kind = "null"
        elif isinstance(value, dict):
            kind = "object"
        elif isinstance(value, bool):
            kind = "boolean"
        elif isinstance(value, (int, float)):
            kind = "number"
        else:
            kind = "string"
        for branch in branches:
            resolved = _resolve_ref(schema, branch)
            if not _is_obj(resolved) or resolved.get("type") in (None, "null"):
                continue
            if resolved.get("type") != kind and not (resolved.get("type") == "integer" and kind == "float"):
                continue
            _fill_defaults(value, resolved, schema)
        return
    if _is_obj(value):
        properties = sub.get("properties")
        if _is_obj(properties):
            for key, child in properties.items():
                resolved = _resolve_ref(schema, child)
                if key not in value:
                    if _is_obj(resolved) and "default" in resolved:
                        value[key] = json.loads(json.dumps(resolved["default"]))
                else:
                    _fill_defaults(value[key], resolved, schema)
        for key, item in value.items():
            if _is_obj(properties) and key in properties:
                continue  # already visited above
            for pattern, child in (sub.get("patternProperties") or {}).items():
                if re.search(pattern, key):
                    _fill_defaults(item, child, schema)
            if _is_obj(sub.get("additionalProperties")):
                _fill_defaults(item, sub["additionalProperties"], schema)
    elif isinstance(value, list):
        if _is_obj(sub.get("items")):
            for item in value:
                _fill_defaults(item, sub["items"], schema)


# ------------------------------------------------------------------- jobs/v1 document


_JOBS_SCHEMA_CACHE: dict[str, Any] | None = None
_JOBS_VALIDATOR_CACHE: jsonschema.Draft202012Validator | None = None


def jobs_schema_path() -> Path:
    return schema_path().with_name("jobs-v1.schema.json")


def load_jobs_schema() -> dict[str, Any]:
    global _JOBS_SCHEMA_CACHE
    if _JOBS_SCHEMA_CACHE is None:
        with open(jobs_schema_path(), encoding="utf-8") as fh:
            _JOBS_SCHEMA_CACHE = json.load(fh)
    return _JOBS_SCHEMA_CACHE


def _jobs_validator() -> jsonschema.Draft202012Validator:
    global _JOBS_VALIDATOR_CACHE
    if _JOBS_VALIDATOR_CACHE is None:
        _JOBS_VALIDATOR_CACHE = jsonschema.Draft202012Validator(load_jobs_schema())
    return _JOBS_VALIDATOR_CACHE


def validate_jobs(doc: Any) -> list[dict[str, Any]]:
    """Structural problems in a comfyrizz.jobs/v1 document, as [{code, path, message}].

    The runner refuses to submit anything when this is non-empty: a jobs.json that does
    not describe what the planner meant is worth more as an error than as a GPU session.
    """
    problems = []
    for error in _jobs_validator().iter_errors(doc):
        path = "/" + "/".join(str(p) for p in error.absolute_path)
        if path == "/":
            path = ""
        problems.append(
            {"code": f"JOBS_{str(error.validator).upper()}", "path": path, "message": error.message}
        )
    if _is_obj(doc):
        ids = [job.get("id") for job in doc.get("jobs", []) if _is_obj(job)]
        for job_id in {i for i in ids if ids.count(i) > 1}:
            problems.append({"code": "JOBS_DUPLICATE_JOB_ID", "path": "/jobs", "message": f"duplicate job id {job_id}"})
        known = set(ids)
        for i, job in enumerate(doc.get("jobs", [])):
            if not _is_obj(job):
                continue
            for dep in job.get("deps", []) or []:
                if dep not in known:
                    problems.append(
                        {"code": "JOBS_UNKNOWN_DEPENDENCY", "path": f"/jobs/{i}/deps", "message": f"dependency {dep} is not in this document"}
                    )
            problems.extend(
                {
                    "code": "JOBS_PATH_NOT_RELATIVE",
                    "path": f"/jobs/{i}/output",
                    "message": f"{problem}: {json.dumps(job.get('output'))}",
                }
                for problem in [path_problem(job.get("output"))]
                if problem
            )
            for k, entry in enumerate(job.get("fileInputs", []) or []):
                at = f"/jobs/{i}/fileInputs/{k}"
                if not _is_obj(entry):
                    problems.append({"code": "JOBS_INPUT_FILE_UNRESOLVED", "path": at, "message": "every fileInputs entry must be an object"})
                    continue
                if entry.get("from") not in ("job", "package"):
                    problems.append(
                        {
                            "code": "JOBS_INPUT_FILE_UNRESOLVED",
                            "path": at,
                            "message": f"from must be job or package (got {json.dumps(entry.get('from'))}); the runner cannot tell where the file is",
                        }
                    )
                problem = path_problem(entry.get("path"))
                if problem:
                    problems.append({"code": "JOBS_PATH_NOT_RELATIVE", "path": f"{at}/path", "message": f"{problem}: {json.dumps(entry.get('path'))}"})
                if entry.get("from") == "job" and entry.get("job") not in known:
                    problems.append(
                        {
                            "code": "JOBS_UNKNOWN_DEPENDENCY",
                            "path": at,
                            "message": f"file input {entry.get('param')} is produced by {entry.get('job')}, which is not in this document",
                        }
                    )
            stage1 = job.get("stage1Dims")
            dims = job.get("dims")
            if _is_obj(stage1) and _is_obj(dims) and _is_number(dims.get("width")) and _is_number(dims.get("height")):
                expected = (dims["width"] / 2, dims["height"] / 2)
                actual = (stage1.get("width"), stage1.get("height"))
                if not all(_is_number(value) for value in actual) or any(
                    abs(float(value) - want) > 0.5 for value, want in zip(actual, expected)
                ):
                    problems.append(
                        {
                            "code": "JOBS_SEMANTIC",
                            "path": f"/jobs/{i}/stage1Dims",
                            "message": f"stage1Dims {actual[0]}x{actual[1]} is not half of dims {dims['width']}x{dims['height']}",
                        }
                    )
    return problems


# --------------------------------------------------------------------------- validation


def schema_errors(doc: Any) -> list[dict[str, Any]]:
    out = []
    for error in _validator().iter_errors(doc):
        path = "/" + "/".join(str(p) for p in error.absolute_path)
        if path == "/":
            path = ""
        out.append(
            {
                "source": "schema",
                "code": f"SCHEMA_{str(error.validator).upper()}",
                "path": path,
                "message": error.message,
            }
        )
    return out


def validate_package(doc: Any, defaults: bool = False) -> dict[str, Any]:
    """Structural + semantic validation. Mirrors packages/schema/src/index.mjs."""
    document = apply_defaults(doc) if defaults else doc
    schema_problems = schema_errors(document)
    semantic = semantic_check(document)
    errors = schema_problems + semantic["errors"]
    errors.sort(key=lambda i: (i["path"], i["code"]))
    # MS2: advisory motion lint (mirrors index.mjs); it never changes `valid`.
    from .motion_lint import lint_motion

    return {
        "valid": not errors,
        "schemaOk": not schema_problems,
        "errors": errors,
        "warnings": semantic["warnings"],
        "semantic": semantic["errors"],
        "motion": lint_motion(document),
        "document": document,
    }

def _check_asset_variants(asset, at: str, errors) -> None:
    """H12: `assets.<id>.variants.upscaled` is the x2 upscale a 1920x1080 export prefers.

    Mirrors packages/schema/src/semantic.mjs `checkAssetVariants` code for code, because the
    conformance test runs both validators over the same fixtures and compares the codes:
      - a variant needs the base file to be a variant *of*;
      - it is a different file from the base, and a package-relative one;
      - it is bigger than the base media (that is the only reason to keep both, and it catches an
        applied run whose measured upscale came out no larger than the file it was made from).
    """
    variants = asset.get("variants")
    if variants is None:
        return
    if not _is_obj(variants):
        errors.append(_err("SEM_ASSET_VARIANT_SHAPE", f"{at}/variants", "variants must be an object of named renditions (upscaled)"))
        return
    if not _is_str(asset.get("file")):
        errors.append(_err("SEM_ASSET_VARIANT_NO_FILE", at, "an asset with variants needs its own file: a variant is an alternate of it"))
    media = asset.get("media") if _is_obj(asset.get("media")) else None
    for name, variant in variants.items():
        variant_at = f"{at}/variants/{name}"
        if name != "upscaled":
            errors.append(_err("SEM_ASSET_VARIANT_NAME", variant_at, f'unknown variant {json.dumps(name)} (only "upscaled" is defined)'))
            continue
        width = variant.get("width") if _is_obj(variant) else None
        height = variant.get("height") if _is_obj(variant) else None
        if (
            not _is_obj(variant)
            or not _is_str(variant.get("file"))
            or not _is_int(width)
            or not _is_int(height)
        ):
            errors.append(_err("SEM_ASSET_VARIANT_SHAPE", variant_at, "an upscaled variant needs file, width and height"))
            continue
        file_name = variant["file"]
        if _is_str(asset.get("file")) and file_name == asset["file"]:
            errors.append(
                _err("SEM_ASSET_VARIANT_SAME_FILE", f"{variant_at}/file", "a variant must be a different file from the asset it belongs to")
            )
        if file_name.startswith("/") or ".." in file_name.split("/"):
            errors.append(_err("SEM_ASSET_VARIANT_PATH", f"{variant_at}/file", f"variant files are relative to the package (got {json.dumps(file_name)})"))
        if media is not None and _is_int(media.get("width")) and _is_int(media.get("height")):
            if width <= media["width"] or height <= media["height"]:
                errors.append(
                    _err(
                        "SEM_ASSET_VARIANT_NOT_BIGGER",
                        variant_at,
                        f"an upscaled variant must be larger than the asset's media "
                        f"({media['width']}x{media['height']}, got {width}x{height})",
                    )
                )

