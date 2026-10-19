# Colab efficiency experiments

These scripts run isolated experiments; they do not change production scheduling or model defaults.

The controller reuses the backend's ownership registry, detached shutdown watchdog and verified teardown. It archives CLI logs, host timings, the remote output ZIP and a `run.json` receipt. Each trial has a named session, a wall-clock limit and a compute-unit reservation. G4/L4 rate assumptions must be checked against live `colab usage` before another campaign.

## Qwen

Create an input ZIP containing:

- `models.lock.json`: `colab/qwen-models.lock.json`.
- `qwen_efficiency.py`: the script in this directory.
- `reference.wav`: one fixed generated reference voice for all comparisons.
- `task.json`: `referenceText`, `texts` and optionally `trials`, e.g. `[{"batch":1},{"batch":8},{"batch":4,"order":"length"}]`.

The default sweep is batch 1/2/4/8 then 8/4/2/1. The model is warmed before measurement; loading and downloads have separate timings. Each trial synchronizes CUDA, records allocated/reserved memory, saves every WAV and checks it with pinned Qwen ASR. WER is normalized for punctuation/case only. The automated gate is finite, non-silent audio, duration over one second and WER ≤ 0.1. This is an intelligibility gate, not a complete perceptual voice-quality evaluation. Different batch sizes may consume random numbers differently.

Optional task fields:

- `datasets`: named text arrays; each trial can select a `dataset`.
- `allocator`: CUDA allocator configuration, e.g. `expandable_segments:True`.
- `sharedTorch`: install pinned Torch once in a base environment referenced through `.pth` files by separate TTS/ASR environments; their incompatible Transformers pins stay isolated.
- `earlyDownload`: validate/download models through a small pinned Hub environment before installing the large inference stacks.

Repository downloads are sequenced, retaining four file workers per repository. Concurrent `snapshot_download` calls triggered a `tqdm` shared-lock race in the experiment. Child stdout/stderr are now saved in `out/worker.log`. CUDA OOMs are recorded and an identical failed batch configuration is not retried later in the sweep.

```sh
node scripts/bench/colab_efficiency.mjs \
  --id eff-qwen-l4-example --gpu L4 --units 2 --minutes 40 \
  --input /path/to/input.zip --out /path/to/evidence
python3 scripts/bench/summarize_efficiency.py /path/to/evidence --rate 1.54
```

Only use these paid commands with a budget reservation. The example does not itself grant spending authorization.

## Graphics

Create an input ZIP with `graphics_efficiency.py`, two fully materialized LTX API graphs (`graph0.json`, `graph1.json`), their reference images, and `task.json` with an `images` filename list. Both graphs should be the same workload geometry. The recorded campaign uses the existing 289-frame, 1024×576 final-output Hermes plates.

```sh
COMFYRIZZ_HF_TOKEN_FILE=/path/to/protected-token node scripts/bench/colab_efficiency.mjs \
  --id eff-graphics-example --gpu G4 --units 5 --minutes 30 \
  --graphics --transfer-bench --worker colab/graphics_efficiency_worker.py \
  --input /path/to/graphics-input.zip --out /path/to/evidence
python3 scripts/bench/summarize_efficiency.py /path/to/evidence --rate 8.9
.venv/bin/python scripts/bench/verify_graphics.py /path/to/evidence
```

The graphics worker records one-second GPU samples and single-worker cold/warm timings. A second worker is admitted only if twice the sampled peak plus 6 GiB fits the device. If admitted, its model loading is warmed separately, two dual-worker pairs are measured, and a final single-worker pair brackets the comparison. Seeds change between trials to invalidate cached generation. Text and model cache behavior is part of the measured workload.

The host compares serial file transfers, four concurrent file transfers and one ZIP on identical immutable files, verifying all hashes. It then compares sequential generation/collection with overlapping generation/collection. Remote graphs, logs, hardware, telemetry and primary-trial videos are archived. Overlap generation timings are in the CLI logs; those additional videos are not in the earlier primary-trial archive.

## Accounting and limitations

- `accountDelta` is account-wide. **Never sum overlapping deltas.** Use the campaign's start/end balance once, after verifying all campaign sessions are stopped and usage is zero.
- Tariff-derived warm costs and whole-lifecycle estimates are useful for comparison but differ from settled billing; account reports may lag.
- Download throughput, CPU allocation and cold-start installation vary between runtimes. Record both warmed throughput and the full lifecycle.
- Batch-size sweeps repeat the same inputs, while two-worker graphics trials retain distinct per-worker caches. Report this when interpreting results.
- Inputs and model weights stay outside Git. The exact campaign input ZIPs and output receipts live in the production evidence archive.
