"""Save the API-format workflow that was actually submitted (W1).

The runner writes two files next to each generated still, plate and upscale:

* ``<stem>.workflow.api.json`` — the graph handed to Comfy, after secret-shaped
  strings are removed. Seed, prompt, model filenames and parameters stay.
* ``<stem>.workflow.md`` — how to replay that graph, and why there is no
  drag-and-drop UI workflow.

ComfyUI's canvas Load expects UI format (``nodes``, ``links``, and
``widgets_values`` in each node's own widget order). API format records links
as ``[node_id, slot]`` and widget values as named inputs. Widget order and
socket types live in the running install's ``/object_info``, not in the graph.
Guessing them opens a broken canvas, so this module does not write a UI file.
"""

from __future__ import annotations

import json
import re
from pathlib import Path, PurePosixPath
from typing import Any

from .atomic import write_json_atomic, write_text_atomic
from .client import inject_params, load_params_map

REDACTED = "[redacted]"

# Keep this in step with packages/sources/src/secrets.ts. Both gates exist on
# purpose: the runner strips secrets before the file is written, and the export
# / download path strips them again if a file was edited afterwards.
_SECRET_KEY = re.compile(
    r"(?i)(?:^|[_\-.])(?:token|secret|password|passwd|authorization|api[_-]?key|apikey|"
    r"credential|hf[_-]?token|access[_-]?key|private[_-]?key|session[_-]?token)(?:$|[_\-.])"
)
_USERINFO = re.compile(r"(?i)(https?://)[^/\s:@]+:[^/\s@]+@")
_QUERY_SECRET = re.compile(
    r"(?i)((?:api[_-]?key|access[_-]?token|refresh[_-]?token|id_token|token|secret|password|"
    r"client_secret|signature|sig|x-api-key|x-amz-signature|x-amz-credential|x-goog-signature))"
    r"=([^&\s\"']+)"
)
_ASSIGNMENT = re.compile(
    r"(?i)((?:api[_-]?key|hf[_-]?token|access[_-]?token|token|secret|password|authorization))"
    r"\s*[:=]\s*([^\s,;\"']{6,})"
)
_BEARER = re.compile(r"(?i)\bbearer\s+[A-Za-z0-9._\-]{8,}")
_TOKEN_PATTERNS = (
    re.compile(r"hf_[A-Za-z0-9]{16,}"),
    re.compile(r"\bsk-(?:proj-)?[A-Za-z0-9_\-]{16,}"),
    re.compile(r"\bgithub_pat_[A-Za-z0-9_]{16,}"),
    re.compile(r"\bgh[pousr]_[A-Za-z0-9]{16,}"),
    re.compile(r"\bAKIA[0-9A-Z]{16}\b"),
    re.compile(r"\bAIza[0-9A-Za-z_\-]{20,}"),
    re.compile(r"\bya29\.[0-9A-Za-z_\-]{16,}"),
)

_MODEL_FIELDS = ("unet_name", "ckpt_name", "vae_name", "clip_name", "model_name", "lora_name")
_PROMPT_FIELDS = ("text", "prompt", "positive")


def is_secret_key(name: str) -> bool:
    return bool(_SECRET_KEY.search(name))


def redact_text(text: str) -> tuple[str, int]:
    """Replace secret-shaped substrings. Ordinary words such as "token" stay."""
    count = 0

    def swap(pattern: re.Pattern[str], repl: Any, value: str) -> str:
        nonlocal count
        updated, found = pattern.subn(repl, value)
        count += found
        return updated

    text = swap(_USERINFO, r"\1" + REDACTED + "@", text)
    text = swap(_QUERY_SECRET, lambda match: f"{match.group(1)}={REDACTED}", text)
    text = swap(_ASSIGNMENT, lambda match: f"{match.group(1)}={REDACTED}", text)
    text = swap(_BEARER, f"Bearer {REDACTED}", text)
    for pattern in _TOKEN_PATTERNS:
        text = swap(pattern, REDACTED, text)
    return text, count


def redact_workflow(value: Any, key: str | None = None) -> tuple[Any, int]:
    """Copy ``value`` with secrets removed. Links, seeds and model names stay."""
    if isinstance(value, dict):
        cleaned: dict[str, Any] = {}
        count = 0
        for child_key, child in value.items():
            name = str(child_key)
            if isinstance(child, str) and is_secret_key(name):
                cleaned[name] = REDACTED
                count += 1
                continue
            next_value, found = redact_workflow(child, name)
            cleaned[name] = next_value
            count += found
        return cleaned, count
    if isinstance(value, list):
        cleaned_list = []
        count = 0
        for item in value:
            next_value, found = redact_workflow(item, None)
            cleaned_list.append(next_value)
            count += found
        return cleaned_list, count
    if isinstance(value, str):
        return redact_text(value)
    return value, 0


def should_capture(job: dict[str, Any]) -> bool:
    """Stills, plates and the ×2 upscale. Narration audio is not a Comfy graph we ship."""
    if job.get("kind") in {"still", "plate", "upscale"}:
        return True
    return job.get("outputKind") in {"image", "video"}


def sidecar_paths(output_rel: str) -> tuple[str, str]:
    """``assets/a.png`` → ``assets/a.workflow.api.json`` and ``assets/a.workflow.md``."""
    raw = str(output_rel).replace("\\", "/").lstrip("/")
    path = PurePosixPath(raw)
    if path.is_absolute() or not path.name or not path.suffix or ".." in path.parts:
        raise ValueError(f"refusing to place a workflow next to {output_rel!r}")
    api = path.with_name(f"{path.stem}.workflow.api.json")
    readme = path.with_name(f"{path.stem}.workflow.md")
    return api.as_posix(), readme.as_posix()


def _contained(root: Path, relative: str) -> Path:
    base = root.resolve()
    dest = (base / relative).resolve()
    if dest != base and base not in dest.parents:
        raise ValueError(f"workflow path escapes the output directory: {relative}")
    return dest


def summarize_graph(graph: dict[str, Any]) -> dict[str, list[Any]]:
    seeds: list[int] = []
    prompts: list[str] = []
    models: list[str] = []
    for node in graph.values():
        if not isinstance(node, dict):
            continue
        inputs = node.get("inputs")
        if not isinstance(inputs, dict):
            continue
        seed = inputs.get("seed")
        if isinstance(seed, int) and not isinstance(seed, bool) and seed not in seeds:
            seeds.append(seed)
        for field in _PROMPT_FIELDS:
            value = inputs.get(field)
            if isinstance(value, str):
                prompts.append(value)
        for field in _MODEL_FIELDS:
            value = inputs.get(field)
            if isinstance(value, str) and value not in models:
                models.append(value)
    return {"seeds": seeds, "prompts": prompts[:4], "models": models}


def render_readme(meta: dict[str, Any], graph: dict[str, Any], *, redactions: int, rebuilt: bool) -> str:
    summary = summarize_graph(graph)
    asset = meta.get("asset") or "this asset"
    lines = [
        f"# Open {asset} in ComfyUI",
        "",
        "This file describes the API-format workflow Comfyrizz submitted for this still or plate.",
        "The sibling `.workflow.api.json` is that graph: seed, prompt, model filenames and parameters.",
        "Secret-shaped strings (tokens, API keys, signed URLs) are removed before either file is written.",
        "No Hugging Face token and no Google Colab token is stored here.",
        "",
        "## Drag-and-drop",
        "",
        "ComfyUI's canvas Load button and drag-and-drop expect the UI workflow format",
        "(`nodes`, `links`, and each node's `widgets_values` in that node's widget order).",
        "The submitted graph is API format. API format does not record widget order or socket types;",
        "those come from the running ComfyUI install (`/object_info`).",
        "A conversion that guesses the order opens as a broken graph, so Comfyrizz does not write a UI-format workflow.",
        "Use the API file below. It is the graph that was submitted.",
        "",
        "## Replay it",
        "",
        "On a ComfyUI that has the same models:",
        "",
        "```bash",
        "curl -sS http://127.0.0.1:8188/prompt \\",
        "  -H 'content-type: application/json' \\",
        "  --data-binary @- <<EOF",
        '{"prompt": <contents of the sibling .workflow.api.json>}',
        "EOF",
        "```",
        "",
        "The same JSON is the `workflow` body of a Comfy API v2 job (`POST /api/v2/jobs`),",
        "which is the call Comfyrizz makes.",
        "",
        "## What was submitted",
        "",
    ]
    if meta.get("job"):
        lines.append(f"- Job: `{meta['job']}`")
    if meta.get("kind"):
        lines.append(f"- Kind: `{meta['kind']}`")
    if meta.get("generator"):
        lines.append(f"- Generator: `{meta['generator']}`")
    if meta.get("model"):
        lines.append(f"- Model: `{meta['model']}`")
    if meta.get("template"):
        lines.append(f"- Template: `{meta['template']}`")
    if summary["seeds"]:
        lines.append("- Seed: " + ", ".join(str(seed) for seed in summary["seeds"]))
    if summary["models"]:
        lines.append("- Model files: " + ", ".join(f"`{name}`" for name in summary["models"]))
    for prompt in summary["prompts"]:
        shown = prompt if len(prompt) <= 400 else prompt[:400] + "…"
        lines.append(f"- Prompt: {shown}")
    if redactions:
        lines.append("")
        lines.append(
            f"{redactions} secret-shaped value(s) were replaced with `{REDACTED}` so this file can be shared."
        )
    if rebuilt:
        lines.append("")
        lines.append(
            "This copy was rebuilt from the job plan because the original submission was not on disk. "
            "Uploaded input filenames come from the upload cache when that cache is present."
        )
    lines.append("")
    return "\n".join(lines)


def materialize_submitted_graph(
    workflow_path: Path,
    params: dict[str, Any],
    params_source: str | None = None,
) -> dict[str, Any]:
    """Inject planned parameters into the API template. This is the graph a submit would send."""
    graph = json.loads(Path(workflow_path).read_text(encoding="utf-8"))
    if not isinstance(graph, dict):
        raise ValueError(f"{workflow_path} is not an API-format workflow object")
    mapping = load_params_map(Path(workflow_path), params_source)
    return inject_params(graph, mapping, dict(params))


def save_captured_workflow(
    out_dir: Path,
    output_rel: str,
    graph: dict[str, Any],
    *,
    meta: dict[str, Any] | None = None,
    rebuilt: bool = False,
) -> dict[str, Any]:
    """Write the redacted API graph and the open instructions next to ``output_rel``."""
    if not isinstance(graph, dict):
        raise ValueError("captured workflow must be a JSON object")
    api_rel, readme_rel = sidecar_paths(output_rel)
    cleaned, redactions = redact_workflow(graph)
    api_path = _contained(Path(out_dir), api_rel)
    readme_path = _contained(Path(out_dir), readme_rel)
    write_json_atomic(api_path, cleaned)
    readme = render_readme(meta or {}, cleaned, redactions=redactions, rebuilt=rebuilt)
    # one more pass: the readme quotes the prompt, which is already redacted,
    # and this catches anything a future summary field might interpolate
    readme, extra = redact_text(readme)
    if extra:
        redactions += extra
    write_text_atomic(readme_path, readme if readme.endswith("\n") else readme + "\n")
    return {"api": api_rel, "readme": readme_rel, "redactions": redactions, "rebuilt": rebuilt}
