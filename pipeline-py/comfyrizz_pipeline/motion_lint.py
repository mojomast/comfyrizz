"""MS2: the motion vocabulary of comfyrizz.package/v1 and a pure motion linter.

Mirrors packages/schema/src/motion.mjs rule for rule: same codes, severities, scenes, paths and
autofix ops (packages/schema/test/motion.test.mjs runs the shared cases through both and
compares them). The vocabulary names are exactly the renderer's motion token names (MS1,
apps/renderer/src/motion/). The numbers are re-expressed from `whaleyxbt/claude-motion` (MIT,
Copyright (c) 2026 whaleyxbt) and the HyperFrames motion skills (Apache-2.0, Copyright HeyGen);
no code was copied.

A finding is ``{code, severity, scene, path, message, autofix, source: "motion"}`` with
``autofix`` either None or ``{description, ops: [{op: "set", path, value} | {op: "delete", path}]}``.
"""

from __future__ import annotations

import copy as _copy
import math
import re
from typing import Any

__all__ = [
    "MOTION_VOCABULARY",
    "TRANSITIONS",
    "ENERGY_TRANSITIONS",
    "MOTION_DEFAULTS",
    "MOTION_LINT_CODES",
    "MAX_TRANSITION_TYPES",
    "lint_motion",
    "apply_motion_fixes",
    "autofix_motion",
]

MOTION_VOCABULARY = {
    "easing": ("enter", "exit", "move", "land", "linear"),
    "springs": ("settle", "heavy", "snap", "pop", "elastic"),
    "energies": ("calm", "medium", "high"),
    "directions": ("left", "right", "up", "down"),
    "staggers": ("none", "word", "listItem", "dot"),
    "entries": ("none", "fadeUp", "maskRise", "pop", "countUp", "waterfall", "drawOn"),
    "emphasis": ("none", "keyword", "hero"),
    "transitionTypes": ("none", "cut", "fade", "blur", "slide", "push", "wipe", "zoom", "iris", "paper-reveal", "draw-reveal", "shape-reveal"),
    "transitionDirections": ("left", "right", "up", "down", "in", "out"),
}

TRANSITIONS = {
    "none": {"axis": None, "minSeconds": 0, "maxSeconds": 0},
    "cut": {"axis": None, "minSeconds": 0, "maxSeconds": 0},
    "fade": {"axis": None, "minSeconds": 0.3, "maxSeconds": 0.8},
    "blur": {"axis": None, "minSeconds": 0.4, "maxSeconds": 0.8},
    "slide": {"axis": "planar", "minSeconds": 0.25, "maxSeconds": 0.6},
    "push": {"axis": "planar", "minSeconds": 0.25, "maxSeconds": 0.6},
    "wipe": {"axis": "planar", "minSeconds": 0.25, "maxSeconds": 0.6},
    "zoom": {"axis": "depth", "minSeconds": 0.15, "maxSeconds": 0.4},
    "iris": {"axis": "depth", "minSeconds": 0.25, "maxSeconds": 0.45},
    # Storytelling reveals (animation research 2026 section 4): no travel axis, so a
    # direction on them is MOTION_DIRECTION_UNUSED.
    "paper-reveal": {"axis": None, "minSeconds": 0.3, "maxSeconds": 0.8},
    "draw-reveal": {"axis": None, "minSeconds": 0.35, "maxSeconds": 0.9},
    "shape-reveal": {"axis": None, "minSeconds": 0.25, "maxSeconds": 0.6},
}

ENERGY_TRANSITIONS = {
    "calm": ("none", "cut", "fade", "blur", "paper-reveal", "draw-reveal"),
    "medium": ("none", "cut", "fade", "slide", "push", "wipe", "paper-reveal", "draw-reveal", "shape-reveal"),
    "high": ("none", "cut", "push", "zoom", "iris", "shape-reveal"),
}

ENERGY_SCALES = {
    "calm": {"entryScale": 1.2, "staggerScale": 1.15},
    "medium": {"entryScale": 1, "staggerScale": 1},
    "high": {"entryScale": 0.8, "staggerScale": 0.75},
}
STAGGER_STEP_SECONDS = {"none": 0, "word": 0.09, "listItem": 0.22, "dot": 0.06}

MOTION_DEFAULTS = {
    "energy": "medium",
    "direction": "left",
    "depthDirection": "in",
    "transition": {"type": "fade", "frames": 15},
    "fps": 30,
}

READING = {
    "minHoldSeconds": 1,
    "freeWords": 3,
    "perExtraWordSeconds": 0.25,
    "finalHoldSeconds": 2,
    "entrySeconds": 0.6,
    "maxStaggerSeconds": 0.5,
}

MAX_TRANSITION_TYPES = 3

MOTION_LINT_CODES = {
    "MOTION_CUT_HAS_FRAMES": "error",
    "MOTION_DIRECTION_AXIS": "error",
    "MOTION_HIGHLIGHT_MISSING": "error",
    "MOTION_HIGHLIGHT_NOT_IN_COPY": "error",
    "MOTION_DIRECTION_UNUSED": "warning",
    "MOTION_TRANSITION_DURATION": "warning",
    "MOTION_TRANSITION_BUDGET": "warning",
    "MOTION_DIRECTION_PINGPONG": "warning",
    "MOTION_HERO_MULTIPLE": "warning",
    "MOTION_ELASTIC_REPEAT": "warning",
    "MOTION_LINEAR_ENTRY": "warning",
    "MOTION_ENTRY_MISMATCH": "warning",
    "MOTION_READING_HOLD": "warning",
    "MOTION_FINAL_HOLD": "warning",
    "MOTION_AGAINST_CURRENT": "info",
    "MOTION_HERO_EARLY": "info",
    "MOTION_NO_HERO": "info",
    "MOTION_ENERGY_MISMATCH": "info",
}

_OPPOSITE = {"left": "right", "right": "left", "up": "down", "down": "up", "in": "out", "out": "in"}
_PLANAR = {"left", "right", "up", "down"}
_DEPTH = {"in", "out"}
_COPY_FIELDS = ("headline", "kicker", "sub", "body", "quote", "attribution", "footnote", "cta")
_VECTOR_KINDS = {"svg", "vector-anim"}
_WS = re.compile(r"\s+")


def _is_obj(v: Any) -> bool:
    return isinstance(v, dict)


def _is_str(v: Any) -> bool:
    return isinstance(v, str)


def _is_int(v: Any) -> bool:
    return isinstance(v, int) and not isinstance(v, bool) or (isinstance(v, float) and v.is_integer())


def _round(v: float) -> int:
    return math.floor(v + 0.5)  # JS Math.round, not banker's rounding


def _finding(code, scene, path, message, autofix=None):
    return {"code": code, "severity": MOTION_LINT_CODES[code], "scene": scene, "path": path, "message": message, "autofix": autofix, "source": "motion"}


def _fix(description, *ops):
    return {"description": description, "ops": list(ops)}


def _words(text) -> list[str]:
    return [w for w in _WS.split(text) if w] if _is_str(text) else []


def _readable_text(scene) -> list[str]:
    out: list[str] = []
    copy = scene.get("copy") if _is_obj(scene.get("copy")) else {}
    for field in _COPY_FIELDS:
        if _is_str(copy.get(field)):
            out.append(copy[field])
    if isinstance(copy.get("items"), list):
        out.extend(item for item in copy["items"] if _is_str(item))
    lower = scene.get("lower_third")
    if _is_obj(lower):
        for key in ("kicker", "text"):
            if _is_str(lower.get(key)):
                out.append(lower[key])
    return out


def _package_motion(doc) -> dict[str, str]:
    m = doc.get("motion") if _is_obj(doc.get("motion")) else {}
    return {
        "energy": m.get("energy") if m.get("energy") in MOTION_VOCABULARY["energies"] else MOTION_DEFAULTS["energy"],
        "direction": m.get("direction") if m.get("direction") in MOTION_VOCABULARY["directions"] else MOTION_DEFAULTS["direction"],
    }


def _scene_energy(scene, pkg) -> str:
    m = scene.get("motion") if _is_obj(scene.get("motion")) else {}
    return m.get("energy") if m.get("energy") in MOTION_VOCABULARY["energies"] else pkg["energy"]


def _transition_of(scene) -> dict[str, Any]:
    t = scene.get("transitionOut")
    if not _is_obj(t):
        return {"type": MOTION_DEFAULTS["transition"]["type"], "frames": MOTION_DEFAULTS["transition"]["frames"], "direction": None, "explicit": False}
    kind = t.get("type") if _is_str(t.get("type")) and t.get("type") in TRANSITIONS else None
    frames = int(t["frames"]) if _is_int(t.get("frames")) else MOTION_DEFAULTS["transition"]["frames"]
    return {"type": kind, "frames": frames, "direction": t.get("direction") if _is_str(t.get("direction")) else None, "explicit": True}


def _resolved_direction(tr, pkg):
    spec = TRANSITIONS.get(tr["type"]) if tr["type"] else None
    if not spec or not spec["axis"]:
        return None
    if spec["axis"] == "planar":
        return tr["direction"] if tr["direction"] in _PLANAR else pkg["direction"]
    return tr["direction"] if tr["direction"] in _DEPTH else MOTION_DEFAULTS["depthDirection"]


def _band(kind, fps):
    spec = TRANSITIONS[kind]
    return _round(spec["minSeconds"] * fps), _round(spec["maxSeconds"] * fps)


def _clamp_frames(kind, frames, fps):
    lo, hi = _band(kind, fps)
    return lo if frames < lo else hi if frames > hi else frames


def _label(scene, index):
    return scene["id"] if _is_str(scene.get("id")) else f"#{index}"


def _scene_frames(scene, timeline):
    if _is_obj(timeline) and isinstance(timeline.get("scenes"), list):
        for s in timeline["scenes"]:
            if _is_obj(s) and s.get("id") == scene.get("id"):
                if _is_int(s.get("durationInFrames")):
                    return int(s["durationInFrames"])
                break
    return int(scene["preferredFrames"]) if _is_int(scene.get("preferredFrames")) else None


def _settle_seconds(scene, pkg) -> float:
    m = scene.get("motion") if _is_obj(scene.get("motion")) else {}
    scales = ENERGY_SCALES[_scene_energy(scene, pkg)]
    if m.get("entry") == "none":
        return 0
    entry = READING["entrySeconds"] * scales["entryScale"]
    family = m.get("stagger") if m.get("stagger") in MOTION_VOCABULARY["staggers"] else None
    if family is None:
        family = "listItem" if scene.get("layout") == "list" and scene.get("variant") == "bullets" else "none"
    copy = scene.get("copy") if _is_obj(scene.get("copy")) else {}
    count = 0
    if family == "listItem":
        count = len(copy["items"]) if isinstance(copy.get("items"), list) else 0
    elif family == "word":
        count = len(_words(copy.get("headline") if _is_str(copy.get("headline")) else copy.get("quote")))
    stagger = min(READING["maxStaggerSeconds"], max(0, count - 1) * STAGGER_STEP_SECONDS[family] * scales["staggerScale"])
    return entry + stagger


def _has_vector_art(scene, doc) -> bool:
    assets = doc.get("assets") if _is_obj(doc.get("assets")) else {}
    ids = []
    bg = scene.get("background")
    if _is_obj(bg) and _is_str(bg.get("asset")):
        ids.append(bg["asset"])
    if isinstance(scene.get("foreground"), list):
        ids.extend(fg["asset"] for fg in scene["foreground"] if _is_obj(fg) and _is_str(fg.get("asset")))
    return any(_is_obj(assets.get(i)) and assets[i].get("kind") in _VECTOR_KINDS for i in ids)


def _js_fixed(value: float) -> str:
    return f"{value:.2f}"


def lint_motion(doc: Any, fps: int | None = None, timeline: Any = None) -> list[dict[str, Any]]:
    """Lint the motion of a package. Pure; never raises on malformed input."""
    if not _is_obj(doc) or not isinstance(doc.get("scenes"), list):
        return []
    fmt = doc.get("format") if _is_obj(doc.get("format")) else {}
    if not (_is_int(fps) and fps > 0):
        fps = int(fmt["fps"]) if _is_int(fmt.get("fps")) and fmt["fps"] > 0 else MOTION_DEFAULTS["fps"]
    pkg = _package_motion(doc)
    scenes = [(scene, index) for index, scene in enumerate(doc["scenes"]) if _is_obj(scene)]
    out: list[dict[str, Any]] = []
    last = scenes[-1][1] if scenes else -1
    transitions: dict[int, dict[str, Any]] = {}

    for scene, index in scenes:
        at = f"/scenes/{index}"
        label = _label(scene, index)
        if index == last:
            continue
        tr = _transition_of(scene)
        if not tr["type"]:
            continue
        transitions[index] = tr
        spec = TRANSITIONS[tr["type"]]
        if tr["type"] == "cut" and tr["frames"] > 0:
            out.append(_finding("MOTION_CUT_HAS_FRAMES", label, f"{at}/transitionOut/frames", f"a cut has no overlap; frames must be 0 (got {tr['frames']})",
                                _fix("set the cut's frames to 0", {"op": "set", "path": f"{at}/transitionOut/frames", "value": 0})))
        if tr["direction"] is not None:
            if not spec["axis"]:
                out.append(_finding("MOTION_DIRECTION_UNUSED", label, f"{at}/transitionOut/direction", f"a {tr['type']} has no direction (got \"{tr['direction']}\")",
                                    _fix("drop the direction", {"op": "delete", "path": f"{at}/transitionOut/direction"})))
            elif (spec["axis"] == "planar" and tr["direction"] not in _PLANAR) or (spec["axis"] == "depth" and tr["direction"] not in _DEPTH):
                value = pkg["direction"] if spec["axis"] == "planar" else MOTION_DEFAULTS["depthDirection"]
                allowed = "left, right, up or down" if spec["axis"] == "planar" else "in or out"
                out.append(_finding("MOTION_DIRECTION_AXIS", label, f"{at}/transitionOut/direction", f"a {tr['type']} goes {allowed} (got \"{tr['direction']}\")",
                                    _fix(f"set the direction to {value}", {"op": "set", "path": f"{at}/transitionOut/direction", "value": value})))
        if tr["type"] not in ("none", "cut"):
            lo, hi = _band(tr["type"], fps)
            if tr["frames"] < lo or tr["frames"] > hi:
                value = _clamp_frames(tr["type"], tr["frames"], fps)
                if tr["explicit"]:
                    autofix = _fix(f"set frames to {value}", {"op": "set", "path": f"{at}/transitionOut/frames", "value": value})
                else:
                    autofix = _fix(f"write the default {tr['type']} out with {value} frames", {"op": "set", "path": f"{at}/transitionOut", "value": {"type": tr["type"], "frames": value}})
                out.append(_finding("MOTION_TRANSITION_DURATION", label, f"{at}/transitionOut/frames", f"a {tr['type']} runs {lo}-{hi} frames at {fps} fps (got {tr['frames']})", autofix))
        energy = _scene_energy(scene, pkg)
        if tr["type"] not in ENERGY_TRANSITIONS[energy]:
            family = ", ".join(t for t in ENERGY_TRANSITIONS[energy] if t != "none")
            out.append(_finding("MOTION_ENERGY_MISMATCH", label, f"{at}/transitionOut/type", f"a {tr['type']} does not read as {energy} energy ({energy}: {family})"))

    order = sorted(transitions)
    counts: dict[str, int] = {}
    for index in order:
        kind = transitions[index]["type"]
        if kind in ("none", "cut"):
            continue
        counts[kind] = counts.get(kind, 0) + 1
    if len(counts) > MAX_TRANSITION_TYPES:
        ranked = [k for k, _ in sorted(counts.items(), key=lambda kv: -kv[1])]  # stable: ties keep first use
        keep = set(ranked[:MAX_TRANSITION_TYPES])
        primary = ranked[0]
        for index in order:
            tr = transitions[index]
            if tr["type"] in ("none", "cut") or tr["type"] in keep:
                continue
            value = {"type": primary, "frames": _clamp_frames(primary, tr["frames"], fps)}
            out.append(_finding("MOTION_TRANSITION_BUDGET", _label(doc["scenes"][index], index), f"/scenes/{index}/transitionOut/type",
                                f"{len(counts)} transition types in one film; keep {MAX_TRANSITION_TYPES} ({', '.join(ranked[:MAX_TRANSITION_TYPES])}) and use the primary {primary} here instead of {tr['type']}",
                                _fix(f"use the primary transition {primary}", {"op": "set", "path": f"/scenes/{index}/transitionOut", "value": value})))
    previous = None
    for index in order:
        tr = transitions[index]
        scene = doc["scenes"][index]
        direction = _resolved_direction(tr, pkg)
        if direction and previous and previous[0] == index - 1 and _OPPOSITE[previous[1]] == direction:
            out.append(_finding("MOTION_DIRECTION_PINGPONG", _label(scene, index), f"/scenes/{index}/transitionOut/direction",
                                f"goes {direction} right after a transition that went {previous[1]}; keep one current",
                                _fix(f"go {previous[1]} like the transition before", {"op": "set", "path": f"/scenes/{index}/transitionOut/direction", "value": previous[1]})))
        elif direction and TRANSITIONS[tr["type"]]["axis"] == "planar" and direction in ("left", "right") and direction == _OPPOSITE[pkg["direction"]]:
            out.append(_finding("MOTION_AGAINST_CURRENT", _label(scene, index), f"/scenes/{index}/transitionOut/direction", f"goes {direction} against the film's current ({pkg['direction']})"))
        previous = (index, direction) if direction else None

    heroes: list[int] = []
    elastic: list[int] = []
    directed = _is_obj(doc.get("motion"))
    for scene, index in scenes:
        at = f"/scenes/{index}"
        label = _label(scene, index)
        m = scene.get("motion")
        if not _is_obj(m):
            continue
        directed = True
        if m.get("emphasis") == "hero":
            heroes.append(index)
        if m.get("spring") == "elastic":
            elastic.append(index)
        if m.get("ease") == "linear" and m.get("entry") != "none":
            out.append(_finding("MOTION_LINEAR_ENTRY", label, f"{at}/motion/ease", "linear is for continuous motion; an entrance eases",
                                _fix("use the enter ease", {"op": "set", "path": f"{at}/motion/ease", "value": "enter"})))
        if m.get("emphasis") == "keyword" and not _is_str(m.get("highlight")):
            out.append(_finding("MOTION_HIGHLIGHT_MISSING", label, f"{at}/motion/highlight", "a keyword emphasis needs the word or phrase to highlight",
                                _fix("drop the keyword emphasis", {"op": "set", "path": f"{at}/motion/emphasis", "value": "none"})))
        if _is_str(m.get("highlight")):
            needle = m["highlight"].lower()
            if not any(needle in text.lower() for text in _readable_text(scene)):
                ops = [{"op": "delete", "path": f"{at}/motion/highlight"}]
                if m.get("emphasis") == "keyword":
                    ops.append({"op": "set", "path": f"{at}/motion/emphasis", "value": "none"})
                out.append(_finding("MOTION_HIGHLIGHT_NOT_IN_COPY", label, f"{at}/motion/highlight", f"\"{m['highlight']}\" is not in this scene's copy", _fix("drop the highlight", *ops)))
        if m.get("entry") == "countUp" and not (_is_obj(scene.get("data")) and _is_str(scene["data"].get("dataset"))):
            out.append(_finding("MOTION_ENTRY_MISMATCH", label, f"{at}/motion/entry", "countUp counts a dataset value; this scene has no data.dataset",
                                _fix("use the layout's default entry", {"op": "delete", "path": f"{at}/motion/entry"})))
        if m.get("entry") == "drawOn" and not _has_vector_art(scene, doc):
            out.append(_finding("MOTION_ENTRY_MISMATCH", label, f"{at}/motion/entry", "drawOn draws SVG strokes; this scene has no svg or vector-anim asset",
                                _fix("use the layout's default entry", {"op": "delete", "path": f"{at}/motion/entry"})))
    if len(heroes) > 1:
        keep = heroes[-1]
        for index in heroes[:-1]:
            out.append(_finding("MOTION_HERO_MULTIPLE", _label(doc["scenes"][index], index), f"/scenes/{index}/motion/emphasis",
                                f"one hero moment per film; {_label(doc['scenes'][keep], keep)} keeps it",
                                _fix("drop this hero emphasis", {"op": "set", "path": f"/scenes/{index}/motion/emphasis", "value": "none"})))
    elif len(heroes) == 1 and scenes and heroes[0] == scenes[0][1] and len(scenes) >= 3:
        out.append(_finding("MOTION_HERO_EARLY", _label(doc["scenes"][heroes[0]], heroes[0]), f"/scenes/{heroes[0]}/motion/emphasis", "the hero moment is spent in the first scene; build to it"))
    elif not heroes and directed and len(scenes) >= 3:
        out.append(_finding("MOTION_NO_HERO", None, "/scenes", "no scene has emphasis hero; a film builds to one hero moment"))
    for index in elastic[1:]:
        out.append(_finding("MOTION_ELASTIC_REPEAT", _label(doc["scenes"][index], index), f"/scenes/{index}/motion/spring", "elastic is an accent: once per film",
                            _fix("use the pop spring", {"op": "set", "path": f"/scenes/{index}/motion/spring", "value": "pop"})))

    for scene, index in scenes:
        count = sum(len(_words(text)) for text in _readable_text(scene))
        if count == 0:
            continue
        frames = _scene_frames(scene, timeline)
        if frames is None:
            continue
        final = index == last
        tr = transitions.get(index)
        out_frames = tr["frames"] if (not final and tr and tr["type"] not in ("none", "cut")) else 0
        required = max(READING["finalHoldSeconds"] if final else READING["minHoldSeconds"],
                       READING["minHoldSeconds"] + max(0, count - READING["freeWords"]) * READING["perExtraWordSeconds"])
        hold = frames / fps - _settle_seconds(scene, pkg) - out_frames / fps
        if hold + 1e-9 < required:
            value = math.ceil(frames + (required - hold) * fps - 1e-9)
            code = "MOTION_FINAL_HOLD" if final else "MOTION_READING_HOLD"
            what = "the final frame holds" if final else f"{count} words hold"
            out.append(_finding(code, _label(scene, index), f"/scenes/{index}/preferredFrames", f"{what} {_js_fixed(hold)} s after settling; needs {_js_fixed(required)} s",
                                _fix(f"lengthen the scene to {value} frames", {"op": "set", "path": f"/scenes/{index}/preferredFrames", "value": value})))

    # Same order as the TypeScript side: path (code-unit order), then code.
    out.sort(key=lambda f: (f["path"], f["code"]))
    return out


def _pointer(path: str) -> list[str]:
    return [p.replace("~1", "/").replace("~0", "~") for p in path.split("/")[1:]]


def _apply_op(doc, op) -> bool:
    parts = _pointer(op.get("path", ""))
    if not parts:
        return False
    node = doc
    for part in parts[:-1]:
        if isinstance(node, list):
            try:
                node = node[int(part)]
            except (ValueError, IndexError):
                return False
        else:
            if part not in node and op.get("op") == "set":
                node[part] = {}
            node = node.get(part)
        if not isinstance(node, (dict, list)):
            return False
    key = parts[-1]
    if op.get("op") == "delete":
        if isinstance(node, list) or key not in node:
            return False
        del node[key]
        return True
    if op.get("op") == "set":
        # A no-op set is not a change, so autofix_motion() stops instead of re-applying it.
        value = op.get("value")
        if isinstance(node, list):
            index = int(key)
            if index < len(node) and node[index] == value:
                return False
            node[index] = _copy.deepcopy(value)
        else:
            if key in node and node[key] == value:
                return False
            node[key] = _copy.deepcopy(value)
        return True
    return False


def apply_motion_fixes(doc: Any, findings: list[dict[str, Any]] | None = None, severities=("error", "warning")) -> dict[str, Any]:
    """Apply the autofixes of ``findings`` (default: lint ``doc``) to a copy of ``doc``."""
    if findings is None:
        findings = lint_motion(doc)
    document = _copy.deepcopy(doc)
    applied = []
    for item in findings:
        if not item or not item.get("autofix") or item.get("severity") not in severities:
            continue
        changed = False
        for op in item["autofix"].get("ops", []):
            changed = _apply_op(document, op) or changed
        if changed:
            applied.append(item)
    return {"document": document, "applied": applied}


def autofix_motion(doc: Any, max_passes: int = 5, severities=("error", "warning"), fps: int | None = None, timeline: Any = None) -> dict[str, Any]:
    """Lint, fix and re-lint until nothing fixable is left (bounded at ``max_passes``)."""
    document = doc
    applied: list[dict[str, Any]] = []
    passes = 0
    while passes < max_passes:
        fixable = [f for f in lint_motion(document, fps=fps, timeline=timeline) if f["autofix"] and f["severity"] in severities]
        if not fixable:
            break
        result = apply_motion_fixes(document, fixable, severities)
        if not result["applied"]:
            break
        document = result["document"]
        applied.extend(result["applied"])
        passes += 1
    return {"document": document, "applied": applied, "remaining": lint_motion(document, fps=fps, timeline=timeline), "passes": passes}
