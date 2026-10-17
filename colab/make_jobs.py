import json, sys
sys.path.insert(0, "/home/box/comfyrizz/workflows")
from build_gpu1 import klein_t2i, klein_img2img, klein_ref, ltx
P_EXPLAIN=("Flat vector editorial illustration in a clean geometric style with soft gradients, set on a deep navy background (#0d0f14). "
 "In the center, a stylized laptop in three-quarter view emits a stream of small glowing cubes that travel to the right along a gentle arc "
 "toward a cluster of three rounded server towers in periwinkle blue (#6d8cff) with thin white outlines. Above the laptop floats a simple "
 "pale grey speech bubble. Thin dotted connector lines and tiny circular nodes link the elements. Soft, even lighting with subtle rim "
 "highlights on the server towers. The upper third of the frame is calm empty negative space reserved for a headline. Absolutely no text, letters, numbers or logos.")
P_ICON=("Minimal 3D icon render centered on a plain soft off-white background (#e6e8ee): a single rounded-square app icon tilted slightly toward "
 "the viewer, made of frosted periwinkle glass (#6d8cff) with a soft inner glow. Embossed on its face is a simple bold white lightning-bolt glyph. "
 "A soft contact shadow sits beneath the icon. Lighting comes from a large diffuse studio softbox at the upper left, with a thin specular "
 "highlight along the top edge. The icon fills about half of the frame with generous empty margins on all sides. No text, no letters.")
P_BG=("Abstract wide background plate: a dark navy to near-black gradient (#0d0f14) with slow flowing ribbons of translucent periwinkle and violet "
 "light sweeping diagonally from the lower left to the upper right, fine film grain, and subtle bokeh particles scattered in the upper right. "
 "The center and left half of the frame stay calm and dark, leaving clean negative space for overlaid text. Soft volumetric haze, no hard edges, "
 "no objects, no text.")
P_DIAG=("Polished flat vector infographic diagram on a dark navy background (#0d0f14) with a faint fine grid texture: three rounded rectangle cards "
 "arranged left to right, each a soft periwinkle-to-violet gradient (#6d8cff) with a subtle drop shadow and a thin light inner border, connected by "
 "two clean white arrows pointing right. The cards contain the centered white bold sans-serif labels \"Brief\", \"Storyboard\" and \"Video\". "
 "Crisp edges, minimal modern presentation style, generous margins.")
P_REF=("Redraw the diagram from the reference image as a polished, modern presentation infographic. Keep the exact layout: three boxes in a row "
 "at the same positions and sizes, the two arrows between them, and the exact labels \"Brief\", \"Storyboard\" and \"Video\" in white bold sans-serif. "
 "Render the boxes as rounded periwinkle glass cards (#6d8cff) with soft shadows and a gentle gradient, and the arrows as clean white arrows, on a "
 "dark navy background (#0d0f14) with a faint fine grid texture.")
P_LTX=("Slow, seamless abstract motion background. Translucent periwinkle and violet ribbons of light drift gently from left to right across a dark "
 "navy void, softly undulating like silk in slow motion, while tiny glowing particles float slowly upward through a soft haze. The camera is locked "
 "off and completely static. The motion is calm, continuous and evenly paced from the first frame to the last, with no cuts, no flashes, no text "
 "and no camera movement. A quiet low ambient hum.")
P_I2V=("Use the provided start image as the first frame. The translucent periwinkle and violet ribbons of light slowly drift and undulate diagonally, "
 "tiny bokeh particles float gently upward and the soft haze breathes. The camera stays completely static. Calm, continuous, evenly paced motion "
 "with no cuts, no flashes and no text. A quiet low ambient hum.")
J=lambda name, wf, **kw: dict(name=name, workflow=wf, **kw)
jobs={
 "klein": [J("klein_explainer_cold", klein_t2i(P_EXPLAIN, 11, prefix="klein_explainer")),
           J("klein_icon_warm", klein_t2i(P_ICON, 12, prefix="klein_icon")),
           J("klein_bg_warm_1344x768", klein_t2i(P_BG, 13, 1344, 768, prefix="klein_bg"))],
 "svg": [J(f"svg_i2i_d{int(d*100)}", klein_img2img(P_DIAG, "diagram.png", d, 21, prefix=f"svg_i2i_d{int(d*100)}")) for d in (0.45, 0.6, 0.75)]
        + [J("svg_ref_edit", klein_ref(P_REF, "diagram.png", 22, prefix="svg_ref"))],
 "ltx_t2v": [J("ltx_t2v_960x544_97f", ltx(P_LTX, 42, prefix="ltx_t2v"), mp4=True, timeout=1200)],
 "ltx_i2v": [J("ltx_i2v_960x544_97f", ltx(P_I2V, 43, image="klein_bg_start.png", prefix="ltx_i2v"), mp4=True, timeout=1200),
             J("klein_after_ltx", klein_t2i(P_ICON, 14, prefix="klein_after_ltx"))],
}
for k,v in jobs.items(): json.dump(v, open(f"jobs_{k}.json","w"))
print({k: len(v) for k,v in jobs.items()})
extra=[J("ltx_t2v_960x544_97f_warm", ltx(P_LTX, 44, prefix="ltx_t2v_warm"), mp4=True, timeout=1200),
       J("ltx_t2v_960x544_121f", ltx(P_LTX, 45, length=121, prefix="ltx_t2v121"), mp4=True, timeout=1200),
       J("ltx_t2v_1280x720_121f", ltx(P_LTX, 46, w=1280, h=720, length=121, prefix="ltx_t2v720"), mp4=True, timeout=1200),
       J("klein_after_ltx_2", klein_t2i(P_EXPLAIN, 15, prefix="klein_after_ltx2"))]
json.dump(extra, open("jobs_extra.json","w")); print("extra", len(extra))
