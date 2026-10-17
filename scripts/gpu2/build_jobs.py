"""Build all GPU test 2 job batches (ComfyUI API graphs) on the box.
Uses workflows/build_gpu1.py graph builders (measured in GPU test 1) and, for Hermes's E2 sweep,
his own svgguide.build_approach + params maps. Writes batches to ./jobs/."""
import json, os, sys, copy, hashlib
HERE = os.path.dirname(os.path.abspath(__file__)); REPO = os.path.abspath(f"{HERE}/../..")
sys.path[:0] = [f"{REPO}/workflows", f"{REPO}/pipeline-py", HERE]
from build_gpu1 import klein_t2i, klein_img2img, klein_ref, ltx
import prompts as P
os.makedirs(f"{HERE}/jobs", exist_ok=True)
J = lambda name, wf, **kw: dict(name=name, workflow=wf, **kw)
def dump(n, jobs): json.dump(jobs, open(f"{HERE}/jobs/{n}.json", "w")); print(n, len(jobs))

# b1: Klein style range
dump("b1_styles", [J(f"st_{i}", klein_t2i(p, 100 + k, w, h, prefix=f"st_{i}")) for k, (i, w, h, p) in enumerate(P.STYLES)])

# b2: SVG-guided compact sweep, 4 SVGs x 3 styles x (img2img 0.45/0.6/0.75 + reference edit)
b2 = []
for s, desc in P.SVGS.items():
    for t, tmpl in P.SVG_STYLES.items():
        pr = f"An infographic slide showing {desc}. {tmpl}"
        for d in (0.45, 0.6, 0.75):
            b2.append(J(f"svg_{s}_{t}_d{int(d*100)}", klein_img2img(pr, f"{s}.png", d, 200, prefix=f"svg_{s}_{t}_d{int(d*100)}")))
        rp = f"Redraw the diagram from the reference image: {desc}. {tmpl}"
        b2.append(J(f"svg_{s}_{t}_ref", klein_ref(rp, f"{s}.png", 201, prefix=f"svg_{s}_{t}_ref")))
dump("b2_svg", b2)

# b3: Hermes's E2 sweep (stills), built with his svgguide code and B4 params maps
from svgguide.workflows import build_approach
e2 = json.load(open(f"{REPO}/workflows/svg-guided/sweeps/e2.json"))
cap = {s["id"]: s["caption"] for s in e2["scenes"]}
b3, seen, e2_issues = [], set(), []
for j in e2["jobs"]:
    img = f"e2_{j['scene']}.png"
    if j["approach"] == "img2img":
        params = dict(image=img, prompt=cap[j["scene"]], width=1280, height=720, seed=j["seed"], steps=16, denoise=j["denoise"])
    elif j["approach"] == "ref_edit":
        key = (j["scene"], j["seed"])
        if key in seen: continue  # reference_weight has no node to map to (ReferenceMultiLatent has no weight)
        seen.add(key); params = dict(reference=img, prompt=cap[j["scene"]], megapixels=1.0, seed=j["seed"], steps=16, denoise=1.0)
    else:
        continue
    d = build_approach(j["approach"], params=params)
    g = d["graph"]
    for n in g.values():
        if n.get("class_type") == "SaveImage": n["inputs"]["filename_prefix"] = "e2_" + j["id"].replace(".", "_")
    b3.append(J("e2_" + j["id"].replace(".", "_"), g))
dump("b3_e2", b3)

# b4: LTX t2v loops + one long clip, two-stage at 1024x576
b4 = [J(n, ltx(p, 300 + k, 1024, 576, 97, prefix=n), mp4=True, timeout=1200) for k, (n, p) in enumerate(P.LOOPS)]
b4.append(J(P.LONG[0], ltx(P.LONG[1], 310, 1024, 576, 241, prefix=P.LONG[0]), mp4=True, timeout=1800))
dump("b4_ltx_t2v", b4)

# b5: LTX i2v from FLUX stills and SVG-guided stills (copy step picks the source image on the VM)
b5 = [J(n, ltx(p, 400 + k, 1024, 576, 97, image=f"src_{n}.png", prefix=n), mp4=True, timeout=1200, copy=[f"st_{src}_", f"src_{n}.png"])
      for k, (n, src, p) in enumerate(P.I2V)]
b5.append(J("i2v_svg_solar_glass", ltx("Use the provided start image as the first frame. Energy pulses of warm light travel along the arrows from Sunlight to Panel to Inverter to Home, the glass elements glow softly in sequence, the background light blobs drift slowly. Static camera, the layout and labels stay perfectly still and legible. No cuts.", 420, 1024, 576, 97, image="src_svg_solar.png", prefix="i2v_svg_solar_glass"), mp4=True, timeout=1200, copy=["svg_solar_flow_glass_ref_", "src_svg_solar.png"]))
b5.append(J("i2v_svg_chart_clay", ltx("Use the provided start image as the first frame. The clay bars gently squash and settle as if just placed, soft light slowly sweeps across the scene, a subtle camera push-in. The labels and numbers stay perfectly still and legible. No cuts.", 421, 1024, 576, 97, image="src_svg_chart.png", prefix="i2v_svg_chart_clay"), mp4=True, timeout=1200, copy=["svg_bar_chart_clay_ref_", "src_svg_chart.png"]))
for k, s in enumerate(cap):  # E2 approach 4: LTX i2v from the SVG-guided ref-edit still
    b5.append(J(f"e2_{s}_ltx_i2v_s42", ltx("Use the provided start image as the first frame. " + cap[s] + " Gentle slow motion, static camera, no cuts.", 430 + k, 1024, 576, 97, image=f"src_e2_{s}.png", prefix=f"e2_{s}_ltx_i2v"), mp4=True, timeout=1200, copy=[f"e2_{s}_ref_edit_s42_", f"src_e2_{s}.png"]))
dump("b5_ltx_i2v", b5)
