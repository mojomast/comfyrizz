"""Build examples/showcase-gpu2/package.json (comfyrizz.package/v1) from GPU test 2 outputs.
Media files are copied into examples/showcase-gpu2/assets/ (gitignored: large binaries stay on the box).
media.json is a sidecar for scripts/gpu2/explainer (the repo renderer does not draw raster/video yet)."""
import json, hashlib, os, shutil, subprocess, sys
HERE = os.path.dirname(os.path.abspath(__file__)); REPO = os.path.abspath(f"{HERE}/../..")
EX = f"{REPO}/examples/showcase-gpu2"; RAW = "/workspace/comfy-hackathon/test/gpu2"
sys.path.insert(0, HERE); import prompts as P
os.makedirs(f"{EX}/assets", exist_ok=True)
SRC = {  # asset id -> (source file, kind, generator, caption)
 "a_sunrise": ("raw/long_solar_sunrise.mp4", "video", "ltx25", P.LONG[1]),
 "a_iso_solar": ("raw/i2v_iso_solar_push.mp4", "video", "ltx25", dict((n, p) for n, _, p in P.I2V)["i2v_iso_solar_push"]),
 "a_svg_flow": ("raw/i2v_svg_solar_glass.mp4", "video", "ltx25", "LTX-2.5 i2v from the SVG-guided FLUX 3 Klein reference edit of an agent-written flow diagram"),
 "a_solarfarm": ("raw/i2v_solarfarm_drift.mp4", "video", "ltx25", dict((n, p) for n, _, p in P.I2V)["i2v_solarfarm_drift"]),
 "a_battery": ("raw/i2v_battery_turntable.mp4", "video", "ltx25", dict((n, p) for n, _, p in P.I2V)["i2v_battery_turntable"]),
 "a_ribbons": ("loops/loop_ribbons_seamless.mp4", "video", "ltx25", P.LOOPS[0][1]),
 "a_particles": ("loops/loop_particles_seamless.mp4", "video", "ltx25", P.LOOPS[1][1]),
 "a_mascot": ("raw/i2v_clay_mascot_wide.mp4", "video", "ltx25", "LTX-2.5 i2v idle loop of the FLUX 3 Klein clay mascot"),
}
def sha(p): return hashlib.sha256(open(p, "rb").read()).hexdigest()
def probe(p):
    o = json.loads(subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v", "-show_entries", "stream=width,height,nb_frames", "-show_entries", "format=duration", "-of", "json", p], capture_output=True, text=True).stdout)
    s = o["streams"][0]; return dict(width=s["width"], height=s["height"], fps=24, frames=int(s["nb_frames"]), durationSeconds=round(float(o["format"]["duration"]), 3), audio="none")
assets = {}
for aid, (src, kind, gen, cap) in SRC.items():
    dst = f"{EX}/assets/{aid}{os.path.splitext(src)[1]}"; shutil.copy(f"{RAW}/{src}", dst)
    assets[aid] = {"kind": kind, "origin": "generated", "status": "ready", "file": f"assets/{os.path.basename(dst)}", "sha256": sha(dst), "bytes": os.path.getsize(dst),
                   "media": probe(dst), "license": {"id": "CC0-1.0"}, "redistributable": True,
                   "model_license": {"id": "LicenseRef-LTX-2.5", "url": "https://huggingface.co/Lightricks/LTX-2.5", "note": "Gated LTX-2.5 licence accepted on Hugging Face; output terms not yet reviewed (PLAN rights work, M6)."},
                   "gen": {"generator": gen, "model": "ltx-2.5-22b-distilled" if gen == "ltx25" else "flux-3-image-klein", "quantization": "int8" if gen == "ltx25" else "bf16", "caption": cap[:2000]},
                   "notes": f"GPU test 2 (comfyrizz-gpu2, Oct 17 2026), source {src}"}
PROC = lambda pat, seed: {"procedural": {"pattern": pat, "seed": seed, "palette": ["#0b1d2e", "#13304a", "#ffd166"]}}
BG = lambda aid: {"asset": aid, "fit": "cover", "loop": True, "muted": True}
FADE = {"type": "fade", "frames": 15}
scenes = [
 {"id": "s_title", "layout": "title", "variant": "centered", "preferredFrames": 180, "copy": {"kicker": "Comfyrizz GPU showcase", "headline": "How solar power works", "sub": "Made with FLUX 3 Klein, LTX-2.5 and SVG on one Google Colab GPU"},
  "background": BG("a_sunrise"), "transitionOut": FADE, "narration": "How does sunlight become the power in your home? Let's follow the energy, step by step."},
 {"id": "s_panels", "layout": "hero", "variant": "split", "preferredFrames": 180, "copy": {"kicker": "Step 1", "headline": "Panels catch the light", "body": "Silicon cells turn photons into a flow of electrons: direct current."},
  "background": PROC("mesh", 7), "foreground": [{"asset": "a_iso_solar", "x": 0.75, "y": 0.5, "w": 0.44, "anim": "slide-in"}], "transitionOut": FADE,
  "narration": "Solar panels are made of silicon cells. When sunlight hits them, it knocks electrons loose and creates a direct current."},
 {"id": "s_flow", "layout": "hero", "variant": "full-bleed", "preferredFrames": 150, "copy": {"headline": "Sunlight to home"},
  "background": BG("a_svg_flow"), "transitionOut": FADE, "narration": "An inverter converts that direct current into alternating current, the kind your home actually uses."},
 {"id": "s_stat", "layout": "stat", "preferredFrames": 180, "copy": {"headline": "Sunlight reaching Earth in", "body": "90 min", "sub": "roughly matches a year of global energy use (a common estimate)."},
  "data": {"dataset": "d_solar_day", "display": "number"}, "background": BG("a_solarfarm"), "transitionOut": FADE,
  "narration": "And there is plenty of it. The sunlight reaching Earth in about ninety minutes roughly matches a whole year of global energy use."},
 {"id": "s_battery", "layout": "hero", "variant": "split", "preferredFrames": 165, "copy": {"kicker": "Step 2", "headline": "Store it for the night", "body": "A home battery keeps the extra daytime energy for the evening."},
  "background": PROC("grid", 4), "foreground": [{"asset": "a_battery", "x": 0.75, "y": 0.5, "w": 0.44, "anim": "slide-in"}], "transitionOut": FADE,
  "narration": "Extra energy from the afternoon charges a home battery, so the lights stay on after sunset."},
 {"id": "s_chart", "layout": "chart", "variant": "bar", "preferredFrames": 180, "copy": {"headline": "A day of home solar", "sub": "Output peaks around midday.", "footnote": "Example data, invented for this demo."},
  "data": {"dataset": "d_solar_day", "display": "bar"}, "background": BG("a_ribbons"), "transitionOut": FADE,
  "narration": "Output follows the sun. It climbs through the morning, peaks around midday, and fades by evening."},
 {"id": "s_outro", "layout": "title", "variant": "outro", "preferredFrames": 165, "copy": {"headline": "Made with Comfyrizz", "sub": "FLUX 3 Klein · LTX-2.5 · SVG guides · Kokoro"},
  "background": BG("a_particles"), "foreground": [{"asset": "a_mascot", "x": 0.84, "y": 0.5, "w": 0.26, "anim": "fade-in"}],
  "narration": "Every image, clip and diagram here came from one short GPU session. Made with Comfyrizz."},
]
pkg = {"$schema": "https://comfyrizz.example/schema/package-v1.json", "schemaVersion": 1, "revision": 1, "id": "pkg_showcasegpu2", "title": "How solar power works: Comfyrizz GPU showcase (GPU test 2)",
       "createdAt": "2026-10-17T13:00:00.000Z", "format": {"width": 1920, "height": 1080, "fps": 30}, "duration": {"mode": "flexible", "flexibleCeilingFrames": 2700},
       "theme": {"palette": ["#0b1d2e", "#13304a", "#ffd166", "#f1faee"], "font": "Inter"},
       "voice": {"enabled": True, "engine": "kokoro", "voice": "af_heart", "speed": 1, "language": "en-us"},
       "datasets": {"d_solar_day": {"unit": "kWh", "label": "Home solar output by time of day", "values": [{"label": "9 am", "value": 2.1}, {"label": "12 pm", "value": 4.8}, {"label": "3 pm", "value": 3.9}, {"label": "6 pm", "value": 1.2}],
                    "source": "example", "approved": True, "note": "Invented numbers for the showcase; labelled as example data on screen."}},
       "scenes": scenes, "assets": assets,
       "compliance": {"open_weights_only": True, "llm": {"provider": "local-agent", "model": "hand-written (DOLAN)", "weights": "open"}, "backends_used": ["colab:G4"], "closed_apis_used": [],
                      "warnings": ["Stills and plates were generated in GPU test 2 on Google Colab G4 (FLUX 3 Klein BF16, LTX-2.5 int8).", "Chart data is invented and labelled as example data.", "The 90-minute sunlight figure is a commonly cited rough estimate."]}}
json.dump(pkg, open(f"{EX}/package.json", "w"), indent=2)
media = {"note": "Sidecar for scripts/gpu2/explainer: how each scene's GPU media is placed (full-frame background with scrim, or a framed panel).",
         "scrim": {"s_title": 0.45, "s_flow": 0.0, "s_stat": 0.62, "s_chart": 0.55, "s_outro": 0.5},
         "skipLayout": ["s_flow"], "lowerThird": {"s_flow": {"kicker": "How it flows", "text": "Sunlight  →  Panel (DC)  →  Inverter (AC)  →  Home"}}}
json.dump(media, open(f"{EX}/media.json", "w"), indent=2)
open(f"{EX}/.gitignore", "w").write("assets/*.mp4\nassets/*.png\npublic/\nout/*.mp4\naudio/narration/\naudio/*.wav\n")
print("ok", len(assets))
