# Colab efficiency experiments — October 19, 2026

Companion to [the research review](COLAB_EFFICIENCY.md). Exact inputs, outputs, logs and receipts are archived under `/home/mojo/comfyrizz-gpu-tests/efficiency-20261019/`. Reproduction tools are in [`scripts/bench`](../scripts/bench/README.md).

## Findings from completed trials

1. **Use L4 for lower-credit Qwen narration, G4 for lower latency, and batch compatible scenes in either case.** The tested project-sized workload used about 36% fewer warm synthesis units on L4, while G4 was about 3.7× faster. On G4, batching twelve mixed-length scenes improved synthesis throughput 7.12×; a large short-text backlog benefited from batches up to 128.
2. **Keep one LTX worker as the normal baseline.** Two workers on one GPU improved warm pair throughput by only about 5.5%, while doubling sampled peak GPU memory. That gain excludes second-worker startup and model warm-up.
3. **Collect immutable artifacts concurrently with subsequent generation.** The measured generation/collection cycle fell by 21.3%.
4. **Reduce per-file transfer overhead.** Four download workers reduced the tested collection time by 72.4%. A single ZIP reduced transfer/extraction/verification time by 86.1%, excluding remote archive creation.
5. **Include cold setup and failed allocations in credit accounting.** Warm inference speedups do not translate directly to whole-project speedups.

These are experimentally supported choices for the measured workloads, not a claim of a global optimum across all models, lengths or hardware. Production integration should retain per-scene quality/retry decisions, artifact hashes, budget admission, cancellation, durable checkpoints and verified shutdown.

## Hardware, software and method

- G4: NVIDIA RTX PRO 6000 Blackwell Server Edition, SM120, nominal 96 GB; observed rate **8.90 units/hour**.
- L4: NVIDIA L4, 22.03 GiB reported CUDA memory, approximately 53 GiB host RAM; observed marginal rate **1.54 units/hour**. The corrected final trial completed successfully; earlier failed trials are accounted for separately.
- Qwen: pinned 1.7B Base clone model and fixed synthetic voice reference; BF16, SDPA, PyTorch 2.9.1+cu128; separate pinned TTS/ASR dependency environments. Full pins remain in `colab/qwen-models.lock.json`.
- LTX: existing pinned LTX-2.5 distilled INT8 convrot two-stage graph, two reference images, 289 frames at 24 fps, final 1024×576 output. Model pins remain in `colab/models.lock.json`.
- LTX hardware was held at G4 for the worker-concurrency test. This campaign does not establish the cheapest GPU type for LTX; the L4/G4 hardware comparison concerns Qwen narration.
- Qwen short workload: eight approximately equal-length texts, **148 words total**, repeated in the larger capacity set. Batch order is ascending then descending, with a warm-up before timing and CUDA synchronization around each trial.
- Qwen checks: finite/non-silent audio, expected output counts and normalized ASR WER ≤ 0.1. Reported zero WER is against the same pinned ASR model, not independent human listening or proof of identical prosody.
- LTX jobs use distinct seeds to invalidate cached generation. Two distinct prompt/image graphs repeat across trials; per-worker text/model cache behavior is part of the workload. This is not an independent-prompt batching implementation.
- GPU samples are approximately one second apart. PyTorch allocated/reserved peaks and `nvidia-smi` used memory are different measurements.
- Host lifecycle includes setup, inference, quality work, collection and teardown. Tariff-derived warm costs are estimates; settled account balance changes are reported separately.

## Qwen: eight-line G4 test

Evidence: `qwen-g4-01/{output.zip,summary.json,run.json}`. Each row is the mean of two trials on the same eight texts.

| Batch | Seconds per eight lines | Relative throughput | Peak allocated GiB | ASR-gate passes |
| ---: | ---: | ---: | ---: | ---: |
| 1 | 34.512 | 1.00× | 4.40 | 16/16 |
| 2 | 17.980 | 1.92× | 4.83 | 16/16 |
| 4 | 9.353 | 3.69× | 5.72 | 16/16 |
| 8 | 4.960 | 6.96× | 7.52 | 16/16 |

All **64** outputs had measured WER zero. Batch 8 produced approximately **11.47 accepted audio-seconds per wall second**. Using accepted words avoids rewarding a configuration simply for speaking more slowly: batch 8 produced **29.84 accepted words/second**, versus 4.29 at batch 1.

The complete test lifecycle was **439.045 seconds**, including installation and all eight measurement trials. Batch 8's roughly 30-second saving for one eight-line production is much smaller than the several-minute cold setup. The 6.96× result applies to warmed synthesis, not complete project latency.

## Qwen: larger G4 capacity test

Evidence: `qwen-g4-capacity-01/{output.zip,summary.json,run.json}`. Each trial contains **64 lines / 1,184 words**; each batch size was repeated twice.

| Batch | Seconds per 64 lines | Relative to batch 8 | Peak allocated GiB | Accepted words/unit, warm estimate |
| ---: | ---: | ---: | ---: | ---: |
| 8 | 41.305 | 1.00× | 7.72 | 11,595 |
| 16 | 21.294 | 1.94× | 11.27 | 22,491 |
| 32 | 11.933 | 3.46× | 18.96 | 40,135 |
| 64 | 6.880 | 6.00× | 32.27 | 69,615 |

All **512** outputs passed, with measured WER zero. Batch 64 produced approximately **65.96 accepted audio-seconds/second**. This requires enough independent work to fill the batch; a twelve-scene project cannot realize a 64-scene batch benefit on its own.

Allocator reservations accumulated across shapes, reaching **65.51 GiB** even though peak allocated memory at batch 64 was 32.27 GiB. Later small-batch trials inherited this reservation. It would be incorrect to call 65.51 GiB the intrinsic memory requirement of batch 8.

The full lifecycle was **535.899 seconds**. Recorded installation steps included **106.52 seconds** for the first Torch install and **88.47 seconds** for the second, plus approximately 38 seconds each for the TTS/ASR packages. This motivated the final shared-Torch setup experiment.

## Final G4 sweep: larger batches and realistic scene lengths

Evidence: `qwen-g4-final-01/{output.zip,summary.json,run.json}`. This run used `PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True` and a shared Torch base environment with separate TTS/ASR package environments.

### 128-line short-text workload

Each trial contains 128 lines / 2,368 words. Results are means of two trials.

| Batch | Seconds per 128 lines | Peak allocated GiB | ASR-gate passes | Accepted words/unit, warm estimate |
| ---: | ---: | ---: | ---: | ---: |
| 64 | 13.910 | 32.27 | 256/256 | 68,862 |
| 96 | 14.557 | 43.56 | 254/256 | 65,271 |
| 128 | **9.395** | **54.63** | **256/256** | **101,950** |

Batch 128 was **1.48× faster than batch 64** for this fixed workload, producing about **95.67 accepted audio-seconds/second**. The largest tested batch is not a universal default: these are short, similarly sized lines. Batch 96 requires a second partial batch for 128 inputs, which helps explain why increasing its nominal batch size did not improve overall time.

The two batch-96 failures were the same line across the repeated seeds: ASR transcribed “compare/check” as “compared/checked,” yielding WER 0.1053 against the 0.1 gate. They were counted as failures rather than silently excluded. No CUDA OOM occurred. Reserved memory peaked at **60.99 GiB** across this larger sweep; later small trials inherited that reservation.

### Mixed-length production-sized workload

Twelve scenes, **554 words**, approximately 200 seconds of generated speech; scene lengths ranged from 17 to 75 words. Each configuration below has one observation.

| Batch/order | Synthesis seconds | ASR-gate passes | Peak allocated GiB |
| --- | ---: | ---: | ---: |
| 1, original | 124.902 | 12/12 | 4.64 |
| 4, original | 48.537 | 12/12 | 6.71 |
| 4, length-grouped | 38.478 | 12/12 | 6.71 |
| 8, original | 33.954 | 12/12 | 9.47 |
| 8, length-grouped | 30.436 | 12/12 | 9.47 |
| 12, original | **17.542** | **12/12** | **12.24** |

The whole-project batch was **7.12× faster than scene-at-a-time synthesis**. Length grouping reduced time by about 20.7% at batch 4 and 10.4% at batch 8 in this sample. All 72 mixed-length outputs had measured WER zero. Restore the original scene order by ID after batching; batching order must not change the edit.

Across this entire final G4 run, **854/856** outputs passed. The additional eight-line checks bracketing the sweep averaged 5.079 seconds, close to the earlier 4.960-second result. Total lifecycle was **701.683 seconds**, with a larger workload than the earlier run; those lifecycle totals are not an apples-to-apples speed comparison.

### Cold setup: share Torch, isolate incompatible Transformers versions

The experiment installed Torch 2.9.1+cu128 once, then exposed its base environment through `.pth` files to separate TTS and ASR environments. Environment receipts confirmed TTS retained Transformers **4.57.3** and ASR **4.57.6**, with the same pinned Torch/Torchaudio versions.

Dependency/setup commands totaled approximately **202 seconds**, versus **284 seconds** in the preceding G4 capacity run, excluding model-download time from both. This is an observed **~82-second** reduction across separate allocations, not a replicated cold-start benchmark. The new method also includes a small early-download environment and kernel probe. Shared installation passed the actual synthesis and ASR workload; it is a promising setup optimization beyond batching.

## L4 versus G4: cost and latency tradeoff

Evidence: `qwen-l4-fixed-01/{output.zip,summary.json,run.json}`. Repository downloads were sequenced after the shared-lock fix. This run used the shared Torch installation and expandable-segments allocator. **All 124 outputs passed, with measured WER zero.**

### Eight short lines

Each L4 row is the mean of two trials, using the same eight texts/reference as G4.

| L4 batch | Synthesis seconds | Peak allocated GiB | ASR-gate passes |
| ---: | ---: | ---: | ---: |
| 1 | 129.160 | 4.26 | 16/16 |
| 2 | 68.240 | 4.57 | 16/16 |
| 4 | 35.878 | 5.21 | 16/16 |
| 8 | **18.292** | **6.41** | **16/16** |

L4 also benefited approximately **7.06×** from batch 8 versus batch 1.

| Identical workload/configuration | G4 time | L4 time | G4 warm synthesis units | L4 warm synthesis units | L4 unit reduction |
| --- | ---: | ---: | ---: | ---: | ---: |
| Eight short lines, batch 8 | 5.079 s | 18.292 s | 0.01256 | 0.00782 | **37.7%** |
| Twelve mixed-length scenes, batch 12 | 17.542 s | 64.806 s | 0.04337 | 0.02772 | **36.1%** |

These tariff-derived figures are **warm synthesis only**: setup, ASR, transfers and shutdown are excluded. They are not settled per-project billing totals. The rates were observed from actual allocations. G4 was approximately 3.60×/3.69× faster in these comparisons, but cost 5.78× as much per hour.

### Mixed-length L4 results

The same twelve scenes / 554 words; one observation per configuration, all twelve outputs accepted in each.

| Batch/order | Synthesis seconds | Peak allocated GiB |
| --- | ---: | ---: |
| 4, original | 182.778 | 5.89 |
| 4, length-grouped | 143.010 | 5.89 |
| 8, original | 128.001 | 7.83 |
| 8, length-grouped | 112.725 | 7.82 |
| 12, original | **64.806** | **9.76** |

The entire L4 experiment lasted **1,572.056 seconds**, including intentionally slow baselines, thirteen trials, installation and QA. It is not the expected duration of a single film. The GPU trace peaked at 11,848 MiB used. Larger L4 batches were not tested, so this study does not establish which GPU has the lowest cost for a large, fully batched backlog. G4 batch 128 is a demonstrated high-throughput option, not proof that it beats every L4 batch size on cost.

## LTX: two workers provide a small gain

Evidence: `graphics-g4-01/{output.zip,summary.json,phase-telemetry.json,review/}`.

| Configuration | Pair timings | Mean pair time | Sampled peak GPU memory | Mean sampled GPU utilization |
| --- | --- | ---: | ---: | ---: |
| One worker, warmed | 53.392 / 53.908 s | **53.650 s** | **41.07 GiB** | 82.2% / 85.9% |
| Two workers, warmed | 50.768 / 50.949 s | **50.858 s** | **82.14 GiB** | 91.2% / 93.4% |

Warm throughput increased **5.49%**; pair wall time decreased **5.20%**. Individual clips took roughly 26–28 seconds with one worker versus about 51 seconds while sharing the GPU. Increased utilization did not yield a proportional throughput gain.

The first single-worker pair took 68.331 seconds including cold loading. The second process was separately started and warmed before its measured pairs; its two warm-up jobs took 45.400 and 27.171 seconds. These produced usable clips, but the warm comparison does not charge the second process's loading cost.

All **12 archived primary-trial videos** fully decoded and passed 289-frame, 1024×576, 24-fps checks. First/middle/last frames were reviewed for all twelve; no obvious concurrency-specific visual corruption was observed. The contact sheet is `graphics-g4-01/review/contact-sheet.jpg`. This test concerns motion plates, not presenter lip sync.

## Collection: more valuable than duplicate LTX models

Identical immutable checkpoint: **14 files / 17,660,161 bytes**. Every downloaded file was size/hash verified.

| Transfer mode | Repeated timings | Mean | Reduction versus serial |
| --- | --- | ---: | ---: |
| Serial file downloads | 14.118 / 14.336 s | **14.227 s** | — |
| Four concurrent downloads | 3.874 / 3.969 s | **3.922 s** | **72.4%** |
| Single ZIP, extract and verify | 2.013 / 1.952 s | **1.983 s** | **86.1%** |

The ZIP was created before these transfer timers started. Its creation cost was not separately measured, so this is not a complete packaging-plus-transfer comparison. The four-worker mode requires no archive creation and demonstrated that concurrent CLI downloads preserve the artifacts in this test.

An additional live test generated two clips while collecting that completed checkpoint:

- Sequential generation then serial collection: **68.946 seconds**.
- Overlapped generation and serial collection: **54.242 seconds**.
- Reduction: **14.704 seconds / 21.3%**.

This overlap experiment has one observation per mode. It demonstrates functional overlap and a material saving on this workload, not a precise universal percentage. New generation used different seeds; immutable earlier artifacts were the transfer set. These additional four clips' generation receipts are in CLI logs, while the twelve primary-trial clips are in the archived video review.

## Failed trials and accounting

- `qwen-l4-01`: kernel connection lost in CLI initialization, before the benchmark worker; shutdown verified. A 60-second execution probe was added for subsequent allocations.
- `qwen-l4-mixed-01` and `qwen-l4-02`: dependency installation completed but model download failed. The original worker did not capture child-process stderr through the notebook kernel, so the underlying download error was unavailable. Subsequent workers persist and stream child logs and check downloads before large inference installs.
- Failed trials are included in the campaign's credit accounting and do not count as L4 throughput measurements.

The captured `qwen-l4-final-01/out/worker.log` subsequently identified the download failure: concurrent `snapshot_download` calls raised **`AttributeError: type object 'tqdm' has no attribute '_lock'`** while closing a progress bar. This was a nested-concurrency shared-lock race, not insufficient GPU capacity. The experiment downloader and production `colab/qwen_narrate.py` now sequence repository calls while retaining four parallel file-download workers within each repository. The same traceback was not captured in the two earlier download failures, so their exact causes cannot be proven retrospectively.

The 36 existing Python TTS tests passed after the production downloader change. Embedded worker-source syntax and the experimental Python/JavaScript entry points were also checked.

At the first all-stopped checkpoint, account balance fell from **365.95 to 361.78**, a **4.17-unit** campaign cost. Usage was **0.00/hr**, with **zero active assignments**. Cumulative authorized testing at that checkpoint was **7.79 / 20 units**, including the prior 3.62 units.

**Final campaign accounting:** balance **365.95 → 359.73**, a **6.22-unit** experimental spend. Including earlier testing, balance **369.57 → 359.73** gives **9.84 / 20 units cumulative**, leaving **10.16 units** authorized. Final `colab usage` reported **0.00/hr and zero assignments**; `colab sessions` independently reported **no active sessions on the server**. Every allocated trial has a verified-stopped receipt, including failed trials. Account deltas from overlapping runs were not summed.

The campaign generated **1,556 Qwen clips**, of which **1,554 passed the automated gate**; the two failures were the repeated batch-96 line described above. This includes repeats for measurement rather than 1,556 distinct scripts. Twelve primary LTX videos passed technical verification and sampled-frame review, with four additional generation jobs used for the overlap test.

## Recommended integration order

1. Retain the downloader fix: sequence Qwen repository downloads, keeping file-level concurrency. Fail a nonresponsive kernel quickly and persist subprocess diagnostics.
2. Add revision-bound Qwen scene batching. Offer **L4 for credit economy** and **G4 for speed**; batch all twelve compatible scenes for the tested project size when memory permits. For larger queues, bucket by expected spoken length and preserve per-scene quality checks/retries and original scene order.
3. Use the tested shared-Torch setup to reduce duplicate installation, while retaining separate TTS/ASR dependency environments. Keep cold-start accounting visible.
4. Keep **one G4 LTX worker** as the ordinary baseline. Make two-worker mode a measured, memory-admitted option for workloads where its small warm gain justifies startup and reduced headroom.
5. Use **four concurrent immutable-file downloads**, or completed-batch ZIP checkpoints where archive creation is accounted for. Overlap collection with subsequent admitted generation and retain hash verification before deleting remote outputs.

The benchmark settings are recorded here for implementation; the production code change in this work is the demonstrated Qwen download-race fix. GPU selection, scene batching and collection scheduling require integration with their existing lifecycle and progress contracts.
