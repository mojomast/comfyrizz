"""GPU test 2, batch 6 (added after reviewing batches 1-5): more i2v variety, a 16:9 mascot for i2v
(the 1:1 mascot was center-cropped), finals-size timing (Klein 1920x1088, LTX 1536x832), and a
corp-hero retry without the empty-headline cue that produced pseudo-text."""
import json, os, sys
HERE = os.path.dirname(os.path.abspath(__file__)); REPO = os.path.abspath(f"{HERE}/../..")
sys.path[:0] = [f"{REPO}/workflows", HERE]
from build_gpu1 import klein_t2i, ltx
import prompts as P
S = {s[0]: s for s in P.STYLES}
J = lambda name, wf, **kw: dict(name=name, workflow=wf, **kw)
jobs = []
mascot = S["clay_mascot"][3].replace("Standing centered", "Standing slightly left of center in a wide 16:9 frame")
jobs.append(J("st_clay_mascot_wide", klein_t2i(mascot, 150, 1344, 768, prefix="st_clay_mascot_wide")))
corp = ("Corporate infographic hero illustration: a diverse team of three stylised flat-vector professionals standing on the right beside a giant upward bar chart and a large pie chart, one pointing at the chart, a few floating UI cards containing only simple icons and coloured bars. Clean white background (#ffffff) with soft blue (#3a86ff) and coral (#ff6b6b) accents, modern SaaS landing-page style, the left half of the frame is plain empty white space. Absolutely no text, no letters, no words, no numbers anywhere.")
jobs.append(J("st_corp_hero_v2", klein_t2i(corp, 151, 1344, 768, prefix="st_corp_hero_v2")))
jobs.append(J("st_iso_solar_1080", klein_t2i(S["iso_solar"][3], 152, 1920, 1088, prefix="st_iso_solar_1080")))
jobs.append(J("st_solarfarm_1080", klein_t2i(S["photo_solarfarm"][3], 153, 1920, 1088, prefix="st_solarfarm_1080")))
I2V = [
 ("i2v_iso_neural_pulse", "st_iso_neural_", "Use the provided start image as the first frame. Waves of violet light pulse upward through the stacked glass layers, the tiny nodes light up in sequence, data cubes slide in from the left and the output node flares brightly. Very slow camera orbit. No cuts, no text."),
 ("i2v_papercut_glow", "st_papercut_neural_", "Use the provided start image as the first frame. The tiny paper nodes inside the head light up one after another and the connecting lines glow softly, gentle shadows shift as if the light slowly moves. Static camera. No cuts, no text."),
 ("i2v_card_lightsweep", "st_photo_card_", "Use the provided start image as the first frame. A narrow beam of warm orange light slowly sweeps across the brushed metal card, the iridescent edge shimmers, dust specks drift through the beam, the camera slowly pushes in. No cuts, no text."),
 ("i2v_dataviz_push", "st_dataviz_city_", "Use the provided start image as the first frame. The glowing bar columns rise slightly and pulse, sparkle particles drift upward, the camera glides slowly forward through the data city. No cuts, no text."),
 ("i2v_fintech_rocket", "st_flat_fintech_", "Use the provided start image as the first frame. The little rocket lifts off and flies upward leaving its dotted trail, the icons around the phone bob gently, the line chart on the phone draws upward. Flat 2D motion-graphics style, static camera. No cuts, no text."),
 ("i2v_lowpoly_clouds", "st_lowpoly_mountain_", "Use the provided start image as the first frame. The geometric clouds drift slowly across the sky, the wind turbines turn, the dawn light gradually warms the faceted mountains. Static camera, calm. No cuts, no text."),
 ("i2v_svg_timeline_clay", "svg_timeline_clay_ref_", "Use the provided start image as the first frame. A soft glow travels along the timeline from Beta to 1M users, each clay milestone gently bounces as the glow reaches it, slow camera push-in. The labels stay perfectly still and legible. No cuts."),
 ("i2v_svg_mindmap_clay", "svg_mind_map_clay_ref_", "Use the provided start image as the first frame. The central Learning node gently pulses, soft light travels along the connectors to Data, Loss, Weights and Gradients in turn, slow camera drift. The labels stay perfectly still and legible. No cuts."),
 ("i2v_clay_mascot_wide", "st_clay_mascot_wide_", "Use the provided start image as the first frame. The little clay robot waves its arm in a friendly loop, blinks its oval eyes, bobs gently up and down and its antenna ball wobbles. Static camera, soft studio lighting, playful stop-motion feel, no cuts, no text."),
]
for k, (n, src, p) in enumerate(I2V):
    jobs.append(J(n, ltx(p, 500 + k, 1024, 576, 97, image=f"src_{n}.png", prefix=n), mp4=True, timeout=1200, copy=[src, f"src_{n}.png"]))
jobs.append(J("ltx_t2v_1536x832_finals", ltx(P.LOOPS[0][1], 520, 1536, 832, 97, prefix="ltx_t2v_1536x832_finals"), mp4=True, timeout=1800))
os.makedirs(f"{HERE}/jobs", exist_ok=True); json.dump(jobs, open(f"{HERE}/jobs/b6_extra.json", "w")); print("b6", len(jobs))
