"""Character LoRA training worker for a Google Colab GPU runtime.

The dataset manifest is built by ``apps/server/src/characters/lora-dataset.mjs``
and uploaded with the character's images. ``--dry-run`` validates that manifest
and the image bytes on CPU without importing torch or allocating a runtime.
A real run requires an explicit per-run spend approval and a units ceiling, and
writes a ``.safetensors`` file whose SHA-256 is reported in ``run.json``.

Only the manifest, image bytes and this script are read. No token, environment
value or user-visible text is logged; event and error messages are redacted.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import re
import sys
import time
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import Any, Callable, Iterable, Mapping

SCHEMA = "comfyrizz.character-lora-dataset/v1"
SCHEMA_ALIASES = frozenset({SCHEMA, "comfyrizz.lora-dataset/v1"})
RUN_SCHEMA = "comfyrizz.character-lora-run/v1"

MIN_IMAGES = 8
MAX_IMAGES = 128
MAX_CAPTION_CHARS = 400
MAX_NAME_CHARS = 80
MAX_IMAGE_BYTES = 20 * 1024 * 1024
ALLOWED_EXTENSIONS = frozenset({".png", ".jpg", ".jpeg", ".webp"})
SUPPORTED_KINDS = frozenset({"fictional", "real_authorized"})
MAX_UNITS = 4.0
LORA_TARGET_MODULES = ("to_q", "to_k", "to_v", "to_out.0")
SAFETENSORS_MAX_HEADER = 64 * 1024 * 1024

EXIT_OK = 0
EXIT_RUNTIME = 1
EXIT_INVALID = 2
EXIT_SPEND = 3

REDACTED = "[redacted]"

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

_CHARACTER_ID = re.compile(r"^chr_[0-9a-f]{16}$")
_TRIGGER = re.compile(r"^[a-z][a-z0-9_]{2,39}$")
_HEX64 = re.compile(r"^[0-9a-f]{64}$")


class LoraTrainError(Exception):
    """A bounded failure with a machine-readable code."""

    def __init__(self, code: str, message: str, *, exit_code: int = EXIT_RUNTIME) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.exit_code = exit_code


@dataclass(frozen=True)
class DatasetImage:
    file: str
    path: Path
    caption: str
    sha256: str
    bytes: int


@dataclass(frozen=True)
class Dataset:
    schema: str
    character_id: str
    revision: int
    name: str
    kind: str
    trigger: str | None
    images: tuple[DatasetImage, ...]
    dataset_sha256: str
    declared_manifest_hash: str | None


@dataclass(frozen=True)
class RunOptions:
    dry_run: bool = False
    approve_spend: bool = False
    units_ceiling: float | None = None
    base_model: str | None = None
    steps: int = 800
    rank: int = 16
    learning_rate: float = 5e-5
    resolution: int = 512
    seed: int = 42

    @property
    def output_name(self) -> str:
        return "character_lora.safetensors"


@dataclass(frozen=True)
class TrainingPlan:
    dataset: Dataset
    out_dir: Path
    output_path: Path
    base_model: str
    steps: int
    rank: int
    learning_rate: float
    resolution: int
    seed: int
    units_ceiling: float


Trainer = Callable[[TrainingPlan, Callable[[dict[str, Any]], None]], Path]
Clock = Callable[[], float]


def redact_text(text: str) -> tuple[str, int]:
    """Replace secret-shaped substrings; ordinary words such as ``token`` stay."""
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


def _redact_value(value: Any) -> Any:
    if isinstance(value, str):
        return redact_text(value)[0]
    if isinstance(value, Mapping):
        return {str(key): _redact_value(child) for key, child in value.items()}
    if isinstance(value, (list, tuple)):
        return [_redact_value(child) for child in value]
    return value


def _emit(callback: Callable[[dict[str, Any]], None], event: Mapping[str, Any]) -> None:
    callback(_redact_value(dict(event)))


def _atomic_write(path: Path, data: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.tmp-{os.getpid()}")
    descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    try:
        with os.fdopen(descriptor, "wb") as handle:
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    except BaseException:
        try:
            temporary.unlink()
        except FileNotFoundError:
            pass
        raise


def _write_json(path: Path, payload: Mapping[str, Any]) -> None:
    text = json.dumps(_redact_value(dict(payload)), indent=2, sort_keys=True, ensure_ascii=False) + "\n"
    _atomic_write(path, text.encode("utf-8"))


def _sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _directory(root: Path) -> Path:
    root.mkdir(parents=True, exist_ok=True)
    return root.resolve()


def _safe_image_path(root: Path, relative: Any, index: int) -> Path:
    if not isinstance(relative, str) or not relative.strip():
        raise LoraTrainError("MANIFEST_INVALID", f"images[{index}].file must be a non-empty string", exit_code=EXIT_INVALID)
    if "\\" in relative or relative.startswith("/"):
        raise LoraTrainError("MANIFEST_INVALID", f"images[{index}].file must be a relative POSIX path", exit_code=EXIT_INVALID)
    parts = PurePosixPath(relative)
    if any(part in ("", ".", "..") for part in parts.parts):
        raise LoraTrainError("MANIFEST_INVALID", f"images[{index}].file must not contain empty, '.' or '..' segments", exit_code=EXIT_INVALID)
    if parts.suffix.lower() not in ALLOWED_EXTENSIONS:
        raise LoraTrainError("MANIFEST_INVALID", f"images[{index}].file has an unsupported extension", exit_code=EXIT_INVALID)
    target = (root / Path(*parts.parts)).resolve()
    try:
        target.relative_to(root)
    except ValueError as exc:
        raise LoraTrainError("MANIFEST_INVALID", f"images[{index}].file escapes the dataset directory", exit_code=EXIT_INVALID) from exc
    return target


def _text_value(value: Any, path: str, *, maximum: int) -> str:
    if not isinstance(value, str):
        raise LoraTrainError("MANIFEST_INVALID", f"{path} must be a string", exit_code=EXIT_INVALID)
    text = value.strip()
    if not text:
        raise LoraTrainError("MANIFEST_INVALID", f"{path} must not be empty", exit_code=EXIT_INVALID)
    if len(text) > maximum:
        raise LoraTrainError("MANIFEST_INVALID", f"{path} is longer than {maximum} characters", exit_code=EXIT_INVALID)
    return text


def _character_fields(manifest: Mapping[str, Any]) -> Mapping[str, Any]:
    nested = manifest.get("character")
    if nested is None:
        merged: dict[str, Any] = dict(manifest)
    else:
        if not isinstance(nested, Mapping):
            raise LoraTrainError("MANIFEST_INVALID", "character must be an object", exit_code=EXIT_INVALID)
        merged = dict(nested)
        for key in ("characterId", "revision", "name", "kind", "consent", "trigger"):
            if key in manifest and key not in merged:
                merged[key] = manifest[key]
    if "characterId" not in merged and "id" in merged:
        merged["characterId"] = merged["id"]
    if "trigger" not in merged and "triggerWord" in merged:
        merged["trigger"] = merged["triggerWord"]
    return merged


def _check_consent(character: Mapping[str, Any]) -> None:
    consent = character.get("consent")
    if not isinstance(consent, Mapping):
        raise LoraTrainError("CHAR_CONSENT_REQUIRED", "real_authorized requires a consent record", exit_code=EXIT_INVALID)
    for key in ("assertedBy", "assertedAt", "scope"):
        if not isinstance(consent.get(key), (str, list)) or not consent.get(key):
            raise LoraTrainError("CHAR_CONSENT_REQUIRED", f"consent.{key} is required", exit_code=EXIT_INVALID)
    if consent.get("likenessWarningShown") is not True:
        raise LoraTrainError("CHAR_CONSENT_REQUIRED", "consent.likenessWarningShown must be true", exit_code=EXIT_INVALID)


def load_dataset(manifest_path: Path, *, min_images: int = MIN_IMAGES) -> Dataset:
    """Validate a dataset manifest and hash every image's bytes."""
    manifest_path = Path(manifest_path)
    try:
        raw = manifest_path.read_bytes()
    except OSError as exc:
        raise LoraTrainError("MANIFEST_INVALID", f"cannot read manifest: {exc.strerror or 'read failed'}", exit_code=EXIT_INVALID) from exc
    try:
        manifest = json.loads(raw)
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise LoraTrainError("MANIFEST_INVALID", "manifest is not valid JSON", exit_code=EXIT_INVALID) from exc
    if not isinstance(manifest, Mapping):
        raise LoraTrainError("MANIFEST_INVALID", "manifest must be an object", exit_code=EXIT_INVALID)

    schema = manifest.get("schema")
    if schema not in SCHEMA_ALIASES:
        raise LoraTrainError("MANIFEST_INVALID", "unsupported dataset schema", exit_code=EXIT_INVALID)

    character = _character_fields(manifest)
    character_id = character.get("characterId")
    if not isinstance(character_id, str) or not _CHARACTER_ID.match(character_id):
        raise LoraTrainError("MANIFEST_INVALID", "characterId must match chr_<16 hex>", exit_code=EXIT_INVALID)
    revision = character.get("revision")
    if isinstance(revision, bool) or not isinstance(revision, int) or revision < 1:
        raise LoraTrainError("MANIFEST_INVALID", "revision must be a positive integer", exit_code=EXIT_INVALID)
    name = _text_value(character.get("name"), "name", maximum=MAX_NAME_CHARS)
    kind = character.get("kind")
    if kind not in SUPPORTED_KINDS:
        raise LoraTrainError("CHAR_KIND_UNSUPPORTED", "only fictional or consented real_authorized characters can be trained", exit_code=EXIT_INVALID)
    if kind == "real_authorized":
        _check_consent(character)

    trigger = character.get("trigger")
    if trigger is not None:
        if not isinstance(trigger, str) or not _TRIGGER.match(trigger):
            raise LoraTrainError("MANIFEST_INVALID", "trigger must match ^[a-z][a-z0-9_]{2,39}$", exit_code=EXIT_INVALID)

    entries = manifest.get("images")
    if not isinstance(entries, list):
        raise LoraTrainError("MANIFEST_INVALID", "images must be an array", exit_code=EXIT_INVALID)
    if len(entries) < min_images:
        raise LoraTrainError("LORA_TOO_FEW_IMAGES", f"at least {min_images} images are required; found {len(entries)}", exit_code=EXIT_INVALID)
    if len(entries) > MAX_IMAGES:
        raise LoraTrainError("MANIFEST_INVALID", f"at most {MAX_IMAGES} images are supported", exit_code=EXIT_INVALID)

    root = _directory(manifest_path.parent)
    images: list[DatasetImage] = []
    seen: set[str] = set()
    for index, entry in enumerate(entries):
        if not isinstance(entry, Mapping):
            raise LoraTrainError("MANIFEST_INVALID", f"images[{index}] must be an object", exit_code=EXIT_INVALID)
        relative = entry.get("file", entry.get("path"))
        target = _safe_image_path(root, relative, index)
        canonical = target.relative_to(root).as_posix()
        if canonical in seen:
            raise LoraTrainError("MANIFEST_INVALID", f"images[{index}].file is duplicated", exit_code=EXIT_INVALID)
        seen.add(canonical)
        if target.is_symlink():
            raise LoraTrainError("MANIFEST_INVALID", f"images[{index}].file must not be a symlink", exit_code=EXIT_INVALID)
        if not target.is_file():
            raise LoraTrainError("MANIFEST_INVALID", f"images[{index}].file is missing", exit_code=EXIT_INVALID)
        size = target.stat().st_size
        if size == 0:
            raise LoraTrainError("MANIFEST_INVALID", f"images[{index}].file is empty", exit_code=EXIT_INVALID)
        if size > MAX_IMAGE_BYTES:
            raise LoraTrainError("MANIFEST_INVALID", f"images[{index}].file exceeds {MAX_IMAGE_BYTES} bytes", exit_code=EXIT_INVALID)
        data = target.read_bytes()
        digest = _sha256_bytes(data)
        declared = entry.get("sha256")
        if declared is not None:
            if not isinstance(declared, str) or not _HEX64.match(declared.lower()):
                raise LoraTrainError("MANIFEST_INVALID", f"images[{index}].sha256 must be 64 hex characters", exit_code=EXIT_INVALID)
            if declared.lower() != digest:
                raise LoraTrainError("MANIFEST_INVALID", f"images[{index}].sha256 does not match the image bytes", exit_code=EXIT_INVALID)
        caption = _text_value(entry.get("caption"), f"images[{index}].caption", maximum=MAX_CAPTION_CHARS)
        images.append(DatasetImage(file=canonical, path=target, caption=caption, sha256=digest, bytes=size))

    declared_hash = manifest.get("manifestHash", manifest.get("hash"))
    if declared_hash is not None and (not isinstance(declared_hash, str) or not _HEX64.match(declared_hash.lower())):
        raise LoraTrainError("MANIFEST_INVALID", "manifestHash must be 64 hex characters", exit_code=EXIT_INVALID)

    canonical_payload = {
        "characterId": character_id,
        "revision": revision,
        "kind": kind,
        "trigger": trigger,
        "images": [{"file": image.file, "sha256": image.sha256, "caption": image.caption} for image in images],
    }
    encoded = json.dumps(canonical_payload, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    dataset_sha256 = _sha256_bytes(encoded)
    declared_dataset_hash = manifest.get("datasetSha256")
    if declared_dataset_hash is not None:
        if not isinstance(declared_dataset_hash, str) or not _HEX64.match(declared_dataset_hash.lower()):
            raise LoraTrainError("MANIFEST_INVALID", "datasetSha256 must be 64 hex characters", exit_code=EXIT_INVALID)
        if declared_dataset_hash.lower() != dataset_sha256:
            raise LoraTrainError("MANIFEST_INVALID", "datasetSha256 does not match the manifest contents", exit_code=EXIT_INVALID)
    return Dataset(
        schema=str(schema),
        character_id=character_id,
        revision=revision,
        name=name,
        kind=kind,
        trigger=trigger,
        images=tuple(images),
        dataset_sha256=dataset_sha256,
        declared_manifest_hash=declared_hash.lower() if isinstance(declared_hash, str) else None,
    )


def _finite_number(value: Any, path: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        raise LoraTrainError("PLAN_INVALID", f"{path} must be a finite number", exit_code=EXIT_INVALID)
    return float(value)


def build_plan(dataset: Dataset, out_dir: Path, options: RunOptions) -> TrainingPlan:
    steps = options.steps
    if isinstance(steps, bool) or not isinstance(steps, int) or not 1 <= steps <= 10_000:
        raise LoraTrainError("PLAN_INVALID", "steps must be an integer in 1..10000", exit_code=EXIT_INVALID)
    rank = options.rank
    if isinstance(rank, bool) or not isinstance(rank, int) or not 1 <= rank <= 128:
        raise LoraTrainError("PLAN_INVALID", "rank must be an integer in 1..128", exit_code=EXIT_INVALID)
    learning_rate = _finite_number(options.learning_rate, "learning_rate")
    if not 0 < learning_rate <= 1e-2:
        raise LoraTrainError("PLAN_INVALID", "learning_rate must be in (0, 0.01]", exit_code=EXIT_INVALID)
    resolution = options.resolution
    if isinstance(resolution, bool) or not isinstance(resolution, int) or not 256 <= resolution <= 1024 or resolution % 64:
        raise LoraTrainError("PLAN_INVALID", "resolution must be a multiple of 64 in 256..1024", exit_code=EXIT_INVALID)
    seed = options.seed
    if isinstance(seed, bool) or not isinstance(seed, int) or not 0 <= seed <= 2**32 - 1:
        raise LoraTrainError("PLAN_INVALID", "seed must be an integer in 0..2^32-1", exit_code=EXIT_INVALID)

    base_model = options.base_model
    if not options.dry_run:
        if options.approve_spend is not True:
            raise LoraTrainError("SPEND_NOT_APPROVED", "this run needs an explicit --approve-spend", exit_code=EXIT_SPEND)
        if options.units_ceiling is None:
            raise LoraTrainError("SPEND_NOT_APPROVED", "a per-run units ceiling is required", exit_code=EXIT_SPEND)
        ceiling = _finite_number(options.units_ceiling, "units_ceiling")
        if ceiling <= 0 or ceiling > MAX_UNITS:
            raise LoraTrainError("SPEND_NOT_APPROVED", f"units ceiling must be in (0, {MAX_UNITS}]", exit_code=EXIT_SPEND)
        if not isinstance(base_model, str) or not base_model.strip():
            raise LoraTrainError("PLAN_INVALID", "base_model is required for a real run", exit_code=EXIT_INVALID)
    else:
        ceiling = None

    out = _directory(Path(out_dir))
    output_path = (out / options.output_name).resolve()
    try:
        output_path.relative_to(out)
    except ValueError as exc:
        raise LoraTrainError("PLAN_INVALID", "output path escapes the output directory", exit_code=EXIT_INVALID) from exc
    return TrainingPlan(
        dataset=dataset,
        out_dir=out,
        output_path=output_path,
        base_model=(base_model or "").strip(),
        steps=steps,
        rank=rank,
        learning_rate=learning_rate,
        resolution=resolution,
        seed=seed,
        units_ceiling=ceiling if ceiling is not None else 0.0,
    )


def safetensors_info(path: Path) -> tuple[dict[str, Any], int, int]:
    """Validate a safetensors file and return ``(header, tensor count, data bytes)``."""
    path = Path(path)
    try:
        data = path.read_bytes()
    except OSError as exc:
        raise LoraTrainError("OUTPUT_INVALID", f"cannot read the trained LoRA: {exc.strerror or 'read failed'}") from exc
    if len(data) < 9:
        raise LoraTrainError("OUTPUT_INVALID", "the trained LoRA is too small to be safetensors")
    header_length = int.from_bytes(data[:8], "little")
    if header_length <= 1 or header_length > SAFETENSORS_MAX_HEADER or 8 + header_length > len(data):
        raise LoraTrainError("OUTPUT_INVALID", "the trained LoRA has an invalid safetensors header")
    try:
        header = json.loads(data[8 : 8 + header_length])
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise LoraTrainError("OUTPUT_INVALID", "the trained LoRA header is not JSON") from exc
    if not isinstance(header, Mapping):
        raise LoraTrainError("OUTPUT_INVALID", "the trained LoRA header is not an object")
    payload = data[8 + header_length :]
    ranges: list[tuple[int, int]] = []
    tensors = 0
    for name, entry in header.items():
        if name == "__metadata__":
            continue
        if not isinstance(entry, Mapping):
            raise LoraTrainError("OUTPUT_INVALID", "a safetensors tensor entry is malformed")
        offsets = entry.get("data_offsets")
        if not isinstance(offsets, list) or len(offsets) != 2:
            raise LoraTrainError("OUTPUT_INVALID", "a safetensors tensor has no data offsets")
        start, end = offsets
        if isinstance(start, bool) or isinstance(end, bool) or not isinstance(start, int) or not isinstance(end, int) or start < 0 or end < start or end > len(payload):
            raise LoraTrainError("OUTPUT_INVALID", "a safetensors tensor offset is out of range")
        ranges.append((start, end))
        tensors += 1
    if tensors == 0:
        raise LoraTrainError("OUTPUT_INVALID", "the trained LoRA contains no tensors")
    ranges.sort()
    for previous, current in zip(ranges, ranges[1:]):
        if previous[1] > current[0]:
            raise LoraTrainError("OUTPUT_INVALID", "safetensors tensor ranges overlap")
    if ranges[-1][1] != len(payload):
        raise LoraTrainError("OUTPUT_INVALID", "the trained LoRA has trailing bytes")
    return dict(header), tensors, len(payload)


def _pack_latents(latents: Any) -> Any:
    import torch

    batch, channels, height, width = latents.shape
    packed = latents.view(batch, channels, height // 2, 2, width // 2, 2)
    packed = packed.permute(0, 2, 4, 1, 3, 5)
    return packed.reshape(batch, (height // 2) * (width // 2), channels * 4)


def _latent_ids(height: int, width: int, device: str) -> Any:
    import torch

    ids = torch.zeros((height // 2, width // 2, 3), device=device)
    ids[..., 1] = torch.arange(height // 2, device=device)[:, None]
    ids[..., 2] = torch.arange(width // 2, device=device)[None, :]
    return ids.reshape(-1, 3)


def default_trainer(plan: TrainingPlan, on_event: Callable[[dict[str, Any]], None]) -> Path:
    """Train a Flux-compatible LoRA with diffusers and peft on the allocated GPU."""
    try:
        import numpy as np
        import torch
        import torch.nn.functional as functional
        from diffusers import FluxPipeline
        from diffusers.utils import convert_state_dict_to_diffusers
        from peft import LoraConfig, get_peft_model
        from peft.utils import get_peft_model_state_dict
        from PIL import Image
    except Exception as exc:
        raise LoraTrainError("TRAINER_UNAVAILABLE", f"training dependencies are missing: {exc}") from exc
    if not torch.cuda.is_available():
        raise LoraTrainError("TRAINER_UNAVAILABLE", "a CUDA GPU is required for a real run")

    torch.manual_seed(plan.seed)
    device = "cuda"
    dtype = torch.bfloat16
    pipe = FluxPipeline.from_pretrained(plan.base_model, torch_dtype=dtype)
    pipe.to(device)
    pipe.vae.requires_grad_(False)
    pipe.text_encoder.requires_grad_(False)
    pipe.text_encoder_2.requires_grad_(False)
    pipe.transformer.requires_grad_(False)
    lora_config = LoraConfig(
        r=plan.rank,
        lora_alpha=plan.rank,
        init_lora_weights="gaussian",
        target_modules=list(LORA_TARGET_MODULES),
    )
    transformer = get_peft_model(pipe.transformer, lora_config)
    transformer.train()
    trainable = [parameter for parameter in transformer.parameters() if parameter.requires_grad]
    optimizer = torch.optim.AdamW(trainable, lr=plan.learning_rate, betas=(0.9, 0.999), weight_decay=0.0)
    shift = float(getattr(pipe.vae.config, "shift_factor", 0.0) or 0.0)
    scale = float(pipe.vae.config.scaling_factor)
    _emit(on_event, {"event": "lora_training_started", "steps": plan.steps, "images": len(plan.dataset.images)})

    loss_value = float("nan")
    for step in range(1, plan.steps + 1):
        image = plan.dataset.images[(step - 1) % len(plan.dataset.images)]
        with Image.open(image.path) as source:
            picture = source.convert("RGB")
            width, height = picture.size
            side = min(width, height)
            left = (width - side) // 2
            top = (height - side) // 2
            picture = picture.crop((left, top, left + side, top + side)).resize((plan.resolution, plan.resolution), Image.LANCZOS)
            array = np.asarray(picture)
        pixel = torch.from_numpy(array).permute(2, 0, 1).float().unsqueeze(0) / 127.5 - 1.0
        pixel = pixel.to(device=device, dtype=dtype)
        with torch.no_grad():
            latents = pipe.vae.encode(pixel).latent_dist.sample()
            latents = (latents - shift) * scale
            latent_height, latent_width = latents.shape[-2:]
            packed = _pack_latents(latents)
            image_ids = _latent_ids(latent_height, latent_width, device)
            prompt_embeds, pooled, text_ids = pipe.encode_prompt(
                prompt=image.caption,
                prompt_2=None,
                device=device,
                num_images_per_prompt=1,
                max_sequence_length=512,
            )
        noise = torch.randn_like(packed)
        timestep = torch.rand((1,), device=device, dtype=torch.float32)
        noisy = ((1.0 - timestep) * packed + timestep * noise).to(dtype)
        target = (noise - packed).float()
        guidance = torch.ones((1,), device=device, dtype=dtype)
        prediction = transformer(
            hidden_states=noisy,
            timestep=timestep,
            guidance=guidance,
            pooled_projections=pooled,
            encoder_hidden_states=prompt_embeds,
            txt_ids=text_ids,
            img_ids=image_ids,
            return_dict=False,
        )[0]
        loss = functional.mse_loss(prediction.float(), target)
        optimizer.zero_grad(set_to_none=True)
        loss.backward()
        torch.nn.utils.clip_grad_norm_(trainable, 1.0)
        optimizer.step()
        loss_value = float(loss.detach().item())
        if step == plan.steps or step % max(1, plan.steps // 10) == 0:
            _emit(on_event, {"event": "lora_step", "step": step, "loss": round(loss_value, 6)})

    state = convert_state_dict_to_diffusers(get_peft_model_state_dict(transformer))
    plan.output_path.parent.mkdir(parents=True, exist_ok=True)
    FluxPipeline.save_lora_weights(
        save_directory=str(plan.output_path.parent),
        transformer_lora_layers=state,
        weight_name=plan.output_path.name,
    )
    if not plan.output_path.is_file():
        raise LoraTrainError("OUTPUT_INVALID", "the trainer did not write the expected safetensors file")
    _emit(on_event, {"event": "lora_training_finished", "steps": plan.steps})
    return plan.output_path


def _iso(clock: Clock) -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(clock()))


def _base_report(plan: TrainingPlan, clock: Clock) -> dict[str, Any]:
    return {
        "schema": RUN_SCHEMA,
        "ok": True,
        "character": {
            "id": plan.dataset.character_id,
            "revision": plan.dataset.revision,
            "name": plan.dataset.name,
            "kind": plan.dataset.kind,
        },
        "dataset": {
            "schema": plan.dataset.schema,
            "images": len(plan.dataset.images),
            "datasetSha256": plan.dataset.dataset_sha256,
            "declaredManifestHash": plan.dataset.declared_manifest_hash,
        },
        "plan": {
            "baseModel": plan.base_model or None,
            "steps": plan.steps,
            "rank": plan.rank,
            "learningRate": plan.learning_rate,
            "resolution": plan.resolution,
            "seed": plan.seed,
        },
        "spend": {"approved": bool(plan.units_ceiling), "unitsCeiling": plan.units_ceiling or None},
        "createdAt": _iso(clock),
    }


def run_training(
    manifest_path: Path,
    out_dir: Path,
    options: RunOptions,
    *,
    trainer: Trainer | None = None,
    clock: Clock = time.time,
    on_event: Callable[[dict[str, Any]], None] | None = None,
) -> dict[str, Any]:
    emit = on_event if on_event is not None else (lambda event: print(json.dumps(event, sort_keys=True), flush=True))
    dataset = load_dataset(Path(manifest_path))
    plan = build_plan(dataset, Path(out_dir), options)
    report = _base_report(plan, clock)
    report["dryRun"] = options.dry_run
    if options.dry_run:
        _emit(emit, {
            "event": "lora_dry_run",
            "characterId": dataset.character_id,
            "revision": dataset.revision,
            "images": len(dataset.images),
            "datasetSha256": dataset.dataset_sha256,
        })
        report = _redact_value(report)
        _write_json(plan.out_dir / "dry-run.json", report)
        return report

    if not options.approve_spend or options.units_ceiling is None:
        raise LoraTrainError("SPEND_NOT_APPROVED", "this run needs an explicit --approve-spend", exit_code=EXIT_SPEND)
    report["spend"] = {
        "approved": True,
        "unitsCeiling": plan.units_ceiling,
        "approvedAt": _iso(clock),
    }
    _emit(emit, {"event": "lora_plan", "steps": plan.steps, "images": len(dataset.images), "unitsCeiling": plan.units_ceiling})

    if plan.output_path.exists() or plan.output_path.is_symlink():
        if plan.output_path.is_symlink() or not plan.output_path.is_file():
            raise LoraTrainError("OUTPUT_INVALID", "the LoRA output path is not a regular file")
        plan.output_path.unlink()

    active = trainer or default_trainer
    try:
        active(plan, emit)
    except LoraTrainError as exc:
        failure = dict(report, ok=False, error={"code": exc.code, "message": redact_text(exc.message)[0]}, finishedAt=_iso(clock))
        _write_json(plan.out_dir / "run.json", failure)
        raise
    except Exception as exc:
        message = redact_text(str(exc) or exc.__class__.__name__)[0]
        failure = dict(report, ok=False, error={"code": "TRAINING_FAILED", "message": message}, finishedAt=_iso(clock))
        _write_json(plan.out_dir / "run.json", failure)
        raise LoraTrainError("TRAINING_FAILED", message) from exc

    try:
        output = plan.output_path.resolve()
        try:
            output.relative_to(plan.out_dir)
        except ValueError as exc:
            raise LoraTrainError("OUTPUT_INVALID", "the trainer wrote outside the expected output path") from exc
        if output != plan.output_path:
            raise LoraTrainError("OUTPUT_INVALID", "the trainer wrote outside the expected output path")
        header, tensors, payload_bytes = safetensors_info(output)
        digest = _sha256_bytes(output.read_bytes())
    except LoraTrainError as exc:
        failure = dict(report, ok=False, error={"code": exc.code, "message": redact_text(exc.message)[0]}, finishedAt=_iso(clock))
        _write_json(plan.out_dir / "run.json", failure)
        raise

    metadata = header.get("__metadata__")
    report["lora"] = {
        "path": output.name,
        "sha256": digest,
        "bytes": output.stat().st_size,
        "tensors": tensors,
        "dataBytes": payload_bytes,
        "format": "safetensors",
        "metadataKeys": sorted(str(key) for key in metadata) if isinstance(metadata, Mapping) else [],
    }
    report["finishedAt"] = _iso(clock)
    report = _redact_value(report)
    _write_json(plan.out_dir / "run.json", report)
    _emit(emit, {"event": "lora_finished", "path": output.name, "sha256": digest, "bytes": report["lora"]["bytes"]})
    return report


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Train a character LoRA from a validated dataset manifest.")
    parser.add_argument("--manifest", required=True, help="path to the character LoRA dataset manifest")
    parser.add_argument("--out", required=True, help="output directory for run.json and the safetensors file")
    parser.add_argument("--dry-run", action="store_true", help="validate the manifest and images without a GPU")
    parser.add_argument("--approve-spend", action="store_true", help="approve this run's Colab spend")
    parser.add_argument("--units-ceiling", type=float, default=None, help=f"maximum Colab units for this run (<= {MAX_UNITS})")
    parser.add_argument("--base-model", default=None, help="pinned base model repository for a real run")
    parser.add_argument("--steps", type=int, default=800)
    parser.add_argument("--rank", type=int, default=16)
    parser.add_argument("--learning-rate", type=float, default=5e-5)
    parser.add_argument("--resolution", type=int, default=512)
    parser.add_argument("--seed", type=int, default=42)
    return parser


def main(argv: Iterable[str] | None = None) -> int:
    arguments = _parser().parse_args(list(argv) if argv is not None else None)
    options = RunOptions(
        dry_run=arguments.dry_run,
        approve_spend=arguments.approve_spend,
        units_ceiling=arguments.units_ceiling,
        base_model=arguments.base_model,
        steps=arguments.steps,
        rank=arguments.rank,
        learning_rate=arguments.learning_rate,
        resolution=arguments.resolution,
        seed=arguments.seed,
    )
    try:
        run_training(Path(arguments.manifest), Path(arguments.out), options)
    except LoraTrainError as exc:
        message = redact_text(exc.message)[0]
        print(json.dumps({"event": "lora_error", "code": exc.code, "message": message}, sort_keys=True), file=sys.stderr, flush=True)
        return exc.exit_code
    except KeyboardInterrupt:
        print(json.dumps({"event": "lora_error", "code": "INTERRUPTED", "message": "interrupted"}), file=sys.stderr, flush=True)
        return EXIT_RUNTIME
    except Exception as exc:
        message = redact_text(str(exc) or exc.__class__.__name__)[0]
        print(json.dumps({"event": "lora_error", "code": "TRAINING_FAILED", "message": message}, sort_keys=True), file=sys.stderr, flush=True)
        return EXIT_RUNTIME
    return EXIT_OK


if __name__ == "__main__":
    sys.exit(main())
