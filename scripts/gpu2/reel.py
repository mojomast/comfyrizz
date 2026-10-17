#!/usr/bin/env python3
"""Build the GPU test 2 highlight reel (CPU, ffmpeg only).
usage: python3 scripts/gpu2/reel.py [GPU2_DIR]   (default /workspace/comfy-hackathon/test/gpu2)
Writes GPU2_DIR/reel_gpu2.mp4 (1920x1080, 30 fps, AAC; silent except the explainer excerpt)."""
import os, subprocess, sys, tempfile

G = sys.argv[1] if len(sys.argv) > 1 else "/workspace/comfy-hackathon/test/gpu2"
R = f"{G}/raw"
REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), "../.."))
FONT = f"{REPO}/apps/renderer/public/fonts/Inter-Variable.ttf"
EXPLAINER = f"{G}/explainer_solar_showcase.mp4"
W, H, FPS = 1920, 1080, 30
COVER = f"scale={W}:{H}:force_original_aspect_ratio=increase,crop={W}:{H},setsar=1"

def esc(t):
    return t.replace("\\", "\\\\").replace(":", "\\:").replace("'", "\u2019").replace(",", "\\,")

def label(text, big=False):
    if not text:
        return ""
    if big:
        return (f",drawtext=fontfile={FONT}:text='{esc(text)}':fontcolor=white:fontsize=84:"
                f"x=(w-text_w)/2:y=(h-text_h)/2-30:shadowcolor=black@0.6:shadowx=3:shadowy=3")
    return (f",drawtext=fontfile={FONT}:text='{esc(text)}':fontcolor=white:fontsize=34:x=72:y=h-110:"
            f"box=1:boxcolor=0x0b1d2e@0.72:boxborderw=18")

def sub(text):
    return (f",drawtext=fontfile={FONT}:text='{esc(text)}':fontcolor=0xffd166:fontsize=40:"
            f"x=(w-text_w)/2:y=(h/2)+70") if text else ""

def run(cmd):
    subprocess.run(cmd, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)

FADE = lambda d: f",fade=t=in:st=0:d=0.25,fade=t=out:st={d-0.25:.2f}:d=0.25"
SILENT = ["-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo"]
ENC = ["-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p", "-r", str(FPS),
       "-c:a", "aac", "-b:a", "160k", "-ar", "48000", "-ac", "2"]

def still(out, png, d, text, zoom_in=True):
    n = int(d * FPS)
    z = f"1+0.08*on/{n}" if zoom_in else f"1.08-0.08*on/{n}"
    vf = (f"{COVER},scale={W*2}:{H*2},zoompan=z='{z}':d={n}:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':"
          f"s={W}x{H}:fps={FPS}{label(text)}{FADE(d)}")
    run(["ffmpeg", "-y", "-v", "error", "-loop", "1", "-i", png, *SILENT, "-vf", vf, "-t", str(d), "-shortest", *ENC, out])

def video(out, mp4, d, text, start=0.0, big=None, subtitle=None, keep_audio=False):
    vf = f"{COVER},fps={FPS}{label(big, True) if big else label(text)}{sub(subtitle)}{FADE(d)}"
    if keep_audio:
        run(["ffmpeg", "-y", "-v", "error", "-ss", str(start), "-i", mp4, "-vf", vf,
             "-af", f"afade=t=in:d=0.3,afade=t=out:st={d-0.4}:d=0.4", "-t", str(d), *ENC, out])
    else:
        run(["ffmpeg", "-y", "-v", "error", "-ss", str(start), "-stream_loop", "-1", "-i", mp4, *SILENT,
             "-map", "0:v", "-map", "1:a", "-vf", vf, "-t", str(d), *ENC, out])

S = lambda name: f"{R}/{name}_00001_.png"
PLAN = [
    ("video", f"{G}/loops/loop_ribbons_seamless.mp4", 3.5, None, dict(big="Comfyrizz · GPU test 2", subtitle="FLUX 3 Klein · LTX-2.5 · one Google Colab G4 session")),
    ("still", S("st_iso_solar"), 2.0, "FLUX 3 Klein · isometric"),
    ("still", S("st_clay_mascot_wide"), 2.0, "Klein · clay mascot"),
    ("still", S("st_glass_ui"), 2.0, "Klein · glassmorphism UI"),
    ("still", S("st_photo_portrait"), 2.0, "Klein · photoreal portrait"),
    ("still", S("st_editorial_ai"), 2.0, "Klein · editorial illustration"),
    ("still", S("st_papercut_neural"), 2.0, "Klein · paper-cut"),
    ("still", S("st_lowpoly_mountain"), 2.0, "Klein · low-poly"),
    ("still", S("st_synthwave_city"), 2.0, "Klein · synthwave"),
    ("still", S("st_flat_fintech"), 2.0, "Klein · flat vector"),
    ("still", S("st_icon_set"), 2.0, "Klein · icon set"),
    ("still", f"{G}/inputs/solar_flow.png", 1.8, "Agent SVG (input)"),
    ("still", S("svg_solar_flow_glass_ref"), 1.8, "SVG-guided · glass (reference edit)"),
    ("still", S("svg_solar_flow_clay_ref"), 1.8, "SVG-guided · clay (reference edit)"),
    ("still", S("svg_timeline_clay_ref"), 1.8, "SVG-guided timeline · clay"),
    ("still", S("svg_mind_map_glass_ref"), 1.8, "SVG-guided mind map · glass"),
    ("still", S("svg_bar_chart_editorial_ref"), 1.8, "SVG-guided chart · editorial"),
    ("video", f"{R}/i2v_svg_solar_glass.mp4", 3.0, "LTX-2.5 image-to-video · SVG-guided still"),
    ("video", f"{R}/i2v_fox_idle.mp4", 3.0, "LTX-2.5 i2v · character idle"),
    ("video", f"{R}/i2v_clay_mascot_wide.mp4", 3.0, "LTX-2.5 i2v · mascot"),
    ("video", f"{R}/i2v_iso_neural_pulse.mp4", 3.0, "LTX-2.5 i2v · isometric pulse"),
    ("video", f"{R}/i2v_papercut_glow.mp4", 3.0, "LTX-2.5 i2v · paper-cut glow"),
    ("video", f"{R}/i2v_synthwave_drive.mp4", 3.0, "LTX-2.5 i2v · synthwave"),
    ("video", f"{R}/i2v_glass_ui_float.mp4", 3.0, "LTX-2.5 i2v · floating UI"),
    ("video", f"{R}/i2v_card_lightsweep.mp4", 3.0, "LTX-2.5 i2v · product light sweep"),
    ("video", f"{R}/i2v_fintech_rocket.mp4", 3.0, "LTX-2.5 i2v · flat vector motion"),
    ("video", f"{R}/long_solar_sunrise.mp4", 5.0, "LTX-2.5 text-to-video · 10 s single shot (241 frames)"),
    ("video", f"{G}/loops/loop_particles_seamless.mp4", 2.5, "Seamless loop · particles (0.5 s crossfade)"),
    ("video", f"{G}/loops/loop_gradient_seamless.mp4", 2.5, "Seamless loop · gradient"),
    ("video", f"{G}/loops/loop_bokeh_seamless.mp4", 2.5, "Seamless loop · bokeh"),
    ("explainer", EXPLAINER, 10.0, None, dict(start=5.0)),
    ("video", f"{G}/loops/loop_particles_seamless.mp4", 3.5, None, dict(big="Made with Comfyrizz", subtitle="134 jobs · 3.42 Google Colab units · narrated by Kokoro")),
]

def main():
    tmp = tempfile.mkdtemp(prefix="reel_")
    parts = []
    for i, (kind, src, d, text, *extra) in enumerate(PLAN):
        kw = extra[0] if extra else {}
        out = f"{tmp}/{i:02d}.mp4"
        if kind == "still":
            still(out, src, d, text, zoom_in=i % 2 == 0)
        elif kind == "explainer":
            video(out, src, d, None, start=kw["start"], keep_audio=True)
        else:
            video(out, src, d, text, **kw)
        parts.append(out)
    lst = f"{tmp}/list.txt"
    open(lst, "w").write("".join(f"file '{p}'\n" for p in parts))
    out = f"{G}/reel_gpu2.mp4"
    run(["ffmpeg", "-y", "-v", "error", "-f", "concat", "-safe", "0", "-i", lst, *ENC, "-movflags", "+faststart", out])
    print(out, sum(p[2] for p in PLAN), "s planned")

if __name__ == "__main__":
    main()
