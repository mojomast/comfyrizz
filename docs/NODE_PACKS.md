# Node packs and licences

Every `class_type` in `workflows/**/*.api.json` is mapped to one row in the
**Class type to pack map** below, and every pack it names is in the **Node
packs** table. `packages/jobs/test/node-pack-licenses.test.mjs` fails on an
unmapped class type, a class type that names a missing pack, a banned pack, or
an active custom pack whose SPDX licence is GPL, AGPL or LGPL.

ComfyUI core is the host, not a vendored dependency: ComfyUI is GPL-3.0 and is
cloned at runtime, never vendored, so its GPL-3.0 host row is allowed. Custom
node packs must be permissive (MIT, Apache-2.0, BSD and similar); no GPL, AGPL
or LGPL node pack may be vendored or required.

`UNPINNED` means the commit is not recorded anywhere in this repository.
`UNVERIFIED` means the value is not recorded anywhere in this repository. Those
placeholders are allowed only for active custom packs, where they are tracked as
an open issue rather than treated as a verified pin. They are never accepted as
a 40-hex commit or as a licence.

## Node packs

| Pack | URL | Commit | SPDX licence | Status | Notes |
| --- | --- | --- | --- | --- | --- |
| comfyui-core | https://github.com/Comfy-Org/ComfyUI | d52a7a5ef60b36062f7c3c69bd774f4c98b56eb0 | GPL-3.0 | host | ComfyUI is runtime-cloned by `colab/bootstrap.py` and `colab/fasth3_bootstrap.py`; not vendored and not shipped. Pin comes from `colab/fasth3-models.lock.json`. |
| comfyui-fill-chatterbox | https://github.com/filliptm/ComfyUI_Fill-ChatterBox | f7d7a16187430abcaf91a3039b9c83aa9960816a | MIT | active | Supplies `FL_ChatterboxMultilingualTTS` for `workflows/chatterbox_multilingual_tts.api.json`. Pin is recorded in that workflow's params note. Licence is MIT per the pack README and accepted by Kyle on 2026-10-30; the pinned tree has no LICENSE file, so this row records the README evidence rather than a file at that commit. |
| comfyui-pulid-flux | UNVERIFIED | UNPINNED | UNVERIFIED | active | Supplies `ApplyPulidFlux`, `PulidFluxModelLoader`, `PulidFluxEvaClipLoader` and `PulidFluxInsightFaceLoader` for `workflows/character_identity_pulid.api.json`. The pack URL, commit and licence are not recorded in this repository: the workflow params, `colab/character-identity-models.lock.json` (weights only), and the bootstrap scripts contain no node-pack provenance. Open issue: pin and licence-check this pack before shipping it. |
| comfyui-motion-previs-studio | https://github.com/navarisun1982/comfyui-motion-previs-studio | dd93095d21d15c56cb2e2baf4ec0118e849c7de5 | GPL-3.0 | banned | BANNED. Source of the removed `workflows/templates/ltx25_stubelius.api.json` LTX-2.5 Stubelius template. GPL-3.0 per `docs/PLAN.md`; never vendor or require this pack or its template. |

## Class type to pack map

| Class type | Pack |
| --- | --- |
| ApplyPulidFlux | comfyui-pulid-flux |
| BasicGuider | comfyui-core |
| BasicScheduler | comfyui-core |
| BlockSparseAttention | comfyui-core |
| CFGNorm | comfyui-core |
| CLIPLoader | comfyui-core |
| CLIPTextEncode | comfyui-core |
| ConditioningZeroOut | comfyui-core |
| CreateVideo | comfyui-core |
| DualCLIPLoader | comfyui-core |
| EmptyFlux2LatentImage | comfyui-core |
| EmptyImage | comfyui-core |
| EmptyLTXVLatentVideo | comfyui-core |
| EmptySD3LatentImage | comfyui-core |
| FL_ChatterboxMultilingualTTS | comfyui-fill-chatterbox |
| FluxGuidance | comfyui-core |
| FluxKontextMultiReferenceLatentMethod | comfyui-core |
| GetImageSize | comfyui-core |
| ImageCompositeMasked | comfyui-core |
| ImageScale | comfyui-core |
| ImageScaleToTotalPixels | comfyui-core |
| InvertMask | comfyui-core |
| JoinImageWithAlpha | comfyui-core |
| KSampler | comfyui-core |
| KSamplerSelect | comfyui-core |
| LTXVAudioVAEEncode | comfyui-core |
| LTXVConcatAVLatent | comfyui-core |
| LTXVConditioning | comfyui-core |
| LTXVDualCFGGuider | comfyui-core |
| LTXVEmptyLatentAudio | comfyui-core |
| LTXVImgToVideoInplace | comfyui-core |
| LTXVLatentUpsampler | comfyui-core |
| LTXVPreprocess | comfyui-core |
| LTXVSeparateAVLatent | comfyui-core |
| LatentUpscaleModelLoader | comfyui-core |
| LoadAudio | comfyui-core |
| LoadBackgroundRemovalModel | comfyui-core |
| LoadImage | comfyui-core |
| LoraLoaderModelOnly | comfyui-core |
| ManualSigmas | comfyui-core |
| MiniMaxH3ReferenceToVideo | comfyui-core |
| MiniMaxH3SigmaShift | comfyui-core |
| ModelAttentionBackend | comfyui-core |
| ModelSamplingAuraFlow | comfyui-core |
| PulidFluxEvaClipLoader | comfyui-pulid-flux |
| PulidFluxInsightFaceLoader | comfyui-pulid-flux |
| PulidFluxModelLoader | comfyui-pulid-flux |
| RandomNoise | comfyui-core |
| ReferenceMultiLatent | comfyui-core |
| RemoveBackground | comfyui-core |
| SamplerCustomAdvanced | comfyui-core |
| SaveAudio | comfyui-core |
| SaveImage | comfyui-core |
| SaveVideo | comfyui-core |
| SetLatentNoiseMask | comfyui-core |
| SolidMask | comfyui-core |
| TextEncodeQwenImageEditPlus | comfyui-core |
| TrimAudioDuration | comfyui-core |
| UNETLoader | comfyui-core |
| VAEDecode | comfyui-core |
| VAEDecodeAudio | comfyui-core |
| VAEDecodeTiled | comfyui-core |
| VAEEncode | comfyui-core |
| VAELoader | comfyui-core |

## Open issues

- `comfyui-pulid-flux` is active but has no pack URL, commit or licence recorded
  in this repository. The test lists it as a todo instead of failing, so the
  graph keeps working while the provenance gap stays visible. Pin the pack and
  add its SPDX licence before shipping the PuLID tier.
- `comfyui-fill-chatterbox` is pinned and MIT, but the pinned tree has no
  LICENSE file. The MIT claim rests on that pack's README, as accepted on
  2026-10-30; keep the evidence with the row.
