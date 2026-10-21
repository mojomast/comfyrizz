"""CCL3b: the Colab character LoRA worker, exercised without a GPU or a runtime.

Everything here runs on CPU against a temporary dataset: the manifest validator,
the per-run spend gate, the safetensors handoff and the redaction of anything
secret-shaped. No model, token, network or Google Colab session is involved.
"""

from __future__ import annotations

import hashlib
import importlib.util
import json
import os
import struct
import subprocess
import sys
from pathlib import Path

import pytest

from conftest import REPO_ROOT

SCRIPT = REPO_ROOT / "colab" / "character_lora_train.py"
CHARACTER_ID = "chr_0123456789abcdef"


def load_module():
    spec = importlib.util.spec_from_file_location("character_lora_train", SCRIPT)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


MODULE = load_module()


def safetensors_bytes(tensors: int = 2) -> bytes:
    entries: dict[str, dict] = {}
    payload = b""
    for index in range(tensors):
        chunk = struct.pack("<f", index + 0.5)
        entries[f"transformer.lora_{index}"] = {
            "dtype": "F32",
            "shape": [1],
            "data_offsets": [len(payload), len(payload) + len(chunk)],
        }
        payload += chunk
    raw = json.dumps(entries, separators=(",", ":")).encode("utf-8")
    header = raw + b" " * ((8 - len(raw) % 8) % 8)
    return len(header).to_bytes(8, "little") + header + payload


def build_dataset(
    root: Path,
    *,
    count: int = 8,
    kind: str = "fictional",
    name: str = "Pip",
    captions: list[str] | None = None,
    consent: dict | None = None,
    source_files: list[str] | None = None,
    image_transform=None,
) -> Path:
    images_dir = root / "dataset" / "images"
    images_dir.mkdir(parents=True, exist_ok=True)
    entries = []
    for index in range(count):
        relative = f"images/{index:02d}.png"
        if source_files is not None:
            relative = source_files[index]
        target = (root / "dataset" / relative).resolve()
        target.parent.mkdir(parents=True, exist_ok=True)
        data = b"\x89PNG\r\n\x1a\n" + f"image-{index}".encode("utf-8")
        if image_transform is not None:
            data = image_transform(index, data)
        target.write_bytes(data)
        caption = captions[index] if captions and index < len(captions) else f"pip_bean, view {index}"
        entries.append({"file": relative, "caption": caption, "sha256": hashlib.sha256(data).hexdigest()})
    manifest = {
        "schema": MODULE.SCHEMA,
        "characterId": CHARACTER_ID,
        "revision": 3,
        "name": name,
        "kind": kind,
        "trigger": "pip_bean",
        "images": entries,
        "manifestHash": "a" * 64,
    }
    if consent is not None:
        manifest["consent"] = consent
    path = root / "dataset" / "manifest.json"
    path.write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    return path


def collect(events: list) -> None:
    events.append


def fake_trainer(payload: bytes | None = None):
    def train(plan, emit):
        plan.output_path.write_bytes(safetensors_bytes() if payload is None else payload)
        emit({"event": "fake_step", "step": 1})
        return plan.output_path

    return train


def run(tmp_path: Path, manifest: Path, **options):
    events: list[dict] = []
    defaults = {"base_model": "example/flux-klein", "approve_spend": True, "units_ceiling": 2.0}
    defaults.update(options)
    report = MODULE.run_training(
        manifest,
        tmp_path / "out",
        MODULE.RunOptions(**defaults),
        trainer=fake_trainer(),
        clock=lambda: 1_700_000_000.0,
        on_event=events.append,
    )
    return report, events


def test_dry_run_validates_the_manifest_and_writes_no_model(tmp_path: Path):
    manifest = build_dataset(tmp_path, count=8)
    events: list[dict] = []
    report = MODULE.run_training(
        manifest,
        tmp_path / "out",
        MODULE.RunOptions(dry_run=True),
        trainer=lambda plan, emit: pytest.fail("dry run must never call the trainer"),
        clock=lambda: 1_700_000_000.0,
        on_event=events.append,
    )

    assert report["ok"] is True and report["dryRun"] is True
    assert report["dataset"]["images"] == 8
    assert report["character"]["id"] == CHARACTER_ID
    assert report["spend"] == {"approved": False, "unitsCeiling": None}
    assert not (tmp_path / "out" / "character_lora.safetensors").exists()
    assert not (tmp_path / "out" / "run.json").exists()
    dry_run = json.loads((tmp_path / "out" / "dry-run.json").read_text(encoding="utf-8"))
    assert dry_run["dataset"]["datasetSha256"] == report["dataset"]["datasetSha256"]
    assert events[0]["event"] == "lora_dry_run"


def test_dry_run_refuses_fewer_than_eight_images(tmp_path: Path):
    manifest = build_dataset(tmp_path, count=7)
    with pytest.raises(MODULE.LoraTrainError) as caught:
        MODULE.run_training(manifest, tmp_path / "out", MODULE.RunOptions(dry_run=True), on_event=collect([]))
    assert caught.value.code == "LORA_TOO_FEW_IMAGES"
    assert caught.value.exit_code == MODULE.EXIT_INVALID
    assert "8" in caught.value.message


def test_manifest_rejects_a_kind_that_is_not_fictional_or_consented(tmp_path: Path):
    manifest = build_dataset(tmp_path, kind="real")
    with pytest.raises(MODULE.LoraTrainError) as caught:
        MODULE.load_dataset(manifest)
    assert caught.value.code == "CHAR_KIND_UNSUPPORTED"


def test_real_authorized_needs_a_complete_consent_record(tmp_path: Path):
    manifest = build_dataset(tmp_path, kind="real_authorized")
    with pytest.raises(MODULE.LoraTrainError) as caught:
        MODULE.load_dataset(manifest)
    assert caught.value.code == "CHAR_CONSENT_REQUIRED"

    consent = {
        "assertedBy": "the character's guardian",
        "assertedAt": "2026-10-21T00:00:00Z",
        "scope": ["lora-training"],
        "likenessWarningShown": True,
    }
    manifest = build_dataset(tmp_path, kind="real_authorized", consent=consent)
    dataset = MODULE.load_dataset(manifest)
    assert dataset.kind == "real_authorized"


def test_manifest_rejects_paths_that_escape_the_dataset(tmp_path: Path):
    outside = tmp_path / "outside.png"
    outside.write_bytes(b"not-part-of-the-dataset")
    manifest = build_dataset(tmp_path, source_files=["../outside.png"] + [f"images/{i:02d}.png" for i in range(1, 8)])
    with pytest.raises(MODULE.LoraTrainError) as caught:
        MODULE.load_dataset(manifest)
    assert caught.value.code == "MANIFEST_INVALID"


def test_manifest_rejects_a_declared_hash_that_does_not_match(tmp_path: Path):
    manifest = build_dataset(tmp_path)
    payload = json.loads(manifest.read_text(encoding="utf-8"))
    payload["images"][0]["sha256"] = "b" * 64
    manifest.write_text(json.dumps(payload), encoding="utf-8")
    with pytest.raises(MODULE.LoraTrainError) as caught:
        MODULE.load_dataset(manifest)
    assert caught.value.code == "MANIFEST_INVALID"


def test_manifest_accepts_the_nested_character_and_path_alias(tmp_path: Path):
    manifest = build_dataset(tmp_path)
    payload = json.loads(manifest.read_text(encoding="utf-8"))
    payload["character"] = {
        "characterId": payload.pop("characterId"),
        "revision": payload.pop("revision"),
        "name": payload.pop("name"),
        "kind": payload.pop("kind"),
    }
    for image in payload["images"]:
        image["path"] = image.pop("file")
    manifest.write_text(json.dumps(payload), encoding="utf-8")
    assert len(MODULE.load_dataset(manifest).images) == 8


def test_dataset_hash_is_deterministic_and_tracks_bytes_and_captions(tmp_path: Path):
    first = MODULE.load_dataset(build_dataset(tmp_path, count=8))
    second = MODULE.load_dataset(build_dataset(tmp_path, count=8))
    assert first.dataset_sha256 == second.dataset_sha256

    changed = MODULE.load_dataset(
        build_dataset(
            tmp_path,
            count=8,
            captions=[f"a different caption {index}" for index in range(8)],
        )
    )
    assert changed.dataset_sha256 != first.dataset_sha256

    changed_bytes = MODULE.load_dataset(
        build_dataset(tmp_path, count=8, image_transform=lambda index, data: data + b"x")
    )
    assert changed_bytes.dataset_sha256 != first.dataset_sha256


def test_a_declared_dataset_hash_is_checked_when_present(tmp_path: Path):
    manifest = build_dataset(tmp_path)
    dataset = MODULE.load_dataset(manifest)
    payload = json.loads(manifest.read_text(encoding="utf-8"))
    payload["datasetSha256"] = dataset.dataset_sha256
    manifest.write_text(json.dumps(payload), encoding="utf-8")
    assert MODULE.load_dataset(manifest).dataset_sha256 == dataset.dataset_sha256

    payload["images"][0]["caption"] = "a different caption"
    manifest.write_text(json.dumps(payload), encoding="utf-8")
    with pytest.raises(MODULE.LoraTrainError) as caught:
        MODULE.load_dataset(manifest)
    assert caught.value.code == "MANIFEST_INVALID"


def test_a_real_run_needs_an_explicit_per_run_spend_approval(tmp_path: Path):
    manifest = build_dataset(tmp_path)
    called: list[str] = []

    def trainer(plan, emit):
        called.append("called")
        return plan.output_path

    with pytest.raises(MODULE.LoraTrainError) as caught:
        MODULE.run_training(
            manifest,
            tmp_path / "out",
            MODULE.RunOptions(base_model="example/flux-klein", approve_spend=False, units_ceiling=2.0),
            trainer=trainer,
            on_event=collect([]),
        )
    assert caught.value.code == "SPEND_NOT_APPROVED"
    assert caught.value.exit_code == MODULE.EXIT_SPEND
    assert called == []
    assert not (tmp_path / "out" / "character_lora.safetensors").exists()


def test_a_real_run_needs_a_bounded_units_ceiling(tmp_path: Path):
    manifest = build_dataset(tmp_path)
    for ceiling in (None, 0.0, MODULE.MAX_UNITS + 0.5):
        with pytest.raises(MODULE.LoraTrainError) as caught:
            MODULE.run_training(
                manifest,
                tmp_path / "out",
                MODULE.RunOptions(base_model="example/flux-klein", approve_spend=True, units_ceiling=ceiling),
                trainer=fake_trainer(),
                on_event=collect([]),
            )
        assert caught.value.code == "SPEND_NOT_APPROVED"


def test_a_real_run_writes_the_safetensors_path_sha_and_approval(tmp_path: Path):
    manifest = build_dataset(tmp_path)
    report, events = run(tmp_path, manifest)

    output = tmp_path / "out" / "character_lora.safetensors"
    assert output.is_file()
    assert report["ok"] is True and report["dryRun"] is False
    assert report["lora"]["path"] == "character_lora.safetensors"
    assert report["lora"]["format"] == "safetensors"
    assert report["lora"]["tensors"] == 2
    assert report["lora"]["sha256"] == hashlib.sha256(output.read_bytes()).hexdigest()
    assert report["lora"]["bytes"] == output.stat().st_size
    assert report["spend"]["approved"] is True
    assert report["spend"]["unitsCeiling"] == 2.0
    assert report["spend"]["approvedAt"] == "2023-11-14T22:13:20Z"

    disk = json.loads((tmp_path / "out" / "run.json").read_text(encoding="utf-8"))
    assert disk == report
    assert events[-1]["event"] == "lora_finished"
    assert events[-1]["sha256"] == report["lora"]["sha256"]


def test_the_report_keeps_runtime_paths_out_of_the_artifacts(tmp_path: Path):
    manifest = build_dataset(tmp_path)
    run(tmp_path, manifest)
    text = (tmp_path / "out" / "run.json").read_text(encoding="utf-8")
    assert str(tmp_path) not in text
    assert "dataset/images" not in text


def test_a_trainer_that_does_not_write_safetensors_fails_closed(tmp_path: Path):
    manifest = build_dataset(tmp_path)
    with pytest.raises(MODULE.LoraTrainError) as caught:
        MODULE.run_training(
            manifest,
            tmp_path / "out",
            MODULE.RunOptions(base_model="example/flux-klein", approve_spend=True, units_ceiling=2.0),
            trainer=fake_trainer(b"not-a-safetensors-file"),
            on_event=collect([]),
        )
    assert caught.value.code == "OUTPUT_INVALID"
    failure = json.loads((tmp_path / "out" / "run.json").read_text(encoding="utf-8"))
    assert failure["ok"] is False
    assert failure["error"]["code"] == "OUTPUT_INVALID"


def test_a_trainer_error_is_redacted_before_it_reaches_the_report(tmp_path: Path):
    manifest = build_dataset(tmp_path)
    secret = "hf_" + "q" * 24

    def trainer(plan, emit):
        raise RuntimeError(f"upload failed with {secret}")

    with pytest.raises(MODULE.LoraTrainError) as caught:
        MODULE.run_training(
            manifest,
            tmp_path / "out",
            MODULE.RunOptions(base_model="example/flux-klein", approve_spend=True, units_ceiling=2.0),
            trainer=trainer,
            on_event=collect([]),
        )
    assert caught.value.code == "TRAINING_FAILED"
    text = (tmp_path / "out" / "run.json").read_text(encoding="utf-8")
    assert secret not in text
    assert MODULE.REDACTED in text


def test_a_secret_shaped_name_never_reaches_the_report(tmp_path: Path):
    secret = "hf_" + "m" * 24
    manifest = build_dataset(tmp_path, name=secret)
    report = MODULE.run_training(
        manifest,
        tmp_path / "out",
        MODULE.RunOptions(dry_run=True),
        on_event=collect([]),
    )
    text = (tmp_path / "out" / "dry-run.json").read_text(encoding="utf-8")
    assert secret not in text
    assert report["character"]["name"] == MODULE.REDACTED


def test_secret_shaped_text_is_redacted():
    secret = "hf_" + "z" * 24
    cleaned, count = MODULE.redact_text(f"authorization: {secret} and Bearer abcdefghijkl")
    assert secret not in cleaned
    assert "abcdefghijkl" not in cleaned
    assert count >= 2


def test_the_cli_dry_run_is_gpu_free_and_logs_no_ambient_token(tmp_path: Path):
    manifest = build_dataset(tmp_path)
    secret = "hf_" + "w" * 24
    environment = dict(os.environ)
    environment["HF_TOKEN"] = secret
    result = subprocess.run(
        [sys.executable, str(SCRIPT), "--manifest", str(manifest), "--out", str(tmp_path / "out"), "--dry-run"],
        capture_output=True,
        text=True,
        cwd=str(REPO_ROOT),
        env=environment,
    )
    combined = result.stdout + result.stderr
    assert result.returncode == 0
    assert secret not in combined
    events = [json.loads(line) for line in result.stdout.splitlines() if line.strip()]
    assert events[0]["event"] == "lora_dry_run"
    assert events[0]["images"] == 8
    assert (tmp_path / "out" / "dry-run.json").is_file()


def test_the_cli_returns_the_spend_exit_code_and_writes_nothing(tmp_path: Path):
    manifest = build_dataset(tmp_path)
    result = subprocess.run(
        [sys.executable, str(SCRIPT), "--manifest", str(manifest), "--out", str(tmp_path / "out"), "--base-model", "example/flux-klein"],
        capture_output=True,
        text=True,
        cwd=str(REPO_ROOT),
    )
    assert result.returncode == MODULE.EXIT_SPEND
    error = json.loads(result.stderr.strip().splitlines()[-1])
    assert error["code"] == "SPEND_NOT_APPROVED"
    assert not (tmp_path / "out" / "character_lora.safetensors").exists()
