# Google Colab efficiency and concurrency review

Research date: **2026-10-19**. This is a source/code/log review, not a new GPU benchmark. Recommendations below have not been enabled or measured in production.

Follow-up: [measured Google Colab experiments](COLAB_EFFICIENCY_RESULTS.md) now cover Qwen batching, LTX worker concurrency and artifact collection. Use that report for experimental results and current recommendations; this document preserves the initial research basis.

## Opt-in final render on the Google Colab VM

The pipeline can assemble the MP4 on the Google Colab VM that already holds the generated plates (`renderLocation: "colab"`, default `local`). That path is not a measured production speedup. It follows the collection finding in this review: serial per-file downloads and the gaps around them dominate wall time once the GPU work is done.

What the option changes:

- Generated plates stay on the VM through Remotion. The media stage returns a manifest, not every asset, while the VM is held.
- Remotion concurrency on the VM is the host CPU count, capped at 8. The local renderer default remains 2.
- Node.js 22.20.0, npm packages (renderer, schema, vector, including the native resvg binding), ffmpeg, and a headless browser are installed only when missing, under `/content/comfyrizz/render-cache`.
- After the render, two zip archives come back: the MP4 plus verification reports, and one media archive so the editable export can still check asset bytes. That is one post-render transfer instead of a serial download of every plate before a local render.
- The VM is stopped before host verification, export, or a local fallback. A failed remote render logs `REMOTE_RENDER_FALLBACK` and renders locally only after a confirmed stop.

The cold install can cost more than a short local render, which is why the default stays on this machine. A later Google Colab session does not inherit the previous VM's cache. Do not treat the Hermes collection gaps (about 109 seconds in the recorded harness) as a promised saving: bootstrap, Chromium, and the post-render archive are unpaid in that log.

## Conclusion

The current path works, but is not demonstrated to maximize throughput or minimize compute units. The clearest measured opportunity is eliminating generation gaps while collecting outputs. The strongest model-level batching candidate is Qwen narration. LTX parallelism needs profiling before choosing a concurrency value.

Optimize **accepted output per compute unit**, including startup, transfers, retries and shutdown, rather than occupied VRAM or GPU utilization alone.

## Actual hardware and workload

The Hermes graphics run's `scratch/out/health.json` identifies **NVIDIA RTX PRO 6000 Blackwell Server Edition**, with 97,887 MiB reported by `nvidia-smi` (roughly 95.6 GiB). This is the nominal 96 GB device selected through our Google Colab `G4` configuration. The pre-workload check reported 94.43 GiB free; that is not peak-workload headroom.

NVIDIA lists this GPU as **compute capability 12.0 / SM120**. B200/GB200 are SM100, and their memory system, kernels and benchmark results must not be assumed to apply to this card. Google Cloud G4 prices are not Google Colab compute-unit prices. Google Colab hardware availability and consumption rates must be checked for each allocation.

Our pinned workloads:

- FLUX 3 Image Klein BF16 image transformer, separate Qwen3-VL-4B text encoder and VAE.
- LTX-2.5 22B distilled INT8 convrot transformer and Gemma4-12B INT8 convrot encoder, BF16 VAEs and latent upscaler.
- Qwen3-TTS 1.7B voice design/base, with 0.6B ASR and forced alignment. The adapter uses BF16 on CUDA and PyTorch SDPA.

## Measured lifecycle evidence

Source archive: `/home/mojo/comfyrizz-gpu-tests/hermes-20261019/graphics-run-01/`; harness summary: `/tmp/opencode/hermes-graphics-01.log`.

| Measurement | Recorded value |
| --- | ---: |
| Graphics harness lifecycle | 11.5 minutes |
| Sum of 14 manifest job durations | 248.52 seconds |
| Six stills | 9.716 seconds total |
| Six motion plates | 176.071 seconds total |
| Two presenters | 62.733 seconds total |
| Stills finished → plates started | 59 seconds |
| Plates finished → presenters started | 50 seconds |
| Settled graphics run spend | 1.62 compute units |
| Klein download | 125.0 seconds |
| LTX download | 169.8 seconds |
| Dependency install | 15.8 seconds |

Job durations are wall-clock runner intervals, not CUDA kernel time. Their approximately 36% share of the harness lifecycle is **not a measured 36% GPU utilization**. Setup, model loading, smoke execution, transfers and control-plane work account for other time; we lack continuous GPU traces to attribute it precisely.

The downloads run concurrently already, so do not add their durations. The two inter-batch gaps total 109 seconds, about 16% of the 690-second harness lifecycle. Removing all of those gaps would be an optimistic upper bound for that particular improvement, not a promised saving: checkpoint transfer and scheduling still consume resources.

Code corroborates the gaps: `packages/backends/src/colab-backend.mjs` waits for `collectOut()` after each batch before dispatching the next. Its file download loop is serial, with listing/control-plane calls around it. It already skips unchanged files by recorded size/mtime; repeated full downloads are not the remaining explanation.

## Best practice applied to these models

### 1. Overlap generation and collection first

Start the next admitted, dependency-ready batch while transferring a completed batch's immutable outputs. Preserve durable attempt records, artifact verification, cancellation cleanup, budget admission and partial-result recovery. Transfer immutable manifests/checkpoints rather than reading a manifest while another batch rewrites it.

Keep generation dependencies on the VM where possible: a completed still need not travel to the host and back just to become a motion reference. Use bounded transfer concurrency or completed-batch archives to reduce per-file CLI overhead, after verifying the CLI's concurrent transfer behavior. Successful artifacts must be durably collected before teardown.

Group work by model and compatible shape to reduce reloads. Retain GPU residency when measured peak usage allows it. Stage validation and input preparation before allocating the GPU; overlap independent installation/download work where dependencies permit. The bootstrap already parallelizes model-repository downloads.

### 2. Batch Qwen narration in one model instance

Qwen's official API supports lists of texts for custom voice, voice design and voice cloning, and explicitly supports reusing a precomputed voice-clone prompt. Our adapter already reuses loaded models and a clone prompt within one synthesis process, but invokes synthesis scene by scene.

Benchmark batch sizes **1, 2, 4, 8**, grouping scenes by voice, language and approximate spoken length. Length grouping reduces padding and waiting for the longest member. Batch ASR/alignment where their APIs support it. Keep scene IDs and independent output durations, quality checks, retry decisions and provenance. Retry only failed scenes. Batched random-number consumption can change samples; do not promise bit-identical output or preserve a misleading per-scene seed contract.

Qwen recommends FlashAttention 2 with FP16/BF16. Compare a verified SM120-compatible build with current SDPA; SDPA may itself dispatch optimized attention, so changing the label alone does not prove acceleration. Compilation/install costs belong in cold-start measurements.

vLLM-Omni is a later option for sustained narration volume. Its June 23, 2026 engineering report records 26.55 → 42.88 audio-seconds/second (+61.5%) for Qwen voice cloning at concurrency 64 on **two H20 GPUs**, after a stack of optimizations. This establishes that batching/runtime engineering matters, not an expected speedup for our twelve-scene single-GPU job.

### 3. FLUX batching is plausible but currently low priority

Hugging Face recommends batching prompts for higher diffusion throughput, with increased memory use and latency. That is a general principle, not proof that our current ComfyUI graph supports independent-prompt batching correctly. A larger latent batch can produce variations of one prompt unless conditioning is mapped appropriately.

The current FLUX 3 Klein model card reports reference-code memory at 1024×1024 on B200, prompt upsampler disabled: 31 GB BF16, 26 GB FP8, 25 GB NVFP4. These are not measurements of our graph or batch-size limits. The transformer has 5.6B parameters; the text encoder is separate.

Test batches of 2 and 4 only after verifying per-prompt conditioning, seeds and asset mapping. Six stills already took under ten seconds in the recorded runner intervals, so even large percentage improvements have small absolute value for this production.

### 4. Profile LTX before adding a second GPU worker

One ComfyUI process executes queued prompts serially. Concurrent HTTP submissions can reduce queue gaps but do not turn that process into concurrent GPU inference. Multiple processes duplicate model weights, compete for bandwidth and add activation/decoder peaks. Spare VRAM alone does not prove a throughput opportunity.

Keep one worker as the baseline. Measure loading, text encoding, denoising, upscale, VAE decode and output encoding separately. Then test a compatible batch of two or two workers only if measured headroom and utilization justify it; the current workflow may require implementation changes for true independent-job batching.

Lightricks' optimization guide discusses retaining models between stages, FP8 scaled matrix multiplication, NVFP4 and opt-in compilation. Our pinned checkpoint is already INT8 convrot: FP8/NVFP4 is a different compatible checkpoint/loader/kernel experiment, not a flag to apply indiscriminately. Preserve quality and presenter lip-sync gates in any comparison.

The guide also distinguishes B200-specific decoder acceleration from SM120 support. Its current CUDA-graph modes have pipeline-specific offload/address-stability requirements. Those examples describe Lightricks' native pipelines, not automatic settings for our ComfyUI deployment. Include compilation warm-up in the decision: eight LTX jobs may not amortize it.

CUDA MPS can help independent processes overlap underutilized workloads, but does not share their model weights or create more memory bandwidth. Treat it as a profiling-driven experiment after simpler batching/residency work.

## Hardware selection

- **96 GB RTX PRO 6000:** strong baseline for the mixed FLUX/LTX workflow and memory-headroom experiments; not yet proven cheapest per accepted asset.
- **L4/T4-class smaller GPUs:** candidates for Qwen-only comparisons if available. Their lower hourly rate can be offset by slower execution, unsupported precision paths or setup overhead. Do not assume our mixed LTX graph fits them.
- **A100 or other offered accelerators:** compare using actual assigned VRAM, supported kernels and live Google Colab rates. Do not transfer B200, GB200 or H20 vendor benchmark results to them.

For a fixed-quality workload, cost is approximately `rate_in_units_per_hour × billed_seconds / 3600`; settled balance changes remain the final accounting. Two runtimes improve cost only if the combined billed units fall, even if wall time improves. Prefer one-runtime batching experiments first.

## Proposed benchmark and acceptance criteria

1. Capture GPU model/UUID, VRAM, compute capability, driver/CUDA/PyTorch/attention versions, CPU/RAM, checkpoints and live unit rate.
2. Log GPU utilization, memory utilization, used VRAM, power and clocks at about one-second intervals, plus CPU/network and application phase timestamps. Use PyTorch allocated/reserved peaks and a short profiler capture for phase-specific decisions; `nvidia-smi` utilization alone does not identify the bottleneck.
3. Run the fixed baseline and each candidate on identical scene sets, dimensions, frame counts, prompts and quality settings. Record cold-start totals separately from warmed repeated-job throughput; alternate comparisons where practical and report variability.
4. Prioritize overlapped collection, Qwen batch 1/2/4/8, then LTX residency and batch/worker 1/2. FLUX batch 1/2/4 and alternate GPUs follow if worthwhile.
5. Compare accepted images/clips/audio seconds per unit, end-to-end latency, time to first preview, peak memory, retries and quality failures. Preserve narration intelligibility/voice consistency, alignment, frame counts and presenter sync gates.
6. Keep bounded memory headroom for decoding and variability. Prefer the lowest cost configuration that passes quality and operational checks, rather than the highest concurrency number.
7. For paid execution, use the remaining cumulative authorization, set a per-run ceiling/watchdog, record settled spend, and verify zero assignments after shutdown. This review allocated no GPU and spent no additional units; the existing ledger remains **3.62 / 20**, with **16.38** remaining.

## Primary sources

Accessed 2026-10-19; live upstream pages can change independently of our pinned deployment.

- [Google Colab FAQ: resource availability and usage](https://research.google.com/colaboratory/faq.html)
- [NVIDIA RTX PRO 6000 Blackwell Server Edition](https://www.nvidia.com/en-us/data-center/rtx-pro-6000-blackwell-server-edition/)
- [NVIDIA compute-capability table](https://developer.nvidia.com/cuda-gpus)
- [Qwen3-TTS: batch inference and reusable clone prompts](https://github.com/QwenLM/Qwen3-TTS)
- [Qwen3-ASR and forced alignment](https://github.com/QwenLM/Qwen3-ASR)
- [vLLM: Engineering TTS Inference, June 23, 2026](https://vllm.ai/blog/2026-06-23-vllm-omni-tts)
- [FLUX 3 Image Klein model card](https://huggingface.co/black-forest-labs/flux-3-image-klein)
- [Diffusers batch inference](https://huggingface.co/docs/diffusers/using-diffusers/batched_inference)
- [Lightricks pipeline optimization guide](https://github.com/Lightricks/LTX-2/blob/main/packages/ltx-pipelines/docs/optimization.md)
- [ComfyUI pinned prompt worker implementation](https://github.com/Comfy-Org/ComfyUI/blob/ce1e922/main.py)
- [NVIDIA CUDA Multi-Process Service](https://docs.nvidia.com/deploy/mps/index.html)
