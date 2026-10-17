"""LTX contact sheets: one row per clip (first / middle / last frame)."""
import glob, os
from PIL import Image, ImageDraw, ImageFont
F = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", 16)
OUT = "/workspace/comfy-hackathon/test/gpu2/contact"
def sheet(names, out, cols=2):
    rows = (len(names) + cols - 1) // cols; W, H = 960, 180
    c = Image.new("RGB", (cols * (W + 10) + 10, rows * (H + 26) + 10), (24, 24, 28)); d = ImageDraw.Draw(c)
    for k, n in enumerate(names):
        x = 10 + (k % cols) * (W + 10); y = 10 + (k // cols) * (H + 26)
        c.paste(Image.open(f"/tmp/fr/{n}.jpg"), (x, y)); d.text((x, y + H + 4), n + "  (first / mid / last)", fill=(230, 230, 235), font=F)
    c.save(out, quality=88); print(out, c.size)
allc = sorted(os.path.basename(f)[:-4] for f in glob.glob("/tmp/fr/*.jpg"))
sheet([n for n in allc if n.startswith("i2v_")], f"{OUT}/ltx_i2v.jpg")
sheet([n for n in allc if not n.startswith("i2v_")], f"{OUT}/ltx_t2v_loops_e2.jpg")
