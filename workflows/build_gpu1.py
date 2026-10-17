"""Build ComfyUI API-format workflows used in GPU test session 1 (comfyrizz-gpu1).
Writes *.api.json templates here and concrete job lists to the test folder.
Model filenames match the VM layout in GPU_TEST_1.md."""
import json, copy, os, sys
HERE=os.path.dirname(os.path.abspath(__file__))
KLEIN_UNET="flux-3-image-klein-bf16.safetensors"; KLEIN_TE="qwen3vl_4b_bf16.safetensors"; KLEIN_VAE="flux2-vae.safetensors"
LTX_UNET="ltx-2.5-22b-distilled-transformer-comfy-int8-convrot.safetensors"
LTX_TE="gemma4-12b-with-proj-ltx-2.5-comfy-int8-convrot.safetensors"
LTX_VAE="ltx-2.5-video-vae-bf16.safetensors"; LTX_AVAE="ltx-2.5-audio-vae-bf16.safetensors"
LTX_UPS="ltx-2.5-latent-spatial-upscaler-x2-bf16-1.0.safetensors"
LTX_NEG="pc game, console game, video game, cartoon, childish, ugly, text, watermark, logo, flicker"

def klein_base(prompt, seed, prefix):
    return {
     "1":{"class_type":"UNETLoader","inputs":{"unet_name":KLEIN_UNET,"weight_dtype":"default"}},
     "2":{"class_type":"CLIPLoader","inputs":{"clip_name":KLEIN_TE,"type":"flux3","device":"default"}},
     "3":{"class_type":"VAELoader","inputs":{"vae_name":KLEIN_VAE}},
     "4":{"class_type":"CLIPTextEncode","inputs":{"clip":["2",0],"text":prompt}},
     "5":{"class_type":"ConditioningZeroOut","inputs":{"conditioning":["4",0]}},
     "7":{"class_type":"KSampler","inputs":{"model":["1",0],"positive":["4",0],"negative":["5",0],"latent_image":["6",0],
          "seed":seed,"steps":16,"cfg":1.0,"sampler_name":"euler","scheduler":"simple","denoise":1.0}},
     "8":{"class_type":"VAEDecode","inputs":{"samples":["7",0],"vae":["3",0]}},
     "9":{"class_type":"SaveImage","inputs":{"images":["8",0],"filename_prefix":prefix}},
    }
def klein_t2i(prompt, seed=1, w=1024, h=1024, prefix="klein_t2i"):
    wf=klein_base(prompt, seed, prefix)
    wf["6"]={"class_type":"EmptyFlux2LatentImage","inputs":{"width":w,"height":h,"batch_size":1}}
    return wf
def klein_img2img(prompt, image, denoise, seed=1, w=1344, h=768, prefix="klein_i2i"):
    wf=klein_base(prompt, seed, prefix)
    wf["10"]={"class_type":"LoadImage","inputs":{"image":image}}
    wf["11"]={"class_type":"ImageScale","inputs":{"image":["10",0],"upscale_method":"lanczos","width":w,"height":h,"crop":"center"}}
    wf["6"]={"class_type":"VAEEncode","inputs":{"pixels":["11",0],"vae":["3",0]}}
    wf["7"]["inputs"]["denoise"]=denoise
    return wf
def klein_ref(prompt, image, seed=1, prefix="klein_ref"):
    """Reference-image edit (FLUX 3 Klein edit path): ReferenceMultiLatent appends the image latent to conditioning."""
    wf=klein_base(prompt, seed, prefix)
    wf["10"]={"class_type":"LoadImage","inputs":{"image":image}}
    wf["12"]={"class_type":"ReferenceMultiLatent","inputs":{"positive":["4",0],"negative":["5",0],"vae":["3",0],
              "resolution":"resize","resolution.megapixels":1.0,"images.image0":["10",0]}}
    wf["7"]["inputs"].update(positive=["12",0], negative=["12",1], latent_image=["12",2])
    return wf

def ltx(prompt, seed=42, w=960, h=544, length=97, fps=24, image=None, prefix="ltx", two_stage=True):
    """LTX-2.5 distilled, structure of the official template. two_stage: stage 1 at w/2 x h/2, x2 latent upsample, 3-step stage 2.
    Frames are saved as PNGs (muted; mp4 assembled with ffmpeg). Audio latent kept in sampling as in the template."""
    # Measured in gpu1: stage-1 latents are floored to multiples of 32 px, so with two_stage the output is
    # floor(w/64)*64 x floor(h/64)*64 (960x544 -> 960x512, 1280x720 -> 1280x704). Use 64-multiples, e.g. 1024x576.
    if two_stage and (w%64 or h%64): print(f"warning: two-stage output will be {w//64*64}x{h//64*64}, not {w}x{h}")
    s1w,s1h=(w//2,h//2) if two_stage else (w,h)
    wf={
     "1":{"class_type":"UNETLoader","inputs":{"unet_name":LTX_UNET,"weight_dtype":"default"}},
     "2":{"class_type":"CLIPLoader","inputs":{"clip_name":LTX_TE,"type":"ltxv","device":"default"}},
     "3":{"class_type":"VAELoader","inputs":{"vae_name":LTX_VAE}},
     "4":{"class_type":"VAELoader","inputs":{"vae_name":LTX_AVAE}},
     "5":{"class_type":"CLIPTextEncode","inputs":{"clip":["2",0],"text":prompt}},
     "6":{"class_type":"CLIPTextEncode","inputs":{"clip":["2",0],"text":LTX_NEG}},
     "7":{"class_type":"LTXVConditioning","inputs":{"positive":["5",0],"negative":["6",0],"frame_rate":float(fps)}},
     "8":{"class_type":"EmptyLTXVLatentVideo","inputs":{"width":s1w,"height":s1h,"length":length,"batch_size":1}},
     "9":{"class_type":"LTXVEmptyLatentAudio","inputs":{"audio_vae":["4",0],"frames_number":length,"frame_rate":fps,"batch_size":1}},
     "11":{"class_type":"RandomNoise","inputs":{"noise_seed":seed}},
     "12":{"class_type":"KSamplerSelect","inputs":{"sampler_name":"euler_ancestral"}},
     "13":{"class_type":"ManualSigmas","inputs":{"sigmas":"1.0, 0.99375, 0.9875, 0.98125, 0.975, 0.909375, 0.725, 0.421875, 0.0"}},
     "14":{"class_type":"LTXVDualCFGGuider","inputs":{"model":["1",0],"positive":["7",0],"negative":["7",1],"video_cfg":1.0,"audio_cfg":1.0}},
     "15":{"class_type":"SamplerCustomAdvanced","inputs":{"noise":["11",0],"guider":["14",0],"sampler":["12",0],"sigmas":["13",0],"latent_image":["10",0]}},
     "16":{"class_type":"LTXVSeparateAVLatent","inputs":{"av_latent":["15",0]}},
    }
    vlat=["8",0]
    if image:
        wf["30"]={"class_type":"LoadImage","inputs":{"image":image}}
        wf["31"]={"class_type":"ImageScale","inputs":{"image":["30",0],"upscale_method":"lanczos","width":w,"height":h,"crop":"center"}}
        wf["32"]={"class_type":"LTXVPreprocess","inputs":{"image":["31",0],"img_compression":18}}
        wf["33"]={"class_type":"LTXVImgToVideoInplace","inputs":{"vae":["3",0],"image":["32",0],"latent":["8",0],"strength":0.7,"bypass":False}}
        vlat=["33",0]
    wf["10"]={"class_type":"LTXVConcatAVLatent","inputs":{"video_latent":vlat,"audio_latent":["9",0]}}
    final=["16",0]
    if two_stage:
        wf["20"]={"class_type":"LatentUpscaleModelLoader","inputs":{"model_name":LTX_UPS}}
        wf["21"]={"class_type":"LTXVLatentUpsampler","inputs":{"samples":["16",0],"upscale_model":["20",0],"vae":["3",0]}}
        up=["21",0]
        if image:
            wf["34"]={"class_type":"LTXVImgToVideoInplace","inputs":{"vae":["3",0],"image":["32",0],"latent":["21",0],"strength":1.0,"bypass":False}}
            up=["34",0]
        wf["22"]={"class_type":"LTXVConcatAVLatent","inputs":{"video_latent":up,"audio_latent":["16",1]}}
        wf["23"]={"class_type":"RandomNoise","inputs":{"noise_seed":seed+1}}
        wf["24"]={"class_type":"ManualSigmas","inputs":{"sigmas":"0.85, 0.7250, 0.4219, 0.0"}}
        wf["25"]={"class_type":"SamplerCustomAdvanced","inputs":{"noise":["23",0],"guider":["14",0],"sampler":["12",0],"sigmas":["24",0],"latent_image":["22",0]}}
        wf["26"]={"class_type":"LTXVSeparateAVLatent","inputs":{"av_latent":["25",0]}}
        final=["26",0]
    wf["40"]={"class_type":"VAEDecodeTiled","inputs":{"samples":final,"vae":["3",0],"tile_size":512,"overlap":64,"temporal_size":64,"temporal_overlap":16}}
    # N3 (GPU test 3): a SaveImage at the end of an LTX graph writes *one PNG per frame*. The
    # runner then collected frame 0 as "<id>.plate.mp4" with PNG bytes in it, hashed that one frame
    # and called the asset a video. ComfyUI's video path is CreateVideo -> SaveVideo: one mp4 per
    # job. Inputs are the schema at ComfyUI ce1e922 (comfy_extras/nodes_video.py):
    # CreateVideo(images, fps, audio optional), SaveVideo(video, filename_prefix, format, codec).
    wf["42"]={"class_type":"CreateVideo","inputs":{"images":["40",0],"fps":24.0}}
    wf["43"]={"class_type":"SaveVideo","inputs":{"video":["42",0],"filename_prefix":prefix,"format":"mp4","codec":"h264"}}
    return wf

if __name__=="__main__":
    T={"flux3_klein_t2i":klein_t2i("PROMPT"),"flux3_klein_img2img":klein_img2img("PROMPT","input.png",0.6),
       "flux3_klein_ref_edit":klein_ref("PROMPT","input.png"),"ltx25_t2v_2stage":ltx("PROMPT"),"ltx25_i2v_2stage":ltx("PROMPT",image="input.png")}
    for k,v in T.items(): json.dump(v, open(f"{HERE}/{k}.api.json","w"), indent=1)
    print("wrote", list(T))
